import { useState, useEffect, useCallback, useRef } from 'react';
import { Job, apiRequest as jobsApiRequest, startProcessing, fetchJob, fetchJobs, fetchJobDownloads, latestJobByUpload, isTerminalStatus } from '../lib/jobs';

interface Upload {
  id: string;
  original_filename: string;
  file_size: number;
  mime_type: string;
  status: string;
  created_at: number;
  error_message: string | null;
}

type Screen = 'upload' | 'uploads' | 'settings' | 'help';

interface Props {
  apiBaseUrl: string;
  initData: string;
  onNavigate: (screen: Screen) => void;
}

const UploadsListScreen: React.FC<Props> = ({ apiBaseUrl, initData, onNavigate }) => {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingUploadId, setProcessingUploadId] = useState<string | null>(null);
  // Jobs are keyed by UPLOAD id because the list renders per upload.
  const [jobsByUpload, setJobsByUpload] = useState<Record<string, Job>>({});
  const [startErrors, setStartErrors] = useState<Record<string, string>>({});
  const [downloadingClip, setDownloadingClip] = useState<string | null>(null);
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const apiRequest = useCallback(
    (endpoint: string, options: RequestInit = {}) => jobsApiRequest(apiBaseUrl, initData, endpoint, options),
    [apiBaseUrl, initData]
  );

  const loadUploads = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiRequest('/api/uploads?limit=20');
      setUploads(data.uploads || []);
    } catch (e) {
      console.error('Failed to load uploads:', e);
    } finally {
      setLoading(false);
    }
  }, [apiRequest]);

  const stopPolling = useCallback((jobId: string) => {
    const timer = pollTimers.current[jobId];
    if (timer) {
      clearInterval(timer);
      delete pollTimers.current[jobId];
    }
  }, []);

  const trackJob = useCallback((job: Job) => {
    setJobsByUpload(prev => ({ ...prev, [job.upload_id]: job }));
    if (isTerminalStatus(job.status)) stopPolling(job.id);
  }, [stopPolling]);

  const startPollingJob = useCallback((jobId: string) => {
    if (pollTimers.current[jobId]) return;
    pollTimers.current[jobId] = setInterval(async () => {
      try {
        trackJob(await fetchJob(apiBaseUrl, initData, jobId));
      } catch (e) {
        // Transient errors: keep polling. A 404 means the job is gone, so stop.
        if (e instanceof Error && e.message === 'Job not found') stopPolling(jobId);
        console.error('Failed to load job status:', e);
      }
    }, 5000);
  }, [apiBaseUrl, initData, trackJob, stopPolling]);

  // Initial load: uploads, plus the caller's existing jobs so status survives a reload.
  useEffect(() => {
    loadUploads();
    fetchJobs(apiBaseUrl, initData)
      .then(jobs => {
        const latest = latestJobByUpload(jobs);
        setJobsByUpload(latest);
        Object.values(latest).forEach(job => {
          if (!isTerminalStatus(job.status)) startPollingJob(job.id);
        });
      })
      .catch(e => console.error('Failed to load jobs:', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop all polling when the screen unmounts.
  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      Object.values(timers).forEach(clearInterval);
    };
  }, []);

  const handleProcess = async (uploadId: string) => {
    setProcessingUploadId(uploadId);
    setStartErrors(prev => {
      const next = { ...prev };
      delete next[uploadId];
      return next;
    });
    try {
      const job = await startProcessing(apiBaseUrl, initData, uploadId);
      trackJob(job);
      if (!isTerminalStatus(job.status)) startPollingJob(job.id);
    } catch (e) {
      setStartErrors(prev => ({
        ...prev,
        [uploadId]: e instanceof Error ? e.message : 'Failed to start processing',
      }));
    } finally {
      setProcessingUploadId(null);
    }
  };

  const handleDownloadClip = async (jobId: string, clipIndex: number) => {
    const key = `${jobId}:${clipIndex}`;
    setDownloadingClip(key);
    setDownloadErrors(prev => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const result = await fetchJobDownloads(apiBaseUrl, initData, jobId, controller.signal);
      const clip = result.clips?.[clipIndex];
      if (!clip?.url) throw new Error('Download link is not available for this clip');

      // Telegram WebViews can block top-level navigation to a cross-origin
      // attachment URL. openLink hands the signed R2 URL to Telegram's external
      // browser instead; normal browsers retain the direct-navigation fallback.
      const telegram = window.Telegram?.WebApp;
      if (telegram?.openLink) {
        telegram.openLink(clip.url);
      } else {
        window.location.assign(clip.url);
      }
    } catch (e) {
      const message = e instanceof Error && e.name === 'AbortError'
        ? 'The download link request timed out. Please try again.'
        : e instanceof Error ? e.message : 'Failed to create download link';
      setDownloadErrors(prev => ({ ...prev, [jobId]: message }));
    } finally {
      window.clearTimeout(timeout);
      // Do not leave the button permanently in "Preparing download" after
      // handing the URL to Telegram/the browser.
      setDownloadingClip(null);
    }
  };

  const handleRetry = async (uploadId: string) => {
    try {
      await apiRequest('/api/upload/part-urls', {
        method: 'POST',
        body: JSON.stringify({ uploadId, partNumbers: [1] }),
      });
      onNavigate('upload');
      window.location.href = `/upload?upload_id=${uploadId}`;
    } catch (e) {
      console.error('Failed to resume upload:', e);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'uploading': return '📤 Uploading';
      case 'uploaded': return '✅ Completed';
      case 'aborted': return '❌ Cancelled';
      case 'expired': return '⏰ Expired';
      case 'failed': return '💥 Failed';
      default: return status;
    }
  };

  const getStatusClass = (status: string) => {
    return `upload-status ${status}`;
  };

  const getJobStatusLabel = (status: string) => {
    switch (status) {
      case 'pending': return '⏳ Queued';
      case 'queued': return '⏳ Queued';
      case 'processing': return '⚙️ Processing';
      case 'completed': return '✅ Completed';
      case 'failed': return '❌ Failed';
      case 'cancelled': return '❌ Cancelled';
      default: return status;
    }
  };

  if (loading) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <div className="spinner" style={{ margin: '0 auto 16px' }}></div>
        <p>Loading uploads...</p>
      </div>
    );
  }

  if (uploads.length === 0) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="icon">📂</div>
          <h3>No uploads yet</h3>
          <p>Tap "Upload" to add your first video</p>
        </div>
        <button className="btn btn-primary" onClick={() => onNavigate('upload')}>
          🎬 Upload Video
        </button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="card-title" style={{ marginBottom: 16 }}>My Uploads</h2>
      {uploads.map(upload => {
        const job = jobsByUpload[upload.id];
        const startError = startErrors[upload.id];
        const jobActive = !!job && !isTerminalStatus(job.status);
        const isProcessing = processingUploadId === upload.id;

        return (
          <div key={upload.id} className="card" style={{ marginBottom: 12, padding: 12 }}>
            <div className="upload-item">
              <div className="upload-thumb">🎬</div>
              <div className="upload-details">
                <div className="upload-filename">{upload.original_filename}</div>
                <div className="upload-meta">
                  {formatBytes(upload.file_size)} • {formatDate(upload.created_at)}
                </div>
              </div>
              <span className={getStatusClass(upload.status)}>{getStatusLabel(upload.status)}</span>
            </div>

            {(upload.status === 'failed' || upload.status === 'aborted' || upload.status === 'expired') && (
              <button 
                className="btn btn-secondary" 
                onClick={() => handleRetry(upload.id)}
                style={{ marginTop: 12, width: '100%' }}
              >
                🔄 Retry Upload
              </button>
            )}

            {upload.status === 'uploaded' && (
              <button 
                className="btn btn-primary" 
                onClick={() => handleProcess(upload.id)}
                disabled={isProcessing || jobActive}
                style={{ marginTop: 12, width: '100%' }}
              >
                {isProcessing ? '⏳ Starting...' : job?.status === 'failed' ? '🔄 Retry Processing' : '▶️ Process Video'}
              </button>
            )}

            {startError && (
              <div className="error" style={{ marginTop: 8, fontSize: 12 }}>
                ❌ {startError}
              </div>
            )}

            {job && (
              <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span className={`upload-status ${job.status}`}>{getJobStatusLabel(job.status)}</span>
                  {job.github_run_url && (
                    <a href={job.github_run_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: 'var(--accent)' }}>
                      🔗 View GitHub Actions
                    </a>
                  )}
                </div>
                {job.status === 'failed' && job.error_message && (
                  <div className="error" style={{ fontSize: 12, marginTop: 8 }}>
                    {job.error_message}
                  </div>
                )}
                {job.status === 'processing' && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                    ⏳ Processing... clips will be ready soon
                  </div>
                )}
                {job.status === 'completed' && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 8 }}>
                      ✅ Processing complete — {job.clip_count} clip{job.clip_count === 1 ? '' : 's'} generated.
                    </div>
                    {Array.from({ length: job.clip_count }, (_, index) => {
                      const downloadKey = `${job.id}:${index}`;
                      return (
                        <button
                          key={downloadKey}
                          className="btn btn-primary"
                          onClick={() => handleDownloadClip(job.id, index)}
                          disabled={downloadingClip === downloadKey}
                          style={{ marginTop: 6, width: '100%' }}
                        >
                          {downloadingClip === downloadKey ? '⏳ Preparing download...' : `⬇️ Download clip ${index + 1}`}
                        </button>
                      );
                    })}
                    {downloadErrors[job.id] && (
                      <div className="error" style={{ fontSize: 12, marginTop: 8 }}>
                        ❌ {downloadErrors[job.id]}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {upload.error_message && (
              <div className="error" style={{ marginTop: 8, fontSize: 12 }}>
                {upload.error_message}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default UploadsListScreen;
