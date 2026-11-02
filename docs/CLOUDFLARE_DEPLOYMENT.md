# Cloudflare Configuration & Deployment Guide

## Overview

This document describes how to configure and deploy the Cloudflare Worker, R2 bucket, D1 database, and Telegram bot for the Telegram Video Clipper project.

## Prerequisites

- Cloudflare account with Workers paid plan (for D1 and R2)
- Telegram Bot token from @BotFather
- Domain or subdomain (optional, can use `*.workers.dev`)

## 1. Create Cloudflare Resources

### R2 Bucket

```bash
# Create private R2 bucket for video uploads
wrangler r2 bucket create telegram-video-clipper-uploads

# Verify bucket exists
wrangler r2 bucket list
```

### D1 Database

```bash
# Create D1 database
wrangler d1 create telegram-video-clipper

# Note the database_id from output, update wrangler.toml
```

### Apply Migrations

```bash
# Apply migrations locally first
wrangler d1 migrations apply telegram-video-clipper --local

# Then apply to production
wrangler d1 migrations apply telegram-video-clipper --remote
```

## 2. Configure R2 CORS

The Mini App needs CORS headers to upload directly to R2. Configure CORS on the bucket:

```bash
# Create cors.json
cat > cors.json << 'EOF'
[
  {
    "AllowedOrigins": ["https://*.telegram.org", "https://web.telegram.org", "https://telegram.org"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 3600
  }
]
EOF

# Apply CORS configuration
wrangler r2 bucket cors put telegram-video-clipper-uploads --file cors.json

# Verify CORS
wrangler r2 bucket cors get telegram-video-clipper-uploads
```

**Important**: The `ExposeHeaders: ["ETag"]` is required for the browser to read the ETag response header after each part upload.

## 3. Generate Secrets

```bash
# Generate webhook secret (32 bytes hex)
openssl rand -hex 32

# Generate session secret (32 bytes hex)
openssl rand -hex 32
```

## 4. Configure Worker Secrets

```bash
# Set secrets in Cloudflare Workers
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put SESSION_SECRET
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY

# Verify secrets are set
wrangler secret list
```

## 5. Create R2 API Token

1. Go to Cloudflare Dashboard → R2 → Manage R2 API Tokens
2. Create token with Object Read & Write permissions for the bucket
3. Note the Access Key ID and Secret Access Key
4. Set as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets

## 6. Configure Telegram Bot

### Set Bot Commands

```bash
# Using the worker endpoint
curl -X POST "https://your-worker.your-subdomain.workers.dev/telegram/setup"
```

Or manually via BotFather:
```
/setcommands
start - Start the bot and show main menu
help - Show help message
settings - Configure processing preferences
uploads - View your upload history
```

### Set Menu Button

The `/telegram/setup` endpoint also configures the menu button to launch the Mini App.

### Configure Webhook

The webhook URL should be:
```
https://your-worker.your-subdomain.workers.dev/telegram/webhook
```

Telegram will send updates to this endpoint with the `X-Telegram-Bot-Api-Secret-Token` header.

## 7. Deploy Worker

### Development

```bash
cd worker
npm run dev
# Worker runs at http://localhost:8787
```

### Production

```bash
cd worker
npm run deploy
# Or: wrangler deploy
```

### Verify Deployment

```bash
# Check worker is running
curl https://your-worker.your-subdomain.workers.dev/api/health

# Test webhook setup
curl -X POST https://your-worker.your-subdomain.workers.dev/telegram/setup
```

## 8. Deploy Mini App

### Build

```bash
cd miniapp
npm run build
# Output in miniapp/dist/
```

### Deploy to Cloudflare Pages

1. Connect GitHub repository to Cloudflare Pages
2. Build command: `cd miniapp && npm run build`
3. Output directory: `miniapp/dist`
4. Custom domain (optional): `miniapp.yourdomain.com`

### Or Deploy to Workers Sites

```bash
# In worker directory
wrangler pages deploy ../miniapp/dist --project-name=telegram-video-clipper-miniapp
```

## 9. Environment Variables Reference

### Worker (wrangler.toml / .dev.vars)

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | Yes |
| `TELEGRAM_WEBHOOK_SECRET` | Secret for webhook validation (32 bytes hex) | Yes |
| `SESSION_SECRET` | Session encryption secret (32 bytes hex) | Yes |
| `R2_ACCOUNT_ID` | Cloudflare account ID | Yes |
| `R2_BUCKET` | R2 bucket name | Yes |
| `R2_ACCESS_KEY_ID` | R2 API token access key | Yes |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret key | Yes |
| `APP_ORIGIN` | Worker URL (e.g., https://worker.subdomain.workers.dev) | Yes |
| `MAX_UPLOAD_BYTES` | Max file size in bytes (default: 2GB) | No |
| `CHUNK_SIZE` | Multipart chunk size in bytes (default: 5MB) | No |
| `MAX_CONCURRENT_CHUNKS` | Max concurrent chunk uploads (default: 3) | No |
| `UPLOAD_EXPIRY_HOURS` | Upload session expiry (default: 24) | No |
| `CLEANUP_INTERVAL_MINUTES` | Cleanup cron interval (default: 60) | No |
| `MAX_CONCURRENT_UPLOADS_PER_USER` | Max concurrent uploads per user (default: 2) | No |
| `RATE_LIMIT_WINDOW_SECONDS` | Rate limit window (default: 60) | No |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window (default: 30) | No |

### Mini App (Vite env)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Worker API base URL |

## 10. Local Development Setup

### 1. Copy example env file

```bash
cd worker
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your values
```

### 2. Start local services

```bash
# Terminal 1: Worker
cd worker
npm run dev

# Terminal 2: Mini App
cd miniapp
npm run dev
```

### 3. Test with ngrok (for Telegram webhook)

```bash
# Expose local worker
ngrok http 8787

# Use ngrok URL for Telegram webhook setup
```

## 11. Monitoring & Debugging

### Worker Logs

```bash
# Tail logs
wrangler tail

# Filter by log level
wrangler tail --format=json | jq 'select(.level=="error")'
```

### D1 Queries

```bash
# Query database
wrangler d1 execute telegram-video-clipper --command "SELECT * FROM uploads LIMIT 10"
```

### R2 Operations

```bash
# List objects
wrangler r2 object list telegram-video-clipper-uploads

# Check object
wrangler r2 object get telegram-video-clipper-uploads uploads/user/id/file.mp4 --head
```

## 12. Production Checklist

- [ ] R2 bucket created and CORS configured
- [ ] D1 database created and migrations applied
- [ ] All secrets set in Cloudflare Workers
- [ ] R2 API token created with correct permissions
- [ ] Telegram bot commands set via BotFather
- [ ] Telegram webhook configured with secret token
- [ ] Worker deployed to production
- [ ] Mini App deployed to Cloudflare Pages
- [ ] Custom domains configured (optional)
- [ ] Health endpoint responding
- [ ] Test upload from Telegram Mini App works
- [ ] Upload progress tracking works
- [ ] Resume/cancel functionality works
- [ ] Upload history displays correctly

## 13. Troubleshooting

### CORS Errors

Ensure R2 bucket CORS includes:
- `AllowedOrigins`: Telegram domains
- `AllowedMethods`: PUT for multipart uploads
- `ExposeHeaders`: ETag for part verification

### Webhook Not Receiving Updates

1. Check webhook URL is correct
2. Verify secret token matches
3. Check worker logs for errors
4. Ensure bot is not blocked

### Upload Fails

1. Check R2 credentials
2. Verify bucket name matches
3. Check file size limits
4. Review worker logs for detailed errors

### Mini App Not Loading

1. Check Pages deployment status
2. Verify API URL in Mini App matches worker
3. Check browser console for errors
4. Ensure Telegram WebApp API is loaded

## 14. Security Considerations

- All secrets stored in Cloudflare Workers secrets (not in code)
- R2 bucket is private (no public access)
- Telegram initData validated on every request
- Upload sessions expire after 24 hours
- Rate limiting applied per user
- Object keys are server-generated (no path traversal)
- Maximum file size enforced
- MIME type and extension validation

## 15. Cost Estimates

| Resource | Free Tier | Paid Estimate (moderate usage) |
|----------|-----------|-------------------------------|
| Workers | 100k requests/day | $5/month |
| R2 Storage | 10 GB | $0.015/GB/month |
| R2 Class A Operations | 1M/month | $4.50/million |
| R2 Class B Operations | 10M/month | $0.36/million |
| D1 Database | 5 GB storage | $0.75/GB/month |
| D1 Reads | 5M/day | $0.001/million |
| D1 Writes | 100k/day | $1.00/million |

Total estimated cost for moderate usage: **$5-15/month**