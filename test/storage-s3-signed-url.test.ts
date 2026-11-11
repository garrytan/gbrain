/**
 * #8793: S3/MinIO file URLs are presigned, as the help promises ("Generate signed URL (1-hour)").
 *
 * 1. Protects: file_url and gbrain files signed-url hand back a SigV4 presigned GET that expires after one hour, so a
 *    remote client can open a file in a private bucket, the way the Supabase backend's signed URL works.
 * 2. Fails when: getUrl returns a plain <endpoint>/<bucket>/<key> URL with no signature (403 on a private bucket), the
 *    expiry is unbounded, or the secret key appears in the URL.
 * 3. Existing coverage: storage-s3 pins exists/list against a stubbed client; nothing pinned getUrl.
 * 4. Real seams: a real S3Client built from config; presigning is offline, so no network or bucket is needed.
 */
import { describe, expect, test } from 'bun:test';
import { S3Storage } from '../src/core/storage/s3.ts';

const KEYS = { accessKeyId: 'test-access-key-a', secretAccessKey: 'test-secret-value-a' };

function signed(url: string) {
  const u = new URL(url);
  return { u, q: u.searchParams };
}

describe('#8793 S3 getUrl presigns a bounded GET', () => {
  test('a MinIO/R2 endpoint gets a path-style presigned URL that expires in one hour', async () => {
    const storage = new S3Storage({ backend: 's3', bucket: 'bucket-a', region: 'us-east-1', endpoint: 'http://127.0.0.1:9000', ...KEYS });
    const { u, q } = signed(await storage.getUrl('files/report a.pdf'));
    expect(u.origin).toBe('http://127.0.0.1:9000');
    expect(u.pathname).toBe('/bucket-a/files/report%20a.pdf');
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Expires')).toBe('3600');
    expect(q.get('X-Amz-Credential')?.startsWith('test-access-key-a/')).toBe(true);
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.toString()).not.toContain(KEYS.secretAccessKey);
  });

  test('AWS S3 without an endpoint is presigned too', async () => {
    const storage = new S3Storage({ backend: 's3', bucket: 'bucket-a', region: 'us-west-2', ...KEYS });
    const { u, q } = signed(await storage.getUrl('files/a.pdf'));
    expect(u.hostname).toBe('bucket-a.s3.us-west-2.amazonaws.com');
    expect(u.pathname).toBe('/files/a.pdf');
    expect(q.get('X-Amz-Expires')).toBe('3600');
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});
