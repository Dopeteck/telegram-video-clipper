## Root Cause

The production video processing fails with:

```
botocore.exceptions.ClientError: An error occurred (403) when calling the HeadObject operation: Forbidden
```

This happens because GitHub Actions uses its own separate R2 credentials to download the original video, but those credentials lack permission to access the object uploaded by the Cloudflare Worker (which uses different credentials).

## Solution

**Architectural change:** Remove GitHub Actions' dependency on its own R2 credentials for downloading the original video.

1. **Worker generates a short-lived, read-only presigned GetObject URL** for the original uploaded video (~15 min expiry)
2. **GitHub Actions authenticates to Worker** using existing WORKER_SECRET
3. **GitHub Actions requests download URL** for the specific job via GET /api/internal/jobs/:jobId/download-url
4. **Worker validates**: job exists -> upload exists -> upload belongs to job's user -> upload status is uploaded
5. **Worker generates presigned URL** for the exact database object key
6. **GitHub Actions downloads** directly from presigned URL via HTTP streaming
6. **Existing Chopify pipeline** runs normally

## Changes

### Worker
- worker/src/r2.ts: Added generatePresignedGetObjectUrl(key, expiresIn=900) method
- worker/src/types.ts: Added PresignedGetObjectResponse interface
- worker/src/api.ts: Added GET /api/internal/jobs/:jobId/download-url endpoint (WORKER_SECRET auth)
- worker/src/r2.ts: Workaround for GetObjectCommand type issue (exists at runtime but not in types)

### GitHub Actions (.github/workflows/process-video.yml)
- Removed R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY env vars
- Removed boto3 HeadObject/download_file calls
- Added Get download URL from Worker step (calls Worker endpoint)
- Added Download video from presigned URL step (HTTP streaming via requests.get)
- Preserved clip uploads using existing GitHub R2 write credentials

### Tests
- Added 12 new tests for /api/internal/jobs/:jobId/download-url endpoint:
  - Auth validation (401 for missing/wrong/empty secrets)
  - 404 for unknown job, missing upload
  - 403 for ownership mismatch
  - 409 for non-uploaded status
  - 200 with valid presigned URL for exact database object key
- Updated workflow tests (tests/test_workflows.py) to verify:
  - New steps exist (Get download URL from Worker, Download video from presigned URL)
  - Old boto3 download step removed
  - No R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY used for download
  - HTTP streaming download with requests.get(stream=True)
  - Worker download URL endpoint called correctly

## Test Results
- Worker: 81 tests pass (including 12 new download URL tests)
- Miniapp: 8 tests pass
- Workflow YAML guards: 12 tests pass
- Worker typecheck: passes (only pre-existing TS7006 errors on Hono context params)
- Worker build: fails on pre-existing TS7006 errors (Hono context params) - not introduced by this PR

## Clip Uploads
Preserved: Clip uploads still use GitHub Actions' R2 write credentials (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) - this is a separate concern and was not part of the 403 failure. A future PR can migrate clip uploads to Worker-generated presigned PUT URLs.

## Remaining Manual Steps
After merging to main:
1. Deploy Worker: cd worker && npx wrangler deploy
2. Deploy Mini App (Cloudflare Pages)
3. Test end-to-end: upload video via Mini App -> process -> verify GitHub Actions run starts

Do not merge until reviewed.