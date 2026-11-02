import React from 'react';

const HelpScreen: React.FC = () => {
  return (
    <div>
      <div className="card">
        <h2 className="card-title">How to Use</h2>
        <div className="help-section">
          <h3 className="help-title">🎬 Upload Video</h3>
          <p className="help-text">Tap the "Upload Video" button or navigate to the Upload tab. Select a video from your gallery or record a new one.</p>
        </div>
        <div className="help-section">
          <h3 className="help-title">📤 Direct Upload</h3>
          <p className="help-text">Videos upload directly from your phone to Cloudflare R2 storage using multipart uploads. This means:</p>
          <ul className="help-list">
            <li>Large files (up to 2 GB) are split into chunks</li>
            <li>Uploads can resume if interrupted</li>
            <li>Real-time progress tracking</li>
            <li>No video data passes through our servers</li>
          </ul>
        </div>
        <div className="help-section">
          <h3 className="help-title">📂 My Uploads</h3>
          <p className="help-text">View all your uploaded videos with their status. Failed or cancelled uploads can be retried with one tap.</p>
        </div>
        <div className="help-section">
          <h3 className="help-title">⚙️ Settings</h3>
          <p className="help-text">Configure default processing options like filler word removal and audio normalization for future video processing.</p>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Supported Formats</h2>
        <ul className="help-list">
          <li>MP4 (.mp4)</li>
          <li>MOV (.mov)</li>
          <li>MKV (.mkv)</li>
          <li>WebM (.webm)</li>
          <li>M4V (.m4v)</li>
          <li>AVI (.avi)</li>
        </ul>
        <p className="help-text" style={{ marginTop: 12 }}>
          <strong>Maximum file size:</strong> 2 GB<br />
          <strong>Maximum duration:</strong> No limit (within file size)
        </p>
      </div>

      <div className="card">
        <h2 className="card-title">Upload Tips</h2>
        <ul className="help-list">
          <li>Use Wi-Fi for large uploads to avoid mobile data charges</li>
          <li>Keep the Mini App open during upload for best reliability</li>
          <li>If upload fails, tap "Retry" — it resumes from where it left off</li>
          <li>Cancelled uploads can be restarted from the "My Uploads" screen</li>
        </ul>
      </div>

      <div className="card">
        <h2 className="card-title">Privacy & Security</h2>
        <ul className="help-list">
          <li>Videos are stored in private Cloudflare R2 buckets</li>
          <li>Only you can access your uploads</li>
          <li>No video content is analyzed or processed without your consent</li>
          <li>Upload sessions expire after 24 hours</li>
          <li>You can delete uploads at any time</li>
        </ul>
      </div>

      <div className="card">
        <h2 className="card-title">Troubleshooting</h2>
        <div className="help-section">
          <h4 style={{ fontWeight: 600, marginBottom: 8 }}>Upload fails immediately</h4>
          <p className="help-text">Check your internet connection. Try switching between Wi-Fi and mobile data.</p>
        </div>
        <div className="help-section">
          <h4 style={{ fontWeight: 600, marginBottom: 8 }}>Upload stalls at a certain percentage</h4>
          <p className="help-text">This is usually a network issue. Tap "Cancel" then "Resume" to retry the remaining chunks.</p>
        </div>
        <div className="help-section">
          <h4 style={{ fontWeight: 600, marginBottom: 8 }}>File too large error</h4>
          <p className="help-text">Maximum file size is 2 GB. Compress your video or trim it before uploading.</p>
        </div>
        <div className="help-section">
          <h4 style={{ fontWeight: 600, marginBottom: 8 }}>Unsupported format</h4>
          <p className="help-text">Convert your video to MP4, MOV, MKV, WebM, M4V, or AVI format.</p>
        </div>
      </div>

      <div className="card" style={{ textAlign: 'center' }}>
        <h2 className="card-title">Need More Help?</h2>
        <p className="help-text" style={{ marginBottom: 16 }}>
          Contact the bot administrator or check the GitHub repository for updates.
        </p>
        <button className="btn btn-secondary" onClick={() => window.open('https://github.com/Dopeteck/telegram-video-clipper', '_blank')}>
          View on GitHub
        </button>
      </div>
    </div>
  );
};

export default HelpScreen;