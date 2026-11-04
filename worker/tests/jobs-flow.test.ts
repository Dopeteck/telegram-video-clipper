import { describe, it, expect, vi, beforeEach } from 'vitest';
import { R2Uploader } from '../src/r2';

// In-memory stand-in for the D1-backed Database class, shared by every
// `new Database(...)` in the Worker (routes and dispatchWorkflow alike).
const store = vi.hoisted(() => ({
  uploads: new Map<string, any>(),
  jobs: new Map<string, any>(),
}));

vi.mock('../src/db', () => {
  class Database {
    constructor(_db?: unknown, _env?: unknown) {}
    async getUpload(id: string) { return store.uploads.get(id) ?? null; }
    async getJob(id: string) { return store.jobs.get(id) ?? null; }
    async createJob(job: any) {
      const row = { github_run_url: null, created_at: Date.now(), updated_at: Date.now(), ...job };
      store.jobs.set(row.id, row);
      return row;
    }
    async updateJob(id: string, updates: any) {
      const row = store.jobs.get(id);
      if (!row) return null;
      Object.assign(row, updates);
      return row;
    }
    async getActiveJobForUpload(uploadId: string) {
      return [...store.jobs.values()].reverse().find(
        j => j.upload_id === uploadId && ['pending', 'queued', 'processing'].includes(j.status)
      ) ?? null;
    }
    async getUserJobs(userId: number) {
      return [...store.jobs.values()].filter(j => j.telegram_user_id === userId).reverse();
    }
  }
  return { Database };
});

import worker from '../src/index';

const BOT_TOKEN = '123456:TEST-BOT-TOKEN';
const WORKER_SECRET = 'worker-secret-value';
const ALICE = 1001;
const BOB = 2002;

async function signInitData(userId: number, opts: { token?: string; ageSeconds?: number } = {}) {
  const enc = new TextEncoder();
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0)),
    user: JSON.stringify({ id: userId, first_name: 'Test' }),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
  });
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(opts.token ?? BOT_TOKEN));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k2, enc.encode(dcs));
  params.set('hash', [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join(''));
  return params.toString();
}

const baseEnv = (over: Record<string, unknown> = {}): any => ({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  WORKER_SECRET,
  GITHUB_TOKEN: 'ghp_test_token',
  GITHUB_REPO: 'Dopeteck/telegram-video-clipper',
  DB: {},
  ...over,
});

const call = (path: string, init: RequestInit, env = baseEnv()) =>
  worker.fetch(new Request(`https://worker.test${path}`, init), env, {} as any);

const asUser = async (userId: number, path: string, method = 'GET', body?: unknown, env = baseEnv()) =>
  call(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signInitData(userId)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);

const seedUpload = (id: string, userId: number, status = 'uploaded') =>
  store.uploads.set(id, {
    id, telegram_user_id: userId, status,
    object_key: `uploads/${userId}/${id}/clip.mp4`, original_filename: 'clip.mp4', file_size: 10,
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.restoreAllMocks();
    store.uploads.clear();
    store.jobs.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    (globalThis as any).fetch = fetchMock;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

describe('REGRESSION: Mini App could never start processing', () => {
  it('the internal route rejects Telegram initData (this is why the old Mini App call failed)', async () => {
    seedUpload('upload_1', ALICE);
    const res = await asUser(ALICE, '/api/internal/jobs', 'POST', { uploadId: 'upload_1', telegramUserId: ALICE });
    expect(res.status).toBe(401);
    expect((await res.json() as any).error).toBe('Invalid worker secret');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.jobs.size).toBe(0);
  });

  it('the public route accepts Telegram initData and dispatches process-video to GitHub with the right payload', async () => {
    seedUpload('upload_1', ALICE);
    const res = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe('queued');
    expect(json.data.telegram_user_id).toBe(ALICE);
    expect(json.data.aspect_ratio).toBe('9:16');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/Dopeteck/telegram-video-clipper/dispatches');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer ghp_test_token');
    expect(init.headers['User-Agent']).toBeTruthy();
    expect(JSON.parse(init.body)).toEqual({
      event_type: 'process-video',
      client_payload: {
        job_id: json.data.id,
        upload_id: 'upload_1',
        telegram_user_id: ALICE,
        object_key: `uploads/${ALICE}/upload_1/clip.mp4`,
      },
    });
  });
});

describe('POST /api/jobs authentication and ownership', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await call('/api/jobs', { method: 'POST', body: JSON.stringify({ uploadId: 'x' }) });
    expect(res.status).toBe(401);
  });

  it('rejects initData signed with a different bot token', async () => {
    seedUpload('upload_1', ALICE);
    const bad = await signInitData(ALICE, { token: '999:WRONG' });
    const res = await call('/api/jobs', {
      method: 'POST', headers: { Authorization: `Bearer ${bad}` }, body: JSON.stringify({ uploadId: 'upload_1' }),
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects expired initData', async () => {
    seedUpload('upload_1', ALICE);
    const old = await signInitData(ALICE, { ageSeconds: 90000 });
    const res = await call('/api/jobs', {
      method: 'POST', headers: { Authorization: `Bearer ${old}` }, body: JSON.stringify({ uploadId: 'upload_1' }),
    });
    expect(res.status).toBe(401);
  });

  it("does not let a user process someone else's upload, and does not reveal that it exists", async () => {
    seedUpload('upload_bob', BOB);
    const res = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_bob' });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.jobs.size).toBe(0);
  });

  it('ignores a spoofed telegramUserId in the body and uses the validated identity', async () => {
    seedUpload('upload_bob', BOB);
    const res = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_bob', telegramUserId: BOB });
    expect(res.status).toBe(404);
    expect(store.jobs.size).toBe(0);
  });

  it('returns 404 for an unknown upload', async () => {
    const res = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'nope' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the upload has not finished uploading', async () => {
    seedUpload('upload_1', ALICE, 'uploading');
    const res = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' });
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the request body', async () => {
    seedUpload('upload_1', ALICE);
    expect((await asUser(ALICE, '/api/jobs', 'POST', {})).status).toBe(400);
    expect((await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1', aspectRatio: '4:3' })).status).toBe(400);
    expect((await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1', captionStyle: 'evil' })).status).toBe(400);
  });

  it('is idempotent: a double tap does not dispatch a second workflow', async () => {
    seedUpload('upload_1', ALICE);
    const first = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    const second = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    expect(second.data.id).toBe(first.data.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.jobs.size).toBe(1);
  });
});

describe('dispatch failures never leave a job stuck', () => {
  it('GitHub 403: job is persisted as failed with a meaningful message and the API reports it', async () => {
    seedUpload('upload_1', ALICE);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Resource not accessible by personal access token' });
    const res = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' });
    expect(res.status).toBe(502);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('403');
    expect(json.error).toContain('Resource not accessible');

    const job = [...store.jobs.values()][0];
    expect(job.status).toBe('failed');
    expect(job.error_message).toContain('GitHub dispatch failed: 403');
    expect(JSON.stringify(job)).not.toContain('ghp_test_token');
  });

  it('GitHub 404 explains likely causes', async () => {
    seedUpload('upload_1', ALICE);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' });
    await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' });
    expect([...store.jobs.values()][0].error_message).toContain('repository not found');
  });

  it('network error: job is marked failed (previously stayed pending forever)', async () => {
    seedUpload('upload_1', ALICE);
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    const res = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' });
    expect(res.status).toBe(502);
    const job = [...store.jobs.values()][0];
    expect(job.status).toBe('failed');
    expect(job.error_message).toContain('connection reset');
  });

  it('missing GITHUB_TOKEN: job is marked failed instead of staying pending', async () => {
    seedUpload('upload_1', ALICE);
    const res = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' }, baseEnv({ GITHUB_TOKEN: undefined }));
    expect(res.status).toBe(502);
    expect([...store.jobs.values()][0].status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('after a failed dispatch the user can retry (failed jobs are not "active")', async () => {
    seedUpload('upload_1', ALICE);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' });
    const retry = await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' });
    expect(retry.status).toBe(200);
    expect(store.jobs.size).toBe(2);
  });
});

describe('GET /api/jobs and /api/jobs/:id (Mini App status polling)', () => {
  it('returns the caller\'s job, keyed by job id, including upload_id and status', async () => {
    seedUpload('upload_1', ALICE);
    const created = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    const res = await asUser(ALICE, `/api/jobs/${created.data.id}`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.data.id).toBe(created.data.id);
    expect(json.data.upload_id).toBe('upload_1');
    expect(json.data.status).toBe('queued');
  });

  it("does not expose another user's job", async () => {
    seedUpload('upload_bob', BOB);
    const created = await (await asUser(BOB, '/api/jobs', 'POST', { uploadId: 'upload_bob' })).json() as any;
    expect((await asUser(ALICE, `/api/jobs/${created.data.id}`)).status).toBe(404);
    const list = await (await asUser(ALICE, '/api/jobs')).json() as any;
    expect(list.data.jobs).toEqual([]);
  });

  it('lists the caller\'s jobs so the UI can resume polling after a reload', async () => {
    seedUpload('upload_1', ALICE);
    await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' });
    const list = await (await asUser(ALICE, '/api/jobs')).json() as any;
    expect(list.data.jobs).toHaveLength(1);
    expect(list.data.jobs[0].upload_id).toBe('upload_1');
  });
});

describe('internal routes stay protected and keep working for the workflow', () => {
  const internal = (path: string, method = 'GET', body?: unknown, token: string | null = WORKER_SECRET, env = baseEnv()) =>
    call(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);

  it('rejects missing, wrong and empty secrets', async () => {
    expect((await internal('/api/internal/jobs/x', 'GET', undefined, null)).status).toBe(401);
    expect((await internal('/api/internal/jobs/x', 'GET', undefined, 'wrong')).status).toBe(401);
    expect((await internal('/api/internal/jobs/x', 'GET', undefined, '', baseEnv({ WORKER_SECRET: '' }))).status).toBe(401);
  });

  it('lets the workflow read a job with the worker secret', async () => {
    seedUpload('upload_1', ALICE);
    const created = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    const res = await internal(`/api/internal/jobs/${created.data.id}`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.caption_style).toBe('default');
  });

  it('internal job creation now enforces upload ownership too', async () => {
    seedUpload('upload_bob', BOB);
    const res = await internal('/api/internal/jobs', 'POST', { uploadId: 'upload_bob', telegramUserId: ALICE });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("'processing' report does not set completed_at or clip_count; 'completed' does", async () => {
    seedUpload('upload_1', ALICE);
    const created = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    const id = created.data.id;

    const started = await internal(`/api/internal/jobs/${id}/complete`, 'POST', {
      clips: [], status: 'processing', github_run_url: 'https://github.com/Dopeteck/telegram-video-clipper/actions/runs/1',
    });
    expect(started.status).toBe(200);
    let job = store.jobs.get(id);
    expect(job.status).toBe('processing');
    expect(job.completed_at ?? null).toBeNull();
    expect(job.github_run_url).toBe('https://github.com/Dopeteck/telegram-video-clipper/actions/runs/1');

    await internal(`/api/internal/jobs/${id}/complete`, 'POST', { clips: ['jobs/a/1.mp4', 'jobs/a/2.mp4'], status: 'completed' });
    job = store.jobs.get(id);
    expect(job.status).toBe('completed');
    expect(job.clip_count).toBe(2);
    expect(job.completed_at).toBeTypeOf('number');
  });

  it('rejects unknown statuses and non-GitHub run URLs are ignored', async () => {
    seedUpload('upload_1', ALICE);
    const created = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    const id = created.data.id;
    expect((await internal(`/api/internal/jobs/${id}/complete`, 'POST', { clips: [], status: 'pending' })).status).toBe(400);
    await internal(`/api/internal/jobs/${id}/complete`, 'POST', { clips: [], status: 'processing', github_run_url: 'https://evil.example/x' });
    expect(store.jobs.get(id).github_run_url).toBe('https://github.com/Dopeteck/telegram-video-clipper/actions');
  });
});

describe('internal download URL endpoint', () => {
  const internal = (path: string, method = 'GET', body?: unknown, token: string | null = WORKER_SECRET, env = baseEnv()) =>
    call(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);

  it('rejects missing, wrong and empty secrets', async () => {
    seedUpload('upload_1', ALICE);
    const created = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    expect((await internal(`/api/internal/jobs/${created.data.id}/download-url`, 'GET', undefined, null)).status).toBe(401);
    expect((await internal(`/api/internal/jobs/${created.data.id}/download-url`, 'GET', undefined, 'wrong')).status).toBe(401);
    expect((await internal(`/api/internal/jobs/${created.data.id}/download-url`, 'GET', undefined, '', baseEnv({ WORKER_SECRET: '' }))).status).toBe(401);
  });

  it('returns 404 for unknown job', async () => {
    const res = await internal('/api/internal/jobs/nonexistent/download-url');
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('Job not found');
  });

  it('returns 404 when job has no associated upload', async () => {
    // Create a job directly in store without an upload
    const jobId = 'job_test_123';
    store.jobs.set(jobId, {
      id: jobId,
      upload_id: 'nonexistent_upload',
      telegram_user_id: ALICE,
      status: 'queued',
    });
    const res = await internal(`/api/internal/jobs/${jobId}/download-url`);
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('Associated upload not found');
  });

  it('rejects when upload ownership does not match job', async () => {
    seedUpload('upload_bob', BOB);
    const created = await (await asUser(BOB, '/api/jobs', 'POST', { uploadId: 'upload_bob' })).json() as any;
    // Manually change job's user to Alice to create mismatch
    store.jobs.get(created.data.id)!.telegram_user_id = ALICE;
    const res = await internal(`/api/internal/jobs/${created.data.id}/download-url`);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe('Upload ownership mismatch');
  });

  it('rejects when upload is not in uploaded status', async () => {
    seedUpload('upload_1', ALICE, 'uploading');
    // Create job directly in store since API rejects it
    const jobId = 'job_test_123';
    store.jobs.set(jobId, {
      id: jobId,
      upload_id: 'upload_1',
      telegram_user_id: ALICE,
      status: 'queued',
    });
    const res = await internal(`/api/internal/jobs/${jobId}/download-url`);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toContain('not ready for download');
  });

  it('returns a presigned download URL for valid job', async () => {
    vi.spyOn(R2Uploader.prototype, 'generatePresignedGetObjectUrl').mockImplementation(async (key: string) => ({
      url: `https://example.com/presigned?key=${encodeURIComponent(key)}`,
      expiresAt: Date.now() + 900000,
    }));
    seedUpload('upload_1', ALICE);
    const created = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    const res = await internal(`/api/internal/jobs/${created.data.id}/download-url`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.url).toContain('example.com/presigned');
    expect(json.data.expiresAt).toBeTypeOf('number');
    expect(json.data.expiresAt).toBeGreaterThan(Date.now());
  });

  it('URL is generated for the exact database object key', async () => {
    vi.spyOn(R2Uploader.prototype, 'generatePresignedGetObjectUrl').mockImplementation(async (key: string) => ({
      url: `https://example.com/presigned?key=${encodeURIComponent(key)}`,
      expiresAt: Date.now() + 900000,
    }));
    const customKey = 'uploads/1001/custom_video.mp4';
    seedUpload('upload_1', ALICE);
    // Override the object key
    store.uploads.get('upload_1')!.object_key = customKey;
    const created = await (await asUser(ALICE, '/api/jobs', 'POST', { uploadId: 'upload_1' })).json() as any;
    const res = await internal(`/api/internal/jobs/${created.data.id}/download-url`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.data.url).toContain(encodeURIComponent(customKey));
  });
});
