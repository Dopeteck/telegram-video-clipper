-- Add optional source URL for videos imported directly from YouTube.
-- Existing uploads continue to use their R2 object_key as before.
ALTER TABLE uploads ADD COLUMN source_url TEXT;
