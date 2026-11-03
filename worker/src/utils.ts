import { Env, TelegramInitData, ApiResponse } from './types';

export async function validateTelegramInitData(
  initData: string,
  botToken: string
): Promise<{ valid: boolean; data?: TelegramInitData; error?: string }> {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      return { valid: false, error: 'Missing hash parameter' };
    }

    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const botTokenKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(botToken),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
    const calculatedHash = await crypto.subtle.sign('HMAC', 
      await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      encoder.encode(dataCheckString)
    );

    const calculatedHashHex = Array.from(new Uint8Array(calculatedHash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (calculatedHashHex !== hash) {
      return { valid: false, error: 'Invalid hash' };
    }

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) {
      return { valid: false, error: 'Authentication expired' };
    }

    const data: TelegramInitData = {
      auth_date: authDate,
      hash: hash,
    };

    if (params.has('query_id')) data.query_id = params.get('query_id')!;
    if (params.has('user')) {
      try {
        data.user = JSON.parse(params.get('user')!);
      } catch {
        return { valid: false, error: 'Invalid user data' };
      }
    }
    if (params.has('receiver')) {
      try {
        data.receiver = JSON.parse(params.get('receiver')!);
      } catch {
        return { valid: false, error: 'Invalid receiver data' };
      }
    }
    if (params.has('chat')) {
      try {
        data.chat = JSON.parse(params.get('chat')!);
      } catch {
        return { valid: false, error: 'Invalid chat data' };
      }
    }
    if (params.has('chat_type')) data.chat_type = params.get('chat_type')!;
    if (params.has('chat_instance')) data.chat_instance = params.get('chat_instance')!;
    if (params.has('start_param')) data.start_param = params.get('start_param')!;
    if (params.has('can_send_after')) data.can_send_after = parseInt(params.get('can_send_after')!, 10);

    return { valid: true, data };
  } catch (error) {
    return { valid: false, error: `Validation error: ${error instanceof Error ? error.message : 'Unknown'}` };
  }
}

export function generateId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function generateSessionToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.+/g, '.')
    .substring(0, 255);
}

export function validateMimeType(mimeType: string): boolean {
  const allowedTypes = [
    'video/mp4',
    'video/quicktime',
    'video/x-matroska',
    'video/webm',
    'video/x-msvideo',
    'video/x-m4v',
  ];
  return allowedTypes.includes(mimeType.toLowerCase());
}

export function validateFileExtension(filename: string): boolean {
  const allowedExtensions = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'];
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  return allowedExtensions.includes(ext);
}

export function createApiResponse<T>(ok: boolean, data?: T, error?: string, code?: string): ApiResponse<T> {
  return { ok, data, error, code };
}

export function getClientIp(request: Request): string {
  const cfConnectingIp = request.headers.get('CF-Connecting-IP');
  if (cfConnectingIp) return cfConnectingIp;
  
  const xForwardedFor = request.headers.get('X-Forwarded-For');
  if (xForwardedFor) return xForwardedFor.split(',')[0].trim();
  
  return 'unknown';
}

export async function hashSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(secret));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function parseInitData(initData: string): Record<string, string> {
  const params = new URLSearchParams(initData);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

export const VIDEO_MIME_TYPES = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'video/x-m4v': '.m4v',
  'video/x-msvideo': '.avi',
} as const;

export function getExtensionFromMimeType(mimeType: string): string {
  return VIDEO_MIME_TYPES[mimeType as keyof typeof VIDEO_MIME_TYPES] || '.bin';
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Constant-time string comparison (avoids leaking secret prefixes via timing).
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}