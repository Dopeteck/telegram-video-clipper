import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  validateTelegramInitData, 
  generateId, 
  sanitizeFilename, 
  validateMimeType, 
  validateFileExtension,
  getExtensionFromMimeType,
  formatBytes,
  formatDuration,
  createApiResponse,
  parseInitData
} from '../src/utils';

describe('utils', () => {
  describe('validateTelegramInitData', () => {
    it('should reject empty initData', async () => {
      const result = await validateTelegramInitData('', 'test_token');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing hash parameter');
    });

    it('should reject missing hash', async () => {
      const result = await validateTelegramInitData('user=%7B%22id%22%3A123%7D&auth_date=1234567890', 'test_token');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing hash parameter');
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 1000; i++) {
        ids.add(generateId());
      }
      expect(ids.size).toBe(1000);
    });

    it('should generate 32-character hex strings', () => {
      const id = generateId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('sanitizeFilename', () => {
    it('should replace special characters', () => {
      expect(sanitizeFilename('video<test>.mp4')).toBe('video_test_.mp4');
      expect(sanitizeFilename('my:video*name.mp4')).toBe('my_video_name.mp4');
    });

    it('should collapse multiple dots', () => {
      expect(sanitizeFilename('video...name.mp4')).toBe('video.name.mp4');
    });

    it('should truncate long filenames', () => {
      const longName = 'a'.repeat(300) + '.mp4';
      expect(sanitizeFilename(longName).length).toBe(255);
    });
  });

  describe('validateMimeType', () => {
    it('should accept valid video MIME types', () => {
      expect(validateMimeType('video/mp4')).toBe(true);
      expect(validateMimeType('video/quicktime')).toBe(true);
      expect(validateMimeType('video/x-matroska')).toBe(true);
      expect(validateMimeType('video/webm')).toBe(true);
      expect(validateMimeType('video/x-m4v')).toBe(true);
      expect(validateMimeType('video/x-msvideo')).toBe(true);
    });

    it('should reject invalid MIME types', () => {
      expect(validateMimeType('image/jpeg')).toBe(false);
      expect(validateMimeType('application/pdf')).toBe(false);
      expect(validateMimeType('audio/mp3')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(validateMimeType('VIDEO/MP4')).toBe(true);
      expect(validateMimeType('Video/Quicktime')).toBe(true);
    });
  });

  describe('validateFileExtension', () => {
    it('should accept valid extensions', () => {
      expect(validateFileExtension('video.mp4')).toBe(true);
      expect(validateFileExtension('video.MOV')).toBe(true);
      expect(validateFileExtension('video.mkv')).toBe(true);
      expect(validateFileExtension('video.webm')).toBe(true);
      expect(validateFileExtension('video.m4v')).toBe(true);
      expect(validateFileExtension('video.avi')).toBe(true);
    });

    it('should reject invalid extensions', () => {
      expect(validateFileExtension('video.jpg')).toBe(false);
      expect(validateFileExtension('video.pdf')).toBe(false);
      expect(validateFileExtension('video.txt')).toBe(false);
    });
  });

  describe('getExtensionFromMimeType', () => {
    it('should return correct extensions', () => {
      expect(getExtensionFromMimeType('video/mp4')).toBe('.mp4');
      expect(getExtensionFromMimeType('video/quicktime')).toBe('.mov');
      expect(getExtensionFromMimeType('video/x-matroska')).toBe('.mkv');
      expect(getExtensionFromMimeType('video/webm')).toBe('.webm');
      expect(getExtensionFromMimeType('video/x-m4v')).toBe('.m4v');
      expect(getExtensionFromMimeType('video/x-msvideo')).toBe('.avi');
    });

    it('should return .bin for unknown types', () => {
      expect(getExtensionFromMimeType('application/octet-stream')).toBe('.bin');
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(500)).toBe('500 B');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(1073741824)).toBe('1 GB');
    });
  });

  describe('formatDuration', () => {
    it('should format seconds correctly', () => {
      expect(formatDuration(30)).toBe('0:30');
      expect(formatDuration(90)).toBe('1:30');
      expect(formatDuration(3600)).toBe('1:00:00');
      expect(formatDuration(3661)).toBe('1:01:01');
    });
  });

  describe('createApiResponse', () => {
    it('should create success response', () => {
      const response = createApiResponse(true, { data: 'test' });
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ data: 'test' });
      expect(response.error).toBeUndefined();
    });

    it('should create error response', () => {
      const response = createApiResponse(false, undefined, 'Error message', 'ERROR_CODE');
      expect(response.ok).toBe(false);
      expect(response.data).toBeUndefined();
      expect(response.error).toBe('Error message');
      expect(response.code).toBe('ERROR_CODE');
    });
  });

  describe('parseInitData', () => {
    it('should parse URLSearchParams', () => {
      const initData = 'user=%7B%22id%22%3A123%7D&auth_date=1234567890&hash=abc';
      const result = parseInitData(initData);
      expect(result.user).toBe('{"id":123}');
      expect(result.auth_date).toBe('1234567890');
      expect(result.hash).toBe('abc');
    });
  });
});

describe('API Response Types', () => {
  it('should match expected structure', () => {
    const success: { ok: true; data: { test: string } } = { ok: true, data: { test: 'value' } };
    const error: { ok: false; error: string; code: string } = { ok: false, error: 'Failed', code: 'ERR' };
    
    expect(success.ok).toBe(true);
    expect(error.ok).toBe(false);
  });
});