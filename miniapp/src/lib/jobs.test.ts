import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startProcessing, fetchJob, fetchJobs, fetchJobDownloads, latestJobByUpload, isTerminalStatus, Job } from './jobs';

const BASE = 'https://worker.example';
const INIT = 'query_id=AAA&user=%7B%22id%22%3A42%7D&auth_date=1&hash=abc';

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  (globalThis as any).fetch = fetchMock;
});

describe('Process Video request (regression: Mini App called the private internal route)', () => {
  it('POSTs to the public /api/jobs route, never /api/internal, with the initData Bearer token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'job_1', upload_id: 'upload_1', status: 'queued' } }));
    const job = await startProcessing(BASE, INIT, 'upload_1');

    expect(job.id).toBe('job_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/jobs`);
    expect(url).not.toContain('/internal');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${INIT}`);
  });

  it('sends the upload id and options but NO user id (the Worker derives it from initData)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'j' } }));
    await startProcessing(BASE, INIT, 'upload_1');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      uploadId: 'upload_1',
      aspectRatio: '9:16',
      captionStyle: 'default',
      enableTighten: false,
      enableLoudnorm: false,
    });
    expect(body).not.toHaveProperty('telegramUserId');
  });

  it('surfaces the Worker error message (e.g. a GitHub dispatch failure) instead of a generic one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { ok: false, error: 'Could not start processing: GitHub dispatch failed: 403 Resource not accessible' }, 502));
    await expect(startProcessing(BASE, INIT, 'upload_1')).rejects.toThrow('GitHub dispatch failed: 403');
  });

  it('reports non-JSON server errors with the status code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html>Not found</html>',
    });
    await expect(startProcessing(BASE, INIT, 'upload_1')).rejects.toThrow('Server error (404)');
  });
});

describe('clip download links', () => {
  it('requests the authenticated downloads endpoint and passes through an abort signal', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: { clips: [{ filename: 'clip.mp4', url: 'https://r2.example/clip', expiresAt: 123 } ] },
    }));
    const result = await fetchJobDownloads(BASE, INIT, 'job_42', controller.signal);
    expect(result.clips[0].url).toBe('https://r2.example/clip');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/jobs/job_42/downloads`);
    expect(init.headers.Authorization).toBe(`Bearer ${INIT}`);
    expect(init.signal).toBe(controller.signal);
  });
});

describe('job status polling', () => {
  it('polls GET /api/jobs/:jobId with the job id (not the upload id)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'job_9', upload_id: 'upload_1', status: 'processing' } }));
    const job = await fetchJob(BASE, INIT, 'job_9');
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/jobs/job_9`);
    expect(job.status).toBe('processing');
  });

  it('loads the caller\'s jobs from GET /api/jobs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { jobs: [{ id: 'a' }] } }));
    expect(await fetchJobs(BASE, INIT)).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/jobs');
  });

  it('maps jobs by UPLOAD id (the list renders per upload) keeping the newest', () => {
    const mk = (id: string, upload_id: string, created_at: number, status = 'queued') =>
      ({ id, upload_id, created_at, status } as Job);
    const map = latestJobByUpload([mk('job_new', 'u1', 200), mk('job_old', 'u1', 100, 'failed'), mk('job_x', 'u2', 50)]);
    expect(map['u1'].id).toBe('job_new');
    expect(map['u2'].id).toBe('job_x');
    expect(map['job_new']).toBeUndefined(); // keyed by upload id, not job id
  });

  it('knows which statuses stop polling', () => {
    expect(['completed', 'failed', 'cancelled'].every(isTerminalStatus)).toBe(true);
    expect(['pending', 'queued', 'processing'].some(isTerminalStatus)).toBe(false);
  });
});
