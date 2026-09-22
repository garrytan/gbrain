import {
  S3Client,
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
 *
 * Credentials: when `accessKeyId` and `secretAccessKey` are both present in
 * config they are used as static credentials (R2, MinIO, IAM-user setups).
 * When both are absent the SDK's default credential provider chain resolves
 * them (env vars, shared config/SSO, EC2/ECS/Lambda roles), so a hosted brain
 * can run on a task role with no long-lived secret in config.json.
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

    const hasKeyId = Boolean(config.accessKeyId);
    const hasSecret = Boolean(config.secretAccessKey);
    // Exactly one of the pair is a misconfiguration, not a request for the
    // default chain — fail loud instead of silently ignoring the given half.
    if (hasKeyId !== hasSecret) {
      throw new Error(
        'S3 storage: accessKeyId and secretAccessKey must be set together. ' +
        'Omit both to use the AWS SDK default credential provider chain ' +
        '(environment variables, shared config/SSO, EC2/ECS/Lambda roles).',
      );
    }

    this.client = new S3Client({
      region,
      ...(config.endpoint ? {
        endpoint: config.endpoint,
        forcePathStyle: true, // Required for R2, MinIO, and custom endpoints
      } : {}),
      // Static keys only when the caller supplied them; otherwise leave
      // `credentials` unset so the SDK default provider chain applies.
      ...(hasKeyId && hasSecret ? {
        credentials: {
          accessKeyId: config.accessKeyId!,
          secretAccessKey: config.secretAccessKey!,
        },
      } : {}),
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
