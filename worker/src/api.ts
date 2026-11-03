import { Hono } from 'hono';
import { Env, ApiResponse, PresignedUrlResponse, InitiateMultipartResponse, CompleteMultipartRequest, UploadStatusResponse, UserUploadsResponse, TelegramUser, TelegramChat, Job } from './types';
import { validateTelegramInitData, createApiResponse, generateId, sanitizeFilename, validateMimeType, validateFileExtension, getExtensionFromMimeType, safeEqual } from './utils';
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

    try {
      await db.updateUpload(uploadId, {
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
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
        error_message: 'Size mismatch after completion',
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
      error_message: error instanceof Error ? error.message : 'Completion failed',
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

// ---------------------------------------------------------------------------
// Job endpoints for the Mini App (authenticated with Telegram initData).
// The Telegram user id is ALWAYS derived from the validated initData; nothing
// identity-related is accepted from the request body.
// ---------------------------------------------------------------------------
const ALLOWED_ASPECT_RATIOS = ['9:16', '16:9', '1:1'];
const ALLOWED_CAPTION_STYLES = ['default', 'hormozi', 'mrbeast', 'podcast'];
const ACTIVE_JOB_STATUSES: Job['status'][] = ['pending', 'queued', 'processing'];

api.post('/jobs', async (c) => {
  const user = c.get('telegramUser');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(createApiResponse(false, undefined, 'Invalid JSON body', 'BAD_REQUEST'), 400);
  }

  const uploadId = body.uploadId;
  if (typeof uploadId !== 'string' || !uploadId) {
    return c.json(createApiResponse(false, undefined, 'Missing uploadId', 'BAD_REQUEST'), 400);
  }

  const aspectRatio = body.aspectRatio === undefined ? '9:16' : body.aspectRatio;
  if (typeof aspectRatio !== 'string' || !ALLOWED_ASPECT_RATIOS.includes(aspectRatio)) {
    return c.json(createApiResponse(false, undefined, 'Invalid aspectRatio', 'BAD_REQUEST'), 400);
  }

  const captionStyle = body.captionStyle === undefined ? 'default' : body.captionStyle;
  if (typeof captionStyle !== 'string' || !ALLOWED_CAPTION_STYLES.includes(captionStyle)) {
    return c.json(createApiResponse(false, undefined, 'Invalid captionStyle', 'BAD_REQUEST'), 400);
  }

  const db = new Database(c.env.DB, c.env);

  // Ownership: a user can only process their own uploads. 404 (not 403) so
  // upload ids of other users are not confirmed to exist.
  const upload = await db.getUpload(uploadId);
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Upload not found', 'UPLOAD_NOT_FOUND'), 404);
  }
  if (upload.status !== 'uploaded') {
    return c.json(createApiResponse(false, undefined, `Upload is not ready for processing (status: ${upload.status})`, 'UPLOAD_NOT_READY'), 409);
  }

  // Idempotent: a double tap must not dispatch a second workflow.
  const active = await db.getActiveJobForUpload(uploadId);
  if (active) {
    return c.json(createApiResponse(true, active));
  }

  try {
    const job = await createProcessingJob(
      c.env,
      db,
      uploadId,
      user.id,
      aspectRatio,
      captionStyle,
      body.enableTighten === true,
      body.enableLoudnorm === true
    );
    return c.json(createApiResponse(true, job));
  } catch (error) {
    if (error instanceof JobError) {
      return c.json(createApiResponse(false, undefined, error.message, error.code), error.status as 404 | 409);
    }
    console.error('Job creation failed:', error);
    const message = error instanceof Error ? error.message : 'Failed to start processing';
    return c.json(createApiResponse(false, undefined, `Could not start processing: ${message}`, 'DISPATCH_FAILED'), 502);
  }
});

api.get('/jobs', async (c) => {
  const user = c.get('telegramUser');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 100);
  const db = new Database(c.env.DB, c.env);
  const jobs = await db.getUserJobs(user.id, limit, 0);
  return c.json(createApiResponse(true, { jobs }));
});

api.get('/jobs/:jobId', async (c) => {
  const user = c.get('telegramUser');
  const db = new Database(c.env.DB, c.env);
  const job = await db.getJob(c.req.param('jobId'));
  if (!job || job.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, undefined, 'Job not found', 'JOB_NOT_FOUND'), 404);
  }
  return c.json(createApiResponse(true, job));
});

// Internal API for GitHub Actions (authenticated via worker secret ONLY).
// The Mini App must never call these routes; it uses /api/jobs instead.
const internalApi = new Hono<{ Bindings: Env }>();

internalApi.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(createApiResponse(false, undefined, 'Missing or invalid authorization'), 401);
  }

  const token = authHeader.substring(7);
  if (!c.env.WORKER_SECRET || !safeEqual(token, c.env.WORKER_SECRET)) {
    return c.json(createApiResponse(false, undefined, 'Invalid worker secret'), 401);
  }

  await next();
});

internalApi.get('/jobs/:jobId/source-url', async (c) => {
  const jobId = c.req.param('jobId');
  const db = new Database(c.env.DB, c.env);
  const job = await db.getJob(jobId);

  if (!job) {
    return c.json(createApiResponse(false, undefined, 'Job not found'), 404);
  }
  if (job.status !== 'processing') {
    return c.json(createApiResponse(false, undefined, 'Job is not processing'), 409);
  }

  const upload = await db.getUpload(job.upload_id);
  if (!upload || upload.status !== 'uploaded') {
    return c.json(createApiResponse(false, undefined, 'Source upload is not available'), 409);
  }

  const expiresIn = 900;
  const r2 = new R2Uploader(c.env);
  const url = await r2.generateDownloadUrl(upload.object_key, expiresIn);

  return c.json(createApiResponse(true, {
    url,
    filename: upload.object_key.split('/').pop() || 'source-video.mp4',
    expiresAt: Date.now() + expiresIn * 1000,
  }));
});

internalApi.post('/jobs/:jobId/output-urls', async (c) => {
  const jobId = c.req.param('jobId');
  const db = new Database(c.env.DB, c.env);
  const job = await db.getJob(jobId);

  if (!job) {
    return c.json(createApiResponse(false, undefined, 'Job not found'), 404);
  }
  if (job.status !== 'processing') {
    return c.json(createApiResponse(false, undefined, 'Job is not processing'), 409);
  }

  let body: Record<string, unknown> | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(createApiResponse(false, undefined, 'Invalid JSON body'), 400);
  }

  const filenames = body?.filenames;
  const validFilename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.mp4$/i;
  if (
    !Array.isArray(filenames) ||
    filenames.length === 0 ||
    filenames.length > 50 ||
    !filenames.every((name) => typeof name === 'string' && validFilename.test(name)) ||
    new Set(filenames).size !== filenames.length
  ) {
    return c.json(createApiResponse(false, undefined, 'filenames must contain 1-50 unique safe MP4 filenames'), 400);
  }

  const expiresIn = 3600;
  const r2 = new R2Uploader(c.env);
  const uploads = await Promise.all((filenames as string[]).map(async (filename) => {
    const key = `jobs/${jobId}/${filename}`;
    const url = await r2.generateUploadUrl(key, 'video/mp4', expiresIn);
    return {
      filename,
      key,
      url,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }));

  return c.json(createApiResponse(true, { uploads }));
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

const REPORTABLE_STATUSES = ['processing', 'completed', 'failed'] as const;
const TERMINAL_STATUSES = ['completed', 'failed'];

internalApi.post('/jobs/:jobId/complete', async (c) => {
  const jobId = c.req.param('jobId');
  const body = await c.req.json();

  const { clips, status, error_message, github_run_url } = body;
  if (!clips || !Array.isArray(clips) || !status) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }
  if (!(REPORTABLE_STATUSES as readonly string[]).includes(status)) {
    return c.json(createApiResponse(false, undefined, `Invalid status: ${status}`), 400);
  }

  const db = new Database(c.env.DB, c.env);
  const job = await db.getJob(jobId);

  if (!job) {
    return c.json(createApiResponse(false, undefined, 'Job not found'), 404);
  }

  const updates: Partial<Job> = { status: status as Job['status'] };

  // Only a terminal report finishes the job and fixes the clip count.
  if (TERMINAL_STATUSES.includes(status)) {
    updates.clip_count = clips.length;
    updates.completed_at = Date.now();
  }

  if (error_message) {
    updates.error_message = String(error_message).slice(0, 1000);
  }

  if (typeof github_run_url === 'string' && github_run_url.startsWith('https://github.com/')) {
    updates.github_run_url = github_run_url;
  }

  const updatedJob = await db.updateJob(jobId, updates);

  return c.json(createApiResponse(true, updatedJob));
});

export class JobError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
    this.name = 'JobError';
  }
}

// Shared function for job creation - called by the public Mini App route,
// the internal route and the bot. Ownership is enforced here so that no
// caller can create a job for an upload the given Telegram user does not own.
export async function createProcessingJob(
  env: Env,
  db: Database,
  uploadId: string,
  telegramUserId: number,
  aspectRatio: string,
  captionStyle: string,
  enableTighten: boolean,
  enableLoudnorm: boolean
): Promise<Job> {
  const upload = await db.getUpload(uploadId);

  if (!upload || upload.telegram_user_id !== telegramUserId) {
    throw new JobError('Upload not found', 404, 'UPLOAD_NOT_FOUND');
  }
  if (upload.status !== 'uploaded') {
    throw new JobError(`Upload is not ready for processing (status: ${upload.status})`, 409, 'UPLOAD_NOT_READY');
  }

  const jobId = `job_${Date.now()}_${telegramUserId}`;

  await db.createJob({
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
    github_run_url: null,
  });

  try {
    await dispatchWorkflow(env, jobId, uploadId, telegramUserId);
  } catch (error) {
    // Never leave a job stuck in 'pending'/'queued' when dispatch failed.
    const message = error instanceof Error ? error.message : 'Dispatch failed';
    try {
      const current = await db.getJob(jobId);
      if (current && ACTIVE_JOB_STATUSES.includes(current.status)) {
        await db.updateJob(jobId, { status: 'failed', error_message: message.slice(0, 1000) });
      }
    } catch (e) {
      console.error(`Failed to mark job ${jobId} as failed:`, e);
    }
    throw error;
  }

  const updatedJob = await db.getJob(jobId);
  if (!updatedJob) {
    throw new Error('Failed to retrieve updated job after dispatch');
  }
  return updatedJob;
}

internalApi.post('/jobs', async (c) => {
  const body = await c.req.json();

  const { uploadId, telegramUserId, aspectRatio, captionStyle, enableTighten, enableLoudnorm } = body;
  if (!uploadId || !telegramUserId) {
    return c.json(createApiResponse(false, undefined, 'Missing required fields'), 400);
  }

  const db = new Database(c.env.DB, c.env);

  try {
    const job = await createProcessingJob(
      c.env,
      db,
      uploadId,
      telegramUserId,
      aspectRatio || '9:16',
      captionStyle || 'default',
      enableTighten ? true : false,
      enableLoudnorm ? true : false
    );
    return c.json(createApiResponse(true, job));
  } catch (error) {
    if (error instanceof JobError) {
      return c.json(createApiResponse(false, undefined, error.message, error.code), error.status as 404 | 409);
    }
    console.error('Job creation failed:', error);
    return c.json(createApiResponse(false, undefined, error instanceof Error ? error.message : 'Failed to create job'), 500);
  }
});

function describeDispatchFailure(status: number, body: string): string {
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  let hint = '';
  if (status === 401) hint = ' (GitHub rejected the token: expired, revoked or invalid)';
  else if (status === 403) hint = ' (token lacks permission to dispatch events, or the request was blocked)';
  else if (status === 404) hint = ' (repository not found, or the token has no access to it)';
  else if (status === 422) hint = ' (GitHub rejected the dispatch payload)';
  return `GitHub dispatch failed: ${status} ${detail}${hint}`;
}

async function dispatchWorkflow(env: Env, jobId: string, uploadId: string, telegramUserId: number): Promise<string> {
  const githubToken = env.GITHUB_TOKEN;
  const githubRepo = env.GITHUB_REPO || 'Dopeteck/telegram-video-clipper';

  if (!githubToken) {
    throw new Error('GITHUB_TOKEN secret not configured in Worker environment');
  }

  const db = new Database(env.DB, env);
  const upload = await db.getUpload(uploadId);

  if (!upload) {
    const message = `Upload ${uploadId} not found while dispatching job`;
    await db.updateJob(jobId, { status: 'failed', error_message: message });
    throw new Error(message);
  }

  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${githubRepo}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        // GitHub rejects API requests without a User-Agent.
        'User-Agent': 'telegram-video-clipper-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: 'process-video',
        client_payload: {
          job_id: jobId,
          upload_id: uploadId,
          telegram_user_id: telegramUserId,
          object_key: upload.object_key,
        },
      }),
    });
  } catch (error) {
    const message = `GitHub dispatch request failed: ${error instanceof Error ? error.message : 'network error'}`;
    await db.updateJob(jobId, { status: 'failed', error_message: message });
    throw error instanceof Error ? error : new Error(message);
  }

  if (!response.ok) {
    const message = describeDispatchFailure(response.status, await response.text());
    await db.updateJob(jobId, { status: 'failed', error_message: message });
    throw new Error(message);
  }

  // GitHub returns 204 No Content: the run id is not available yet. The
  // workflow reports its real run URL when it starts.
  const runUrl = `https://github.com/${githubRepo}/actions`;

  await db.updateJob(jobId, { status: 'queued', github_run_url: runUrl });

  console.log(`Dispatched process-video workflow for job ${jobId}`);
  return runUrl;
}

export { api, internalApi, dispatchWorkflow };
