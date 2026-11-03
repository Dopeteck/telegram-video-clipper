var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/utils.ts
async function validateTelegramInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) {
      return { valid: false, error: "Missing hash parameter" };
    }
    params.delete("hash");
    const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const botTokenKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(botToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
    const calculatedHash = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      encoder.encode(dataCheckString)
    );
    const calculatedHashHex = Array.from(new Uint8Array(calculatedHash)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (calculatedHashHex !== hash) {
      return { valid: false, error: "Invalid hash" };
    }
    const authDate = parseInt(params.get("auth_date") || "0", 10);
    const now = Math.floor(Date.now() / 1e3);
    if (now - authDate > 86400) {
      return { valid: false, error: "Authentication expired" };
    }
    const data = {
      auth_date: authDate,
      hash
    };
    if (params.has("query_id")) data.query_id = params.get("query_id");
    if (params.has("user")) {
      try {
        data.user = JSON.parse(params.get("user"));
      } catch {
        return { valid: false, error: "Invalid user data" };
      }
    }
    if (params.has("receiver")) {
      try {
        data.receiver = JSON.parse(params.get("receiver"));
      } catch {
        return { valid: false, error: "Invalid receiver data" };
      }
    }
    if (params.has("chat")) {
      try {
        data.chat = JSON.parse(params.get("chat"));
      } catch {
        return { valid: false, error: "Invalid chat data" };
      }
    }
    if (params.has("chat_type")) data.chat_type = params.get("chat_type");
    if (params.has("chat_instance")) data.chat_instance = params.get("chat_instance");
    if (params.has("start_param")) data.start_param = params.get("start_param");
    if (params.has("can_send_after")) data.can_send_after = parseInt(params.get("can_send_after"), 10);
    return { valid: true, data };
  } catch (error) {
    return { valid: false, error: `Validation error: ${error instanceof Error ? error.message : "Unknown"}` };
  }
}
function generateId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.+/g, ".").substring(0, 255);
}
function validateMimeType(mimeType) {
  const allowedTypes = [
    "video/mp4",
    "video/quicktime",
    "video/x-matroska",
    "video/webm",
    "video/x-msvideo",
    "video/x-m4v"
  ];
  return allowedTypes.includes(mimeType.toLowerCase());
}
function validateFileExtension(filename) {
  const allowedExtensions = [".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"];
  const ext = filename.toLowerCase().substring(filename.lastIndexOf("."));
  return allowedExtensions.includes(ext);
}
function createApiResponse(ok, data, error, code) {
  return { ok, data, error, code };
}
function getExtensionFromMimeType(mimeType) {
  return VIDEO_MIME_TYPES[mimeType] || ".bin";
}
var VIDEO_MIME_TYPES;
var init_utils = __esm({
  "src/utils.ts"() {
    "use strict";
    VIDEO_MIME_TYPES = {
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "video/x-matroska": ".mkv",
      "video/webm": ".webm",
      "video/x-m4v": ".m4v",
      "video/x-msvideo": ".avi"
    };
  }
});

// src/db.ts
var db_exports = {};
__export(db_exports, {
  Database: () => Database
});
var Database;
var init_db = __esm({
  "src/db.ts"() {
    "use strict";
    init_utils();
    Database = class {
      constructor(db, env) {
        this.db = db;
        this.env = env;
      }
      db;
      env;
      async createUpload(upload) {
        const id = upload.id || generateId();
        const now = Date.now();
        const expiryHours = parseInt(this.env?.UPLOAD_EXPIRY_HOURS || "24", 10);
        const expiresAt = now + expiryHours * 3600 * 1e3;
        await this.db.prepare(`
      INSERT INTO uploads (id, telegram_user_id, telegram_chat_id, original_filename, object_key, file_size, mime_type, multipart_upload_id, status, created_at, updated_at, expires_at, completed_etag, completed_size, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
          id,
          upload.telegram_user_id,
          upload.telegram_chat_id,
          upload.original_filename,
          upload.object_key,
          upload.file_size,
          upload.mime_type,
          null,
          // multipart_upload_id
          upload.status,
          now,
          now,
          expiresAt,
          null,
          // completed_etag
          null,
          // completed_size
          null
          // error_message
        ).run();
        const result = await this.getUpload(id);
        if (!result) throw new Error("Failed to create upload");
        return result;
      }
      async getUpload(id) {
        const result = await this.db.prepare("SELECT * FROM uploads WHERE id = ?").bind(id).first();
        return result || null;
      }
      async getUploadByMultipartId(multipartUploadId) {
        const result = await this.db.prepare("SELECT * FROM uploads WHERE multipart_upload_id = ?").bind(multipartUploadId).first();
        return result || null;
      }
      async updateUpload(id, updates) {
        const fields = [];
        const values = [];
        const now = Date.now();
        for (const [key, value] of Object.entries(updates)) {
          if (key !== "id" && key !== "created_at" && value !== void 0) {
            fields.push(`${key} = ?`);
            values.push(value);
          }
        }
        if (fields.length === 0) return this.getUpload(id);
        fields.push("updated_at = ?");
        values.push(now);
        values.push(id);
        await this.db.prepare(`UPDATE uploads SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
        return this.getUpload(id);
      }
      async getUserUploads(telegramUserId, limit = 50, offset = 0) {
        const results = await this.db.prepare(`
      SELECT * FROM uploads WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).bind(telegramUserId, limit, offset).all();
        return results.results || [];
      }
      async getUploadsByStatus(status, limit = 100) {
        const results = await this.db.prepare(`
      SELECT * FROM uploads WHERE status = ? ORDER BY created_at ASC LIMIT ?
    `).bind(status, limit).all();
        return results.results || [];
      }
      async getExpiredUploads() {
        const now = Date.now();
        const results = await this.db.prepare(`
      SELECT * FROM uploads WHERE expires_at < ? AND status IN ('uploading', 'uploaded')
    `).bind(now).all();
        return results.results || [];
      }
      async createUploadPart(part) {
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
        const id = result.meta.last_row_id;
        return { id, ...part, uploaded_at: part.uploaded_at || Date.now() };
      }
      async updateUploadPart(uploadId, partNumber, etag, size) {
        await this.db.prepare(`
      UPDATE upload_parts SET etag = ?, size = ?, uploaded_at = ? WHERE upload_id = ? AND part_number = ?
    `).bind(etag, size, Date.now(), uploadId, partNumber).run();
      }
      async getUploadParts(uploadId) {
        const results = await this.db.prepare(`
      SELECT * FROM upload_parts WHERE upload_id = ? ORDER BY part_number
    `).bind(uploadId).all();
        return results.results || [];
      }
      async getUploadedPartNumbers(uploadId) {
        const results = await this.db.prepare(`
      SELECT part_number FROM upload_parts WHERE upload_id = ? AND etag IS NOT NULL ORDER BY part_number
    `).bind(uploadId).all();
        return results.results?.map((r) => r.part_number) || [];
      }
      async deleteUploadParts(uploadId) {
        await this.db.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(uploadId).run();
      }
      async createUser(user) {
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
        if (!result) throw new Error("Failed to create user");
        return result;
      }
      async getUser(telegramUserId) {
        const result = await this.db.prepare("SELECT * FROM users WHERE telegram_user_id = ?").bind(telegramUserId).first();
        return result || null;
      }
      async updateUser(telegramUserId, updates) {
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(updates)) {
          if (key !== "telegram_user_id" && key !== "created_at" && value !== void 0) {
            fields.push(`${key} = ?`);
            values.push(value);
          }
        }
        if (fields.length === 0) return this.getUser(telegramUserId);
        fields.push("updated_at = ?");
        values.push(Date.now());
        values.push(telegramUserId);
        await this.db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE telegram_user_id = ?`).bind(...values).run();
        return this.getUser(telegramUserId);
      }
      async createJob(job) {
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
        if (!result) throw new Error("Failed to create job");
        return result;
      }
      async getJob(id) {
        const result = await this.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
        return result || null;
      }
      async getJobByUploadId(uploadId) {
        const result = await this.db.prepare("SELECT * FROM jobs WHERE upload_id = ?").bind(uploadId).first();
        return result || null;
      }
      async updateJob(id, updates) {
        const fields = [];
        const values = [];
        const now = Date.now();
        for (const [key, value] of Object.entries(updates)) {
          if (key !== "id" && key !== "created_at" && value !== void 0) {
            fields.push(`${key} = ?`);
            values.push(value);
          }
        }
        if (fields.length === 0) return this.getJob(id);
        fields.push("updated_at = ?");
        values.push(now);
        values.push(id);
        await this.db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
        return this.getJob(id);
      }
      async getUserJobs(telegramUserId, limit = 50, offset = 0) {
        const results = await this.db.prepare(`
      SELECT * FROM jobs WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).bind(telegramUserId, limit, offset).all();
        return results.results || [];
      }
      async getPendingJobs(limit = 100) {
        const results = await this.db.prepare(`
      SELECT * FROM jobs WHERE status IN ('pending', 'queued') ORDER BY created_at ASC LIMIT ?
    `).bind(limit).all();
        return results.results || [];
      }
    };
  }
});

// src/index.ts
import { Hono as Hono2 } from "hono";
import { cors } from "hono/cors";

// src/api.ts
init_utils();
init_db();
import { Hono } from "hono";

// src/r2.ts
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
var R2Uploader = class {
  client;
  bucket;
  accountId;
  accessKeyId;
  secretAccessKey;
  constructor(env) {
    this.bucket = env.R2_BUCKET_NAME || "telegram-video-clipper-uploads";
    this.accountId = env.R2_ACCOUNT_ID;
    this.accessKeyId = env.R2_ACCESS_KEY_ID;
    this.secretAccessKey = env.R2_SECRET_ACCESS_KEY;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey
      }
    });
  }
  async initiateMultipartUpload(key, contentType, totalParts, expiresIn = 3600) {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType
    });
    const response = await this.client.send(command);
    const uploadId = response.UploadId;
    const partUrls = [];
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const partCommand = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber
      });
      const url = await getSignedUrl(this.client, partCommand, { expiresIn });
      partUrls.push({
        uploadId,
        key,
        partNumber,
        url,
        expiresAt: Date.now() + expiresIn * 1e3
      });
    }
    return {
      uploadId,
      key,
      expiresAt: Date.now() + expiresIn * 1e3,
      partUrls
    };
  }
  async generatePartUploadUrl(key, uploadId, partNumber, expiresIn = 3600) {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return {
      uploadId,
      key,
      partNumber,
      url,
      expiresAt: Date.now() + expiresIn * 1e3
    };
  }
  async generatePartUploadUrls(key, uploadId, partNumbers, expiresIn = 3600) {
    const urls = [];
    for (const partNumber of partNumbers) {
      urls.push(await this.generatePartUploadUrl(key, uploadId, partNumber, expiresIn));
    }
    return urls;
  }
  async completeMultipartUpload(request) {
    const command = new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: request.key,
      UploadId: request.uploadId,
      MultipartUpload: {
        Parts: request.parts.map((p) => ({
          PartNumber: p.partNumber,
          ETag: p.etag
        }))
      }
    });
    const response = await this.client.send(command);
    const headCommand = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: request.key
    });
    const headResponse = await this.client.send(headCommand);
    return {
      etag: response.ETag || "",
      size: headResponse.ContentLength || 0
    };
  }
  async abortMultipartUpload(key, uploadId) {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId
    });
    await this.client.send(command);
  }
  async verifyObject(key, expectedSize) {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key
      });
      const response = await this.client.send(command);
      return {
        exists: true,
        size: response.ContentLength || 0,
        etag: response.ETag
      };
    } catch (error) {
      if (error instanceof Error && error.name === "NotFound") {
        return { exists: false, size: 0, etag: void 0 };
      }
      throw error;
    }
  }
  async deleteObject(key) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key
    });
    await this.client.send(command);
  }
};

// src/api.ts
var api = new Hono();
api.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(createApiResponse(false, void 0, "Missing or invalid authorization"), 401);
  }
  const initData = authHeader.substring(7);
  const { valid, data, error } = await validateTelegramInitData(initData, c.env.TELEGRAM_BOT_TOKEN);
  if (!valid || !data || !data.user) {
    return c.json(createApiResponse(false, void 0, error || "Invalid authentication"), 401);
  }
  c.set("telegramUser", data.user);
  c.set("telegramChat", data.chat || null);
  await next();
});
api.post("/upload/initiate", async (c) => {
  const user = c.get("telegramUser");
  const chat = c.get("telegramChat");
  const body = await c.req.json();
  const { filename, fileSize, mimeType } = body;
  if (!filename || !fileSize || !mimeType) {
    return c.json(createApiResponse(false, void 0, "Missing required fields"), 400);
  }
  if (!validateMimeType(mimeType)) {
    return c.json(createApiResponse(false, void 0, "Unsupported file type"), 400);
  }
  if (!validateFileExtension(filename)) {
    return c.json(createApiResponse(false, void 0, "Unsupported file extension"), 400);
  }
  const maxSize = parseInt(c.env.MAX_UPLOAD_BYTES || "2147483648", 10);
  if (fileSize > maxSize) {
    return c.json(createApiResponse(false, void 0, "File too large"), 400);
  }
  if (fileSize === 0) {
    return c.json(createApiResponse(false, void 0, "Empty file"), 400);
  }
  const db = new Database(c.env.DB, c.env);
  const r2 = new R2Uploader(c.env);
  const uploadId = `upload_${Date.now()}_${user.id}`;
  const objectKey = `uploads/${user.id}/${uploadId}/${sanitizeFilename(filename)}`;
  const chunkSize = parseInt(c.env.CHUNK_SIZE || "5242880", 10);
  const totalParts = Math.ceil(fileSize / chunkSize);
  const upload = await db.createUpload({
    id: uploadId,
    telegram_user_id: user.id,
    telegram_chat_id: chat?.id ?? null,
    original_filename: filename,
    object_key: objectKey,
    file_size: fileSize,
    mime_type: mimeType,
    status: "uploading"
  });
  const initResponse = await r2.initiateMultipartUpload(objectKey, mimeType, totalParts);
  await db.updateUpload(uploadId, { multipart_upload_id: initResponse.uploadId });
  return c.json(createApiResponse(true, {
    uploadId: upload.id,
    objectKey: upload.object_key,
    multipartUploadId: initResponse.uploadId,
    totalParts,
    chunkSize,
    partUrls: initResponse.partUrls
  }));
});
api.post("/upload/part-urls", async (c) => {
  const user = c.get("telegramUser");
  const body = await c.req.json();
  const { uploadId, partNumbers } = body;
  if (!uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
    return c.json(createApiResponse(false, void 0, "Missing required fields"), 400);
  }
  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, void 0, "Upload not found"), 404);
  }
  if (!upload.multipart_upload_id) {
    return c.json(createApiResponse(false, void 0, "Multipart upload not initialized"), 400);
  }
  const r2 = new R2Uploader(c.env);
  const partUrls = await r2.generatePartUploadUrls(upload.object_key, upload.multipart_upload_id, partNumbers);
  return c.json(createApiResponse(true, { partUrls }));
});
api.post("/upload/part-complete", async (c) => {
  const user = c.get("telegramUser");
  const body = await c.req.json();
  const { uploadId, partNumber, etag, size } = body;
  if (!uploadId || !partNumber || !etag) {
    return c.json(createApiResponse(false, void 0, "Missing required fields"), 400);
  }
  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, void 0, "Upload not found"), 404);
  }
  if (!upload.multipart_upload_id) {
    return c.json(createApiResponse(false, void 0, "Multipart upload not initialized"), 400);
  }
  if (partNumber < 1 || partNumber > Math.ceil(upload.file_size / parseInt(c.env.CHUNK_SIZE || "5242880", 10))) {
    return c.json(createApiResponse(false, void 0, "Invalid part number"), 400);
  }
  await db.updateUploadPart(uploadId, partNumber, etag, size || 0);
  return c.json(createApiResponse(true, { ok: true }));
});
api.post("/upload/complete", async (c) => {
  const user = c.get("telegramUser");
  const body = await c.req.json();
  const { uploadId } = body;
  if (!uploadId) {
    return c.json(createApiResponse(false, void 0, "Missing uploadId"), 400);
  }
  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, void 0, "Upload not found"), 404);
  }
  if (!upload.multipart_upload_id) {
    return c.json(createApiResponse(false, void 0, "Multipart upload not initialized"), 400);
  }
  if (upload.status !== "uploading") {
    return c.json(createApiResponse(false, void 0, "Upload not in progress"), 400);
  }
  const chunkSize = parseInt(c.env.CHUNK_SIZE || "5242880", 10);
  const totalParts = Math.ceil(upload.file_size / chunkSize);
  const parts = await db.getUploadParts(uploadId);
  const uploadedPartNumbers = parts.filter((p) => p.etag).map((p) => p.part_number).sort((a, b) => a - b);
  if (uploadedPartNumbers.length !== totalParts) {
    return c.json(createApiResponse(false, void 0, `Missing parts: expected ${totalParts}, got ${uploadedPartNumbers.length}`), 400);
  }
  for (let i = 1; i <= totalParts; i++) {
    if (!uploadedPartNumbers.includes(i)) {
      return c.json(createApiResponse(false, void 0, `Missing part ${i}`), 400);
    }
  }
  const r2 = new R2Uploader(c.env);
  try {
    const result = await r2.completeMultipartUpload({
      uploadId: upload.multipart_upload_id,
      key: upload.object_key,
      parts: parts.map((p) => ({ partNumber: p.part_number, etag: p.etag }))
    });
    const verified = await r2.verifyObject(upload.object_key, upload.file_size);
    if (!verified.exists || verified.size !== upload.file_size) {
      await db.updateUpload(uploadId, {
        status: "failed",
        error_message: "Size mismatch after completion"
      });
      return c.json(createApiResponse(false, void 0, "Upload verification failed"), 500);
    }
    await db.updateUpload(uploadId, {
      status: "uploaded",
      completed_etag: verified.etag,
      completed_size: verified.size
    });
    return c.json(createApiResponse(true, {
      uploadId: upload.id,
      objectKey: upload.object_key,
      etag: verified.etag,
      size: verified.size
    }));
  } catch (error) {
    await db.updateUpload(uploadId, {
      status: "failed",
      error_message: error instanceof Error ? error.message : "Completion failed"
    });
    return c.json(createApiResponse(false, void 0, "Failed to complete upload"), 500);
  }
});
api.post("/upload/abort", async (c) => {
  const user = c.get("telegramUser");
  const body = await c.req.json();
  const { uploadId } = body;
  if (!uploadId) {
    return c.json(createApiResponse(false, void 0, "Missing uploadId"), 400);
  }
  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, void 0, "Upload not found"), 404);
  }
  if (upload.multipart_upload_id) {
    const r2 = new R2Uploader(c.env);
    await r2.abortMultipartUpload(upload.object_key, upload.multipart_upload_id);
  }
  await db.updateUpload(uploadId, { status: "aborted", error_message: "Aborted by user" });
  await db.deleteUploadParts(uploadId);
  return c.json(createApiResponse(true, { ok: true }));
});
api.get("/upload/status/:uploadId", async (c) => {
  const user = c.get("telegramUser");
  const uploadId = c.req.param("uploadId");
  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  if (!upload || upload.telegram_user_id !== user.id) {
    return c.json(createApiResponse(false, void 0, "Upload not found"), 404);
  }
  const parts = await db.getUploadParts(uploadId);
  const uploadedBytes = parts.reduce((sum, p) => sum + (p.size || 0), 0);
  const percentage = upload.file_size > 0 ? Math.round(uploadedBytes / upload.file_size * 100) : 0;
  const response = {
    upload,
    parts,
    progress: {
      uploadedBytes,
      totalBytes: upload.file_size,
      percentage
    }
  };
  return c.json(createApiResponse(true, response));
});
api.get("/uploads", async (c) => {
  const user = c.get("telegramUser");
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const db = new Database(c.env.DB, c.env);
  const uploads = await db.getUserUploads(user.id, limit, offset);
  const response = { uploads };
  return c.json(createApiResponse(true, response));
});
api.get("/user/profile", async (c) => {
  const user = c.get("telegramUser");
  const db = new Database(c.env.DB, c.env);
  const profile = await db.getUser(user.id);
  return c.json(createApiResponse(true, profile));
});
api.post("/user/profile", async (c) => {
  const user = c.get("telegramUser");
  const body = await c.req.json();
  const db = new Database(c.env.DB, c.env);
  const profile = await db.updateUser(user.id, body);
  return c.json(createApiResponse(true, profile));
});
api.get("/health", (c) => {
  return c.json(createApiResponse(true, { status: "ok", timestamp: Date.now() }));
});
var internalApi = new Hono();
internalApi.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(createApiResponse(false, void 0, "Missing or invalid authorization"), 401);
  }
  const token = authHeader.substring(7);
  if (token !== c.env.WORKER_SECRET) {
    return c.json(createApiResponse(false, void 0, "Invalid worker secret"), 401);
  }
  await next();
});
internalApi.get("/jobs/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const db = new Database(c.env.DB, c.env);
  const job = await db.getJob(jobId);
  if (!job) {
    return c.json(createApiResponse(false, void 0, "Job not found"), 404);
  }
  return c.json(createApiResponse(true, job));
});
internalApi.post("/jobs/:jobId/complete", async (c) => {
  const jobId = c.req.param("jobId");
  const body = await c.req.json();
  const { clips, status, error_message } = body;
  if (!clips || !Array.isArray(clips) || !status) {
    return c.json(createApiResponse(false, void 0, "Missing required fields"), 400);
  }
  const db = new Database(c.env.DB, c.env);
  const job = await db.getJob(jobId);
  if (!job) {
    return c.json(createApiResponse(false, void 0, "Job not found"), 404);
  }
  const updates = {
    status,
    clip_count: clips.length,
    completed_at: Date.now()
  };
  if (error_message) {
    updates.error_message = error_message;
  }
  const updatedJob = await db.updateJob(jobId, updates);
  return c.json(createApiResponse(true, updatedJob));
});
internalApi.post("/jobs", async (c) => {
  const body = await c.req.json();
  const { uploadId, telegramUserId, aspectRatio, captionStyle, enableTighten, enableLoudnorm } = body;
  if (!uploadId || !telegramUserId) {
    return c.json(createApiResponse(false, void 0, "Missing required fields"), 400);
  }
  const db = new Database(c.env.DB, c.env);
  const upload = await db.getUpload(uploadId);
  if (!upload) {
    return c.json(createApiResponse(false, void 0, "Upload not found"), 404);
  }
  const jobId = `job_${Date.now()}_${telegramUserId}`;
  const job = await db.createJob({
    id: jobId,
    upload_id: uploadId,
    telegram_user_id: telegramUserId,
    status: "pending",
    aspect_ratio: aspectRatio || "9:16",
    caption_style: captionStyle || "default",
    enable_tighten: enableTighten ? 1 : 0,
    enable_loudnorm: enableLoudnorm ? 1 : 0,
    clip_count: 0,
    error_message: null,
    completed_at: null
  });
  try {
    await dispatchWorkflow(c.env, jobId, uploadId, telegramUserId);
  } catch (e) {
    console.error("Failed to dispatch workflow:", e);
  }
  return c.json(createApiResponse(true, job));
});
async function dispatchWorkflow(env, jobId, uploadId, telegramUserId) {
  const githubToken = env.GITHUB_TOKEN;
  const githubRepo = env.GITHUB_REPO || "Dopeteck/telegram-video-clipper";
  if (!githubToken) {
    console.warn("GITHUB_TOKEN not configured, skipping workflow dispatch");
    return;
  }
  const upload = await (await Promise.resolve().then(() => (init_db(), db_exports))).Database.prototype.getUpload.call(new (await Promise.resolve().then(() => (init_db(), db_exports))).Database(env.DB, env), uploadId);
  const response = await fetch(`https://api.github.com/repos/${githubRepo}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${githubToken}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      event_type: "process-video",
      client_payload: {
        job_id: jobId,
        upload_id: uploadId,
        telegram_user_id: telegramUserId,
        object_key: upload?.object_key || `uploads/${telegramUserId}/${uploadId}/`
      }
    })
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${error}`);
  }
  console.log(`Dispatched process-video workflow for job ${jobId}`);
}

// src/bot.ts
init_utils();
init_db();
var HELP_MESSAGE = `
\u{1F3AC} <b>Telegram Video Clipper Bot</b>

<b>Main Features:</b>
\u2022 Upload long videos directly from your phone
\u2022 Videos are stored securely in private Cloudflare R2
\u2022 Track upload progress in real-time
\u2022 Resume interrupted uploads
\u2022 Process videos into clips with Chopify

<b>How to Use:</b>
1. Tap <b>\u{1F3AC} Upload Video</b> to open the Mini App
2. Select a video from your gallery or record one
3. Watch the upload progress
4. Tap "Start Processing" on completed uploads
5. Receive finished clips in Telegram

<b>Supported Formats:</b> MP4, MOV, MKV, WebM, M4V, AVI
<b>Max File Size:</b> 2 GB

For support, contact the bot administrator.
`;
var SETTINGS_MESSAGE = `
\u2699\uFE0F <b>Settings</b>

<b>Default Processing Options:</b>
These will be applied to future video processing jobs.

\u2022 <b>Aspect Ratio:</b> 9:16 (vertical for Shorts/Reels/TikTok)
\u2022 <b>Caption Style:</b> Default
\u2022 <b>Remove Filler Words:</b> Off
\u2022 <b>Audio Normalization:</b> Off

<i>Processing features coming in future updates.</i>
`;
var TelegramBot = class {
  db;
  r2;
  botToken;
  webhookSecret;
  appOrigin;
  maxUploadBytes;
  chunkSize;
  constructor(env) {
    this.botToken = env.TELEGRAM_BOT_TOKEN;
    this.webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
    this.appOrigin = env.APP_ORIGIN;
    this.maxUploadBytes = parseInt(env.MAX_UPLOAD_BYTES || "2147483648", 10);
    this.chunkSize = parseInt(env.CHUNK_SIZE || "5242880", 10);
    this.db = new Database(env.DB, env);
    this.r2 = new R2Uploader(env);
  }
  async handleWebhook(update) {
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
  async handleMessage(message) {
    const userId = message.from?.id;
    const chatId = message.chat.id;
    if (!userId) return createApiResponse(false, void 0, "No user ID");
    await this.upsertUser(message.from);
    const keyboard = this.getMainKeyboard();
    if (message.text === "/start") {
      return this.sendWelcomeMessage(chatId, userId);
    }
    if (message.text === "/help") {
      return this.sendMessage(chatId, HELP_MESSAGE, { parse_mode: "HTML", reply_markup: keyboard });
    }
    if (message.text === "/settings") {
      return this.sendMessage(chatId, SETTINGS_MESSAGE, { parse_mode: "HTML", reply_markup: keyboard });
    }
    if (message.text === "/uploads") {
      return this.showUserUploads(chatId, userId);
    }
    if (message.text === "\u{1F3AC} Upload Video") {
      return this.sendMessage(chatId, "Tap the button below to upload a video:", { reply_markup: keyboard });
    }
    if (message.text === "\u{1F4C2} My Uploads") {
      return this.showUserUploads(chatId, userId);
    }
    if (message.text === "\u2699\uFE0F Settings") {
      return this.sendMessage(chatId, SETTINGS_MESSAGE, { parse_mode: "HTML", reply_markup: keyboard });
    }
    if (message.text === "\u2753 Help") {
      return this.sendMessage(chatId, HELP_MESSAGE, { parse_mode: "HTML", reply_markup: keyboard });
    }
    if (message.document || message.video) {
      return this.handleMediaUpload(message, userId, chatId);
    }
    return this.sendMessage(chatId, "Use the buttons below or type /help for instructions.", { reply_markup: keyboard });
  }
  async handleCallbackQuery(query) {
    const userId = query.from.id;
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const data = query.data;
    if (!chatId || !messageId || !data) {
      return createApiResponse(false, void 0, "Invalid callback query");
    }
    await this.answerCallbackQuery(query.id);
    switch (data) {
      case "my_uploads":
        return this.showUserUploads(chatId, userId, messageId);
      case "settings":
        return this.editMessage(chatId, messageId, SETTINGS_MESSAGE, { parse_mode: "HTML" });
      case "help":
        return this.editMessage(chatId, messageId, HELP_MESSAGE, { parse_mode: "HTML" });
      case "upload_video":
        return this.sendMessage(chatId, "Tap the button below to upload a video:", {
          reply_markup: this.getMainKeyboard()
        });
      default:
        if (data.startsWith("upload_")) {
          return this.handleUploadAction(chatId, messageId, userId, data);
        }
        if (data.startsWith("job_")) {
          return this.handleJobAction(chatId, messageId, userId, data);
        }
    }
    return createApiResponse(true, { ok: true });
  }
  async handleInlineQuery(query) {
    return createApiResponse(true, { results: [] });
  }
  async handleMediaUpload(message, userId, chatId) {
    const media = message.document || message.video;
    if (!media) return createApiResponse(false, void 0, "No media found");
    const fileName = media.file_name || `video_${Date.now()}${getExtensionFromMimeType(media.mime_type || "video/mp4")}`;
    const mimeType = media.mime_type || "video/mp4";
    const fileSize = media.file_size || 0;
    if (!validateMimeType(mimeType)) {
      return this.sendMessage(chatId, "\u274C Unsupported file type. Please upload MP4, MOV, MKV, WebM, M4V, or AVI files.");
    }
    if (!validateFileExtension(fileName)) {
      return this.sendMessage(chatId, "\u274C Unsupported file extension.");
    }
    if (fileSize > this.maxUploadBytes) {
      return this.sendMessage(chatId, `\u274C File too large. Maximum size is 2 GB.`);
    }
    if (fileSize === 0) {
      return this.sendMessage(chatId, "\u274C Empty file. Please upload a valid video.");
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
      status: "uploading"
    });
    const initResponse = await this.r2.initiateMultipartUpload(objectKey, mimeType, totalParts);
    await this.db.updateUpload(uploadId, { multipart_upload_id: initResponse.uploadId });
    const keyboard = this.getMainKeyboard();
    const uploadButtonKeyboard = {
      inline_keyboard: [
        [{ text: "\u{1F680} Start Upload", web_app: { url: `${this.appOrigin}/miniapp/upload?upload_id=${uploadId}` } }],
        [{ text: "\u274C Cancel", callback_data: `upload_cancel_${uploadId}` }]
      ]
    };
    return this.sendMessage(chatId, `\u{1F4E4} <b>Upload Ready</b>

File: <code>${fileName}</code>
Size: ${this.formatBytes(fileSize)}

Tap the button below to start uploading:`, {
      parse_mode: "HTML",
      reply_markup: uploadButtonKeyboard
    });
  }
  async handleUploadAction(chatId, messageId, userId, action) {
    const [, , actionType, uploadId] = action.split("_");
    const upload = await this.db.getUpload(uploadId);
    if (!upload || upload.telegram_user_id !== userId) {
      return this.editMessage(chatId, messageId, "\u274C Upload not found or access denied.");
    }
    switch (actionType) {
      case "cancel":
        if (upload.multipart_upload_id) {
          await this.r2.abortMultipartUpload(upload.object_key, upload.multipart_upload_id);
        }
        await this.db.updateUpload(uploadId, { status: "aborted", error_message: "Cancelled by user" });
        return this.editMessage(chatId, messageId, "\u274C Upload cancelled.");
      case "retry":
        if (upload.status !== "failed" && upload.status !== "aborted") {
          return this.editMessage(chatId, messageId, "\u274C Can only retry failed or cancelled uploads.");
        }
        const totalParts = Math.ceil(upload.file_size / this.chunkSize);
        const initResponse = await this.r2.initiateMultipartUpload(upload.object_key, upload.mime_type, totalParts);
        await this.db.updateUpload(uploadId, {
          status: "uploading",
          multipart_upload_id: initResponse.uploadId,
          error_message: null
        });
        await this.db.deleteUploadParts(uploadId);
        return this.editMessage(chatId, messageId, `\u{1F504} <b>Upload Ready for Retry</b>

File: <code>${upload.original_filename}</code>
Size: ${this.formatBytes(upload.file_size)}

Tap the button below to resume:`, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "\u{1F680} Resume Upload", web_app: { url: `${this.appOrigin}/miniapp/upload?upload_id=${uploadId}` } }],
              [{ text: "\u274C Cancel", callback_data: `upload_cancel_${uploadId}` }]
            ]
          }
        });
      case "process":
        if (upload.status !== "uploaded") {
          return this.editMessage(chatId, messageId, "\u274C Can only process completed uploads.");
        }
        try {
          const response = await fetch(`${this.appOrigin}/api/internal/jobs`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${this.webhookSecret}`
            },
            body: JSON.stringify({
              uploadId: upload.id,
              telegramUserId: userId,
              aspectRatio: "9:16",
              captionStyle: "default",
              enableTighten: false,
              enableLoudnorm: false
            })
          });
          const result = await response.json();
          if (!result.ok) throw new Error(result.error || "Failed to create job");
          const job = result.data;
          await this.dispatchWorkflow(job.id, upload.id, userId);
          return this.editMessage(chatId, messageId, `\u2705 <b>Processing Started</b>

Job ID: <code>${job.id}</code>
File: <code>${upload.original_filename}</code>

You'll receive the clips when processing completes.`, {
            parse_mode: "HTML",
            reply_markup: this.getMainKeyboard()
          });
        } catch (e) {
          return this.editMessage(chatId, messageId, `\u274C Failed to start processing: ${e instanceof Error ? e.message : "Unknown error"}`);
        }
    }
    return createApiResponse(true, { ok: true });
  }
  async dispatchWorkflow(jobId, uploadId, userId) {
    console.log(`Would dispatch workflow for job ${jobId}, upload ${uploadId}, user ${userId}`);
  }
  async handleJobAction(chatId, messageId, userId, action) {
    const [, actionType, jobId] = action.split("_");
    const db = this.db;
    const job = await db.getJob(jobId);
    if (!job || job.telegram_user_id !== userId) {
      return this.editMessage(chatId, messageId, "\u274C Job not found or access denied.");
    }
    switch (actionType) {
      case "progress":
        return this.editMessage(chatId, messageId, `\u{1F4CA} <b>Job Progress</b>

Job ID: <code>${job.id}</code>
Status: ${job.status}
Clips: ${job.clip_count}`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "\u{1F519} Back", callback_data: "my_uploads" }]] }
        });
      case "cancel":
        if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
          return this.editMessage(chatId, messageId, "\u274C Cannot cancel completed/failed/cancelled job.");
        }
        await db.updateJob(jobId, { status: "cancelled", error_message: "Cancelled by user" });
        return this.editMessage(chatId, messageId, "\u274C Job cancelled.", { reply_markup: this.getMainKeyboard() });
      case "retry":
        if (job.status !== "failed" && job.status !== "cancelled") {
          return this.editMessage(chatId, messageId, "\u274C Can only retry failed or cancelled jobs.");
        }
        await db.updateJob(jobId, { status: "pending", error_message: null });
        await this.dispatchWorkflow(jobId, job.upload_id, userId);
        return this.editMessage(chatId, messageId, "\u{1F504} Job queued for retry.", { reply_markup: this.getMainKeyboard() });
      case "download":
        return this.editMessage(chatId, messageId, "\u{1F4E5} Download links would be provided here when clips are ready.", {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "\u{1F519} Back", callback_data: "my_uploads" }]] }
        });
      case "delete":
        return this.editMessage(chatId, messageId, "\u26A0\uFE0F <b>Confirm Delete</b>\n\nThis will permanently delete the job and all associated clips.\n\nAre you sure?", {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "\u2705 Yes, Delete", callback_data: `job_confirm_delete_${jobId}` }],
              [{ text: "\u274C No", callback_data: "my_uploads" }]
            ]
          }
        });
      case "confirm_delete":
        await db.updateJob(jobId, { status: "cancelled", error_message: "Deleted by user" });
        return this.editMessage(chatId, messageId, "\u{1F5D1}\uFE0F Job and clips deleted.", { reply_markup: this.getMainKeyboard() });
    }
    return createApiResponse(true, { ok: true });
  }
  async showUserUploads(chatId, userId, messageId) {
    const uploads = await this.db.getUserUploads(userId, 10);
    if (uploads.length === 0) {
      const text2 = '\u{1F4C2} <b>My Uploads</b>\n\nNo uploads yet. Tap "\u{1F3AC} Upload Video" to get started!';
      if (messageId) {
        return this.editMessage(chatId, messageId, text2, { parse_mode: "HTML" });
      }
      return this.sendMessage(chatId, text2, { parse_mode: "HTML" });
    }
    let text = "\u{1F4C2} <b>My Uploads</b>\n\n";
    const keyboard = [];
    for (const upload of uploads) {
      const statusEmoji = this.getStatusEmoji(upload.status);
      text += `${statusEmoji} <code>${upload.original_filename}</code> \u2014 ${this.formatBytes(upload.file_size)} \u2014 ${this.formatDate(upload.created_at)}
`;
      if (upload.status === "uploading" || upload.status === "failed" || upload.status === "aborted") {
        keyboard.push([
          { text: `\u{1F504} ${upload.original_filename.substring(0, 20)}`, callback_data: `upload_retry_${upload.id}` },
          { text: "\u274C", callback_data: `upload_cancel_${upload.id}` }
        ]);
      } else if (upload.status === "uploaded") {
        keyboard.push([
          { text: `\u25B6\uFE0F Process ${upload.original_filename.substring(0, 20)}`, callback_data: `upload_process_${upload.id}` },
          { text: "\u274C", callback_data: `upload_cancel_${upload.id}` }
        ]);
      }
    }
    keyboard.push([{ text: "\u{1F3AC} Upload New Video", callback_data: "upload_video" }]);
    if (messageId) {
      return this.editMessage(chatId, messageId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
    }
    return this.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
  }
  getStatusEmoji(status) {
    switch (status) {
      case "uploading":
        return "\u{1F4E4}";
      case "uploaded":
        return "\u2705";
      case "aborted":
        return "\u274C";
      case "expired":
        return "\u23F0";
      case "failed":
        return "\u{1F4A5}";
      default:
        return "\u2753";
    }
  }
  formatDate(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }
  async upsertUser(user) {
    await this.db.createUser({
      telegram_user_id: user.id,
      first_name: user.first_name,
      last_name: user.last_name ?? null,
      username: user.username ?? null,
      language_code: user.language_code ?? null,
      preferred_aspect_ratio: "9:16",
      preferred_caption_style: "default",
      enable_tighten: 0,
      enable_loudnorm: 0
    });
  }
  async sendWelcomeMessage(chatId, userId) {
    const text = `\u{1F44B} Welcome to <b>Telegram Video Clipper</b>!

Upload long videos from your phone and get them ready for Shorts, Reels, and TikTok.

<i>Powered by Chopify \u2014 100% local, free video clipping.</i>`;
    return this.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: this.getMainKeyboard() });
  }
  getMainKeyboard() {
    return {
      keyboard: [
        [{ text: "\u{1F3AC} Upload Video", web_app: { url: `${this.appOrigin}/miniapp/upload` } }],
        [{ text: "\u{1F4C2} My Uploads" }],
        [{ text: "\u2699\uFE0F Settings" }],
        [{ text: "\u2753 Help" }]
      ],
      resize_keyboard: true,
      persistent: true,
      one_time_keyboard: false
    };
  }
  async sendMessage(chatId, text, options = {}) {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...options })
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }
  async editMessage(chatId, messageId, text, options = {}) {
    const url = `https://api.telegram.org/bot${this.botToken}/editMessageText`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...options })
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }
  async answerCallbackQuery(callbackQueryId, text) {
    const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }
  async setWebhook(url) {
    const webhookUrl = `${url}/telegram/webhook`;
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: this.webhookSecret })
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }
  async deleteWebhook() {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/deleteWebhook`, { method: "POST" });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }
  async setMyCommands() {
    const commands = [
      { command: "start", description: "Start the bot and show main menu" },
      { command: "help", description: "Show help message" },
      { command: "settings", description: "Configure processing preferences" },
      { command: "uploads", description: "View your upload history" }
    ];
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands })
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }
  async setMenuButton() {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        menu_button: {
          type: "web_app",
          text: "\u{1F3AC} Upload Video",
          web_app: { url: `${this.appOrigin}/miniapp/upload` }
        }
      })
    });
    const data = await response.json();
    return createApiResponse(data.ok, data, data.description);
  }
};

// src/index.ts
var app = new Hono2();
app.use("*", cors({
  origin: ["https://*.telegram.org", "https://web.telegram.org", "https://telegram.org"],
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true
}));
app.route("/api", api);
app.route("/api/internal", internalApi);
app.post("/telegram/webhook", async (c) => {
  const secretToken = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (secretToken !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ ok: false, error: "Invalid webhook secret" }, 401);
  }
  const update = await c.req.json();
  const bot = new TelegramBot(c.env);
  const result = await bot.handleWebhook(update);
  return c.json(result);
});
app.get("/telegram/setup", async (c) => {
  const bot = new TelegramBot(c.env);
  const webhookResult = await bot.setWebhook(c.env.APP_ORIGIN);
  const commandsResult = await bot.setMyCommands();
  const menuResult = await bot.setMenuButton();
  return c.json({ webhook: webhookResult, commands: commandsResult, menu: menuResult });
});
app.get("/upload*", async (c) => {
  return c.redirect(`${c.env.APP_ORIGIN}/miniapp${c.req.path.replace("/upload", "")}${c.req.query() ? "?" + c.req.query() : ""}`);
});
app.get("*", (c) => {
  return c.notFound();
});
var index_default = app;
export {
  index_default as default
};
