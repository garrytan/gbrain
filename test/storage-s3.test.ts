import { describe, test, expect, spyOn } from 'bun:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client as RealS3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Storage } from '../src/core/storage/s3.ts';
import { presignS3Get } from '../src/core/storage/s3-presign.ts';

const CONFIG = { backend: 's3' as const, bucket: 'blobs' };
const KEYS = { accessKeyId: 'AKIATESTKEY0000001', secretAccessKey: 'test-secret-not-in-the-url' };

/**
 * Minimal stub for the slice of S3Client the backend touches: `send` plus
 * `config.endpoint` / `config.region()`. Cast through unknown because the
 * real client's `send` is a heavily-overloaded generic. Records every
 * command it was sent.
 */
function stubClient(opts: {
  send?: (command: any) => Promise<any>;
  endpoint?: unknown;
  region?: string;
} = {}): { client: S3Client; sent: any[] } {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      return (opts.send ?? (async () => ({})))(command);
    },
    config: {
      endpoint: opts.endpoint,
      region: async () => opts.region ?? 'us-east-1',
    },
  } as unknown as S3Client;
  return { client, sent };
}

/** An error shaped like the AWS SDK's service exceptions. */
const awsError = (name: string, httpStatusCode?: number) =>
  Object.assign(new Error(`${name} error`), {
    name,
    ...(httpStatusCode !== undefined ? { $metadata: { httpStatusCode } } : {}),
  });

describe('S3Storage constructor seam', () => {
  test('injected client skips construction and credential validation', async () => {
    const { client, sent } = stubClient();
    const storage = new S3Storage(CONFIG, client); // no accessKeyId/secretAccessKey — no throw
    expect(await storage.exists('a.txt')).toBe(true);
    expect(sent.length).toBe(1);
  });

  test('without an injected client, missing credentials still throw', () => {
    expect(() => new S3Storage(CONFIG))
      .toThrow('S3 storage requires accessKeyId and secretAccessKey in config');
  });
});

describe('S3Storage exists', () => {
  test('returns false on a NotFound-named error', async () => {
    const { client } = stubClient({ send: async () => { throw awsError('NotFound'); } });
    expect(await new S3Storage(CONFIG, client).exists('a.txt')).toBe(false);
  });

  test('returns false on a 404-status error under any name', async () => {
    const { client } = stubClient({ send: async () => { throw awsError('NoSuchKey', 404); } });
    expect(await new S3Storage(CONFIG, client).exists('a.txt')).toBe(false);
  });

  test('rethrows AccessDenied (403)', async () => {
    const { client } = stubClient({ send: async () => { throw awsError('AccessDenied', 403); } });
    await expect(new S3Storage(CONFIG, client).exists('a.txt')).rejects.toThrow('AccessDenied error');
  });

  test('rethrows a 500-status error', async () => {
    const { client } = stubClient({ send: async () => { throw awsError('InternalError', 500); } });
    await expect(new S3Storage(CONFIG, client).exists('a.txt')).rejects.toThrow('InternalError error');
  });

  test('returns true on success and sends HeadObjectCommand with Bucket/Key', async () => {
    const { client, sent } = stubClient();
    expect(await new S3Storage(CONFIG, client).exists('p/a.txt')).toBe(true);
    expect(sent[0]).toBeInstanceOf(HeadObjectCommand);
    expect(sent[0].input).toEqual({ Bucket: 'blobs', Key: 'p/a.txt' });
  });
});

describe('S3Storage getUrl', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');

  test('custom endpoint: path-style presigned GET, secret stays out of the URL', async () => {
    const storage = new S3Storage({ ...CONFIG, ...KEYS, endpoint: 'https://acct.r2.example.com/' });
    const url = new URL(await storage.getUrl('img/a.png'));
    expect(url.origin + url.pathname).toBe('https://acct.r2.example.com/blobs/img/a.png');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Credential')).toStartWith(`${KEYS.accessKeyId}/`);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain(KEYS.secretAccessKey);
    expect(url.searchParams.has('X-Amz-Acl') || url.searchParams.has('x-amz-acl')).toBe(false);
    expect(url.toString().toLowerCase()).not.toContain('checksum');
  });

  test('publicEndpoint is the signed host; exists() still uses the data-plane endpoint', async () => {
    const errs: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errs.push(args.join(' ')); });
    const hits = { data: 0 };
    const data = Bun.serve({ port: 0, fetch: () => { hits.data++; return new Response(null, { status: 404 }); } });
    try {
      const storage = new S3Storage({
        ...CONFIG, ...KEYS, region: 'us-east-1',
        endpoint: `http://127.0.0.1:${data.port}`,
        publicEndpoint: 'https://files.example.ts.net:9000/',
        signedUrlExpiresIn: 120,
      });
      const raw = await storage.getUrl('img/a.png');
      const url = new URL(raw);
      expect(url.origin + url.pathname).toBe('https://files.example.ts.net:9000/blobs/img/a.png');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
      expect(raw).not.toContain('127.0.0.1');
      expect(hits.data).toBe(0);
      expect(await storage.exists('img/a.png')).toBe(false);
      expect(hits.data).toBeGreaterThan(0);
      expect(errs.join('\n')).not.toContain('loopback');
      expect(errs.join('\n')).not.toContain('X-Amz-');
    } finally {
      spy.mockRestore();
      data.stop(true);
    }
  });

  test('loopback endpoint with no publicEndpoint still signs, and the notice omits the URL', async () => {
    const errs: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errs.push(args.join(' ')); });
    try {
      const { client, sent } = stubClient();
      const storage = new S3Storage({ ...CONFIG, ...KEYS, endpoint: 'http://127.0.0.1:9000' }, client);
      const raw = await storage.getUrl('目录/文件 名+测试.pdf');
      const url = new URL(raw);
      expect(sent).toEqual([]);
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.pathname).toBe('/' + ['blobs', '目录', '文件 名+测试.pdf'].map(encodeURIComponent).join('/'));
      expect(url.pathname).toContain('%E7%9B%AE');
      expect(url.pathname).toContain('%20');
      expect(url.pathname).toContain('%2B');
      expect(url.pathname).not.toContain('+');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      const notice = errs.join('\n');
      expect(notice).toContain('storage.publicEndpoint');
      expect(notice).not.toContain('X-Amz-');
      expect(notice).not.toContain(KEYS.secretAccessKey);
      expect(notice).not.toContain(raw);
    } finally {
      spy.mockRestore();
    }
  });

  test('no endpoint: regional virtual-hosted presigned AWS URL', async () => {
    const storage = new S3Storage({ ...CONFIG, ...KEYS, region: 'eu-central-1' });
    const url = new URL(await storage.getUrl('img/a.png'));
    expect(url.hostname).toBe('blobs.s3.eu-central-1.amazonaws.com');
    expect(url.pathname).toBe('/img/a.png');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  test('percent-encodes ?, #, and % in the key, and matches the SDK signer for that host', async () => {
    const key = 'notes/100%_a?b#c.txt';
    const endpoint = 'https://files.example.ts.net/s3';
    const signed = await presignS3Get({
      bucket: 'blobs', key, region: 'us-east-1', endpoint, credentials: KEYS, expiresIn: 3600, now,
    });
    const client = new RealS3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: KEYS,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    try {
      const direct = await getSignedUrl(client, new GetObjectCommand({ Bucket: 'blobs', Key: key }), {
        expiresIn: 3600, signingDate: now,
      });
      expect(signed).toBe(direct);
    } finally {
      client.destroy();
    }
    const url = new URL(signed);
    expect(url.pathname).toBe('/' + ['s3', 'blobs', 'notes', '100%_a?b#c.txt'].map(encodeURIComponent).join('/'));
    expect(url.pathname).toContain('100%25_');
    expect(url.pathname).toContain('%3F');
    expect(url.pathname).toContain('%23');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });

  test('the same inputs and signing time produce the same URL; a different key does not', async () => {
    const base = { bucket: 'blobs', region: 'us-east-1', endpoint: 'http://minio.example:9000', credentials: KEYS, expiresIn: 60, now };
    const a = await presignS3Get({ ...base, key: 'a.txt' });
    const b = await presignS3Get({ ...base, key: 'a.txt' });
    const c = await presignS3Get({ ...base, key: 'b.txt' });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  test('refuses to sign without keys, and refuses a bad publicEndpoint or lifetime', async () => {
    const { client } = stubClient({ endpoint: 'http://127.0.0.1:9000' });
    await expect(new S3Storage(CONFIG, client).getUrl('a.txt')).rejects.toThrow('accessKeyId and secretAccessKey');
    expect(() => new S3Storage({ ...CONFIG, ...KEYS, publicEndpoint: 'ftp://files.example' })).toThrow('publicEndpoint is invalid');
    expect(() => new S3Storage({ ...CONFIG, ...KEYS, signedUrlExpiresIn: 0 })).toThrow('signedUrlExpiresIn');
    expect(() => new S3Storage({ ...CONFIG, ...KEYS, signedUrlExpiresIn: 604801 })).toThrow('signedUrlExpiresIn');
  });
});

describe('S3Storage getContentHash', () => {
  test('dequotes the ETag', async () => {
    const { client } = stubClient({
      send: async () => ({ ETag: '"d41d8cd98f00b204e9800998ecf8427e"' }),
    });
    expect(await new S3Storage(CONFIG, client).getContentHash('a.txt'))
      .toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  test('keeps the multipart -N suffix (only quotes are stripped)', async () => {
    const { client } = stubClient({ send: async () => ({ ETag: '"abc123-2"' }) });
    expect(await new S3Storage(CONFIG, client).getContentHash('a.txt')).toBe('abc123-2');
  });

  test('returns null (not throw) on HEAD failure — even errors exists() would rethrow', async () => {
    const { client } = stubClient({ send: async () => { throw awsError('AccessDenied', 403); } });
    expect(await new S3Storage(CONFIG, client).getContentHash('a.txt')).toBeNull();
  });

  test('returns null when the response has no ETag', async () => {
    const { client } = stubClient({ send: async () => ({}) });
    expect(await new S3Storage(CONFIG, client).getContentHash('a.txt')).toBeNull();
  });
});

describe('S3Storage list', () => {
  test('filters falsy Keys out of Contents', async () => {
    const { client, sent } = stubClient({
      send: async () => ({
        Contents: [{ Key: 'p/a' }, { Key: undefined }, {}, { Key: '' }, { Key: 'p/b' }],
      }),
    });
    expect(await new S3Storage(CONFIG, client).list('p')).toEqual(['p/a', 'p/b']);
    expect(sent[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(sent[0].input).toEqual({ Bucket: 'blobs', Prefix: 'p' });
  });

  test('returns [] when Contents is absent', async () => {
    const { client } = stubClient({ send: async () => ({}) });
    expect(await new S3Storage(CONFIG, client).list('p')).toEqual([]);
  });
});
