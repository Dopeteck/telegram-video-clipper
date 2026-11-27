import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramBot, parseUploadAction } from '../src/bot';
import { TelegramMessage, TelegramUser, TelegramChat, TelegramCallbackQuery, TelegramWebhookUpdate } from '../src/types';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock D1Database and R2Bucket
const mockDB = {
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }),
  }),
};

const mockR2 = {
  initiateMultipartUpload: vi.fn().mockResolvedValue({
    uploadId: 'test-upload-id',
    key: 'test-key',
    expiresAt: Date.now() + 3600000,
    partUrls: [],
  }),
  abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../src/db', () => ({
  Database: vi.fn().mockImplementation(() => ({
    createUpload: vi.fn().mockResolvedValue({
      id: 'upload-123',
      status: 'uploading',
    }),
    getUpload: vi.fn().mockResolvedValue(null),
    updateUpload: vi.fn().mockResolvedValue(null),
    getUserUploads: vi.fn().mockResolvedValue([]),
    createUser: vi.fn().mockResolvedValue({}),
    getUser: vi.fn().mockResolvedValue(null),
    updateUser: vi.fn().mockResolvedValue(null),
    createJob: vi.fn().mockResolvedValue({}),
    getJob: vi.fn().mockResolvedValue(null),
    updateJob: vi.fn().mockResolvedValue(null),
    getUserJobs: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../src/r2', () => ({
  R2Uploader: vi.fn().mockImplementation(() => mockR2),
}));

describe('parseUploadAction', () => {
  it.each([
    ['upload_process_upload_1793706123456_12345', 'process', 'upload_1793706123456_12345'],
    ['upload_retry_upload_1793706123456_12345', 'retry', 'upload_1793706123456_12345'],
    ['upload_cancel_upload_1793706123456_12345', 'cancel', 'upload_1793706123456_12345'],
  ])('preserves the full upload ID for %s', (callbackData, actionType, uploadId) => {
    expect(parseUploadAction(callbackData)).toEqual({ actionType, uploadId });
  });

  it.each(['upload_video', 'upload_process_', 'my_uploads', 'upload_delete_upload_123'])(
    'rejects malformed or unsupported upload callback data: %s',
    (callbackData) => {
      expect(parseUploadAction(callbackData)).toBeNull();
    }
  );
});

describe('TelegramBot', () => {
  let bot: TelegramBot;
  const mockEnv = {
    TELEGRAM_BOT_TOKEN: 'test_token',
    BROLL_ALLOWED_TELEGRAM_USER_IDS: '',
    TELEGRAM_WEBHOOK_SECRET: 'test_secret',
    APP_ORIGIN: 'https://test.example.com',
    DB: mockDB as any,
    R2_BUCKET: {} as any,
    MAX_UPLOAD_BYTES: '2147483648',
    CHUNK_SIZE: '5242880',
    MAX_CONCURRENT_CHUNKS: '3',
    UPLOAD_EXPIRY_HOURS: '24',
    CLEANUP_INTERVAL_MINUTES: '60',
    MAX_CONCURRENT_UPLOADS_PER_USER: '2',
    RATE_LIMIT_WINDOW_SECONDS: '60',
    RATE_LIMIT_MAX_REQUESTS: '30',
    SESSION_SECRET: 'test_session_secret',
    R2_ACCOUNT_ID: 'test_account',
    R2_ACCESS_KEY_ID: 'test_key',
    R2_SECRET_ACCESS_KEY: 'test_secret',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    bot = new TelegramBot(mockEnv as any);
  });

  describe('handleWebhook', () => {
    it('should handle /start command', async () => {
      const message: TelegramMessage = {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, is_bot: false, first_name: 'Test' },
        text: '/start',
      };

      const update: TelegramWebhookUpdate = { update_id: 1, message };
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });

      const result = await bot.handleWebhook(update);
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest_token/sendMessage',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Welcome'),
        })
      );
    });

    it('should handle /help command', async () => {
      const message: TelegramMessage = {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, is_bot: false, first_name: 'Test' },
        text: '/help',
      };

      const update: TelegramWebhookUpdate = { update_id: 1, message };
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });

      const result = await bot.handleWebhook(update);
      expect(result.ok).toBe(true);
    });

    it('should return the Telegram user ID for /whoami', async () => {
      const message: TelegramMessage = {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, is_bot: false, first_name: 'Test' },
        text: '/whoami',
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });
      await bot.handleWebhook({ update_id: 1, message });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest_token/sendMessage',
        expect.objectContaining({ body: expect.stringContaining('<code>123</code>') })
      );
    });

    it('keeps /broll locked until the Telegram user is allowlisted', async () => {
      const message: TelegramMessage = {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, is_bot: false, first_name: 'Test' },
        text: '/broll',
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });
      await bot.handleWebhook({ update_id: 1, message });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest_token/sendMessage',
        expect.objectContaining({ body: expect.stringContaining('BROLL_ALLOWED_TELEGRAM_USER_IDS') })
      );
    });

    it('should handle document upload', async () => {
      const message: TelegramMessage = {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, is_bot: false, first_name: 'Test' },
        document: {
          file_id: 'file123',
          file_unique_id: 'unique123',
          file_name: 'video.mp4',
          mime_type: 'video/mp4',
          file_size: 1000000,
        },
      };

      const update: TelegramWebhookUpdate = { update_id: 1, message };
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });

      const result = await bot.handleWebhook(update);
      expect(result.ok).toBe(true);
    });

    it('should reject unsupported file type', async () => {
      const message: TelegramMessage = {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, is_bot: false, first_name: 'Test' },
        document: {
          file_id: 'file123',
          file_unique_id: 'unique123',
          file_name: 'document.pdf',
          mime_type: 'application/pdf',
          file_size: 1000000,
        },
      };

      const update: TelegramWebhookUpdate = { update_id: 1, message };
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });

      const result = await bot.handleWebhook(update);
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest_token/sendMessage',
        expect.objectContaining({
          body: expect.stringContaining('Unsupported file type'),
        })
      );
    });
  });

  describe('handleCallbackQuery', () => {
    it('should handle my_uploads callback', async () => {
      const query: TelegramCallbackQuery = {
        id: 'query123',
        from: { id: 123, is_bot: false, first_name: 'Test' },
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123, type: 'private' },
        },
        chat_instance: 'chat123',
        data: 'my_uploads',
      };

      const update: TelegramWebhookUpdate = { update_id: 1, callback_query: query };
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });

      const result = await bot.handleWebhook(update);
      expect(result.ok).toBe(true);
    });

    it('should answer callback query', async () => {
      const query: TelegramCallbackQuery = {
        id: 'query123',
        from: { id: 123, is_bot: false, first_name: 'Test' },
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123, type: 'private' },
        },
        chat_instance: 'chat123',
        data: 'help',
      };

      const update: TelegramWebhookUpdate = { update_id: 1, callback_query: query };
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });

      const result = await bot.handleWebhook(update);
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest_token/answerCallbackQuery',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('query123'),
        })
      );
    });
  });

  describe('setWebhook', () => {
    it('should set webhook with secret token', async () => {
      mockFetch.mockResolvedValueOnce({ 
        ok: true, 
        json: () => Promise.resolve({ ok: true, result: true, description: 'Webhook was set' }) 
      });

      const result = await bot.setWebhook('https://test.example.com');
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest_token/setWebhook',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('test_secret'),
        })
      );
    });
  });

  describe('setMyCommands', () => {
    it('should set bot commands', async () => {
      mockFetch.mockResolvedValueOnce({ 
        ok: true, 
        json: () => Promise.resolve({ ok: true, result: true }) 
      });

      const result = await bot.setMyCommands();
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest_token/setMyCommands',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('start'),
        })
      );
    });
  });

  describe('setMenuButton', () => {
    it('should set menu button to web app', async () => {
      mockFetch.mockResolvedValueOnce({ 
        ok: true, 
        json: () => Promise.resolve({ ok: true, result: true }) 
      });

      const result = await bot.setMenuButton();
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest_token/setChatMenuButton',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('web_app'),
        })
      );
    });
  });
});