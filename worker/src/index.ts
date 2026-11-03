import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import { api, internalApi } from './api';
import { TelegramBot } from './bot';
import { Database } from './db';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: [
    'https://*.telegram.org', 
    'https://web.telegram.org', 
    'https://telegram.org',
    'https://telegram-video-clipper-miniapp.pages.dev',
    'https://*.pages.dev'
  ],
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// Global error handler - ensures all errors return JSON
app.onError((err, c) => {
  const requestId = crypto.randomUUID();
  console.error(`[${requestId}] Unhandled error:`, err);
  return c.json({ 
    ok: false, 
    error: 'Internal server error', 
    code: 'INTERNAL_ERROR',
    requestId 
  }, 500);
});

app.use('*', cors({
  origin: [
    'https://*.telegram.org', 
    'https://web.telegram.org', 
    'https://telegram.org',
    'https://telegram-video-clipper-miniapp.pages.dev',
    'https://*.pages.dev'
  ],
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

app.route('/api/internal', internalApi);
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
  const webhookResult = await bot.setWebhook(c.env.WORKER_URL);
  const commandsResult = await bot.setMyCommands();
  const menuResult = await bot.setMenuButton();
  return c.json({ webhook: webhookResult, commands: commandsResult, menu: menuResult });
});

// Health check for Pages/Workers monitoring
app.get('/health', (c) => c.json({ status: 'ok' }));

// Scheduled handler for expired upload cleanup
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const requestId = crypto.randomUUID();
    console.log(`[${requestId}] Scheduled cleanup triggered at ${new Date().toISOString()}, cron: ${controller.cron}`);
    const db = new Database(env.DB, env);
    
    try {
      const expiredUploads = await db.getExpiredUploads();
      console.log(`[${requestId}] Found ${expiredUploads.length} expired uploads`);
      
      for (const upload of expiredUploads) {
        if (upload.multipart_upload_id) {
          const { R2Uploader } = await import('./r2');
          const r2 = new R2Uploader(env);
          await r2.abortMultipartUpload(upload.object_key, upload.multipart_upload_id);
        }
        await db.updateUpload(upload.id, { 
          status: 'expired', 
          error_message: 'Upload session expired' 
        });
        console.log(`[${requestId}] Expired upload ${upload.id}`);
      }
    } catch (e) {
      console.error(`[${requestId}] Cleanup failed:`, e);
    }
  },
};