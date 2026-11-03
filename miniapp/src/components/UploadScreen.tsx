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
  apiBaseUrl: string;
  initData: string;
  uploadId: string | null;
  onNavigate: (screen: Screen) => void;
}

const UploadScreen: React.FC<Props> = ({ apiBaseUrl, initData, uploadId: initialUploadId, onNavigate }) => {
  const [uploadId, setUploadId] = useState<string | null>(initialUploadId);
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadStateRef = useRef({
    uploadedParts: new Set<number>(),
    totalParts: 0,
    chunkSize: 0,
    file: null as File | null,
    completing: false,
  });

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

  const loadStatus = useCallback(async () => {
    if (!uploadId) return;
    try {
      const data = await apiRequest(`/api/upload/status/${uploadId}`);
      setStatus(data);
      uploadStateRef.current.uploadedParts = new Set(
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

      // Pass the server-issued ID directly; React state updates are asynchronous.
      const activeUploadId = data.uploadId as string;
      setUploadId(activeUploadId);
      uploadStateRef.current.totalParts = data.totalParts;
      uploadStateRef.current.chunkSize = data.chunkSize;
      uploadStateRef.current.file = file;
      uploadStateRef.current.uploadedParts = new Set();
      
      await uploadParts(data.partUrls, activeUploadId);
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

      // Restore totalParts and chunkSize from server
      const chunkSize = parseInt(currentStatus.upload.mime_type || '5242880', 10) || 5242880;
      const totalParts = Math.ceil(currentStatus.upload.file_size / chunkSize);
      
      uploadStateRef.current.totalParts = totalParts;
      uploadStateRef.current.chunkSize = chunkSize;
      uploadStateRef.current.uploadedParts = new Set(
        currentStatus.parts.filter((p: any) => p.etag).map((p: any) => p.part_number)
      );

      const missingParts: number[] = [];
      for (let i = 1; i <= totalParts; i++) {
        if (!uploadStateRef.current.uploadedParts.has(i)) missingParts.push(i);
      }

      if (missingParts.length === 0) {
        await completeUpload(uploadId);
        return;
      }

      const { partUrls } = await apiRequest('/api/upload/part-urls', {
        method: 'POST',
        body: JSON.stringify({ uploadId, partNumbers: missingParts }),
      });

      uploadStateRef.current.file = null; // Will prompt user to reselect file
      await uploadParts(partUrls, uploadId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resume upload');
      setUploading(false);
    }
  };

  const uploadParts = async (partUrls: PartUrl[], activeUploadId: string) => {
    const state = uploadStateRef.current;
    state.completing = false;
    
    // If we don't have the file, prompt user to select it
    if (!state.file) {
      const selectedFile = await promptForFile();
      if (!selectedFile) {
        setError('File selection cancelled');
        setUploading(false);
        return;
      }
      // Verify file size matches
      const expectedSize = status?.upload.file_size;
      if (expectedSize && selectedFile.size !== expectedSize) {
        setError(`File size mismatch. Expected ${expectedSize} bytes, got ${selectedFile.size} bytes.`);
        setUploading(false);
        return;
      }
      state.file = selectedFile;
    }

    const concurrency = 3;
    const queue = [...partUrls];
    const active = new Set<number>();
    const results: Array<{ partNumber: number; etag: string; size: number }> = [];
    let hasError = false;
    let firstError: Error | null = null;

    const uploadPart = async (partUrl: PartUrl): Promise<{ partNumber: number; etag: string; size: number }> => {
      if (hasError) throw new Error('Upload aborted due to previous error');
      
      const start = (partUrl.partNumber - 1) * state.chunkSize;
      const end = Math.min(start + state.chunkSize, state.file!.size);
      const blob = state.file!.slice(start, end);

      const response = await fetch(partUrl.url, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': 'application/octet-stream' },
      });

      if (!response.ok) throw new Error(`Failed to upload part ${partUrl.partNumber}: ${response.status}`);
      
      const etag = response.headers.get('ETag')?.replace(/"/g, '');
      if (!etag) throw new Error(`Missing ETag for part ${partUrl.partNumber}`);

      // Persist ETag immediately
      await apiRequest('/api/upload/part-complete', {
        method: 'POST',
        body: JSON.stringify({ uploadId: activeUploadId, partNumber: partUrl.partNumber, etag, size: blob.size }),
      });

      return { partNumber: partUrl.partNumber, etag, size: blob.size };
    };

    const processQueue = async (): Promise<void> => {
      while (queue.length > 0 && !hasError) {
        const partUrl = queue.shift()!;
        active.add(partUrl.partNumber);
        
        try {
          const result = await uploadPart(partUrl);
          results.push(result);
          state.uploadedParts.add(partUrl.partNumber);
          updateProgress();
        } catch (e) {
          hasError = true;
          firstError = e instanceof Error ? e : new Error(String(e));
          break;
        } finally {
          active.delete(partUrl.partNumber);
        }
      }
    };

    // Start initial workers
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => processQueue());
    await Promise.all(workers);

    if (hasError) {
      throw firstError!;
    }

    // All parts uploaded successfully, now complete
    await completeUpload(activeUploadId);
  };

  const promptForFile = (): Promise<File | null> => {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.onchange = (e) => {
        resolve((e.target as HTMLInputElement).files?.[0] || null);
      };
      input.click();
    });
  };

  const updateProgress = () => {
    const state = uploadStateRef.current;
    if (!status) return;
    const uploaded = status.parts
      .filter((p: any) => state.uploadedParts.has(p.part_number))
      .reduce((sum: number, p: any) => sum + (p.size || 0), 0);
    const percentage = Math.round((uploaded / status.upload.file_size) * 100);
    
    setStatus(prev => prev ? {
      ...prev,
      progress: { ...prev.progress, uploadedBytes: uploaded, percentage }
    } : null);
  };

  const completeUpload = async (activeUploadId: string) => {
    const state = uploadStateRef.current;
    if (state.completing) return;
    state.completing = true;
    
    if (!activeUploadId) return;
    
    try {
      await apiRequest('/api/upload/complete', {
        method: 'POST',
        body: JSON.stringify({ uploadId: activeUploadId }),
      });

      setCompleted(true);
      setUploading(false);
      const tg = window.Telegram?.WebApp;
      if (tg) tg.close();
    } catch (e) {
      state.completing = false;
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
    uploadStateRef.current = {
      uploadedParts: new Set(),
      totalParts: 0,
      chunkSize: 0,
      file: null,
      completing: false,
    };
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