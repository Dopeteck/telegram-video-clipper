-- Migration 0002: Add github_run_url to jobs table
-- Stores the GitHub Actions run URL for job tracking

ALTER TABLE jobs ADD COLUMN github_run_url TEXT;

-- Migration 0002: Add index for job status queries
CREATE INDEX IF NOT EXISTS idx_jobs_github_run ON jobs(github_run_url);