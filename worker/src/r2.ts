import { Env, PresignedUrlResponse, InitiateMultipartResponse, CompleteMultipartRequest } from './types';
import { generateId } from './utils';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class R2Uploader {
  private client: S3Client;
  private bucket: string;
  private accountId: string;
  private accessKeyId: string;
  private secretAccessKey: string;

  constructor(env: Env) {
    this.bucket = env.R2_BUCKET_NAME || 'telegram-video-clipper-uploads';
    this.accountId = env.R2_ACCOUNT_ID;
    this.accessKeyId = env.R2_ACCESS_KEY_ID;
    this.secretAccessKey = env.R2_SECRET_ACCESS_KEY;

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    });
  }

  async initiateMultipartUpload(
    key: string,
    contentType: string,
    totalParts: number,
    expiresIn = 3600
  ): Promise<InitiateMultipartResponse> {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    const response = await this.client.send(command);
    const uploadId = response.UploadId!;

    const partUrls: PresignedUrlResponse[] = [];

    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const partCommand = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const url = await getSignedUrl(this.client, partCommand, { expiresIn });
      partUrls.push({
        uploadId,
        key,
        partNumber,
        url,
        expiresAt: Date.now() + expiresIn * 1000,
      });
    }

    return {
      uploadId,
      key,
      expiresAt: Date.now() + expiresIn * 1000,
      partUrls,
    };
  }

  async generatePartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 3600
  ): Promise<PresignedUrlResponse> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const url = await getSignedUrl(this.client, command, { expiresIn });

    return {
      uploadId,
      key,
      partNumber,
      url,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  async generatePartUploadUrls(
    key: string,
    uploadId: string,
    partNumbers: number[],
    expiresIn = 3600
  ): Promise<PresignedUrlResponse[]> {
    const urls: PresignedUrlResponse[] = [];
    for (const partNumber of partNumbers) {
      urls.push(await this.generatePartUploadUrl(key, uploadId, partNumber, expiresIn));
    }
    return urls;
  }

  async completeMultipartUpload(request: CompleteMultipartRequest): Promise<{ etag: string; size: number }> {
    const command = new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: request.key,
      UploadId: request.uploadId,
      MultipartUpload: {
        Parts: request.parts.map(p => ({
          PartNumber: p.partNumber,
          ETag: p.etag,
        })),
      },
    });

    const response = await this.client.send(command);
    
    const headCommand = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: request.key,
    });
    const headResponse = await this.client.send(headCommand);

    return {
      etag: response.ETag || '',
      size: headResponse.ContentLength || 0,
    };
  }

  async generateDownloadUrl(key: string, expiresIn = 900): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async generateUploadUrl(key: string, contentType = 'video/mp4', expiresIn = 3600): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
    });
    await this.client.send(command);
  }

  async verifyObject(key: string, expectedSize: number): Promise<{ exists: boolean; size: number; etag: string | undefined }> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      const response = await this.client.send(command);
      return {
        exists: true,
        size: response.ContentLength || 0,
        etag: response.ETag,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFound') {
        return { exists: false, size: 0, etag: undefined };
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.client.send(command);
  }
}