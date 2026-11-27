import { useCallback, useEffect, useState } from 'react';

interface PartUrl {
  partNumber: number;
  url: string;
}

interface BrollAsset {
  id: string;
  key: string;
  description: string;
  tags: string[];
  source_url: string;
  license: string;
  rights_verified: boolean;
}

interface Props {
  apiBaseUrl: string;
  initData: string;
}

const BrollLibraryScreen: React.FC<Props> = ({ apiBaseUrl, initData }) => {
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [licence, setLicence] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [assets, setAssets] = useState<BrollAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const apiRequest = useCallback(async (endpoint: string, options: RequestInit = {}) => {
    const response = await fetch(apiBaseUrl + endpoint, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + initData,
        ...options.headers,
      },
    });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('Server error (' + response.status + '). Please try again.');
    }
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Request failed (' + response.status + ')');
    return data.data;
  }, [apiBaseUrl, initData]);

  const refreshCatalogue = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest('/api/broll/catalog');
      setAssets(Array.isArray(data.assets) ? data.assets : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load B-roll catalogue');
    } finally {
      setLoading(false);
    }
  }, [apiRequest]);

  useEffect(() => { refreshCatalogue(); }, [refreshCatalogue]);

  const guessedMimeType = (selected: File) => {
    if (selected.type) return selected.type;
    const extension = selected.name.toLowerCase().split('.').pop();
    const types: Record<string, string> = {
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
      webm: 'video/webm',
    };
    return types[extension || ''] || 'application/octet-stream';
  };

  const upload = async () => {
    setError(null);
    setSuccess(null);
    if (!file) return setError('Choose a video file first.');
    if (!description.trim()) return setError('Add a short description of what the footage actually shows.');
    if (!sourceUrl.trim()) return setError('Add the original asset/source page URL.');
    if (!/^https?:\/\//i.test(sourceUrl.trim())) return setError('The source URL must begin with http:// or https://.');
    if (!licence.trim()) return setError('Record the licence or permission for this footage.');
    if (!rightsConfirmed) return setError('Confirm that you own this footage or have checked the specific licence.');

    setUploading(true);
    setProgress(0);
    let session: { key: string; uploadId: string } | null = null;
    try {
      const started = await apiRequest('/api/broll/upload/initiate', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, fileSize: file.size, mimeType: guessedMimeType(file) }),
      });
      session = { key: started.key, uploadId: started.uploadId };

      const queue = [...(started.partUrls as PartUrl[])];
      const completed: Array<{ partNumber: number; etag: string }> = [];
      let cursor = 0;
      let uploadedBytes = 0;
      const chunkSize = Number(started.chunkSize);

      const worker = async () => {
        while (true) {
          const part = queue[cursor++];
          if (!part) return;
          const start = (part.partNumber - 1) * chunkSize;
          const blob = file.slice(start, Math.min(start + chunkSize, file.size));
          const response = await fetch(part.url, {
            method: 'PUT',
            body: blob,
            headers: { 'Content-Type': 'application/octet-stream' },
          });
          if (!response.ok) throw new Error('R2 upload failed on part ' + part.partNumber + ' (' + response.status + ').');
          const etag = response.headers.get('ETag')?.replace(/"/g, '');
          if (!etag) throw new Error('R2 did not return an ETag for part ' + part.partNumber + '. Check the bucket CORS rules.');
          completed.push({ partNumber: part.partNumber, etag });
          uploadedBytes += blob.size;
          setProgress(Math.min(99, Math.round((uploadedBytes / file.size) * 100)));
        }
      };

      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
      completed.sort((a, b) => a.partNumber - b.partNumber);

      const result = await apiRequest('/api/broll/upload/complete', {
        method: 'POST',
        body: JSON.stringify({
          key: session.key,
          uploadId: session.uploadId,
          fileSize: file.size,
          filename: file.name,
          parts: completed,
          description: description.trim(),
          tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
          sourceUrl: sourceUrl.trim(),
          licence: licence.trim(),
          rightsConfirmed,
        }),
      });

      setProgress(100);
      setSuccess('Added to your B-roll library. ' + result.assetCount + ' asset(s) are now indexed.');
      setAssets((current) => [...current, result.asset as BrollAsset]);
      setFile(null);
      setDescription('');
      setTags('');
      setSourceUrl('');
      setLicence('');
      setRightsConfirmed(false);
      const input = document.getElementById('broll-file-input') as HTMLInputElement | null;
      if (input) input.value = '';
    } catch (e) {
      if (session) {
        try {
          await apiRequest('/api/broll/upload/abort', {
            method: 'POST',
            body: JSON.stringify(session),
          });
        } catch { /* The multipart upload may already have completed. */ }
      }
      setError(e instanceof Error ? e.message : 'B-roll upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, index)).toFixed(1) + ' ' + units[index];
  };

  return (
    <div className="card">
      <h2 className="card-title">🎞 B-roll Library</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
        Upload footage to the private Cloudflare R2 library used by the AI editor. Files upload directly from this Mini App, so Telegram's 20 MB bot-download limit does not apply.
      </p>

      {error && <div className="error-message" role="alert">{error}</div>}
      {success && <div className="success-message" role="status">{success}</div>}

      <label style={{ display: 'block', marginBottom: 12, fontWeight: 600 }}>
        Video file (MP4, MOV, MKV or WebM)
        <input
          id="broll-file-input"
          type="file"
          accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
          onChange={(event) => setFile(event.target.files?.[0] || null)}
          disabled={uploading}
          style={{ display: 'block', width: '100%', marginTop: 8 }}
        />
      </label>
      {file && <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>{file.name} · {formatBytes(file.size)}</p>}

      <label style={{ display: 'block', marginBottom: 12, fontWeight: 600 }}>
        What does this footage show?
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={3} disabled={uploading} placeholder="Example: close-up of a hand scrolling through a social media feed" style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8 }} />
      </label>

      <label style={{ display: 'block', marginBottom: 12, fontWeight: 600 }}>
        Search tags (comma-separated)
        <input value={tags} onChange={(event) => setTags(event.target.value)} disabled={uploading} placeholder="technology, smartphone, social media" style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8 }} />
      </label>

      <label style={{ display: 'block', marginBottom: 12, fontWeight: 600 }}>
        Original source / asset page URL
        <input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} disabled={uploading} placeholder="https://www.pexels.com/video/..." style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8 }} />
      </label>

      <label style={{ display: 'block', marginBottom: 12, fontWeight: 600 }}>
        Licence / permission details
        <textarea value={licence} onChange={(event) => setLicence(event.target.value)} maxLength={500} rows={2} disabled={uploading} placeholder="Pexels License — commercial use checked; item restrictions checked" style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8 }} />
      </label>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '16px 0', fontWeight: 500 }}>
        <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} disabled={uploading} style={{ marginTop: 3 }} />
        I own this footage or have checked that its specific licence permits the intended commercial editing use.
      </label>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={upload} disabled={uploading || loading}>
          {uploading ? 'Uploading ' + progress + '%...' : 'Upload to B-roll Library'}
        </button>
        <button className="btn btn-secondary" onClick={refreshCatalogue} disabled={uploading || loading}>
          Refresh
        </button>
      </div>

      {uploading && (
        <div style={{ marginTop: 14, background: 'var(--border-color, #ddd)', borderRadius: 10, overflow: 'hidden', height: 8 }}>
          <div style={{ width: progress + '%', height: '100%', background: 'var(--primary-color, #3487d5)', transition: 'width .2s' }} />
        </div>
      )}

      <section style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 10 }}>Library contents ({assets.length})</h3>
        {loading ? <p>Loading library...</p> : assets.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No B-roll assets yet.</p> : (
          <div style={{ display: 'grid', gap: 10 }}>
            {assets.slice().reverse().map((asset) => (
              <article key={asset.id} style={{ padding: 12, border: '1px solid var(--border-color, #ddd)', borderRadius: 10 }}>
                <strong>{asset.description}</strong>
                <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 5 }}>{asset.tags.join(' · ')}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 5 }}>{asset.key}</div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default BrollLibraryScreen;
