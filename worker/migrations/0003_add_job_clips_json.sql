-- Store the R2 object keys for generated clips so the Telegram Mini App can download them.
ALTER TABLE jobs ADD COLUMN clips_json TEXT;
