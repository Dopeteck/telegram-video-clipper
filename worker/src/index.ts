import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import { api } from './api';
import { TelegramBot } from './bot';
import { Database } from './db';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: ['https://*.telegram.org', 'https://web.telegram.org', 'https://telegram.org'],
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

app.route('/api', api);

app.post('/telegram/webhook', async (c) => {
  const secretToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (secretToken !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ ok: false, error: 'Invalid webhook secret' }, 401);
  }

  const update = await c.req.json();
  const bot = new TelegramBot(c.env);
  const result = await bot.handleWebhook(update);
  return c.json(result);
});

app.get('/telegram/setup', async (c) => {
  const bot = new TelegramBot(c.env);
  const webhookResult = await bot.setWebhook(c.env.APP_ORIGIN);
  const commandsResult = await bot.setMyCommands();
  const menuResult = await bot.setMenuButton();
  return c.json({ webhook: webhookResult, commands: commandsResult, menu: menuResult });
});

app.get('/upload', async (c) => {
  const uploadId = c.req.query('upload_id');
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upload Video</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; flex-direction: column; }
    .header { background: #0088cc; color: white; padding: 16px; text-align: center; font-weight: 600; }
    .container { flex: 1; padding: 16px; max-width: 480px; margin: 0 auto; width: 100%; }
    .file-info { background: white; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .file-name { font-weight: 600; margin-bottom: 8px; word-break: break-all; }
    .file-meta { color: #666; font-size: 14px; }
    .progress-container { background: white; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .progress-bar { height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden; margin: 12px 0; }
    .progress-fill { height: 100%; background: #0088cc; border-radius: 4px; transition: width 0.3s ease; width: 0%; }
    .progress-text { display: flex; justify-content: space-between; font-size: 14px; color: #666; }
    .status { text-align: center; padding: 12px; font-weight: 500; }
    .status.uploading { color: #0088cc; }
    .status.completed { color: #4caf50; }
    .status.failed { color: #f44336; }
    .btn { width: 100%; padding: 14px; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 16px; }
    .btn-primary { background: #0088cc; color: white; }
    .btn-primary:disabled { background: #90caf9; }
    .btn-secondary { background: #fff; color: #0088cc; border: 2px solid #0088cc; }
    .btn-danger { background: #fff; color: #f44336; border: 2px solid #f44336; }
    .error { background: #ffebee; color: #c62828; padding: 12px; border-radius: 8px; margin-top: 12px; display: none; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="header">Upload Video</div>
  <div class="container">
    <div class="file-info" id="fileInfo" style="display: none;">
      <div class="file-name" id="fileName"></div>
      <div class="file-meta" id="fileMeta"></div>
    </div>
    <div class="progress-container" id="progressContainer" style="display: none;">
      <div class="status uploading" id="status">Preparing upload...</div>
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div class="progress-text">
        <span id="uploadedText">0 MB</span>
        <span id="percentageText">0%</span>
      </div>
    </div>
    <button class="btn btn-primary" id="startBtn" onclick="startUpload()" style="display: none;">Start Upload</button>
    <button class="btn btn-primary" id="resumeBtn" onclick="resumeUpload()" class="hidden">Resume Upload</button>
    <button class="btn btn-danger" id="cancelBtn" onclick="cancelUpload()" class="hidden">Cancel Upload</button>
    <div class="error" id="error"></div>
  </div>
  <script>
    const tg = window.Telegram.WebApp;
    tg.expand();
    tg.ready();

    const urlParams = new URLSearchParams(window.location.search);
    const uploadId = urlParams.get('upload_id');
    const initData = tg.initData;

    let uploadInfo = null;
    let abortController = null;
    let uploadedParts = new Set();
    let totalParts = 0;
    let chunkSize = 0;
    let file = null;

    async function apiRequest(endpoint, options = {}) {
      const response = await fetch(endpoint, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + initData,
          ...options.headers,
        },
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Request failed');
      return data.data;
    }

    async function loadUploadInfo() {
      if (!uploadId) {
        showError('No upload ID provided');
        return;
      }
      try {
        uploadInfo = await apiRequest('/api/upload/status/' + uploadId);
        displayFileInfo();
        if (uploadInfo.upload.status === 'uploading') {
          await resumeUpload();
        } else if (uploadInfo.upload.status === 'uploaded') {
          showCompleted();
        } else if (uploadInfo.upload.status === 'failed' || uploadInfo.upload.status === 'aborted') {
          showRetry();
        }
      } catch (e) {
        showError(e.message);
      }
    }

    function displayFileInfo() {
      document.getElementById('fileName').textContent = uploadInfo.upload.original_filename;
      document.getElementById('fileMeta').textContent = formatBytes(uploadInfo.upload.file_size) + ' • ' + uploadInfo.upload.mime_type;
      document.getElementById('fileInfo').style.display = 'block';
    }

    async function startUpload() {
      if (!uploadId) return;
      try {
        const init = await apiRequest('/api/upload/initiate', {
          method: 'POST',
          body: JSON.stringify({
            filename: uploadInfo.upload.original_filename,
            fileSize: uploadInfo.upload.file_size,
            mimeType: uploadInfo.upload.mime_type,
          }),
        });
        uploadInfo = init;
        totalParts = init.totalParts;
        chunkSize = init.chunkSize;
        await pickFileAndUpload(init.partUrls);
      } catch (e) {
        showError(e.message);
      }
    }

    async function resumeUpload() {
      if (!uploadId) return;
      try {
        uploadInfo = await apiRequest('/api/upload/status/' + uploadId);
        if (!uploadInfo.upload.multipart_upload_id) {
          showError('Upload session expired');
          return;
        }
        totalParts = Math.ceil(uploadInfo.upload.file_size / uploadInfo.progress.uploadedBytes * uploadInfo.parts.filter(p => p.etag).length) || 
                     Math.ceil(uploadInfo.upload.file_size / (parseInt(document.getElementById('chunkSize')?.value) || 5242880));
        
        uploadedParts = new Set(uploadInfo.parts.filter(p => p.etag).map(p => p.part_number));
        
        const missingParts = [];
        for (let i = 1; i <= totalParts; i++) {
          if (!uploadedParts.has(i)) missingParts.push(i);
        }
        
        if (missingParts.length === 0) {
          await completeUpload();
          return;
        }

        const partUrls = await apiRequest('/api/upload/part-urls', {
          method: 'POST',
          body: JSON.stringify({ uploadId, partNumbers: missingParts.slice(0, 3) }),
        });
        
        await pickFileAndUpload(partUrls.partUrls);
      } catch (e) {
        showError(e.message);
      }
    }

    async function pickFileAndUpload(partUrls) {
      document.getElementById('startBtn').classList.add('hidden');
      document.getElementById('resumeBtn').classList.add('hidden');
      document.getElementById('cancelBtn').classList.remove('hidden');
      document.getElementById('progressContainer').style.display = 'block';
      document.getElementById('status').textContent = 'Select video file...';

      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*';
        input.onchange = async (e) => {
          file = e.target.files[0];
          if (!file) {
            reject(new Error('No file selected'));
            return;
          }
          if (file.size !== uploadInfo.upload.file_size) {
            showError('File size mismatch. Please select the same file.');
            reject(new Error('File size mismatch'));
            return;
          }
          await uploadParts(partUrls);
          resolve();
        };
        input.click();
      });
    }

    async function uploadParts(partUrls) {
      abortController = new AbortController();
      const concurrency = 3;
      const queue = [...partUrls];
      const active = new Set();

      const uploadPart = async (partUrl) => {
        const start = (partUrl.partNumber - 1) * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const blob = file.slice(start, end);

        const response = await fetch(partUrl.url, {
          method: 'PUT',
          body: blob,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal: abortController.signal,
        });

        if (!response.ok) throw new Error('Failed to upload part ' + partUrl.partNumber);
        
        const etag = response.headers.get('ETag')?.replace(/"/g, '');
        if (!etag) throw new Error('Missing ETag for part ' + partUrl.partNumber);

        uploadedParts.add(partUrl.partNumber);
        updateProgress();

        if (queue.length > 0) {
          await uploadPart(queue.shift()!);
        } else if (active.size === 0 && uploadedParts.size === totalParts) {
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
    }

    async function completeUpload() {
      document.getElementById('status').textContent = 'Finalizing...';
      document.getElementById('status').className = 'status uploading';
      
      const parts = Array.from(uploadedParts).sort((a, b) => a - b).map(partNumber => {
        const part = uploadInfo.parts.find(p => p.part_number === partNumber);
        return { partNumber, etag: part?.etag || '' };
      });

      try {
        await apiRequest('/api/upload/complete', {
          method: 'POST',
          body: JSON.stringify({ uploadId, parts }),
        });
        showCompleted();
      } catch (e) {
        showError(e.message);
        document.getElementById('cancelBtn').classList.remove('hidden');
        document.getElementById('resumeBtn').classList.remove('hidden');
      }
    }

    async function cancelUpload() {
      if (abortController) abortController.abort();
      try {
        await apiRequest('/api/upload/abort', {
          method: 'POST',
          body: JSON.stringify({ uploadId }),
        });
      } catch (e) {}
      showError('Upload cancelled');
      document.getElementById('cancelBtn').classList.add('hidden');
      document.getElementById('resumeBtn').classList.remove('hidden');
    }

    function updateProgress() {
      const uploaded = uploadInfo.parts
        .filter(p => uploadedParts.has(p.part_number))
        .reduce((sum, p) => sum + (p.size || 0), 0);
      const percentage = Math.round((uploaded / uploadInfo.upload.file_size) * 100);
      
      document.getElementById('progressFill').style.width = percentage + '%';
      document.getElementById('percentageText').textContent = percentage + '%';
      document.getElementById('uploadedText').textContent = formatBytes(uploaded);
      document.getElementById('status').textContent = 'Uploading... ' + percentage + '%';
    }

    function showCompleted() {
      document.getElementById('status').textContent = '✅ Upload completed successfully!';
      document.getElementById('status').className = 'status completed';
      document.getElementById('progressFill').style.width = '100%';
      document.getElementById('percentageText').textContent = '100%';
      document.getElementById('cancelBtn').classList.add('hidden');
      document.getElementById('resumeBtn').classList.add('hidden');
      tg.close();
    }

    function showRetry() {
      document.getElementById('status').textContent = 'Upload failed. Tap to retry.';
      document.getElementById('status').className = 'status failed';
      document.getElementById('cancelBtn').classList.add('hidden');
      document.getElementById('resumeBtn').classList.remove('hidden');
    }

    function showError(message) {
      const errorEl = document.getElementById('error');
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    loadUploadInfo();
  </script>
</body>
</html>
  `;
  return c.html(html);
});

app.get('*', (c) => {
  return c.notFound();
});

export default app;