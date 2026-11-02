-- Migration 0001: Create uploads table
-- Tracks multipart video uploads from Telegram Mini App

CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    telegram_user_id INTEGER NOT NULL,
    telegram_chat_id INTEGER,
    original_filename TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    multipart_upload_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('uploading', 'uploaded', 'aborted', 'expired', 'failed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    completed_etag TEXT,
    completed_size INTEGER,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);
CREATE INDEX IF NOT EXISTS idx_uploads_expires ON uploads(expires_at);
CREATE INDEX IF NOT EXISTS idx_uploads_multipart ON uploads(multipart_upload_id);

-- Migration 0001: Create upload_parts table
-- Tracks individual parts of multipart uploads for resumption

CREATE TABLE IF NOT EXISTS upload_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    etag TEXT,
    size INTEGER,
    uploaded_at INTEGER,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_parts_unique ON upload_parts(upload_id, part_number);
CREATE INDEX IF NOT EXISTS idx_upload_parts_upload ON upload_parts(upload_id);

-- Migration 0001: Create users table
-- Stores Telegram user preferences and settings

CREATE TABLE IF NOT EXISTS users (
    telegram_user_id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    language_code TEXT,
    preferred_aspect_ratio TEXT DEFAULT '9:16',
    preferred_caption_style TEXT DEFAULT 'default',
    enable_tighten INTEGER DEFAULT 0,
    enable_loudnorm INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Migration 0001: Create jobs table
-- Tracks video processing jobs (for future phases)

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    upload_id TEXT NOT NULL,
    telegram_user_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
    aspect_ratio TEXT NOT NULL DEFAULT '9:16',
    caption_style TEXT NOT NULL DEFAULT 'default',
    enable_tighten INTEGER DEFAULT 0,
    enable_loudnorm INTEGER DEFAULT 0,
    clip_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_upload ON jobs(upload_id);