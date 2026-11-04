import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSignedUrl = vi.fn();
const mockGetObjectCommand = vi.fn();

beforeEach(() => {
  vi.doMock('@aws-sdk/client-s3', () => ({
    S3Client: class {},
    GetObjectCommand: mockGetObjectCommand,
    HeadObjectCommand: class {},
    CreateMultipartUploadCommand: class {},
    UploadPartCommand: class {},
    CompleteMultipartUploadCommand: class {},
    AbortMultipartUploadCommand: class {},
  }));
  vi.doMock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: mockGetSignedUrl,
  }));
});

afterEach(() => {
  vi.unmock('@aws-sdk/client-s3');
  vi.unmock('@aws-sdk/s3-request-presigner');
  mockGetSignedUrl.mockClear();
  mockGetObjectCommand.mockClear();
});

describe('R2Uploader.generatePresignedGetObjectUrl (real implementation)', () => {
  it('generates presigned GetObject URL using genuine SDK command', async () => {
    mockGetObjectCommand.mockImplementation(function (this: any, input: any) {
      this.input = input;
    });
    mockGetSignedUrl.mockResolvedValue('https://example.com/presigned?key=test-bucket%2Fuploads%2F1001%2Fclip.mp4');

    const { R2Uploader } = await vi.importActual('../src/r2');
    const uploader = new R2Uploader({
      R2_BUCKET_NAME: 'test-bucket',
      R2_ACCOUNT_ID: 'test-account',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
    } as any);

    const result = await uploader.generatePresignedGetObjectUrl('uploads/1001/clip.mp4', 900);

    expect(mockGetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'uploads/1001/clip.mp4',
    });
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expiresIn: 900 })
    );
    expect(result.url).toBe('https://example.com/presigned?key=test-bucket%2Fuploads%2F1001%2Fclip.mp4');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });
});
