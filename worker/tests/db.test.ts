import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { Database } from '../src/db';

// Mock D1Database
const mockPrepare = vi.fn();
const mockBind = vi.fn();
const mockRun = vi.fn();
const mockFirst = vi.fn();
const mockAll = vi.fn();

const createMockDb = () => {
  mockPrepare.mockReset();
  mockBind.mockReset();
  mockRun.mockReset();
  mockFirst.mockReset();
  mockAll.mockReset();

  mockBind.mockReturnValue({ run: mockRun, first: mockFirst, all: mockAll });
  mockPrepare.mockReturnValue({ bind: mockBind });

  return { prepare: mockPrepare };
};

describe('Database', () => {
  let db: Database;
  let mockD1: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockD1 = createMockDb();
    db = new Database(mockD1 as any);
  });

  describe('createUpload', () => {
    it('should insert upload with all fields', async () => {
      mockFirst.mockResolvedValueOnce({
        id: 'test-id',
        telegram_user_id: 123,
        telegram_chat_id: 456,
        original_filename: 'test.mp4',
        object_key: 'uploads/123/test-id/test.mp4',
        file_size: 1000000,
        mime_type: 'video/mp4',
        multipart_upload_id: null,
        status: 'uploading',
        created_at: 1234567890,
        updated_at: 1234567890,
        expires_at: 1234567890 + 86400000,
        completed_etag: null,
        completed_size: null,
        error_message: null,
      });

      const upload = await db.createUpload({
        telegram_user_id: 123,
        telegram_chat_id: 456,
        original_filename: 'test.mp4',
        object_key: 'uploads/123/test-id/test.mp4',
        file_size: 1000000,
        mime_type: 'video/mp4',
        status: 'uploading',
      });

      expect(mockPrepare).toHaveBeenCalled();
      expect(upload.id).toBe('test-id');
      expect(upload.telegram_user_id).toBe(123);
    });
  });

  describe('getUpload', () => {
    it('should return upload when found', async () => {
      mockFirst.mockResolvedValueOnce({
        id: 'test-id',
        telegram_user_id: 123,
        telegram_chat_id: 456,
        original_filename: 'test.mp4',
        object_key: 'uploads/123/test-id/test.mp4',
        file_size: 1000000,
        mime_type: 'video/mp4',
        multipart_upload_id: null,
        status: 'uploading',
        created_at: 1234567890,
        updated_at: 1234567890,
        expires_at: 1234567890 + 86400000,
        completed_etag: null,
        completed_size: null,
        error_message: null,
      });

      const upload = await db.getUpload('test-id');
      expect(upload).not.toBeNull();
      expect(upload!.id).toBe('test-id');
    });

    it('should return null when not found', async () => {
      mockFirst.mockResolvedValueOnce(null);
      const upload = await db.getUpload('nonexistent');
      expect(upload).toBeNull();
    });
  });

  describe('updateUpload', () => {
    it('should update upload fields', async () => {
      mockRun.mockResolvedValueOnce({ success: true });
      mockFirst.mockResolvedValueOnce({
        id: 'test-id',
        telegram_user_id: 123,
        telegram_chat_id: 456,
        original_filename: 'test.mp4',
        object_key: 'uploads/123/test-id/test.mp4',
        file_size: 1000000,
        mime_type: 'video/mp4',
        multipart_upload_id: 'multipart-123',
        status: 'uploaded',
        created_at: 1234567890,
        updated_at: 1234567900,
        expires_at: 1234567890 + 86400000,
        completed_etag: 'etag123',
        completed_size: 1000000,
        error_message: null,
      });

      const upload = await db.updateUpload('test-id', { 
        status: 'uploaded', 
        multipart_upload_id: 'multipart-123',
        completed_etag: 'etag123',
        completed_size: 1000000,
      });

      expect(upload).not.toBeNull();
      expect(upload!.status).toBe('uploaded');
      expect(upload!.multipart_upload_id).toBe('multipart-123');
    });
  });

  describe('getUserUploads', () => {
    it('should return user uploads', async () => {
      mockAll.mockResolvedValueOnce({
        results: [
          { id: '1', telegram_user_id: 123, status: 'uploaded', created_at: 1000 },
          { id: '2', telegram_user_id: 123, status: 'uploading', created_at: 2000 },
        ],
      });

      const uploads = await db.getUserUploads(123);
      expect(uploads).toHaveLength(2);
      expect(uploads[0].id).toBe('1');
    });
  });

  describe('createUploadPart', () => {
    it('should insert upload part', async () => {
      mockRun.mockResolvedValueOnce({ meta: { last_row_id: 1 } });

      const part = await db.createUploadPart({
        upload_id: 'test-id',
        part_number: 1,
        etag: 'etag123',
        size: 5242880,
      });

      expect(part.id).toBe(1);
      expect(part.part_number).toBe(1);
      expect(part.etag).toBe('etag123');
    });
  });

  describe('getUploadParts', () => {
    it('should return parts ordered by part_number', async () => {
      mockAll.mockResolvedValueOnce({
        results: [
          { id: 1, upload_id: 'test-id', part_number: 1, etag: 'etag1', size: 5242880, uploaded_at: 1000 },
          { id: 2, upload_id: 'test-id', part_number: 2, etag: 'etag2', size: 5242880, uploaded_at: 2000 },
        ],
      });

      const parts = await db.getUploadParts('test-id');
      expect(parts).toHaveLength(2);
      expect(parts[0].part_number).toBe(1);
      expect(parts[1].part_number).toBe(2);
    });
  });

  describe('createUser', () => {
    it('should insert or replace user', async () => {
      mockRun.mockResolvedValueOnce({ success: true });
      mockFirst.mockResolvedValueOnce({
        telegram_user_id: 123,
        first_name: 'John',
        last_name: 'Doe',
        username: 'johndoe',
        language_code: 'en',
        preferred_aspect_ratio: '9:16',
        preferred_caption_style: 'default',
        enable_tighten: 0,
        enable_loudnorm: 0,
        created_at: 1234567890,
        updated_at: 1234567890,
      });

      const user = await db.createUser({
        telegram_user_id: 123,
        first_name: 'John',
        last_name: 'Doe',
        username: 'johndoe',
        language_code: 'en',
        preferred_aspect_ratio: '9:16',
        preferred_caption_style: 'default',
        enable_tighten: 0,
        enable_loudnorm: 0,
      });

      expect(user.telegram_user_id).toBe(123);
      expect(user.username).toBe('johndoe');
    });
  });

  describe('createJob', () => {
    it('should insert job', async () => {
      mockRun.mockResolvedValueOnce({ success: true });
      mockFirst.mockResolvedValueOnce({
        id: 'job-123',
        upload_id: 'upload-123',
        telegram_user_id: 123,
        status: 'pending',
        aspect_ratio: '9:16',
        caption_style: 'default',
        enable_tighten: 0,
        enable_loudnorm: 0,
        clip_count: 0,
        error_message: null,
        created_at: 1234567890,
        updated_at: 1234567890,
        completed_at: null,
      });

      const job = await db.createJob({
        upload_id: 'upload-123',
        telegram_user_id: 123,
        status: 'pending',
        aspect_ratio: '9:16',
        caption_style: 'default',
        enable_tighten: 0,
        enable_loudnorm: 0,
        clip_count: 0,
      });

      expect(job.id).toBe('job-123');
      expect(job.status).toBe('pending');
    });
  });
});