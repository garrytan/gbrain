import { createHash } from 'node:crypto';
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
import { coerceSignedUrlExpiresIn, httpEndpointProblem, normalizeHttpEndpoint, signedUrlLoopbackNotice } from '../storage-url.ts';
import { presignS3Get } from './s3-presign.ts';

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
  private region: string;
  private endpoint?: string;
  private publicEndpoint?: string;
  private expiresIn: number;
  private credentials?: { accessKeyId: string; secretAccessKey: string };

  constructor(config: StorageConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.region = config.region || 'us-east-1';
    this.endpoint = config.endpoint;
    if (config.publicEndpoint !== undefined && config.publicEndpoint !== '') {
      const problem = httpEndpointProblem(config.publicEndpoint);
      if (problem) throw new Error(`S3 storage publicEndpoint is invalid. ${problem}`);
      this.publicEndpoint = normalizeHttpEndpoint(config.publicEndpoint);
    }
    this.expiresIn = coerceSignedUrlExpiresIn(config.signedUrlExpiresIn);
    if (config.accessKeyId && config.secretAccessKey) {
      this.credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
    }

    // Test seam: an injected client (stub or preconfigured S3Client) is used
    // as-is — no construction, no credential validation. getUrl still needs
    // the keys above so it can sign without sending through this client.
    if (client) {
      this.client = client;
      return;
    }

    if (!this.credentials) {
      throw new Error('S3 storage requires accessKeyId and secretAccessKey in config');
    }

    this.client = new S3Client({
      region: this.region,
      ...(this.endpoint ? {
        endpoint: this.endpoint,
        forcePathStyle: true, // Required for R2, MinIO, and custom endpoints
      } : {}),
      credentials: this.credentials,
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

  async hashObject(path: string): Promise<{ size: number; sha256: string }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
    if (!res.Body) throw new Error(`S3 download returned empty body: ${path}`);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) { hash.update(chunk); size += chunk.length; }
    return { size, sha256: hash.digest('hex') };
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

  /**
   * Presigned GET for a private object. `publicEndpoint` is the signed host
   * when set; otherwise the data-plane `endpoint` (virtual-hosted AWS when
   * neither is set). The data-plane client is not used, and no ACL is changed.
   * A loopback host logs a notice that omits the URL.
   */
  async getUrl(path: string): Promise<string> {
    if (!this.credentials) {
      throw new Error('S3 storage requires accessKeyId and secretAccessKey to sign a private-object URL');
    }
    const url = await presignS3Get({
      bucket: this.bucket,
      key: path,
      region: this.region,
      endpoint: this.publicEndpoint ?? this.endpoint,
      credentials: this.credentials,
      expiresIn: this.expiresIn,
    });
    const notice = signedUrlLoopbackNotice(url);
    if (notice) console.error(notice);
    return url;
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
