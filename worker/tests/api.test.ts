import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { dispatchWorkflow } from '../src/api';
import { Database } from '../src/db';
import { Env } from '../src/types';

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

  return { prepare: mockPrepare };
};

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

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