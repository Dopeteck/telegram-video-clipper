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
  chunkSize: number;
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
  mode?: 'video' | 'broll';
  onNavigate: (screen: Screen) => void;
}

const UploadScreen: React.FC<Props> = ({ apiBaseUrl, initData, uploadId: initialUploadId, mode = 'video', onNavigate }) => {
  const isBrollMode = mode === 'broll';
  const [uploadId, setUploadId] = useState<string | null>(initialUploadId);
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeImporting, setYoutubeImporting] = useState(false);
  const [brollDescription, setBrollDescription] = useState('');
  const [brollTags, setBrollTags] = useState('');
  const [brollSourceUrl, setBrollSourceUrl] = useState('');
  const [brollLicense, setBrollLicense] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [brollPublishing, setBrollPublishing] = useState(false);
  const [brollPublished, setBrollPublished] = useState(false);
  
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

  const importYouTubeVideo = async () => {
    const url = youtubeUrl.trim();
    if (!url) {
      setError('Paste a YouTube video link first.');
      return;
    }

    setYoutubeImporting(true);
    setError(null);
    try {
      await apiRequest('/api/youtube/import', {
        method: 'POST',
        body: JSON.stringify({ url, aspectRatio: '9:16' }),
      });
      setYoutubeUrl('');
      onNavigate('uploads');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import YouTube video');
    } finally {
      setYoutubeImporting(false);
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
      const data = await apiRequest(isBrollMode ? '/api/broll/upload/initiate' : '/api/upload/initiate', {
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
      const chunkSize = Number(currentStatus.chunkSize) || 5242880;
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
      if (tg && !isBrollMode) tg.close();
    } catch (e) {
      state.completing = false;
      setError(e instanceof Error ? e.message : 'Failed to complete upload');
      setUploading(false);
    }
  };

  const publishBroll = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!uploadId) {
      setError('Missing uploaded B-roll file. Please start the upload again.');
      return;
    }
    const tags = [...new Set(brollTags.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
    if (!rightsConfirmed) {
      setError('Please confirm that you checked the footage usage rights.');
      return;
    }
    if (tags.length === 0) {
      setError('Add at least one tag, separated by commas.');
      return;
    }

    setBrollPublishing(true);
    setError(null);
    try {
      await apiRequest('/api/broll/publish', {
        method: 'POST',
        body: JSON.stringify({
          uploadId,
          description: brollDescription,
          tags,
          source_url: brollSourceUrl,
          license: brollLicense,
          rights_confirmed: true,
        }),
      });
      setBrollPublished(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add B-roll to the library');
    } finally {
      setBrollPublishing(false);
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

  if (completed && isBrollMode) {
    if (brollPublished) {
      return (
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
          <h2 style={{ marginBottom: 8 }}>B-roll added to your library!</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
            The footage is now registered in broll/catalog.json and can be selected by the AI editor when it matches a clip.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Upload another B-roll
          </button>
        </div>
      );
    }

    return (
      <div className="card">
        <div style={{ fontSize: 36, marginBottom: 12, textAlign: 'center' }}>✅</div>
        <h2 className="card-title">B-roll uploaded — add its details</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
          Your file is safely in R2 staging. Add accurate information so the AI editor can find the right shot. It will not enter the library until you confirm the rights.
        </p>
        <form onSubmit={publishBroll}>
          <label className="form-label" htmlFor="brollDescription">What is visibly happening in this footage?</label>
          <textarea
            id="brollDescription"
            value={brollDescription}
            onChange={(e) => setBrollDescription(e.target.value)}
            placeholder="Example: Close-up of a person scrolling through a social media feed on a smartphone."
            maxLength={500}
            minLength={12}
            required
            rows={4}
            style={{ width: '100%', marginBottom: 14 }}
          />
          <label className="form-label" htmlFor="brollTags">Tags (comma-separated)</label>
          <input
            id="brollTags"
            value={brollTags}
            onChange={(e) => setBrollTags(e.target.value)}
            placeholder="technology, smartphone, social media, scrolling"
            required
            style={{ width: '100%', marginBottom: 14 }}
          />
          <label className="form-label" htmlFor="brollSourceUrl">Original source webpage</label>
          <input
            id="brollSourceUrl"
            type="url"
            value={brollSourceUrl}
            onChange={(e) => setBrollSourceUrl(e.target.value)}
            placeholder="https://www.pexels.com/video/..."
            required
            style={{ width: '100%', marginBottom: 14 }}
          />
          <label className="form-label" htmlFor="brollLicense">Licence or permission</label>
          <input
            id="brollLicense"
            value={brollLicense}
            onChange={(e) => setBrollLicense(e.target.value)}
            placeholder="Pexels License — commercial use permitted"
            minLength={8}
            maxLength={300}
            required
            style={{ width: '100%', marginBottom: 14 }}
          />
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '8px 0 18px', fontSize: 13, lineHeight: 1.45 }}>
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(e) => setRightsConfirmed(e.target.checked)}
              required
              style={{ marginTop: 3 }}
            />
            I have checked the original licence or permission and confirm that it allows the intended commercial video-editing use.
          </label>
          <button className="btn btn-primary" type="submit" disabled={brollPublishing}>
            {brollPublishing ? 'Adding to library...' : '✅ Confirm and add to B-roll library'}
          </button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

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
        {!isBrollMode && <h2 className="card-title">Import from YouTube</h2>}
        {!isBrollMode && <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
          Paste a public YouTube video link. The video will be sent to the clipping workflow for processing.
        </p>}
        {!isBrollMode && <>
          <input
            type="url"
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            aria-label="YouTube video URL"
            autoComplete="off"
            disabled={youtubeImporting}
            style={{ width: '100%', marginBottom: 12 }}
          />
          <button className="btn btn-primary" onClick={importYouTubeVideo} disabled={youtubeImporting || !youtubeUrl.trim()}>
            {youtubeImporting ? 'Importing video...' : '▶ Import YouTube Video'}
          </button>
          {error && <div className="error">{error}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0', color: 'var(--text-secondary)', fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border-color, #ddd)' }} />
          OR UPLOAD A FILE
            <div style={{ flex: 1, height: 1, background: 'var(--border-color, #ddd)' }} />
          </div>
        </>}
        <h2 className="card-title">{isBrollMode ? 'Upload B-roll footage' : 'Upload Video'}</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
          {isBrollMode
            ? 'Select a background or cutaway video. It will upload directly to your B-roll library in Cloudflare R2.'
            : 'Select a video from your device to upload it directly to secure cloud storage.'}
        </p>
        <input
          type="file"
          accept={isBrollMode
            ? '.mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm'
            : 'video/*'}
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          id="fileInput"
          ref={(el) => { if (el) el.click(); }}
        />
        <label htmlFor="fileInput" className="btn btn-primary">
          {isBrollMode ? '📁 Choose B-roll footage' : '📁 Choose Video'}
        </label>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12, textAlign: 'center' }}>
          {isBrollMode ? 'B-roll formats: MP4, MOV, MKV, WebM • Max 2 GB' : 'Supported: MP4, MOV, MKV, WebM, M4V, AVI • Max 2 GB'}
        </p>
      </div>
    );
  }

  if (file && !uploadId) {
    return (
      <div className="card">
        <h2 className="card-title">{isBrollMode ? 'Ready to add B-roll' : 'Ready to Upload'}</h2>
        <div className="file-info">
          <div className="file-name">{file.name}</div>
          <div className="file-meta">
            {formatBytes(file.size)} • {file.type || 'video/mp4'}
          </div>
        </div>
        <button className="btn btn-primary" onClick={initiateUpload} disabled={uploading}>
          {uploading ? 'Preparing...' : isBrollMode ? '🚀 Upload B-roll to R2' : '🚀 Start Upload'}
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