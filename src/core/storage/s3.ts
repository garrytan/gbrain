import { open } from 'fs/promises';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { StorageBackend, StorageConfig } from '../storage.ts';

/**
 * S3-compatible storage — works with AWS S3, Cloudflare R2, MinIO, etc.
 * Uses @aws-sdk/client-s3 for proper authentication and request signing.
 */
export class S3Storage implements StorageBackend {
  private client: S3Client;
  private bucket: string;

  constructor(config: StorageConfig, client?: S3Client) {
    this.bucket = config.bucket;

    // Test seam: an injected client (stub or preconfigured S3Client) is used
    // as-is — no construction, no credential validation.
    if (client) {
      this.client = client;
      return;
    }

    const region = config.region || 'us-east-1';

    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error('S3 storage requires accessKeyId and secretAccessKey in config');
    }

    this.client = new S3Client({
      region,
      ...(config.endpoint ? {
        endpoint: config.endpoint,
        forcePathStyle: true, // Required for R2, MinIO, and custom endpoints
      } : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async upload(path: string, data: Buffer, mime?: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: path,
      Body: data,
      ContentType: mime || 'application/octet-stream',
    }));
  }

  /** Sequential multipart upload bounds memory independently of original size. */
  async uploadFile(path: string, filePath: string, mime?: string): Promise<void> {
    const file = await open(filePath, 'r');
    let uploadId: string | undefined;
    const target = { Bucket: this.bucket, Key: path };
    try {
      const { size } = await file.stat();
      // Keep within S3's 10,000-part limit for multi-terabyte originals.
      const partSize = Math.max(16 * 1024 * 1024, Math.ceil(size / 10000));
      const buffer = Buffer.allocUnsafe(Math.min(size, partSize));
      const readPart = async (offset: number, length: number) => {
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await file.read(buffer, filled, length - filled, offset + filled);
          if (!bytesRead) throw new Error('File ended during S3 upload');
          filled += bytesRead;
        }
        return buffer.subarray(0, length);
      };
      if (size <= partSize) {
        await this.upload(path, await readPart(0, size), mime);
        return;
      }
      const created = await this.client.send(new CreateMultipartUploadCommand({
        ...target, ContentType: mime || 'application/octet-stream',
      }));
      uploadId = created.UploadId;
      if (!uploadId) throw new Error('S3 multipart upload returned no upload ID');
      const parts: { PartNumber: number; ETag: string }[] = [];
      for (let offset = 0; offset < size;) {
        const length = Math.min(partSize, size - offset);
        const PartNumber = parts.length + 1;
        const result = await this.client.send(new UploadPartCommand({
          ...target, UploadId: uploadId, PartNumber,
          Body: await readPart(offset, length), ContentLength: length,
        }));
        if (!result.ETag) throw new Error('S3 multipart part returned no ETag');
        parts.push({ PartNumber, ETag: result.ETag });
        offset += length;
      }
      await this.client.send(new CompleteMultipartUploadCommand({
        ...target, UploadId: uploadId, MultipartUpload: { Parts: parts },
      }));
    } catch (error) {
      if (uploadId) {
        await this.client.send(new AbortMultipartUploadCommand({
          ...target, UploadId: uploadId,
        })).catch(() => {}); // Preserve the original failure if cleanup also fails.
      }
      throw error;
    } finally {
      await file.close();
    }
  }

  async download(path: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: path,
    }));
    if (!res.Body) throw new Error(`S3 download returned empty body: ${path}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(path: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: path,
    }));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: path,
      }));
      return true;
    } catch (e: any) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
    }));
    return (res.Contents || []).map(obj => obj.Key!).filter(Boolean);
  }

  async getUrl(path: string): Promise<string> {
    // For custom endpoints (R2, MinIO), use the endpoint URL
    const endpoint = (this.client.config as any).endpoint;
    if (endpoint) {
      const base = typeof endpoint === 'function' ? (await endpoint()).url.toString() : endpoint;
      return `${base}/${this.bucket}/${path}`;
    }
    const region = await this.client.config.region();
    return `https://${this.bucket}.s3.${region}.amazonaws.com/${path}`;
  }

  async getContentHash(path: string): Promise<string | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: path,
      }));
      // ETag is typically the MD5 hash (quoted), but for multipart uploads it's different
      return res.ETag?.replace(/"/g, '') || null;
    } catch {
      return null;
    }
  }
}
