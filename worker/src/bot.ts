import { Env, TelegramWebhookUpdate, TelegramMessage, TelegramUser, TelegramInlineKeyboardMarkup, TelegramInlineKeyboardButton, TelegramWebAppInfo, ApiResponse, TelegramCallbackQuery, TelegramInlineQuery } from './types';
import { validateTelegramInitData, createApiResponse, sanitizeFilename, validateMimeType, validateFileExtension, getExtensionFromMimeType } from './utils';
import { Database } from './db';
import { R2Uploader } from './r2';

const MAIN_KEYBOARD: TelegramInlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: '🎬 Upload Video', web_app: { url: '' } },
      { text: '📂 My Uploads', callback_data: 'my_uploads' },
    ],
    [
      { text: '⚙️ Settings', callback_data: 'settings' },
      { text: '❓ Help', callback_data: 'help' },
    ],
  ],
};

const HELP_MESSAGE = `
🎬 <b>Telegram Video Clipper Bot</b>

<b>Main Features:</b>
• Upload long videos directly from your phone
• Videos are stored securely in private Cloudflare R2
• Track upload progress in real-time
• Resume interrupted uploads
• Future: AI-powered video clipping with Chopify

<b>How to Use:</b>
1. Tap <b>🎬 Upload Video</b> to open the Mini App
2. Select a video from your gallery or record one
3. Watch the upload progress
4. Get notified when upload completes

<b>Supported Formats:</b> MP4, MOV, MKV, WebM, M4V, AVI
<b>Max File Size:</b> 2 GB

<b>Buttons:</b>
• 🎬 Upload Video — Opens the upload interface
• 📂 My Uploads — View your upload history and status
• ⚙️ Settings — Configure processing preferences
• ❓ Help — Show this message

For support, contact the bot administrator.
`;

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
  private appOrigin: string;
  private maxUploadBytes: number;

  constructor(env: Env) {
    this.botToken = env.TELEGRAM_BOT_TOKEN;
    this.webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
    this.appOrigin = env.APP_ORIGIN;
    this.maxUploadBytes = parseInt(env.MAX_UPLOAD_BYTES || '2147483648', 10);
    this.db = new Database(env.DB);
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

    if (message.text === '/start') {
      return this.sendWelcomeMessage(chatId, userId);
    }

    if (message.text === '/help') {
      return this.sendMessage(chatId, HELP_MESSAGE, { parse_mode: 'HTML' });
    }

    if (message.text === '/settings') {
      return this.sendMessage(chatId, SETTINGS_MESSAGE, { parse_mode: 'HTML' });
    }

    if (message.text === '/uploads') {
      return this.showUserUploads(chatId, userId);
    }

    if (message.document || message.video) {
      return this.handleMediaUpload(message, userId, chatId);
    }

    return this.sendMessage(chatId, 'Use the buttons below or type /help for instructions.', {
      reply_markup: this.getMainKeyboard(),
    });
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

    const initResponse = await this.r2.initiateMultipartUpload(objectKey, mimeType);
    await this.db.updateUpload(uploadId, { multipart_upload_id: initResponse.uploadId });

    return this.sendMessage(chatId, `📤 <b>Upload Ready</b>\n\nFile: <code>${fileName}</code>\nSize: ${this.formatBytes(fileSize)}\n\nTap the button below to start uploading:`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Start Upload', web_app: { url: `${this.appOrigin}/upload?upload_id=${uploadId}` } }],
          [{ text: '❌ Cancel', callback_data: `upload_cancel_${uploadId}` }],
        ],
      },
    });
  }

  private async handleUploadAction(chatId: number, messageId: number, userId: number, action: string): Promise<ApiResponse> {
    const [, , actionType, uploadId] = action.split('_');
    
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
        const initResponse = await this.r2.initiateMultipartUpload(upload.object_key, upload.mime_type);
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
              [{ text: '🚀 Resume Upload', web_app: { url: `${this.appOrigin}/upload?upload_id=${uploadId}` } }],
              [{ text: '❌ Cancel', callback_data: `upload_cancel_${uploadId}` }],
            ],
          },
        });
    }

    return createApiResponse(true, { ok: true });
  }

  private async handleJobAction(chatId: number, messageId: number, userId: number, action: string): Promise<ApiResponse> {
    return createApiResponse(true, { ok: true });
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
      last_name: user.last_name,
      username: user.username,
      language_code: user.language_code,
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

  private getMainKeyboard(): TelegramInlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [{ text: '🎬 Upload Video', web_app: { url: `${this.appOrigin}/upload` } }],
        [{ text: '📂 My Uploads', callback_data: 'my_uploads' }],
        [{ text: '⚙️ Settings', callback_data: 'settings' }],
        [{ text: '❓ Help', callback_data: 'help' }],
      ],
    };
  }

  private async sendMessage(chatId: number, text: string, options: Record<string, unknown> = {}): Promise<ApiResponse> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...options }),
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }

  private async editMessage(chatId: number, messageId: number, text: string, options: Record<string, unknown> = {}): Promise<ApiResponse> {
    const url = `https://api.telegram.org/bot${this.botToken}/editMessageText`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...options }),
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }

  private async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<ApiResponse> {
    const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }

  async setWebhook(url: string): Promise<ApiResponse> {
    const webhookUrl = `${url}/telegram/webhook`;
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: this.webhookSecret }),
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }

  async deleteWebhook(): Promise<ApiResponse> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/deleteWebhook`, { method: 'POST' });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }

  async setMyCommands(): Promise<ApiResponse> {
    const commands = [
      { command: 'start', description: 'Start the bot and show main menu' },
      { command: 'help', description: 'Show help message' },
      { command: 'settings', description: 'Configure processing preferences' },
      { command: 'uploads', description: 'View your upload history' },
    ];
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const data = await response.json();
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
          web_app: { url: `${this.appOrigin}/upload` },
        },
      }),
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }
}