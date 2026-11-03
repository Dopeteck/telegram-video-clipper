import { useState, useEffect, useCallback } from 'react';

interface Upload {
  id: string;
  original_filename: string;
  file_size: number;
  mime_type: string;
  status: string;
  created_at: number;
  error_message: string | null;
}

interface Job {
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
  github_run_url?: string;
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
  const [jobStatus, setJobStatus] = useState<Record<string, Job>>({});
  const [pollingIntervals, setPollingIntervals] = useState<Record<string, ReturnType<typeof setInterval>>>({});

  const apiRequest = useCallback(async (endpoint: string, options: RequestInit = {}) => {
    const response = await fetch(`${apiBaseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${initData}`,
        ...options.headers,
      },
    });
    
    const contentType = response.headers.get('content-type');
    let data: any;
    
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      console.error('Non-JSON response:', response.status, text);
      throw new Error(`Server error (${response.status}): ${text || 'Unknown error'}`);
    }
    
    if (!response.ok) {
      throw new Error(data.error || `Request failed with status ${response.status}`);
    }
    return data.data;
  }, [apiBaseUrl, initData]);

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

  const loadJobStatus = useCallback(async (jobId: string) => {
    try {
      const data = await apiRequest(`/api/internal/jobs/${jobId}`);
      setJobStatus(prev => ({ ...prev, [jobId]: data }));
      return data;
    } catch (e) {
      console.error('Failed to load job status:', e);
    }
  }, [apiRequest]);

  const startPollingJob = useCallback((jobId: string) => {
    if (pollingIntervals[jobId]) return;
    
    const interval = setInterval(() => {
      loadJobStatus(jobId).then(job => {
        if (job && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
          clearInterval(pollingIntervals[jobId]);
          setPollingIntervals(prev => {
            const next = { ...prev };
            delete next[jobId];
            return next;
          });
        }
      });
    }, 5000);
    
    setPollingIntervals(prev => ({ ...prev, [jobId]: interval }));
  }, [loadJobStatus, pollingIntervals]);

  useEffect(() => {
    loadUploads();
    return () => {
      Object.values(pollingIntervals).forEach(clearInterval);
    };
  }, [loadUploads, pollingIntervals]);

  const handleProcess = async (uploadId: string) => {
    setProcessingUploadId(uploadId);
    try {
      const job = await apiRequest('/api/internal/jobs', {
        method: 'POST',
        body: JSON.stringify({
          uploadId,
          telegramUserId: parseInt(initData.split('user=')[1]?.split('&')[0] || '0'),
          aspectRatio: '9:16',
          captionStyle: 'default',
          enableTighten: false,
          enableLoudnorm: false,
        }),
      });
      
      loadJobStatus(job.id);
      startPollingJob(job.id);
      
      alert(`✅ Processing started!\nJob ID: ${job.id}\n\nYou'll receive clips when processing completes.`);
    } catch (e) {
      alert(`❌ Failed to start processing: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setProcessingUploadId(null);
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
        const job = jobStatus[upload.id];
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
                disabled={isProcessing}
                style={{ marginTop: 12, width: '100%' }}
              >
                {isProcessing ? '⏳ Starting...' : '▶️ Process Video'}
              </button>
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
                  <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 8 }}>
                    ✅ Processing complete! Clips ready for delivery.
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