import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import { api } from './api';
import { TelegramBot } from './bot';

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

app.get('/upload*', async (c) => {
  return c.redirect(`${c.env.APP_ORIGIN}/miniapp${c.req.path.replace('/upload', '')}${c.req.query() ? '?' + c.req.query() : ''}`);
});

app.get('*', (c) => {
  return c.notFound();
});

export default app;