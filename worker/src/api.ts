import { Hono } from 'hono';
import { Env, ApiResponse, PresignedUrlResponse, InitiateMultipartResponse, CompleteMultipartRequest, UploadStatusResponse, UserUploadsResponse, TelegramUser, TelegramChat, Job } from './types';
import { validateTelegramInitData, createApiResponse, generateId, sanitizeFilename, validateMimeType, validateFileExtension, getExtensionFromMimeType } from './utils';
import { Database } from './db';
import { R2Uploader } from './r2';

type ApiVariables = {
  telegramUser: TelegramUser;
  telegramChat: TelegramChat | null;
};

const api = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

api.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(createApiResponse(false, undefined, 'Missing or invalid authorization'), 401);
  }

  const initData = authHeader.substring(7);
  const { valid, data, error } = await validateTelegramInitData(initData, c.env.TELEGRAM_BOT_TOKEN);
  if (!valid || !data || !data.user) {
    return c.json(createApiResponse(false, undefined, error || 'Invalid authentication'), 401);
  }

  c.set('telegramUser', data.user);
  c.set('telegramChat', data.chat || null);
  await next();
});

api.post('/upload/initiate', async (c) => {
  const requestId = crypto.randomUUID();
  const user = c.get('telegramUser');
  const chat = c.get('telegramChat');
  const body = await c.req.json();
  
  const { filename, fileSize, mimeType } = body;
  if (!filename || !fileSize || !mimeType) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }

  if (!validateMimeType(mimeType)) {
    return c.json(createApiResponse(false, undefined, 'Unsupported file type'), 400);
  }

  if (!validateFileExtension(filename)) {
    return c.json(createApiResponse(false, undefined, 'Unsupported file extension'), 400);
  }

  const maxSize = parseInt(c.env.MAX_UPLOAD_BYTES || '2147483648', 10);
  if (fileSize > maxSize) {
    return c.json(createApiResponse(false, undefined, 'File too large'), 400);
  }

  if (fileSize === 0) {
    return c.json(createApiResponse(false, undefined, 'Empty file'), 400);
  }

  const db = new Database(c.env.DB, c.env);
  const r2 = new R2Uploader(c.env);

  const uploadId = `upload_${Date.now()}_${user.id}`;
  const objectKey = `uploads/${user.id}/${uploadId}/${sanitizeFilename(filename)}`;

  const chunkSize = parseInt(c.env.CHUNK_SIZE || '5242880', 10);
  const totalParts = Math.ceil(fileSize / chunkSize);

  try {
    console.log(`[${requestId}] db_create_upload: uploadId=${uploadId}, userId=${user.id}, fileSize=${fileSize}`);
    
    const upload = await db.createUpload({
      id: uploadId,
      telegram_user_id: user.id,
      telegram_chat_id: chat?.id ?? null,
      original_filename: filename,
      object_key: objectKey,
      file_size: fileSize,
      mime_type: mimeType,
      status: 'uploading',
    });

    console.log(`[${requestId}] r2_create_multipart: uploadId=${uploadId}, key=${objectKey}, totalParts=${totalParts}`);
    
    const initResponse = await r2.initiateMultipartUpload(objectKey, mimeType, totalParts);
    
    console.log(`[${requestId}] r2_presign_parts: uploadId=${initResponse.uploadId}, parts=${initResponse.partUrls.length}`);

    await db.updateUpload(uploadId, { multipart_upload_id: initResponse.uploadId });

    console.log(`[${requestId}] db_update_upload: uploadId=${uploadId}, multipart_upload_id=${initResponse.uploadId}`);

    return c.json(createApiResponse(true, {
      uploadId: upload.id,
      objectKey: upload.object_key,
      multipartUploadId: initResponse.uploadId,
      totalParts,
      chunkSize,
      partUrls: initResponse.partUrls,
    }));
  } catch (error) {
    console.error(`[${requestId}] Upload initiate failed:`, error);
    
    // Try to clean up D1 record if it was created
    try {
      await db.updateUpload(uploadId, { 
        status: 'failed', 
        error_message: error instanceof Error ? error.message : 'Unknown error' 
      });
    } catch (e) {
      console.error(`[${requestId}] Failed to mark upload as failed:`, e);
    }
    
    return c.json(createApiResponse(false, undefined, 
      error instanceof Error ? error.message : 'Failed to initiate upload'), 500);
  }
});

api.post('/upload/part-urls', async (c) => {
  const requestId = crypto.randomUUID();
  const user = c.get('telegramUser');
  const body = await c.req.json();
  
  const { uploadId, partNumbers } = body;
  if (!uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }

  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Upload not found'), 404);
  }

  if (!upload.multipart_upload_id) {
    return c.json(createApiResponse(false, undefined, 'Multipart upload not initialized'), 400);
  }

  try {
    console.log(`[${requestId}] r2_presign_parts: uploadId=${uploadId}, parts=${partNumbers.join(',')}`);
    
    const r2 = new R2Uploader(c.env);
    const partUrls = await r2.generatePartUploadUrls(upload.object_key, upload.multipart_upload_id, partNumbers);

    console.log(`[${requestId}] r2_presign_parts complete: uploadId=${uploadId}, generated=${partUrls.length}`);

    return c.json(createApiResponse(true, { partUrls }));
  } catch (error) {
    console.error(`[${requestId}] Part URLs generation failed:`, error);
    return c.json(createApiResponse(false, undefined, 
      error instanceof Error ? error.message : 'Failed to generate part URLs'), 500);
  }
});

api.post('/upload/part-complete', async (c) => {
  const user = c.get('telegramUser');
  const body = await c.req.json();
  
  const { uploadId, partNumber, etag, size } = body;
  if (!uploadId || !partNumber || !etag) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }

  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Upload not found'), 404);
  }

  if (!upload.multipart_upload_id) {
    return c.json(createApiResponse(false, undefined, 'Multipart upload not initialized'), 400);
  }

  if (partNumber < 1 || partNumber > Math.ceil(upload.file_size / parseInt(c.env.CHUNK_SIZE || '5242880', 10))) {
    return c.json(createApiResponse(false, undefined, 'Invalid part number'), 400);
  }

  await db.updateUploadPart(uploadId, partNumber, etag, size || 0);

  return c.json(createApiResponse(true, { ok: true }));
});

api.post('/upload/complete', async (c) => {
  const user = c.get('telegramUser');
  const body = await c.req.json();
  
  const { uploadId } = body;
  if (!uploadId) {
    return c.json(createApiResponse(false, undefined, 'Missing uploadId'), 400);
  }

  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Upload not found'), 404);
  }

  if (!upload.multipart_upload_id) {
    return c.json(createApiResponse(false, undefined, 'Multipart upload not initialized'), 400);
  }

  if (upload.status !== 'uploading') {
    return c.json(createApiResponse(false, undefined, 'Upload not in progress'), 400);
  }

  const chunkSize = parseInt(c.env.CHUNK_SIZE || '5242880', 10);
  const totalParts = Math.ceil(upload.file_size / chunkSize);

  const parts = await db.getUploadParts(uploadId);
  const uploadedPartNumbers = parts.filter(p => p.etag).map(p => p.part_number).sort((a, b) => a - b);
  
  if (uploadedPartNumbers.length !== totalParts) {
    return c.json(createApiResponse(false, undefined, `Missing parts: expected ${totalParts}, got ${uploadedPartNumbers.length}`), 400);
  }

  for (let i = 1; i <= totalParts; i++) {
    if (!uploadedPartNumbers.includes(i)) {
      return c.json(createApiResponse(false, undefined, `Missing part ${i}`), 400);
    }
  }

  const r2 = new R2Uploader(c.env);
  
  try {
    const result = await r2.completeMultipartUpload({
      uploadId: upload.multipart_upload_id,
      key: upload.object_key,
      parts: parts.map(p => ({ partNumber: p.part_number, etag: p.etag! })),
    });

    const verified = await r2.verifyObject(upload.object_key, upload.file_size);
    if (!verified.exists || verified.size !== upload.file_size) {
      await db.updateUpload(uploadId, { 
        status: 'failed', 
        error_message: 'Size mismatch after completion' 
      });
      return c.json(createApiResponse(false, undefined, 'Upload verification failed'), 500);
    }

    await db.updateUpload(uploadId, {
      status: 'uploaded',
      completed_etag: verified.etag,
      completed_size: verified.size,
    });

    return c.json(createApiResponse(true, {
      uploadId: upload.id,
      objectKey: upload.object_key,
      etag: verified.etag,
      size: verified.size,
    }));
  } catch (error) {
    await db.updateUpload(uploadId, { 
      status: 'failed', 
      error_message: error instanceof Error ? error.message : 'Completion failed' 
    });
    return c.json(createApiResponse(false, undefined, 'Failed to complete upload'), 500);
  }
});

api.post('/upload/abort', async (c) => {
  const user = c.get('telegramUser');
  const body = await c.req.json();
  
  const { uploadId } = body;
  if (!uploadId) {
    return c.json(createApiResponse(false, undefined, 'Missing uploadId'), 400);
  }

  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Upload not found'), 404);
  }

  if (upload.multipart_upload_id) {
    const r2 = new R2Uploader(c.env);
    await r2.abortMultipartUpload(upload.object_key, upload.multipart_upload_id);
  }

  await db.updateUpload(uploadId, { status: 'aborted', error_message: 'Aborted by user' });
  await db.deleteUploadParts(uploadId);

  return c.json(createApiResponse(true, { ok: true }));
});

api.get('/upload/status/:uploadId', async (c) => {
  const user = c.get('telegramUser');
  const uploadId = c.req.param('uploadId');
  
  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Upload not found'), 404);
  }

  const parts = await db.getUploadParts(uploadId);
  const uploadedBytes = parts.reduce((sum, p) => sum + (p.size || 0), 0);
  const percentage = upload.file_size > 0 ? Math.round((uploadedBytes / upload.file_size) * 100) : 0;

  const response: UploadStatusResponse = {
    upload,
    parts,
    progress: {
      uploadedBytes,
      totalBytes: upload.file_size,
      percentage,
    },
  };

  return c.json(createApiResponse(true, response));
});

api.get('/uploads', async (c) => {
  const user = c.get('telegramUser');
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  
  const db = new Database(c.env.DB, c.env);
  const uploads = await db.getUserUploads(user.id, limit, offset);
  
  const response: UserUploadsResponse = { uploads };
  return c.json(createApiResponse(true, response));
});

api.get('/user/profile', async (c) => {
  const user = c.get('telegramUser');
  const db = new Database(c.env.DB, c.env);
  const profile = await db.getUser(user.id);
  return c.json(createApiResponse(true, profile));
});

api.post('/user/profile', async (c) => {
  const user = c.get('telegramUser');
  const body = await c.req.json();
  const db = new Database(c.env.DB, c.env);
  const profile = await db.updateUser(user.id, body);
  return c.json(createApiResponse(true, profile));
});

api.get('/health', (c) => {
  return c.json(createApiResponse(true, { status: 'ok', timestamp: Date.now() }));
});

// Internal API for GitHub Actions (authenticated via worker secret)
const internalApi = new Hono<{ Bindings: Env }>();

internalApi.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(createApiResponse(false, undefined, 'Missing or invalid authorization'), 401);
  }

  const token = authHeader.substring(7);
  if (token !== c.env.WORKER_SECRET) {
    return c.json(createApiResponse(false, undefined, 'Invalid worker secret'), 401);
  }

  await next();
});

internalApi.get('/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const db = new Database(c.env.DB, c.env);
  const job = await db.getJob(jobId);
  
  if (!job) {
    return c.json(createApiResponse(false, undefined, 'Job not found'), 404);
  }

  return c.json(createApiResponse(true, job));
});

internalApi.post('/jobs/:jobId/complete', async (c) => {
  const jobId = c.req.param('jobId');
  const body = await c.req.json();
  
  const { clips, status, error_message } = body;
  if (!clips || !Array.isArray(clips) || !status) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }

  const db = new Database(c.env.DB, c.env);
  const job = await db.getJob(jobId);
  
  if (!job) {
    return c.json(createApiResponse(false, undefined, 'Job not found'), 404);
  }

  const updates: Partial<Job> = {
    status: status as Job['status'],
    clip_count: clips.length,
    completed_at: Date.now(),
  };
  
  if (error_message) {
    updates.error_message = error_message;
  }

  const updatedJob = await db.updateJob(jobId, updates);
  
  return c.json(createApiResponse(true, updatedJob));
});

internalApi.post('/jobs', async (c) => {
  const body = await c.req.json();
  
  const { uploadId, telegramUserId, aspectRatio, captionStyle, enableTighten, enableLoudnorm } = body;
  if (!uploadId || !telegramUserId) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }

  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  
  if (!upload) {
    return c.json(createApiResponse(false, undefined, 'Upload not found'), 404);
  }

  const jobId = `job_${Date.now()}_${telegramUserId}`;
  
  const job = await db.createJob({
    id: jobId,
    upload_id: uploadId,
    telegram_user_id: telegramUserId,
    status: 'pending',
    aspect_ratio: aspectRatio || '9:16',
    caption_style: captionStyle || 'default',
    enable_tighten: enableTighten ? 1 : 0,
    enable_loudnorm: enableLoudnorm ? 1 : 0,
    clip_count: 0,
    error_message: null,
    completed_at: null,
  });

  // Dispatch GitHub Actions workflow
  try {
    await dispatchWorkflow(c.env, jobId, uploadId, telegramUserId);
  } catch (e) {
    console.error('Failed to dispatch workflow:', e);
    // Don't fail the request, just log the error
  }

  return c.json(createApiResponse(true, job));
});

async function dispatchWorkflow(env: Env, jobId: string, uploadId: string, telegramUserId: number): Promise<void> {
  const githubToken = env.GITHUB_TOKEN;
  const githubRepo = env.GITHUB_REPO || 'Dopeteck/telegram-video-clipper';
  
  if (!githubToken) {
    console.warn('GITHUB_TOKEN not configured, skipping workflow dispatch');
    return;
  }

  const upload = await (await import('./db')).Database.prototype.getUpload.call(new (await import('./db')).Database(env.DB, env), uploadId);
  
  const response = await fetch(`https://api.github.com/repos/${githubRepo}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'process-video',
      client_payload: {
        job_id: jobId,
        upload_id: uploadId,
        telegram_user_id: telegramUserId,
        object_key: upload?.object_key || `uploads/${telegramUserId}/${uploadId}/`,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${error}`);
  }

  console.log(`Dispatched process-video workflow for job ${jobId}`);
}

export { api, internalApi };