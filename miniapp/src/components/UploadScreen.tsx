import { useState, useEffect, useRef, useCallback } from 'react';

interface PartUrl {
  uploadId: string;
  key: string;
  partNumber: number;
  url: string;
  expiresAt: number;
}

interface UploadStatus {
  upload: {
    id: string;
    original_filename: string;
    file_size: number;
    mime_type: string;
    status: string;
    multipart_upload_id: string | null;
    object_key: string;
    created_at: number;
    error_message: string | null;
  };
  parts: Array<{
    part_number: number;
    etag: string | null;
    size: number | null;
  }>;
  progress: {
    uploadedBytes: number;
    totalBytes: number;
    percentage: number;
  };
}

type Screen = 'upload' | 'uploads' | 'settings' | 'help';

interface Props {
  initData: string;
  uploadId: string | null;
  onNavigate: (screen: Screen) => void;
}

const UploadScreen: React.FC<Props> = ({ initData, uploadId: initialUploadId, onNavigate }) => {
  const [uploadId, setUploadId] = useState<string | null>(initialUploadId);
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadedPartsRef = useRef<Set<number>>(new Set());
  const totalPartsRef = useRef(0);
  const chunkSizeRef = useRef(0);

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

  const loadStatus = useCallback(async () => {
    if (!uploadId) return;
    try {
      const data = await apiRequest(`/api/upload/status/${uploadId}`);
      setStatus(data);
      uploadedPartsRef.current = new Set(
        data.parts.filter((p: any) => p.etag).map((p: any) => p.part_number)
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load status');
    }
  }, [uploadId, apiRequest]);

  useEffect(() => {
    if (initialUploadId) {
      loadStatus();
    }
  }, [initialUploadId, loadStatus]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
    }
  };

  const initiateUpload = async () => {
    if (!file) {
      setError('Please select a video file');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const data = await apiRequest('/api/upload/initiate', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          fileSize: file.size,
          mimeType: file.type || 'video/mp4',
        }),
      });

      setUploadId(data.uploadId);
      totalPartsRef.current = data.totalParts;
      chunkSizeRef.current = data.chunkSize;
      
      await uploadParts(data.partUrls);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to initiate upload');
      setUploading(false);
    }
  };

  const resumeUpload = async () => {
    if (!uploadId) return;
    
    setUploading(true);
    setError(null);

    try {
      const currentStatus = await apiRequest(`/api/upload/status/${uploadId}`);
      if (!currentStatus.upload.multipart_upload_id) {
        throw new Error('Upload session expired');
      }

      const missingParts: number[] = [];
      for (let i = 1; i <= totalPartsRef.current; i++) {
        if (!uploadedPartsRef.current.has(i)) missingParts.push(i);
      }

      if (missingParts.length === 0) {
        await completeUpload();
        return;
      }

      const { partUrls } = await apiRequest('/api/upload/part-urls', {
        method: 'POST',
        body: JSON.stringify({ uploadId, partNumbers: missingParts }),
      });

      await uploadParts(partUrls);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resume upload');
      setUploading(false);
    }
  };

  const uploadParts = async (partUrls: PartUrl[]) => {
    abortControllerRef.current = new AbortController();
    const controller = abortControllerRef.current;
    const concurrency = 3;
    const queue = [...partUrls];
    const active = new Set<number>();

    const uploadPart = async (partUrl: PartUrl) => {
      const start = (partUrl.partNumber - 1) * chunkSizeRef.current;
      const end = Math.min(start + chunkSizeRef.current, file!.size);
      const blob = file!.slice(start, end);

      const response = await fetch(partUrl.url, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`Failed to upload part ${partUrl.partNumber}`);
      
      const etag = response.headers.get('ETag')?.replace(/"/g, '');
      if (!etag) throw new Error(`Missing ETag for part ${partUrl.partNumber}`);

      await apiRequest('/api/upload/part-complete', {
        method: 'POST',
        body: JSON.stringify({ uploadId, partNumber: partUrl.partNumber, etag, size: blob.size }),
      });

      uploadedPartsRef.current.add(partUrl.partNumber);
      updateProgress();

      if (queue.length > 0) {
        await uploadPart(queue.shift()!);
      } else if (active.size === 0 && uploadedPartsRef.current.size === totalPartsRef.current) {
        await completeUpload();
      }
    };

    const startNext = async () => {
      if (queue.length === 0) return;
      const partUrl = queue.shift()!;
      active.add(partUrl.partNumber);
      try {
        await uploadPart(partUrl);
      } finally {
        active.delete(partUrl.partNumber);
        if (queue.length > 0) {
          startNext();
        }
      }
    };

    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
      startNext();
    }
  };

  const updateProgress = () => {
    if (!status) return;
    const uploaded = status.parts
      .filter((p: any) => uploadedPartsRef.current.has(p.part_number))
      .reduce((sum: number, p: any) => sum + (p.size || 0), 0);
    const percentage = Math.round((uploaded / status.upload.file_size) * 100);
    
    setStatus(prev => prev ? {
      ...prev,
      progress: { ...prev.progress, uploadedBytes: uploaded, percentage }
    } : null);
  };

  const completeUpload = async () => {
    if (!uploadId) return;
    
    try {
      await apiRequest('/api/upload/complete', {
        method: 'POST',
        body: JSON.stringify({ uploadId }),
      });

      setCompleted(true);
      setUploading(false);
      const tg = window.Telegram?.WebApp;
      if (tg) tg.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to complete upload');
      setUploading(false);
    }
  };

  const cancelUpload = async () => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    if (uploadId) {
      try {
        await apiRequest('/api/upload/abort', {
          method: 'POST',
          body: JSON.stringify({ uploadId }),
        });
      } catch (e) {}
    }
    setError('Upload cancelled');
    setUploading(false);
    setFile(null);
    uploadedPartsRef.current.clear();
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (completed) {
    return (
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ marginBottom: 8 }}>Upload Complete!</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
          Your video has been uploaded successfully.
        </p>
        <button className="btn btn-primary" onClick={() => onNavigate('uploads')}>
          View Uploads
        </button>
      </div>
    );
  }

  if (!uploadId && !file) {
    return (
      <div className="card">
        <h2 className="card-title">Upload Video</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
          Select a video from your device to upload it directly to secure cloud storage.
        </p>
        <input
          type="file"
          accept="video/*"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          id="fileInput"
          ref={(el) => { if (el) el.click(); }}
        />
        <label htmlFor="fileInput" className="btn btn-primary">
          📁 Choose Video
        </label>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12, textAlign: 'center' }}>
          Supported: MP4, MOV, MKV, WebM, M4V, AVI • Max 2 GB
        </p>
      </div>
    );
  }

  if (file && !uploadId) {
    return (
      <div className="card">
        <h2 className="card-title">Ready to Upload</h2>
        <div className="file-info">
          <div className="file-name">{file.name}</div>
          <div className="file-meta">
            {formatBytes(file.size)} • {file.type || 'video/mp4'}
          </div>
        </div>
        <button className="btn btn-primary" onClick={initiateUpload} disabled={uploading}>
          {uploading ? 'Preparing...' : '🚀 Start Upload'}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      {status && (
        <div className="file-info">
          <div className="file-name">{status.upload.original_filename}</div>
          <div className="file-meta">
            {formatBytes(status.upload.file_size)} • {status.upload.mime_type}
          </div>
        </div>
      )}
      
      <div className="progress-container">
        <div className={`status ${status?.upload.status === 'uploading' ? 'uploading' : status?.upload.status === 'uploaded' ? 'completed' : 'failed'}`}>
          {status?.upload.status === 'uploading' && `Uploading... ${status.progress.percentage}%`}
          {status?.upload.status === 'uploaded' && '✅ Upload completed'}
          {status?.upload.status === 'failed' && '❌ Upload failed'}
          {status?.upload.status === 'aborted' && '⏹ Upload cancelled'}
          {status?.upload.status === 'expired' && '⏰ Upload expired'}
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${status?.progress.percentage || 0}%` }}></div>
        </div>
        <div className="progress-text">
          <span>{formatBytes(status?.progress.uploadedBytes || 0)}</span>
          <span>{status?.progress.percentage || 0}%</span>
        </div>
      </div>

      {status?.upload.status === 'uploading' && (
        <button className="btn btn-danger" onClick={cancelUpload}>
          Cancel Upload
        </button>
      )}

      {(status?.upload.status === 'failed' || status?.upload.status === 'aborted' || status?.upload.status === 'expired') && (
        <button className="btn btn-primary" onClick={resumeUpload} disabled={uploading}>
          {uploading ? 'Resuming...' : '🔄 Resume Upload'}
        </button>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  );
};

export default UploadScreen;