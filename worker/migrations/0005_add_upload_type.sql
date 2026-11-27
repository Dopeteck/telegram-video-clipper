-- Migration 0005: distinguish B-roll uploads from source videos.
-- Existing rows remain normal video uploads by default.
ALTER TABLE uploads ADD COLUMN upload_type TEXT NOT NULL DEFAULT 'video'
  CHECK (upload_type IN ('video', 'broll'));

CREATE INDEX IF NOT EXISTS idx_uploads_type_user
  ON uploads(upload_type, telegram_user_id, created_at);
