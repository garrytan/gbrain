import { describe, test, expect } from 'bun:test';
import { SupabaseStorage, type FetchImpl } from '../src/core/storage/supabase.ts';

// Mirrors of the module-private constants in src/core/storage/supabase.ts.
// If those drift, the routing/chunking assertions below fail — update together.
const TUS_THRESHOLD = 100 * 1024 * 1024; // 100 MB
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;  // 6 MB
const SIGNED_URL_EXPIRY = 3600;          // 1 hour

const PROJECT_URL = 'https://acme-example.supabase.co';
const BUCKET = 'files';
const CONFIG = {
  backend: 'supabase' as const,
  bucket: BUCKET,
  projectUrl: PROJECT_URL,
  serviceRoleKey: 'sr-test-key',
};

interface SeenCall { url: string; init: RequestInit; }

/**
 * Queue-based fetch stub: responses are consumed in call order; every call
 * (url + init) is recorded for assertion. Throws if the script runs dry so a
 * surprise extra request fails loudly instead of hanging.
 */
function stubFetch(script: Array<(call: SeenCall) => Response>) {
  const calls: SeenCall[] = [];
  const impl: FetchImpl = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const step = script.shift();
    if (!step) {
      throw new Error(`fetch stub script exhausted at call ${calls.length}: ${init.method ?? 'GET'} ${url}`);
    }
    return step(call);
  };
  return { impl, calls };
}

/** Body-less Response (works for ok and error statuses; res.text() yields ''). */
const resp = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The class builds headers as plain objects, so this cast is always safe here. */
const hdrs = (c: SeenCall) => c.init.headers as Record<string, string>;

describe('SupabaseStorage getSignedUrl — prefix ladder', () => {
  test('relative /object/sign path gets the /storage/v1 base prefixed exactly once', async () => {
    const { impl, calls } = stubFetch([
      () => json({ signedURL: `/object/sign/${BUCKET}/a.txt?token=tok` }),
    ]);
    const storage = new SupabaseStorage(CONFIG, impl);
    const url = await storage.getSignedUrl('a.txt');
    expect(url).toBe(`${PROJECT_URL}/storage/v1/object/sign/${BUCKET}/a.txt?token=tok`);
    // The sign request itself: POST to the sign endpoint with the 1h default expiry
    expect(calls[0].url).toBe(`${PROJECT_URL}/storage/v1/object/sign/${BUCKET}/a.txt`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ expiresIn: SIGNED_URL_EXPIRY });
  });

  test('already-/storage/v1-prefixed value is not double-prefixed', async () => {
    const { impl } = stubFetch([
      () => json({ signedURL: `/storage/v1/object/sign/${BUCKET}/a.txt?token=tok` }),
    ]);
    const storage = new SupabaseStorage(CONFIG, impl);
    const url = await storage.getSignedUrl('a.txt');
    expect(url).toBe(`${PROJECT_URL}/storage/v1/object/sign/${BUCKET}/a.txt?token=tok`);
    expect(url).not.toContain('/storage/v1/storage/v1');
  });

  test('absolute http(s) URL passes through untouched', async () => {
    const absolute = 'https://cdn.example.com/signed/a.txt?token=tok';
    const { impl } = stubFetch([() => json({ signedURL: absolute })]);
    const storage = new SupabaseStorage(CONFIG, impl);
    expect(await storage.getSignedUrl('a.txt')).toBe(absolute);
  });

  test('bare relative value (no leading slash) gets a separator inserted', async () => {
    const { impl } = stubFetch([
      () => json({ signedURL: `object/sign/${BUCKET}/a.txt?token=tok` }),
    ]);
    const storage = new SupabaseStorage(CONFIG, impl);
    expect(await storage.getSignedUrl('a.txt'))
      .toBe(`${PROJECT_URL}/storage/v1/object/sign/${BUCKET}/a.txt?token=tok`);
  });
});

describe('SupabaseStorage getUrl — signed-first with public fallback', () => {
  test('falls back to the public URL shape when the sign call returns non-ok', async () => {
    const { impl } = stubFetch([() => resp(400)]);
    const storage = new SupabaseStorage(CONFIG, impl);
    expect(await storage.getUrl('pages/a.txt'))
      .toBe(`${PROJECT_URL}/storage/v1/object/public/${BUCKET}/pages/a.txt`);
  });

  test('returns the signed URL when signing succeeds', async () => {
    const { impl } = stubFetch([
      () => json({ signedURL: `/object/sign/${BUCKET}/pages/a.txt?token=tok` }),
    ]);
    const storage = new SupabaseStorage(CONFIG, impl);
    expect(await storage.getUrl('pages/a.txt'))
      .toBe(`${PROJECT_URL}/storage/v1/object/sign/${BUCKET}/pages/a.txt?token=tok`);
  });
});

describe('SupabaseStorage upload routing (100 MB TUS threshold)', () => {
  test('below the threshold: single POST to the object URL with x-upsert', async () => {
    const { impl, calls } = stubFetch([() => resp(200)]);
    const storage = new SupabaseStorage(CONFIG, impl);
    await storage.upload('notes/a.txt', Buffer.from('hello'), 'text/plain');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${PROJECT_URL}/storage/v1/object/${BUCKET}/notes/a.txt`);
    expect(calls[0].init.method).toBe('POST');
    const h = hdrs(calls[0]);
    expect(h['x-upsert']).toBe('true');
    expect(h['Content-Type']).toBe('text/plain');
    expect(h['Authorization']).toBe('Bearer sr-test-key');
    expect(h['apikey']).toBe('sr-test-key');
    // Body carries the exact bytes
    expect(Buffer.from(calls[0].init.body as Uint8Array).toString()).toBe('hello');
  });

  test('one byte under the threshold still goes single POST (>= boundary)', async () => {
    const { impl, calls } = stubFetch([() => resp(200)]);
    const storage = new SupabaseStorage(CONFIG, impl);
    await storage.upload('big-ish.bin', Buffer.alloc(TUS_THRESHOLD - 1));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${PROJECT_URL}/storage/v1/object/${BUCKET}/big-ish.bin`);
  });

  test('at the threshold: TUS create session then 6 MB PATCH chunks', async () => {
    const data = Buffer.alloc(TUS_THRESHOLD);
    const uploadUrl = `${PROJECT_URL}/storage/v1/upload/resumable/session-1`;
    const { impl, calls } = stubFetch([
      () => resp(201, { Location: uploadUrl }),
      // Report the full length back so the chunk loop terminates after one PATCH
      () => resp(204, { 'Upload-Offset': String(TUS_THRESHOLD) }),
    ]);
    const storage = new SupabaseStorage(CONFIG, impl);
    await storage.upload('big.bin', data);
    expect(calls.length).toBe(2);
    // Create: POST to the resumable endpoint with TUS metadata
    expect(calls[0].url).toBe(`${PROJECT_URL}/storage/v1/upload/resumable`);
    expect(calls[0].init.method).toBe('POST');
    const ch = hdrs(calls[0]);
    expect(ch['Tus-Resumable']).toBe('1.0.0');
    expect(ch['Upload-Length']).toBe(String(TUS_THRESHOLD));
    expect(ch['x-upsert']).toBe('true');
    expect(ch['Upload-Metadata']).toContain(`bucketName ${btoa(BUCKET)}`);
    expect(ch['Upload-Metadata']).toContain(`objectName ${btoa('big.bin')}`);
    expect(ch['Upload-Metadata']).toContain(`contentType ${btoa('application/octet-stream')}`);
    // First chunk: PATCH against the returned Location, 6 MB from offset 0
    expect(calls[1].url).toBe(uploadUrl);
    expect(calls[1].init.method).toBe('PATCH');
    const ph = hdrs(calls[1]);
    expect(ph['Upload-Offset']).toBe('0');
    expect(ph['Content-Length']).toBe(String(TUS_CHUNK_SIZE));
    expect(ph['Content-Type']).toBe('application/offset+octet-stream');
  });

  test('TUS resume: after a failed PATCH the retry starts at the SERVER offset from HEAD', async () => {
    const data = Buffer.alloc(TUS_THRESHOLD);
    // Surprising server offset: mid-chunk — not 0 (stale local) and not 6 MB
    // (a full assumed-successful chunk). The server kept only 4 MB.
    const serverOffset = 4 * 1024 * 1024;
    data[0] = 0x01;
    data[serverOffset] = 0xab; // marker: the resumed body must start HERE
    const uploadUrl = `${PROJECT_URL}/storage/v1/upload/resumable/session-2`;
    const { impl, calls } = stubFetch([
      () => resp(201, { Location: uploadUrl }),                     // create
      () => resp(500),                                              // PATCH #1 fails
      () => resp(200, { 'Upload-Offset': String(serverOffset) }),   // HEAD reveals real offset
      () => resp(204, { 'Upload-Offset': String(TUS_THRESHOLD) }),  // PATCH #2 completes
    ]);
    const storage = new SupabaseStorage(CONFIG, impl);
    await storage.upload('big.bin', data);
    expect(calls.length).toBe(4);
    // The retry re-read the offset via HEAD on the session URL
    expect(calls[2].init.method).toBe('HEAD');
    expect(calls[2].url).toBe(uploadUrl);
    expect(hdrs(calls[2])['Tus-Resumable']).toBe('1.0.0');
    // The retry PATCH resumes from the server's offset, not its stale local one
    const retry = calls[3];
    expect(retry.init.method).toBe('PATCH');
    expect(hdrs(retry)['Upload-Offset']).toBe(String(serverOffset));
    expect(hdrs(retry)['Content-Length']).toBe(String(TUS_CHUNK_SIZE));
    expect((retry.init.body as Uint8Array)[0]).toBe(0xab); // bytes re-windowed from serverOffset
  }, 10_000); // the retry path sleeps a real 1s backoff before the HEAD

  test('standard POST non-ok status throws with the status in the message', async () => {
    const { impl, calls } = stubFetch([() => resp(413)]);
    const storage = new SupabaseStorage(CONFIG, impl);
    await expect(storage.upload('notes/a.txt', Buffer.from('hello'), 'text/plain'))
      .rejects.toThrow('Supabase upload failed: 413');
    expect(calls.length).toBe(1); // no retry on the standard arm
  });

  test('TUS create-session failure throws: non-ok status, and ok-but-no-Location', async () => {
    // Non-ok create → the status-carrying throw, and NO chunk PATCH follows.
    const nonOk = stubFetch([() => resp(403)]);
    await expect(new SupabaseStorage(CONFIG, nonOk.impl).upload('big.bin', Buffer.alloc(TUS_THRESHOLD)))
      .rejects.toThrow('TUS create failed: 403');
    expect(nonOk.calls.length).toBe(1);
    // Ok create with a missing Location header → the documented throw.
    const noLocation = stubFetch([() => resp(201)]);
    await expect(new SupabaseStorage(CONFIG, noLocation.impl).upload('big.bin', Buffer.alloc(TUS_THRESHOLD)))
      .rejects.toThrow('TUS create did not return Location header');
    expect(noLocation.calls.length).toBe(1);
  });

  test('three consecutive PATCH failures exhaust the retries and throw', async () => {
    const uploadUrl = `${PROJECT_URL}/storage/v1/upload/resumable/session-3`;
    const { impl, calls } = stubFetch([
      () => resp(201, { Location: uploadUrl }),                 // create
      () => resp(500),                                          // PATCH #1 fails
      () => resp(200, { 'Upload-Offset': '0' }),                // HEAD before retry #1
      () => resp(500),                                          // PATCH #2 fails
      () => resp(200, { 'Upload-Offset': '0' }),                // HEAD before retry #2
      () => resp(500),                                          // PATCH #3 fails → maxAttempts (3) exhausted
    ]);
    const storage = new SupabaseStorage(CONFIG, impl);
    await expect(storage.upload('big.bin', Buffer.alloc(TUS_THRESHOLD)))
      .rejects.toThrow('TUS PATCH failed: 500');
    // Exactly maxAttempts (3) PATCHes were sent — no fourth attempt.
    expect(calls.length).toBe(6);
    expect(calls.filter(c => c.init.method === 'PATCH').length).toBe(3);
  }, 15_000); // the retry loop sleeps real 1s + 2s backoffs between attempts
});

describe('SupabaseStorage delete', () => {
  test('404 is swallowed (idempotent delete)', async () => {
    const { impl, calls } = stubFetch([() => resp(404)]);
    const storage = new SupabaseStorage(CONFIG, impl);
    await storage.delete('gone.txt'); // no throw
    expect(calls[0].url).toBe(`${PROJECT_URL}/storage/v1/object/${BUCKET}`);
    expect(calls[0].init.method).toBe('DELETE');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ prefixes: ['gone.txt'] });
  });

  test('500 throws', async () => {
    const { impl } = stubFetch([() => resp(500)]);
    const storage = new SupabaseStorage(CONFIG, impl);
    await expect(storage.delete('a.txt')).rejects.toThrow('Supabase delete failed: 500');
  });
});

describe('SupabaseStorage list', () => {
  test('URL join has no double slash and results are prefix-joined', async () => {
    const { impl, calls } = stubFetch([() => json([{ name: 'x.md' }, { name: 'y.md' }])]);
    const storage = new SupabaseStorage(CONFIG, impl);
    const items = await storage.list('notes');
    expect(items).toEqual(['notes/x.md', 'notes/y.md']);
    expect(calls[0].url).toBe(`${PROJECT_URL}/storage/v1/object/list/${BUCKET}`);
    // No '//' anywhere past the protocol
    expect(calls[0].url.replace(/^https:\/\//, '')).not.toContain('//');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ prefix: 'notes', limit: 1000 });
  });
});
