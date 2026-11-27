import { Env, Upload, UploadPart, User, Job } from './types';
import { generateId } from './utils';

export class Database {
  constructor(private db: D1Database, private env?: Env) {}

  async createUpload(upload: Omit<Upload, 'id' | 'created_at' | 'updated_at' | 'multipart_upload_id' | 'expires_at' | 'completed_etag' | 'completed_size' | 'error_message' | 'upload_type'> & { id?: string; upload_type?: 'video' | 'broll' }): Promise<Upload> {
    const id = upload.id || generateId();
    const now = Date.now();
    const expiryHours = parseInt(this.env?.UPLOAD_EXPIRY_HOURS || '24', 10);
    const expiresAt = now + (expiryHours * 3600 * 1000);

    await this.db.prepare(`
      INSERT INTO uploads (id, telegram_user_id, telegram_chat_id, original_filename, object_key, file_size, mime_type, multipart_upload_id, status, created_at, updated_at, expires_at, completed_etag, completed_size, error_message, source_url, upload_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      upload.telegram_user_id,
      upload.telegram_chat_id,
      upload.original_filename,
      upload.object_key,
      upload.file_size,
      upload.mime_type,
      null, // multipart_upload_id
      upload.status,
      now,
      now,
      expiresAt,
      null, // completed_etag
      null, // completed_size
      null, // error_message
      upload.source_url || null,
      upload.upload_type || 'video'
    ).run();

    const result = await this.getUpload(id);
    if (!result) throw new Error('Failed to create upload');
    return result;
  }

  async getUpload(id: string): Promise<Upload | null> {
    const result = await this.db.prepare('SELECT * FROM uploads WHERE id = ?').bind(id).first<Upload>();
    return result || null;
  }

  async getUploadByMultipartId(multipartUploadId: string): Promise<Upload | null> {
    const result = await this.db.prepare('SELECT * FROM uploads WHERE multipart_upload_id = ?').bind(multipartUploadId).first<Upload>();
    return result || null;
  }

  async updateUpload(id: string, updates: Partial<Upload>): Promise<Upload | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const now = Date.now();

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'id' && key !== 'created_at' && value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return this.getUpload(id);

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    await this.db.prepare(`UPDATE uploads SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    return this.getUpload(id);
  }

  async getUserUploads(telegramUserId: number, limit = 50, offset = 0): Promise<Upload[]> {
    const results = await this.db.prepare(`
      SELECT * FROM uploads WHERE telegram_user_id = ? AND upload_type = 'video' ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).bind(telegramUserId, limit, offset).all<Upload>();
    return results.results || [];
  }

  async getUploadsByStatus(status: Upload['status'], limit = 100): Promise<Upload[]> {
    const results = await this.db.prepare(`
      SELECT * FROM uploads WHERE status = ? ORDER BY created_at ASC LIMIT ?
    `).bind(status, limit).all<Upload>();
    return results.results || [];
  }

  async getExpiredUploads(): Promise<Upload[]> {
    const now = Date.now();
    const results = await this.db.prepare(`
      SELECT * FROM uploads WHERE expires_at < ? AND status IN ('uploading', 'uploaded')
    `).bind(now).all<Upload>();
    return results.results || [];
  }

  async createUploadPart(part: Omit<UploadPart, 'id' | 'uploaded_at'> & { uploaded_at?: number }): Promise<UploadPart> {
    const result = await this.db.prepare(`
      INSERT INTO upload_parts (upload_id, part_number, etag, size, uploaded_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      part.upload_id,
      part.part_number,
      part.etag,
      part.size,
      part.uploaded_at || Date.now()
    ).run();

    const id = result.meta.last_row_id as number;
    return { id, ...part, uploaded_at: part.uploaded_at || Date.now() };
  }

  async updateUploadPart(uploadId: string, partNumber: number, etag: string, size: number): Promise<void> {
    await this.db.prepare(`
      INSERT INTO upload_parts (upload_id, part_number, etag, size, uploaded_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(upload_id, part_number) DO UPDATE SET
        etag = excluded.etag,
        size = excluded.size,
        uploaded_at = excluded.uploaded_at
    `).bind(uploadId, partNumber, etag, size, Date.now()).run();
  }

  async getUploadParts(uploadId: string): Promise<UploadPart[]> {
    const results = await this.db.prepare(`
      SELECT * FROM upload_parts WHERE upload_id = ? ORDER BY part_number
    `).bind(uploadId).all<UploadPart>();
    return results.results || [];
  }

  async getUploadedPartNumbers(uploadId: string): Promise<number[]> {
    const results = await this.db.prepare(`
      SELECT part_number FROM upload_parts WHERE upload_id = ? AND etag IS NOT NULL ORDER BY part_number
    `).bind(uploadId).all<{ part_number: number }>();
    return results.results?.map(r => r.part_number) || [];
  }

  async deleteUploadParts(uploadId: string): Promise<void> {
    await this.db.prepare('DELETE FROM upload_parts WHERE upload_id = ?').bind(uploadId).run();
  }

  async createUser(user: Omit<User, 'created_at' | 'updated_at'>): Promise<User> {
    const now = Date.now();
    await this.db.prepare(`
      INSERT OR REPLACE INTO users (telegram_user_id, first_name, last_name, username, language_code, preferred_aspect_ratio, preferred_caption_style, enable_tighten, enable_loudnorm, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      user.telegram_user_id,
      user.first_name,
      user.last_name,
      user.username,
      user.language_code,
      user.preferred_aspect_ratio,
      user.preferred_caption_style,
      user.enable_tighten,
      user.enable_loudnorm,
      now,
      now
    ).run();
    const result = await this.getUser(user.telegram_user_id);
    if (!result) throw new Error('Failed to create user');
    return result;
  }

  async getUser(telegramUserId: number): Promise<User | null> {
    const result = await this.db.prepare('SELECT * FROM users WHERE telegram_user_id = ?').bind(telegramUserId).first<User>();
    return result || null;
  }

  async updateUser(telegramUserId: number, updates: Partial<User>): Promise<User | null> {
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'telegram_user_id' && key !== 'created_at' && value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return this.getUser(telegramUserId);

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(telegramUserId);

    await this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE telegram_user_id = ?`).bind(...values).run();
    return this.getUser(telegramUserId);
  }

  async createJob(job: Omit<Job, 'id' | 'created_at' | 'updated_at'> & { id?: string }): Promise<Job> {
    const id = job.id || generateId();
    const now = Date.now();

    await this.db.prepare(`
      INSERT INTO jobs (id, upload_id, telegram_user_id, status, aspect_ratio, caption_style, enable_tighten, enable_loudnorm, clip_count, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      job.upload_id,
      job.telegram_user_id,
      job.status,
      job.aspect_ratio,
      job.caption_style,
      job.enable_tighten,
      job.enable_loudnorm,
      job.clip_count,
      job.error_message,
      now,
      now
    ).run();

    const result = await this.getJob(id);
    if (!result) throw new Error('Failed to create job');
    return result;
  }

  async getJob(id: string): Promise<Job | null> {
    const result = await this.db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<Job>();
    return result || null;
  }

  async getJobByUploadId(uploadId: string): Promise<Job | null> {
    const result = await this.db.prepare('SELECT * FROM jobs WHERE upload_id = ?').bind(uploadId).first<Job>();
    return result || null;
  }

  async getActiveJobForUpload(uploadId: string): Promise<Job | null> {
    const result = await this.db.prepare(`
      SELECT * FROM jobs WHERE upload_id = ? AND status IN ('pending', 'queued', 'processing') ORDER BY created_at DESC LIMIT 1
    `).bind(uploadId).first<Job>();
    return result || null;
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<Job | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const now = Date.now();

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'id' && key !== 'created_at' && value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return this.getJob(id);

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    await this.db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    return this.getJob(id);
  }

  async getUserJobs(telegramUserId: number, limit = 50, offset = 0): Promise<Job[]> {
    const results = await this.db.prepare(`
      SELECT * FROM jobs WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).bind(telegramUserId, limit, offset).all<Job>();
    return results.results || [];
  }

  async getPendingJobs(limit = 100): Promise<Job[]> {
    const results = await this.db.prepare(`
      SELECT * FROM jobs WHERE status IN ('pending', 'queued') ORDER BY created_at ASC LIMIT ?
    `).bind(limit).all<Job>();
    return results.results || [];
  }
}