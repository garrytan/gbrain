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
 */
export class S3Storage implements StorageBackend {
  private client: S3Client;
  private bucket: string;
  private requestTimeoutMs: number;

  constructor(config: StorageConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.requestTimeoutMs = Number.isSafeInteger(config.requestTimeoutMs) && config.requestTimeoutMs! > 0
      ? Math.min(config.requestTimeoutMs!, 10 * 60 * 1000)
      : 60_000;

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

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('S3 storage request timed out')), this.requestTimeoutMs);
    timer.unref?.();
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private send(command: unknown, signal: AbortSignal): Promise<any> {
    return (this.client as any).send(command, { abortSignal: signal });
  }

  async upload(path: string, data: Buffer, mime?: string): Promise<void> {
    await this.withTimeout(signal => this.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: data,
        ContentType: mime || 'application/octet-stream',
      }), signal));
  }

  async download(path: string, maxBytes?: number): Promise<Buffer> {
    return this.withTimeout(async signal => {
      if (maxBytes !== undefined) {
        const head = await this.send(new HeadObjectCommand({
          Bucket: this.bucket,
          Key: path,
        }), signal);
        if (typeof head.ContentLength === 'number' && head.ContentLength > maxBytes) {
          throw new Error(`Storage object exceeds the ${maxBytes}-byte download limit`);
        }
      }
      const res = await this.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: path,
        ...(maxBytes !== undefined ? { Range: `bytes=0-${maxBytes}` } : {}),
      }), signal);
      if (!res.Body) throw new Error(`S3 download returned empty body: ${path}`);
      if (maxBytes !== undefined) {
        const totalFromRange = res.ContentRange?.match(/\/(\d+)$/)?.[1];
        if ((totalFromRange && Number(totalFromRange) > maxBytes) ||
            (typeof res.ContentLength === 'number' && res.ContentLength > maxBytes)) {
          throw new Error(`Storage object exceeds the ${maxBytes}-byte download limit`);
        }
      }
      const body = res.Body as unknown as AsyncIterable<Uint8Array> & { transformToByteArray(): Promise<Uint8Array> };
      if (typeof body[Symbol.asyncIterator] === 'function') {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of body) {
          const bytes = Buffer.from(chunk);
          total += bytes.length;
          if (maxBytes !== undefined && total > maxBytes) {
            throw new Error(`Storage object exceeds the ${maxBytes}-byte download limit`);
          }
          chunks.push(bytes);
        }
        return Buffer.concat(chunks, total);
      }
      const bytes = Buffer.from(await body.transformToByteArray());
      if (maxBytes !== undefined && bytes.length > maxBytes) {
        throw new Error(`Storage object exceeds the ${maxBytes}-byte download limit`);
      }
      return bytes;
    });
  }

  async delete(path: string): Promise<void> {
    await this.withTimeout(signal => this.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: path,
    }), signal));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.withTimeout(signal => this.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: path,
      }), signal));
      return true;
    } catch (e: any) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.withTimeout(signal => this.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
    }), signal));
    return (res.Contents || []).map((obj: { Key?: string }) => obj.Key!).filter(Boolean);
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
      const res = await this.withTimeout(signal => this.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: path,
      }), signal));
      // ETag is typically the MD5 hash (quoted), but for multipart uploads it's different
      return res.ETag?.replace(/"/g, '') || null;
    } catch {
      return null;
    }
  }
}
