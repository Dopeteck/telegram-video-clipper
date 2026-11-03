import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { dispatchWorkflow, api } from '../src/api';
import { Database } from '../src/db';
import { Env } from '../src/types';
import { Hono } from 'hono';

// Mock D1Database
const mockPrepare = vi.fn();
const mockBind = vi.fn();
const mockRun = vi.fn();
const mockFirst = vi.fn();
const mockAll = vi.fn();

const createMockDb = () => {
  mockPrepare.mockReset();
  mockBind.mockReset();
  mockRun.mockReset();
  mockFirst.mockReset();
  mockAll.mockReset();

  mockBind.mockReturnValue({ run: mockRun, first: mockFirst, all: mockAll });
  mockPrepare.mockReturnValue({ bind: mockBind });

  return { prepare: mockBind };
};

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper to create a mock Env
const createMockEnv = (overrides: Record<string, any> = {}): Env => ({
  GITHUB_TOKEN: 'test-github-token',
  GITHUB_REPO: 'Dopeteck/telegram-video-clipper',
  DB: mockDb as any,
  R2_BUCKET: {} as any,
  R2_BUCKET_NAME: 'test-bucket',
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  SESSION_SECRET: 'test-session-secret',
  WORKER_URL: 'https://test-worker.workers.dev',
  MINIAPP_URL: 'https://test-miniapp.pages.dev',
  MAX_UPLOAD_BYTES: '2147483648',
  CHUNK_SIZE: '5242880',
  MAX_CONCURRENT_CHUNKS: '3',
  UPLOAD_EXPIRY_HOURS: '24',
  CLEANUP_INTERVAL_MINUTES: '60',
  MAX_CONCURRENT_UPLOADS_PER_USER: '2',
  RATE_LIMIT_WINDOW_SECONDS: '60',
  RATE_LIMIT_MAX_REQUESTS: '30',
  R2_ACCOUNT_ID: 'test-account-id',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret-key',
  WORKER_SECRET: 'test-worker-secret',
  R2_BUCKET: {} as any,
  ...overrides,
});

describe('dispatchWorkflow', () => {
  let mockEnv: Env;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockDatabase: Database;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();

    mockDb = createMockDb();
    mockDatabase = new Database(mockDb as any);

    mockEnv = {
      GITHUB_TOKEN: 'test-github-token',
      GITHUB_REPO: 'Dopeteck/telegram-video-clipper',
      DB: mockDb as any,
      R2_BUCKET: {} as any,
      R2_BUCKET_NAME: 'test-bucket',
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      SESSION_SECRET: 'test-session-secret',
      WORKER_URL: 'https://test-worker.workers.dev',
      MINIAPP_URL: 'https://test-miniapp.pages.dev',
      MAX_UPLOAD_BYTES: '2147483648',
      CHUNK_SIZE: '5242880',
      MAX_CONCURRENT_CHUNKS: '3',
      UPLOAD_EXPIRY_HOURS: '24',
      CLEANUP_INTERVAL_MINUTES: '60',
      MAX_CONCURRENT_UPLOADS_PER_USER: '2',
      RATE_LIMIT_WINDOW_SECONDS: '60',
      RATE_LIMIT_MAX_REQUESTS: '30',
      R2_ACCOUNT_ID: 'test-account-id',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
      WORKER_SECRET: 'test-worker-secret',
      R2_BUCKET: {} as any,
    };
  });

  it('throws error when GITHUB_TOKEN is missing', async () => {
    const envWithoutToken = { ...mockEnv, GITHUB_TOKEN: '' };

    await expect(dispatchWorkflow(envWithoutToken as any, 'job-123', 'upload-456', 12345))
      .rejects.toThrow('GITHUB_TOKEN secret not configured in Worker environment');
  });

  it('throws error when GITHUB_TOKEN is undefined', async () => {
    const envWithoutToken = { ...mockEnv, GITHUB_TOKEN: undefined as any };

    await expect(dispatchWorkflow(envWithoutToken as any, 'job-123', 'upload-456', 12345))
      .rejects.toThrow('GITHUB_TOKEN secret not configured in Worker environment');
  });

  it('successfully dispatches workflow on HTTP 204', async () => {
    const jobId = 'job-123';
    const uploadId = 'upload-456';
    const telegramUserId = 12345;

    // Mock successful 204 response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      statusText: 'No Content',
    });

    // Mock upload lookup
    mockFirst.mockResolvedValueOnce({
      id: uploadId,
      object_key: `uploads/${telegramUserId}/${uploadId}/test.mp4`,
    });

    // Mock job update
    mockRun.mockResolvedValueOnce({ success: true });

    const result = await dispatchWorkflow(mockEnv, jobId, uploadId, 12345);

    expect(result).toBe('https://github.com/Dopeteck/telegram-video-clipper/actions');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/Dopeteck/telegram-video-clipper/dispatches',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-github-token',
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('process-video'),
      })
    );

    // Verify job was updated with github_run_url
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE jobs SET')
    );
  });

  it('throws and marks job failed on non-2xx response', async () => {
    const jobId = 'job-123';
    const uploadId = 'upload-456';

    // Mock failed response
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Bad credentials',
    });

    // Mock upload lookup
    mockFirst.mockResolvedValueOnce({
      id: uploadId,
      object_key: `uploads/12345/${uploadId}/test.mp4`,
    });

    // Mock job update for failure
    mockRun.mockResolvedValueOnce({ success: true });

    await expect(dispatchWorkflow(mockEnv, jobId, uploadId, 12345))
      .rejects.toThrow('GitHub dispatch failed: 401 Bad credentials');

    // Verify job was marked as failed (2nd call after upload lookup)
    expect(mockPrepare).toHaveBeenNthCalledWith(2,
      expect.stringContaining("UPDATE jobs SET status")
    );
  });

  it('throws on network error', async () => {
    const jobId = 'job-123';
    const uploadId = 'upload-456';

    // Mock network error
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // Mock upload lookup
    mockFirst.mockResolvedValueOnce({
      id: uploadId,
      object_key: `uploads/12345/${uploadId}/test.mp4`,
    });

    // Mock job update for failure
    mockRun.mockResolvedValueOnce({ success: true });

    await expect(dispatchWorkflow(mockEnv, jobId, uploadId, 12345))
      .rejects.toThrow('Network error');
  });
});

describe('API: /api/jobs (Telegram-authenticated)', () => {
  let mockEnv: Env;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();

    mockDb = createMockDb();
    mockEnv = {
      GITHUB_TOKEN: 'test-github-token',
      GITHUB_REPO: 'Dopeteck/telegram-video-clipper',
      DB: mockDb as any,
      R2_BUCKET: {} as any,
      R2_BUCKET_NAME: 'test-bucket',
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      SESSION_SECRET: 'test-session-secret',
      WORKER_URL: 'https://test-worker.workers.dev',
      MINIAPP_URL: 'https://test-miniapp.pages.dev',
      MAX_UPLOAD_BYTES: '2147483648',
      CHUNK_SIZE: '5242880',
      MAX_CONCURRENT_CHUNKS: '3',
      UPLOAD_EXPIRY_HOURS: '24',
      CLEANUP_INTERVAL_MINUTES: '60',
      MAX_CONCURRENT_UPLOADS_PER_USER: '2',
      RATE_LIMIT_WINDOW_SECONDS: '60',
      RATE_LIMIT_MAX_REQUESTS: '30',
      R2_ACCOUNT_ID: 'test-account-id',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
      WORKER_SECRET: 'test-worker-secret',
      R2_BUCKET: {} as any,
    };
  });

  const createMockUpload = (overrides: Record<string, any> = {}) => ({
    id: 'upload-456',
    telegram_user_id: 12345,
    telegram_chat_id: 67890,
    original_filename: 'test-video.mp4',
    object_key: 'uploads/12345/upload-456/test-video.mp4',
    file_size: 1000000,
    mime_type: 'video/mp4',
    multipart_upload_id: 'multipart-123',
    status: 'uploaded',
    created_at: Date.now(),
    updated_at: Date.now(),
    expires_at: Date.now() + 86400000,
    completed_etag: null,
    completed_size: null,
    error_message: null,
    ...overrides,
  });

  const mockAuthHeader = (initData: string) => ({
    Authorization: `Bearer ${initData}`,
  });

  it('creates a job with valid Telegram authentication', async () => {
    const uploadId = 'upload-456';
    const telegramUserId = 12345;

    // Mock upload lookup
    mockFirst.mockResolvedValueOnce({
      id: uploadId,
      telegram_user_id: telegramUserId,
      object_key: `uploads/${telegramUserId}/${uploadId}/test.mp4`,
      status: 'uploaded',
    });

    // Mock job creation
    mockRun.mockResolvedValueOnce({ success: true });
    mockFirst.mockResolvedValueOnce({
      id: 'job-123',
      upload_id: uploadId,
      telegram_user_id: telegramUserId,
      status: 'queued',
      aspect_ratio: '9:16',
      caption_style: 'default',
      enable_tighten: 0,
      enable_loudnorm: 0,
      clip_count: 0,
      error_message: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
      github_run_url: null,
    });

    // Mock successful GitHub dispatch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      statusText: 'No Content',
    });

    const response = await api.request(
      '/api/jobs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer valid-init-data-user=12345`,
        },
        body: JSON.stringify({ uploadId }),
      },
      mockEnv
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('job-123');
    expect(body.data.status).toBe('queued');
  });

  it('rejects invalid Telegram authentication', async () => {
    const response = await api.request(
      '/api/jobs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-init-data',
        },
        body: JSON.stringify({ uploadId: 'upload-456' }),
      },
      mockEnv
    );

    expect(response.status).toBe(401);
  });

  it('rejects missing authorization header', async () => {
    const response = await api.request(
      '/api/jobs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uploadId: 'upload-456' }),
      },
      mockEnv
    );

    expect(response.status).toBe(401);
  });

  it('rejects upload not found', async () => {
    const uploadId = 'upload-456';

    // Mock upload not found
    mockFirst.mockResolvedValueOnce(null);

    const response = await api.request(
      '/api/jobs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-init-data-user=12345',
        },
        body: JSON.stringify({ uploadId }),
      },
      mockEnv
    );

    expect(response.status).toBe(404);
  });

  it('rejects cross-user upload access', async () => {
    const uploadId = 'upload-456';

    // Mock upload belonging to different user
    mockFirst.mockResolvedValueOnce({
      id: uploadId,
      telegram_user_id: 99999, // Different user
      object_key: `uploads/99999/${uploadId}/test.mp4`,
    });

    const response = await api.request(
      '/api/jobs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-init-data-user=12345',
        },
        body: JSON.stringify({ uploadId }),
      },
      mockEnv
    );

    expect(response.status).toBe(404);
  });

  it('returns job status with ownership enforcement', async () => {
    const jobId = 'job-123';
    const uploadId = 'upload-456';
    const telegramUserId = 12345;

    // Mock job lookup - job belongs to authenticated user
    mockFirst.mockResolvedValueOnce({
      id: jobId,
      upload_id: uploadId,
      telegram_user_id: telegramUserId,
      status: 'processing',
      aspect_ratio: '9:16',
      caption_style: 'default',
      enable_tighten: 0,
      enable_loudnorm: 0,
      clip_count: 0,
      error_message: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
      github_run_url: null,
    });

    const response = await api.request(
      `/api/jobs/${jobId}`,
      {
        headers: {
          'Authorization': 'Bearer valid-init-data-user=12345',
        },
      },
      mockEnv
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(jobId);
    expect(body.data.status).toBe('processing');
  });

  it('rejects job access for different user', async () => {
    const jobId = 'job-123';
    const uploadId = 'upload-456';

    // Mock job belonging to different user
    mockFirst.mockResolvedValueOnce({
      id: jobId,
      upload_id: uploadId,
      telegram_user_id: 99999, // Different user
      status: 'processing',
      aspect_ratio: '9:16',
      caption_style: 'default',
      enable_tighten: 0,
      enable_loudnorm: 0,
      clip_count: 0,
      error_message: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
      github_run_url: null,
    });

    const response = await api.request(
      `/api/jobs/${jobId}`,
      {
        headers: {
          'Authorization': 'Bearer valid-init-data-user=12345',
        },
      },
      mockEnv
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 for non-existent job', async () => {
    const jobId = 'nonexistent-job';

    // Mock job not found
    mockFirst.mockResolvedValueOnce(null);

    const response = await api.request(
      `/api/jobs/${jobId}`,
      {
        headers: {
          'Authorization': 'Bearer valid-init-data-user=12345',
        },
      },
      mockEnv
    );

    expect(response.status).toBe(404);
  });

  it('rejects internal API without WORKER_SECRET', async () => {
    const response = await api.request(
      '/api/internal/jobs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-secret',
        },
        body: JSON.stringify({ uploadId: 'upload-456' }),
      },
      mockEnv
    );

    expect(response.status).toBe(401);
  });
});