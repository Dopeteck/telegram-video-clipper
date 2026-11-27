import { Env, TelegramWebhookUpdate, TelegramMessage, TelegramUser, TelegramReplyKeyboardMarkup, TelegramKeyboardButton, TelegramWebAppInfo, ApiResponse, TelegramCallbackQuery, TelegramInlineQuery, TelegramInlineKeyboardButton, TelegramInlineKeyboardMarkup, Job } from './types';
import { validateTelegramInitData, createApiResponse, sanitizeFilename, validateMimeType, validateFileExtension, getExtensionFromMimeType } from './utils';
import { Database } from './db';
import { R2Uploader } from './r2';
import { createProcessingJob } from './api';

const MAIN_KEYBOARD: TelegramReplyKeyboardMarkup = {
  keyboard: [
    [{ text: '🎬 Upload Video', web_app: { url: '' } }],
    [{ text: '📂 My Uploads' }],
    [{ text: '✂️ Edit a Clipped Video' }],
    [{ text: '⚙️ Settings' }],
    [{ text: '❓ Help' }],
  ],
  resize_keyboard: true,
  persistent: true,
  one_time_keyboard: false,
};

const HELP_MESSAGE = `
🎬 <b>Telegram Video Clipper Bot</b>

<b>Main Features:</b>
• Upload long videos directly from your phone
• Videos are stored securely in private Cloudflare R2
• Track upload progress in real-time
• Resume interrupted uploads
• Process videos into clips with Chopify
• Upload rights-cleared B-roll footage for the AI editor
• Send a finished clip to the separate AI editor from Telegram

<b>How to Use:</b>
1. Tap <b>🎬 Upload Video</b> to open the Mini App
2. Select a video from your gallery or record one
3. Watch the upload progress
4. Tap "Start Processing" on completed uploads
5. Type /edit to choose a finished clip for AI editing
6. Receive finished clips in Telegram

<b>Supported Formats:</b> MP4, MOV, MKV, WebM, M4V, AVI
<b>Max File Size:</b> 2 GB

For support, contact the bot administrator.
`;

export function parseUploadAction(action: string): { actionType: 'cancel' | 'retry' | 'process'; uploadId: string } | null {
  const match = action.match(/^upload_(cancel|retry|process)_(.+)$/);
  if (!match) return null;

  const [, actionType, uploadId] = match;
  if (!uploadId) return null;

  return {
    actionType: actionType as 'cancel' | 'retry' | 'process',
    uploadId,
  };
}

const SETTINGS_MESSAGE = `
⚙️ <b>Settings</b>

<b>Default Processing Options:</b>
These will be applied to future video processing jobs.

• <b>Aspect Ratio:</b> 9:16 (vertical for Shorts/Reels/TikTok)
• <b>Caption Style:</b> Default
• <b>Remove Filler Words:</b> Off
• <b>Audio Normalization:</b> Off

<i>Processing features coming in future updates.</i>
`;

export class TelegramBot {
  private db: Database;
  private r2: R2Uploader;
  private botToken: string;
  private webhookSecret: string;
  private workerSecret: string;
  private workerUrl: string;
  private miniappUrl: string;
  private maxUploadBytes: number;
  private chunkSize: number;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    this.botToken = env.TELEGRAM_BOT_TOKEN;
    this.webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
    this.workerSecret = env.WORKER_SECRET;
    this.workerUrl = env.WORKER_URL;
    this.miniappUrl = env.MINIAPP_URL;
    this.maxUploadBytes = parseInt(env.MAX_UPLOAD_BYTES || '2147483648', 10);
    this.chunkSize = parseInt(env.CHUNK_SIZE || '5242880', 10);
    this.db = new Database(env.DB, env);
    this.r2 = new R2Uploader(env);
  }

  async handleWebhook(update: TelegramWebhookUpdate): Promise<ApiResponse> {
    if (update.message) {
      return this.handleMessage(update.message);
    }
    if (update.callback_query) {
      return this.handleCallbackQuery(update.callback_query);
    }
    if (update.inline_query) {
      return this.handleInlineQuery(update.inline_query);
    }
    return createApiResponse(true, { ok: true });
  }

  private async handleMessage(message: TelegramMessage): Promise<ApiResponse> {
    const userId = message.from?.id;
    const chatId = message.chat.id;

    if (!userId) return createApiResponse(false, undefined, 'No user ID');

    await this.upsertUser(message.from!);

    const keyboard = this.getMainKeyboard();

    if (message.text === '/start') {
      return this.sendWelcomeMessage(chatId, userId);
    }

    if (message.text === '/help') {
      return this.sendMessage(chatId, HELP_MESSAGE, { parse_mode: 'HTML', reply_markup: keyboard });
    }

    if (message.text === '/settings') {
      return this.sendMessage(chatId, SETTINGS_MESSAGE, { parse_mode: 'HTML', reply_markup: keyboard });
    }

    if (message.text === '/uploads') {
      return this.showUserUploads(chatId, userId);
    }

    if (message.text === '/edit' || message.text === '✂️ Edit a Clipped Video') {
      return this.showEditableClips(chatId, userId);
    }

    if (message.text === '/whoami') {
      return this.sendMessage(chatId, 'Your Telegram user ID is <code>' + userId + '</code>.', { parse_mode: 'HTML' });
    }

    if (message.text === '/broll' || message.text === '🎞 B-roll Library') {
      return this.showBrollLibrary(chatId, userId);
    }

    if (message.text === '🎬 Upload Video') {
      return this.sendMessage(chatId, 'Tap the button below to upload a video:', { reply_markup: keyboard });
    }

    if (message.text === '📂 My Uploads') {
      return this.showUserUploads(chatId, userId);
    }

    if (message.text === '✂️ Edit a Clipped Video') {
      return this.showEditableClips(chatId, userId);
    }

    if (message.text === '⚙️ Settings') {
      return this.sendMessage(chatId, SETTINGS_MESSAGE, { parse_mode: 'HTML', reply_markup: keyboard });
    }

    if (message.text === '❓ Help') {
      return this.sendMessage(chatId, HELP_MESSAGE, { parse_mode: 'HTML', reply_markup: keyboard });
    }

    if (message.document || message.video) {
      return this.handleMediaUpload(message, userId, chatId);
    }

    return this.sendMessage(chatId, 'Use the buttons below or type /help for instructions.', { reply_markup: keyboard });
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<ApiResponse> {
    const userId = query.from.id;
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const data = query.data;

    if (!chatId || !messageId || !data) {
      return createApiResponse(false, undefined, 'Invalid callback query');
    }

    await this.answerCallbackQuery(query.id);

    switch (data) {
      case 'my_uploads':
        return this.showUserUploads(chatId, userId, messageId);
      case 'settings':
        return this.editMessage(chatId, messageId, SETTINGS_MESSAGE, { parse_mode: 'HTML' });
      case 'help':
        return this.editMessage(chatId, messageId, HELP_MESSAGE, { parse_mode: 'HTML' });
      case 'edit_back':
        return this.showEditableClips(chatId, userId, messageId);
      case 'upload_video':
        return this.sendMessage(chatId, 'Tap the button below to upload a video:', {
          reply_markup: this.getMainKeyboard(),
        });
      default:
        if (data.startsWith('upload_')) {
          return this.handleUploadAction(chatId, messageId, userId, data);
        }
        if (data.startsWith('job_')) {
          return this.handleJobAction(chatId, messageId, userId, data);
        }
        if (data.startsWith('edit_')) {
          return this.handleEditAction(chatId, messageId, userId, data);
        }
    }

    return createApiResponse(true, { ok: true });
  }

  private async handleInlineQuery(query: TelegramInlineQuery): Promise<ApiResponse> {
    return createApiResponse(true, { results: [] });
  }

  private async handleMediaUpload(message: TelegramMessage, userId: number, chatId: number): Promise<ApiResponse> {
    const media = message.document || message.video;
    if (!media) return createApiResponse(false, undefined, 'No media found');

    const fileName = media.file_name || `video_${Date.now()}${getExtensionFromMimeType(media.mime_type || 'video/mp4')}`;
    const mimeType = media.mime_type || 'video/mp4';
    const fileSize = media.file_size || 0;

    if (!validateMimeType(mimeType)) {
      return this.sendMessage(chatId, '❌ Unsupported file type. Please upload MP4, MOV, MKV, WebM, M4V, or AVI files.');
    }

    if (!validateFileExtension(fileName)) {
      return this.sendMessage(chatId, '❌ Unsupported file extension.');
    }

    if (fileSize > this.maxUploadBytes) {
      return this.sendMessage(chatId, `❌ File too large. Maximum size is 2 GB.`);
    }

    if (fileSize === 0) {
      return this.sendMessage(chatId, '❌ Empty file. Please upload a valid video.');
    }

    const uploadId = `upload_${Date.now()}_${userId}`;
    const objectKey = `uploads/${userId}/${uploadId}/${sanitizeFilename(fileName)}`;
    const totalParts = Math.ceil(fileSize / this.chunkSize);

    await this.db.createUpload({
      id: uploadId,
      telegram_user_id: userId,
      telegram_chat_id: chatId,
      original_filename: fileName,
      object_key: objectKey,
      file_size: fileSize,
      mime_type: mimeType,
      status: 'uploading',
    });

    const initResponse = await this.r2.initiateMultipartUpload(objectKey, mimeType, totalParts);
    await this.db.updateUpload(uploadId, { multipart_upload_id: initResponse.uploadId });

    const keyboard = this.getMainKeyboard();
    const uploadButtonKeyboard: TelegramInlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: '🚀 Start Upload', web_app: { url: `${this.miniappUrl}/miniapp/upload?upload_id=${uploadId}` } }],
        [{ text: '❌ Cancel', callback_data: `upload_cancel_${uploadId}` }],
      ],
    };

    return this.sendMessage(chatId, `📤 <b>Upload Ready</b>\n\nFile: <code>${fileName}</code>\nSize: ${this.formatBytes(fileSize)}\n\nTap the button below to start uploading:`, {
      parse_mode: 'HTML',
      reply_markup: uploadButtonKeyboard,
    });
  }

  private async handleUploadAction(chatId: number, messageId: number, userId: number, action: string): Promise<ApiResponse> {
    const parsedAction = parseUploadAction(action);
    if (!parsedAction) {
      return this.editMessage(chatId, messageId, '❌ Invalid upload action.');
    }
    const { actionType, uploadId } = parsedAction;

    const upload = await this.db.getUpload(uploadId);
    if (!upload || upload.telegram_user_id !== userId) {
      return this.editMessage(chatId, messageId, '❌ Upload not found or access denied.');
    }

    switch (actionType) {
      case 'cancel':
        if (upload.multipart_upload_id) {
          await this.r2.abortMultipartUpload(upload.object_key, upload.multipart_upload_id);
        }
        await this.db.updateUpload(uploadId, { status: 'aborted', error_message: 'Cancelled by user' });
        return this.editMessage(chatId, messageId, '❌ Upload cancelled.');
      
      case 'retry':
        if (upload.status !== 'failed' && upload.status !== 'aborted') {
          return this.editMessage(chatId, messageId, '❌ Can only retry failed or cancelled uploads.');
        }
        const totalParts = Math.ceil(upload.file_size / this.chunkSize);
        const initResponse = await this.r2.initiateMultipartUpload(upload.object_key, upload.mime_type, totalParts);
        await this.db.updateUpload(uploadId, { 
          status: 'uploading', 
          multipart_upload_id: initResponse.uploadId,
          error_message: null,
        });
        await this.db.deleteUploadParts(uploadId);
        return this.editMessage(chatId, messageId, `🔄 <b>Upload Ready for Retry</b>\n\nFile: <code>${upload.original_filename}</code>\nSize: ${this.formatBytes(upload.file_size)}\n\nTap the button below to resume:`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 Resume Upload', web_app: { url: `${this.miniappUrl}/miniapp/upload?upload_id=${uploadId}` } }],
              [{ text: '❌ Cancel', callback_data: `upload_cancel_${uploadId}` }],
            ],
          },
        });

      case 'process':
        if (upload.status !== 'uploaded') {
          return this.editMessage(chatId, messageId, '❌ Can only process completed uploads.');
        }
        // Immediately show "Starting..." feedback
        await this.editMessage(chatId, messageId, `⏳ <b>Starting processing...</b>\n\nFile: <code>${upload.original_filename}</code>\n\nDispatching to GitHub Actions...`, {
          parse_mode: 'HTML',
        });
        
        try {
          const job = await createProcessingJob(
            this.env,
            this.db,
            upload.id,
            userId,
            '9:16',
            'default',
            false,
            false
          );
          
          let message = `✅ <b>Processing Started</b>\n\nJob ID: <code>${job.id}</code>\nFile: <code>${upload.original_filename}</code>\n\n`;
          
          if (job.github_run_url) {
            message += `🔗 <a href="${job.github_run_url}">View GitHub Actions Run</a>\n\n`;
          }
          
          message += `You'll receive the clips when processing completes.`;
          
          return this.editMessage(chatId, messageId, message, {
            parse_mode: 'HTML',
            reply_markup: this.getMainKeyboard(),
          });
        } catch (e) {
          return this.editMessage(chatId, messageId, `❌ Failed to start processing: ${e instanceof Error ? e.message : 'Unknown error'}`, {
            reply_markup: this.getMainKeyboard(),
          });
        }
    }

    return createApiResponse(true, { ok: true });
  }

  private async handleJobAction(chatId: number, messageId: number, userId: number, action: string): Promise<ApiResponse> {
    const [, actionType, jobId] = action.split('_');
    
    const db = this.db;
    const job = await db.getJob(jobId);
    if (!job || job.telegram_user_id !== userId) {
      return this.editMessage(chatId, messageId, '❌ Job not found or access denied.');
    }

    switch (actionType) {
      case 'progress':
        return this.editMessage(chatId, messageId, `📊 <b>Job Progress</b>\n\nJob ID: <code>${job.id}</code>\nStatus: ${job.status}\nClips: ${job.clip_count}`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'my_uploads' }]] },
        });

      case 'cancel':
        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
          return this.editMessage(chatId, messageId, '❌ Cannot cancel completed/failed/cancelled job.');
        }
        await db.updateJob(jobId, { status: 'cancelled', error_message: 'Cancelled by user' });
        return this.editMessage(chatId, messageId, '❌ Job cancelled.', { reply_markup: this.getMainKeyboard() });

      case 'retry':
        if (job.status !== 'failed' && job.status !== 'cancelled') {
          return this.editMessage(chatId, messageId, '❌ Can only retry failed or cancelled jobs.');
        }
        await db.updateJob(jobId, { status: 'pending', error_message: null });
        // Dispatch via shared function (avoids external HTTP request)
        try {
          await createProcessingJob(
            this.env,
            this.db,
            job.upload_id,
            userId,
            job.aspect_ratio,
            job.caption_style,
            job.enable_tighten === 1,
            job.enable_loudnorm === 1
          );
        } catch (e) {
          console.error('Failed to dispatch retry workflow:', e);
        }
        return this.editMessage(chatId, messageId, '🔄 Job queued for retry.', { reply_markup: this.getMainKeyboard() });

      case 'download':
        return this.editMessage(chatId, messageId, '📥 Download links would be provided here when clips are ready.', {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'my_uploads' }]] },
        });

      case 'delete':
        return this.editMessage(chatId, messageId, '⚠️ <b>Confirm Delete</b>\n\nThis will permanently delete the job and all associated clips.\n\nAre you sure?', {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Yes, Delete', callback_data: `job_confirm_delete_${jobId}` }],
              [{ text: '❌ No', callback_data: 'my_uploads' }],
            ],
          },
        });

      case 'confirm_delete':
        await db.updateJob(jobId, { status: 'cancelled', error_message: 'Deleted by user' });
        // TODO: Delete clips from R2
        return this.editMessage(chatId, messageId, '🗑️ Job and clips deleted.', { reply_markup: this.getMainKeyboard() });
    }

    return createApiResponse(true, { ok: true });
  }

  private async getCompletedClipKeys(userId: number): Promise<Array<{ jobId: string; key: string; clipIndex: number }>> {
    const jobs = await this.db.getUserJobs(userId, 20, 0);
    const clips: Array<{ jobId: string; key: string; clipIndex: number }> = [];
    for (const job of jobs) {
      if (job.status !== 'completed') continue;
      let keys: string[] = [];
      try {
        keys = job.clips_json ? JSON.parse(job.clips_json) : [];
      } catch {
        console.error(`Invalid clips_json for completed job ${job.id}`);
      }
      if (!Array.isArray(keys) || keys.length === 0) {
        const listed = await this.env.R2_BUCKET.list({ prefix: `jobs/${job.id}/`, limit: 20 });
        keys = listed.objects.map((object) => object.key);
      }
      for (let clipIndex = 0; clipIndex < keys.length; clipIndex++) {
        const key = keys[clipIndex];
        if (typeof key === 'string' && key.startsWith(`jobs/${job.id}/`) &&
            key.split('/').length === 3 && key.toLowerCase().endsWith('.mp4')) {
          clips.push({ jobId: job.id, key, clipIndex });
        }
      }
      if (clips.length >= 10) break;
    }
    return clips.slice(0, 10);
  }

  private async showEditableClips(chatId: number, userId: number, messageId?: number): Promise<ApiResponse> {
    try {
      const clips = await this.getCompletedClipKeys(userId);
      if (clips.length === 0) {
        const message = '✂️ <b>AI Video Editor</b>\\n\\nI could not find any completed clips yet. Process a video first, then return here and type /edit.';
        if (messageId) return this.editMessage(chatId, messageId, message, { parse_mode: 'HTML' });
        return this.sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: this.getMainKeyboard() });
      }
      const keyboard: TelegramInlineKeyboardButton[][] = clips.map((clip, index) => {
        const filename = clip.key.split('/').pop() || 'Finished clip';
        return [{ text: `✂️ ${filename.slice(0, 48)}`, callback_data: `edit_clip_${clip.jobId}_${clip.clipIndex}` }];
      });
      const message = '✂️ <b>Choose a finished clip to edit</b>\\n\\nSelect one of your completed clips. The editor creates a separate edited copy and leaves the original untouched.';
      if (messageId) return this.editMessage(chatId, messageId, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      return this.sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    } catch (error) {
      console.error('Could not list finished clips for editor:', error);
      return this.sendMessage(chatId, '❌ I could not load your finished clips. Please try /edit again in a moment.');
    }
  }

  private async handleEditAction(chatId: number, messageId: number, userId: number, action: string): Promise<ApiResponse> {
    const parts = action.split('_');
    const actionType = parts[1];
    const clipIndex = Number(parts[parts.length - 1]);
    const jobId = parts.slice(2, -1).join('_');
    if (!['clip', 'confirm'].includes(actionType) || !jobId || !Number.isInteger(clipIndex) || clipIndex < 0) {
      return this.editMessage(chatId, messageId, '❌ Invalid editor selection.');
    }

    const job = await this.db.getJob(jobId);
    if (!job || job.telegram_user_id !== userId || job.status !== 'completed') {
      return this.editMessage(chatId, messageId, '❌ This clip is unavailable or does not belong to your account.');
    }

    let keys: string[] = [];
    try { keys = job.clips_json ? JSON.parse(job.clips_json) : []; } catch { keys = []; }
    if (!Array.isArray(keys) || keys.length === 0) {
      const listed = await this.env.R2_BUCKET.list({ prefix: `jobs/${job.id}/`, limit: 20 });
      keys = listed.objects.map((object) => object.key);
    }
    const clipKey = keys[clipIndex];
    if (typeof clipKey !== 'string' || !clipKey.startsWith(`jobs/${job.id}/`) ||
        clipKey.split('/').length !== 3 || !clipKey.toLowerCase().endsWith('.mp4')) {
      return this.editMessage(chatId, messageId, '❌ I could not verify that clip. Please run /edit again.');
    }

    if (actionType === 'clip') {
      const filename = clipKey.split('/').pop() || 'finished clip';
      return this.editMessage(chatId, messageId,
        `<b>Start AI editing?</b>\\n\\nClip: <code>${filename}</code>\\n\\nThe editor will add captions and use matching footage from your rights-cleared B-roll library when suitable. It will not overwrite the original clip.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [{ text: '🚀 Start editing', callback_data: `edit_confirm_${job.id}_${clipIndex}` }],
          [{ text: '🔙 Choose another clip', callback_data: 'edit_back' }],
        ] } });
    }

    await this.editMessage(chatId, messageId, '⏳ <b>Starting the AI editor...</b>\\n\\nYour original clip will remain unchanged.', { parse_mode: 'HTML' });
    const token = this.env.GITHUB_TOKEN;
    const repository = (this.env.EDITOR_GITHUB_REPO || 'Dopeteck/telegram-video-editor').trim();
    if (!token) {
      return this.editMessage(chatId, messageId, '❌ Editor dispatch is not configured. The Worker is missing its GitHub token.');
    }
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/edit-clip.yml/dispatches`, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { clip_key: clipKey, catalog_key: 'broll/catalog.json', whisper_model: 'small' } }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`GitHub returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return this.editMessage(chatId, messageId,
        `✅ <b>AI editing started</b>\\n\\nClip: <code>${clipKey.split('/').pop()}</code>\\nThe editor is now running. When finished, it will send the edited video here in Telegram.\\n\\n<a href="https://github.com/${repository}/actions/workflows/edit-clip.yml">View editor progress</a>`,
        { parse_mode: 'HTML', reply_markup: this.getMainKeyboard() });
    } catch (error) {
      console.error('Editor workflow dispatch failed:', error);
      return this.editMessage(chatId, messageId,
        `❌ <b>Could not start the editor</b>\\n\\n${error instanceof Error ? error.message : 'Unknown GitHub error'}\\n\\nCheck that the Worker GitHub token has Actions write access to ${repository}.`,
        { parse_mode: 'HTML', reply_markup: this.getMainKeyboard() });
    }
  }

  private async showBrollLibrary(chatId: number, userId: number): Promise<ApiResponse> {
    const allowedIds = (this.env.BROLL_ALLOWED_TELEGRAM_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!allowedIds.includes(String(userId))) {
      const text = '🔒 <b>B-roll Library Access</b>\n\nYour Telegram ID: <code>' + userId + '</code>\n\nThe library is restricted to approved administrators. Add this ID to the Cloudflare Worker variable <code>BROLL_ALLOWED_TELEGRAM_USER_IDS</code>, then try /broll again.';
      return this.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: this.getMainKeyboard() });
    }
    return this.sendMessage(chatId, '🎞 <b>B-roll Library</b>\n\nUpload licensed or self-owned footage to the private R2 library. Add its description, tags, source and licence, then confirm the usage rights.', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🎞 Open B-roll Library', web_app: { url: this.miniappUrl + '/miniapp/upload?mode=broll' } }]] },
    });
  }

  private async showUserUploads(chatId: number, userId: number, messageId?: number): Promise<ApiResponse> {
    const uploads = await this.db.getUserUploads(userId, 10);
    
    if (uploads.length === 0) {
      const text = '📂 <b>My Uploads</b>\n\nNo uploads yet. Tap "🎬 Upload Video" to get started!';
      if (messageId) {
        return this.editMessage(chatId, messageId, text, { parse_mode: 'HTML' });
      }
      return this.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }

    let text = '📂 <b>My Uploads</b>\n\n';
    const keyboard: TelegramInlineKeyboardButton[][] = [];

    for (const upload of uploads) {
      const statusEmoji = this.getStatusEmoji(upload.status);
      text += `${statusEmoji} <code>${upload.original_filename}</code> — ${this.formatBytes(upload.file_size)} — ${this.formatDate(upload.created_at)}\n`;
      
      if (upload.status === 'uploading' || upload.status === 'failed' || upload.status === 'aborted') {
        keyboard.push([
          { text: `🔄 ${upload.original_filename.substring(0, 20)}`, callback_data: `upload_retry_${upload.id}` },
          { text: '❌', callback_data: `upload_cancel_${upload.id}` },
        ]);
      } else if (upload.status === 'uploaded') {
        keyboard.push([
          { text: `▶️ Process ${upload.original_filename.substring(0, 20)}`, callback_data: `upload_process_${upload.id}` },
          { text: '❌', callback_data: `upload_cancel_${upload.id}` },
        ]);
      }
    }

    keyboard.push([{ text: '🎬 Upload New Video', callback_data: 'upload_video' }]);

    if (messageId) {
      return this.editMessage(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    }
    return this.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  }

  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'uploading': return '📤';
      case 'uploaded': return '✅';
      case 'aborted': return '❌';
      case 'expired': return '⏰';
      case 'failed': return '💥';
      default: return '❓';
    }
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private async upsertUser(user: TelegramUser): Promise<void> {
    await this.db.createUser({
      telegram_user_id: user.id,
      first_name: user.first_name,
      last_name: user.last_name ?? null,
      username: user.username ?? null,
      language_code: user.language_code ?? null,
      preferred_aspect_ratio: '9:16',
      preferred_caption_style: 'default',
      enable_tighten: 0,
      enable_loudnorm: 0,
    });
  }

  private async sendWelcomeMessage(chatId: number, userId: number): Promise<ApiResponse> {
    const text = `👋 Welcome to <b>Telegram Video Clipper</b>!\n\nUpload long videos from your phone and get them ready for Shorts, Reels, and TikTok.\n\n<i>Powered by Chopify — 100% local, free video clipping.</i>`;
    return this.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: this.getMainKeyboard() });
  }

  private getMainKeyboard(): TelegramReplyKeyboardMarkup {
    return {
      keyboard: [
        [{ text: '🎬 Upload Video', web_app: { url: `${this.miniappUrl}/miniapp/upload` } }],
        [{ text: '📂 My Uploads' }],
        [{ text: '🎞 B-roll Library', web_app: { url: this.miniappUrl + '/miniapp/upload?mode=broll' } }],
        [{ text: '⚙️ Settings' }],
        [{ text: '❓ Help' }],
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false,
    };
  }

  private async sendMessage(chatId: number, text: string, options: Record<string, unknown> = {}): Promise<ApiResponse> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...options }),
    });
    const data = await response.json() as { ok: boolean; description?: string };
    return createApiResponse(data.ok, data, data.description);
  }

  private async editMessage(chatId: number, messageId: number, text: string, options: Record<string, unknown> = {}): Promise<ApiResponse> {
    const url = `https://api.telegram.org/bot${this.botToken}/editMessageText`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...options }),
    });
    const data = await response.json() as { ok: boolean; description?: string };
    return createApiResponse(data.ok, data, data.description);
  }

  private async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<ApiResponse> {
    const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    const data = await response.json() as { ok: boolean; description?: string };
    return createApiResponse(data.ok, data, data.description);
  }

  async setWebhook(url: string): Promise<ApiResponse> {
    const webhookUrl = `${url}/telegram/webhook`;
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: this.webhookSecret }),
    });
    const data = await response.json() as { ok: boolean; description?: string };
    return createApiResponse(data.ok, data, data.description);
  }

  async deleteWebhook(): Promise<ApiResponse> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/deleteWebhook`, { method: 'POST' });
    const data = await response.json() as { ok: boolean; description?: string };
    return createApiResponse(data.ok, data, data.description);
  }

  async setMyCommands(): Promise<ApiResponse> {
    const commands = [
      { command: 'start', description: 'Start the bot and show main menu' },
      { command: 'help', description: 'Show help message' },
      { command: 'settings', description: 'Configure processing preferences' },
      { command: 'uploads', description: 'View your upload history' },
      { command: 'edit', description: 'Edit one of your finished clips' },
      { command: 'broll', description: 'Upload footage to the B-roll library' },
      { command: 'whoami', description: 'Show your Telegram user ID' },
    ];
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const data = await response.json() as { ok: boolean; description?: string };
    return createApiResponse(data.ok, data, data.description);
  }

  async setMenuButton(): Promise<ApiResponse> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: '🎬 Upload Video',
          web_app: { url: `${this.miniappUrl}/miniapp/upload` },
        },
      }),
    });
    const data = await response.json() as { ok: boolean; description?: string };
    return createApiResponse(data.ok, data, data.description);
  }
}