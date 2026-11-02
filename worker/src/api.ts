import { Hono } from 'hono';
import { Env, ApiResponse, PresignedUrlResponse, InitiateMultipartResponse, CompleteMultipartRequest, UploadStatusResponse, UserUploadsResponse } from './types';
import { validateTelegramInitData, createApiResponse, generateId, sanitizeFilename, validateMimeType, validateFileExtension, getExtensionFromMimeType } from './utils';
import { Database } from './db';
import { R2Uploader } from './r2';

export const api = new Hono<{ Bindings: Env }>();

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
  c.set('telegramChat', data.chat);
  await next();
});

api.post('/upload/initiate', async (c) => {
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

  const db = new Database(c.env.DB);
  const r2 = new R2Uploader(c.env);

  const uploadId = `upload_${Date.now()}_${user.id}`;
  const objectKey = `uploads/${user.id}/${uploadId}/${sanitizeFilename(filename)}`;

  const upload = await db.createUpload({
    id: uploadId,
    telegram_user_id: user.id,
    telegram_chat_id: chat?.id,
    original_filename: filename,
    object_key: objectKey,
    file_size: fileSize,
    mime_type: mimeType,
    status: 'uploading',
  });

  const chunkSize = parseInt(c.env.CHUNK_SIZE || '5242880', 10);
  const totalParts = Math.ceil(fileSize / chunkSize);
  const maxConcurrentChunks = parseInt(c.env.MAX_CONCURRENT_CHUNKS || '3', 10);
  const initialParts = Math.min(totalParts, maxConcurrentChunks);

  const initResponse = await r2.initiateMultipartUpload(objectKey, mimeType);
  await db.updateUpload(uploadId, { multipart_upload_id: initResponse.uploadId });

  return c.json(createApiResponse(true, {
    uploadId: upload.id,
    objectKey: upload.object_key,
    multipartUploadId: initResponse.uploadId,
    totalParts,
    chunkSize,
    partUrls: initResponse.partUrls.slice(0, initialParts),
  }));
});

api.post('/upload/part-urls', async (c) => {
  const user = c.get('telegramUser');
  const body = await c.req.json();
  
  const { uploadId, partNumbers } = body;
  if (!uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }

  const db = new Database(c.env.DB);
  const upload = await db.getUpload(uploadId);
  
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Upload not found'), 404);
  }

  if (!upload.multipart_upload_id) {
    return c.json(createApiResponse(false, undefined, 'Multipart upload not initialized'), 400);
  }

  const r2 = new R2Uploader(c.env);
  const partUrls = await r2.generatePartUploadUrls(upload.object_key, upload.multipart_upload_id, partNumbers);

  return c.json(createApiResponse(true, { partUrls }));
});

api.post('/upload/complete', async (c) => {
  const user = c.get('telegramUser');
  const body = await c.req.json();
  
  const { uploadId, parts } = body;
  if (!uploadId || !Array.isArray(parts) || parts.length === 0) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }

  const db = new Database(c.env.DB);
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

  const r2 = new R2Uploader(c.env);
  
  try {
    const result = await r2.completeMultipartUpload({
      uploadId: upload.multipart_upload_id,
      key: upload.object_key,
      parts: parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })),
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

  const db = new Database(c.env.DB);
  const upload = await db.getUpload(uploadId);
  
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Upload not found'), 404);
  }

  if (upload.multipart_upload_id) {
    const r2 = new R2Uploader(c.env);
    await r2.abortMultipartUpload(upload.object_key, upload.multipart_upload_id);
  }

  await db.updateUpload(uploadId, { status: 'aborted', error_message: 'Aborted by user' });

  return c.json(createApiResponse(true, { ok: true }));
});

api.get('/upload/status/:uploadId', async (c) => {
  const user = c.get('telegramUser');
  const uploadId = c.req.param('uploadId');
  
  const db = new Database(c.env.DB);
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
  
  const db = new Database(c.env.DB);
  const uploads = await db.getUserUploads(user.id, limit, offset);
  
  const response: UserUploadsResponse = { uploads };
  return c.json(createApiResponse(true, response));
});

api.get('/user/profile', async (c) => {
  const user = c.get('telegramUser');
  const db = new Database(c.env.DB);
  const profile = await db.getUser(user.id);
  return c.json(createApiResponse(true, profile));
});

api.post('/user/profile', async (c) => {
  const user = c.get('telegramUser');
  const body = await c.req.json();
  const db = new Database(c.env.DB);
  const profile = await db.updateUser(user.id, body);
  return c.json(createApiResponse(true, profile));
});

api.get('/health', (c) => {
  return c.json(createApiResponse(true, { status: 'ok', timestamp: Date.now() }));
});