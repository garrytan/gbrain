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
import { FileDigest, type StorageBackend, type StorageConfig } from '../storage.ts';

const MIN_PART_SIZE = 16 * 1024 * 1024;
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_PARTS = 10_000;

/** Multipart part size for `size` bytes within S3's limits: 5 MiB..5 GiB per part, at most 10,000 parts. */
export function multipartPartSize(size: number): number {
  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS));
  if (partSize > MAX_PART_SIZE) throw new Error(`File too large for an S3 multipart upload: ${size} bytes`);
  return partSize;
}

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

  /**
   * Sequential multipart upload from one reused part buffer, so memory is
   * bounded by the part size, not the file size (#7427). A file that fits in
   * one part is a single PutObject.
   */
  async uploadFile(path: string, filePath: string, mime?: string, sha256?: string): Promise<void> {
    const file = await open(filePath, 'r');
    const digest = new FileDigest(filePath, sha256);
    const target = { Bucket: this.bucket, Key: path };
    let uploadId: string | undefined;
    try {
      const { size } = await file.stat();
      const partSize = multipartPartSize(size);
      const buffer = Buffer.allocUnsafe(Math.min(size, partSize));
      if (size <= partSize) {
        const data = await digest.read(file, buffer, size, 0);
        digest.assertMatches(size);
        await this.upload(path, data, mime);
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
          Body: await digest.read(file, buffer, length, offset), ContentLength: length,
        }));
        if (!result.ETag) throw new Error(`S3 multipart part ${PartNumber} returned no ETag`);
        parts.push({ PartNumber, ETag: result.ETag });
        offset += length;
      }
      digest.assertMatches(size);
      await this.client.send(new CompleteMultipartUploadCommand({
        ...target, UploadId: uploadId, MultipartUpload: { Parts: parts },
      }));
    } catch (error) {
      if (uploadId) {
        // Best effort: the original failure is the one to surface.
        await this.client.send(new AbortMultipartUploadCommand({ ...target, UploadId: uploadId })).catch(() => {});
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
