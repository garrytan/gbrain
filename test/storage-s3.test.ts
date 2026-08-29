import { describe, test, expect } from 'bun:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { S3Storage } from '../src/core/storage/s3.ts';

const CONFIG = { backend: 's3' as const, bucket: 'blobs' };

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
  test('string endpoint (R2/MinIO): endpoint/bucket/path', async () => {
    const { client } = stubClient({ endpoint: 'https://acct.r2.example.com' });
    expect(await new S3Storage(CONFIG, client).getUrl('img/a.png'))
      .toBe('https://acct.r2.example.com/blobs/img/a.png');
  });

  test('function endpoint: resolves the provider and uses its url', async () => {
    const { client } = stubClient({
      endpoint: async () => ({ url: new URL('https://minio.local:9000/s3') }),
    });
    expect(await new S3Storage(CONFIG, client).getUrl('img/a.png'))
      .toBe('https://minio.local:9000/s3/blobs/img/a.png');
  });

  test('no endpoint: regional virtual-hosted AWS URL', async () => {
    const { client } = stubClient({ region: 'eu-central-1' });
    expect(await new S3Storage(CONFIG, client).getUrl('img/a.png'))
      .toBe('https://blobs.s3.eu-central-1.amazonaws.com/img/a.png');
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
