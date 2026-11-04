// Job API client for the Mini App.
//
// Every request is authenticated with the Telegram initData as a Bearer token and
// goes to the PUBLIC /api/jobs routes. The Mini App must never call /api/internal/*
// (those require the server-side WORKER_SECRET) and never sends a user id: the
// Worker derives it from the validated initData.

export interface Job {
  id: string;
  upload_id: string;
  telegram_user_id: number;
  status: string;
  aspect_ratio: string;
  caption_style: string;
  enable_tighten: number;
  enable_loudnorm: number;
  clip_count: number;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  github_run_url?: string | null;
}

export interface ClipDownload {
  filename: string;
  url: string;
  expiresAt: number;
}

export interface StartOptions {
  aspectRatio?: string;
  captionStyle?: string;
  enableTighten?: boolean;
  enableLoudnorm?: boolean;
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

export const isTerminalStatus = (status: string): boolean => TERMINAL.includes(status);

export async function apiRequest<T = any>(
  apiBaseUrl: string,
  initData: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${initData}`,
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(`Server error (${response.status}): ${text || 'Unknown error'}`);
  }

  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data.data as T;
}

export function startProcessing(
  apiBaseUrl: string,
  initData: string,
  uploadId: string,
  options: StartOptions = {}
): Promise<Job> {
  return apiRequest<Job>(apiBaseUrl, initData, '/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      uploadId,
      aspectRatio: options.aspectRatio ?? '9:16',
      captionStyle: options.captionStyle ?? 'default',
      enableTighten: options.enableTighten ?? false,
      enableLoudnorm: options.enableLoudnorm ?? false,
    }),
  });
}

export function fetchJob(apiBaseUrl: string, initData: string, jobId: string): Promise<Job> {
  return apiRequest<Job>(apiBaseUrl, initData, `/api/jobs/${encodeURIComponent(jobId)}`);
}

export async function fetchJobs(apiBaseUrl: string, initData: string): Promise<Job[]> {
  const data = await apiRequest<{ jobs: Job[] }>(apiBaseUrl, initData, '/api/jobs?limit=50');
  return data.jobs || [];
}

/** Newest job per upload id. Input is expected newest-first (as the Worker returns it). */
export function latestJobByUpload(jobs: Job[]): Record<string, Job> {
  const result: Record<string, Job> = {};
  for (const job of jobs) {
    const existing = result[job.upload_id];
    if (!existing || job.created_at > existing.created_at) {
      result[job.upload_id] = job;
    }
  }
  return result;
}

export function fetchJobDownloads(apiBaseUrl: string, initData: string, jobId: string): Promise<{ clips: ClipDownload[] }> {
  return apiRequest<{ clips: ClipDownload[] }>(apiBaseUrl, initData, `/api/jobs/${encodeURIComponent(jobId)}/downloads`);
}
