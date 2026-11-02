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

type Screen = 'upload' | 'uploads' | 'settings' | 'help';

interface Props {
  initData: string;
  onNavigate: (screen: Screen) => void;
}

const UploadsListScreen: React.FC<Props> = ({ initData, onNavigate }) => {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loading, setLoading] = useState(true);

  const apiRequest = useCallback(async (endpoint: string, options: RequestInit = {}) => {
    const response = await fetch(endpoint, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${initData}`,
        ...options.headers,
      },
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data.data;
  }, [initData]);

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

  useEffect(() => {
    loadUploads();
  }, [loadUploads]);

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
      {uploads.map(upload => (
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
          {upload.error_message && (
            <div className="error" style={{ marginTop: 8, fontSize: 12 }}>
              {upload.error_message}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default UploadsListScreen;