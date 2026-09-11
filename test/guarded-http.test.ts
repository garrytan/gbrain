import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { assertSupportedBun } from '../src/core/runtime-version.ts';
import {
  __setDnsLookupForTests, fetchWithSSRFGuard, validateAndResolveUrl,
  type GuardedHttpDependencies, type GuardedHttpOptions,
} from '../src/core/ssrf-validate.ts';

beforeEach(() => {
  __setDnsLookupForTests((async () => [{ address: '8.8.8.8', family: 4 }]) as any);
});
afterEach(() => __setDnsLookupForTests(undefined));

const probe = { headerOnly: true };

test('unsupported runtime refuses guarded operations with upgrade guidance', () => {
  for (const version of ['', '1.3.10', '1.2.99', '1.3.11-canary']) {
    expect(() => assertSupportedBun(version)).toThrow('Run bun upgrade');
  }
  for (const version of ['1.3.11', '1.3.13', '1.4.0', '2.0.0']) {
    expect(() => assertSupportedBun(version)).not.toThrow();
  }
});

describe('guarded HTTP destination and redirect policy', () => {
  test('denial diagnostics exclude requested URLs and DNS exception content', async () => {
    for (const url of ['http://127.0.0.1/private-document?api_key=private-value', 'http://owner:private-value@']) {
      let error: unknown;
      try { await validateAndResolveUrl(url); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('private-');
      expect((error as Error).message.length).toBeLessThan(150);
    }
    __setDnsLookupForTests((async () => { throw new Error('private-document private-value'); }) as any);
    await expect(validateAndResolveUrl('https://private-document.example')).rejects.toMatchObject({
      code: 'DNS_RESOLUTION_FAILED', message: 'DNS resolution failed for the requested destination',
    });
  });
  test('pins the validated DNS answer and preserves the original URL', async () => {
    let lookups = 0;
    __setDnsLookupForTests((async () => {
      lookups++;
      return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    }) as any);
    const r = await fetchWithSSRFGuard('https://example.test:8443/path?q=1', probe, {
      fetch: async (target, url) => {
        expect(target.resolvedUrl).toBe('https://8.8.8.8:8443/path?q=1');
        expect(target.originalHost).toBe('example.test');
        expect(url.host).toBe('example.test:8443');
        return new Response('unused');
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    expect(lookups).toBe(1);
  });

  test.each([
    { address: '::ffff:7f00:1', family: 6 },
    { address: '0:0:0:0:0:ffff:127.0.0.1', family: 6 },
    { address: '0:0:0:0:0:0:0:1', family: 6 },
    { address: 'fe90::1', family: 6 },
    { address: 'fd00::1', family: 6 },
    { address: '127.0.0.1', family: 6 },
    { address: '8.8.8.8', family: 99 },
  ])('rejects mixed DNS including nonpublic/corrupt answer %j', async answer => {
    __setDnsLookupForTests((async () => [{ address: '8.8.8.8', family: 4 }, answer]) as any);
    let calls = 0;
    await expect(fetchWithSSRFGuard('https://example.test', probe, {
      fetch: async () => { calls++; return new Response(); },
    })).rejects.toMatchObject({ code: 'DNS_RESOLVED_INTERNAL' });
    expect(calls).toBe(0);
  });

  test('public IPv6 DNS answer remains pinned and bracket encoded', async () => {
    __setDnsLookupForTests((async () => [{ address: '2606:4700:4700::1111', family: 6 }]) as any);
    const target = await validateAndResolveUrl('https://example.test:8443/a');
    expect(target.resolvedUrl).toBe('https://[2606:4700:4700::1111]:8443/a');
  });

  test('each redirect receives a fresh complete DNS check', async () => {
    let lookups = 0;
    __setDnsLookupForTests((async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }]) as any);
    let requests = 0;
    await expect(fetchWithSSRFGuard('https://example.test/start', probe, {
      fetch: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: '/next' } });
      },
    })).rejects.toMatchObject({ code: 'DNS_RESOLVED_INTERNAL' });
    expect(requests).toBe(1);
  });

  test('plain probes cross public origins with harmless headers', async () => {
    const urls: string[] = [];
    const r = await fetchWithSSRFGuard('https://one.test/start', { ...probe, headers: { Accept: 'text/html' } }, {
      fetch: async (_, url, init) => {
        urls.push(url.href);
        expect(init.headers.get('accept')).toBe('text/html');
        return urls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://two.test/final' } }) : new Response();
      },
    });
    expect(urls).toEqual(['https://one.test/start', 'https://two.test/final']);
    expect(r.url).toBe('https://two.test/final');
  });

  test.each([
    { headers: { Authorization: 'test-token' } },
    { headers: { 'X-Api-Key': 'test-token' } },
    { headers: { Accept: 'test-secret' }, sameOrigin: true },
    { method: 'POST', body: 'test-data' },
    { method: 'DELETE' },
  ] as GuardedHttpOptions[])('sensitive requests never cross origins: %j', async options => {
    let requests = 0;
    await expect(fetchWithSSRFGuard('https://one.test', { ...probe, ...options }, {
      fetch: async () => {
        requests++;
        return new Response(null, { status: 307, headers: { location: 'https://two.test' } });
      },
    })).rejects.toMatchObject({ code: 'SSRF_REDIRECT_DENIED' });
    expect(requests).toBe(1);
  });

  test('preserves recipe method/body/auth for a same-origin redirect', async () => {
    let requests = 0;
    await fetchWithSSRFGuard('https://one.test/start', {
      ...probe, method: 'PATCH', body: 'test-body', headers: { Authorization: 'test-only' },
    }, {
      fetch: async (_, url, init) => {
        expect(init.method).toBe('PATCH');
        expect(init.body).toBe('test-body');
        expect(init.headers.get('authorization')).toBe('test-only');
        return ++requests === 1 ? new Response(null, { status: 303, headers: { location: '/next' } }) : new Response();
      },
    });
    expect(requests).toBe(2);
  });

  test.each(['http://one.test', 'file:///tmp/unused', 'http://['])('refuses downgrade/invalid redirect %s', async location => {
    await expect(fetchWithSSRFGuard('https://one.test', probe, {
      fetch: async () => new Response(null, { status: 302, headers: { location } }),
    })).rejects.toMatchObject({ code: 'SSRF_REDIRECT_DENIED' });
  });

  test.each([3, 5])('enforces %i redirects and cancels every intermediate body', async limit => {
    let requests = 0;
    let cancelled = 0;
    await expect(fetchWithSSRFGuard('https://one.test', { ...probe, maxRedirects: limit }, {
      fetch: async () => {
        requests++;
        return new Response(new ReadableStream({ cancel: () => { cancelled++; } }), {
          status: 302, headers: { location: '/again' },
        });
      },
    })).rejects.toMatchObject({ code: 'SSRF_HOP_LIMIT' });
    expect(requests).toBe(limit + 1);
    expect(cancelled).toBe(requests);
  });

  test('HEAD fallback consumes no body and does not consume a redirect hop', async () => {
    const methods: string[] = [];
    let cancelled = 0;
    const r = await fetchWithSSRFGuard('https://one.test', {
      ...probe, method: 'HEAD', headFallback: true, maxRedirects: 0,
    }, {
      fetch: async (_, __, init) => {
        methods.push(init.method);
        return new Response(new ReadableStream({ cancel: () => { cancelled++; } }), { status: init.method === 'HEAD' ? 405 : 200 });
      },
    });
    expect(r.ok).toBe(true);
    expect(methods).toEqual(['HEAD', 'GET']);
    expect(cancelled).toBe(2);
  });
});

describe('one deadline and bounded decoded bodies', () => {
  test('timeout during DNS never starts a request, even after late resolution', async () => {
    let finish!: (target: Awaited<ReturnType<typeof validateAndResolveUrl>>) => void;
    let requests = 0;
    const pending = fetchWithSSRFGuard('https://one.test', { ...probe, timeoutMs: 20 }, {
      resolve: () => new Promise(resolve => { finish = resolve; }),
      fetch: async () => { requests++; return new Response(); },
    });
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    finish({ resolvedUrl: 'https://8.8.8.8', resolvedIp: '8.8.8.8', originalHost: 'one.test', ipv6: false });
    await Promise.resolve();
    expect(requests).toBe(0);
  });

  test('external cancellation during DNS is immediate', async () => {
    const ac = new AbortController();
    const promise = fetchWithSSRFGuard('https://one.test', { ...probe, signal: ac.signal }, {
      resolve: () => new Promise(() => {}),
    });
    ac.abort();
    await expect(promise).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });

  test('headers do not end the deadline; stalled body is cancelled', async () => {
    let cancelled = false;
    await expect(fetchWithSSRFGuard('https://one.test', { maxBytes: 1024, timeoutMs: 20 }, {
      fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        cancel() { cancelled = true; },
      })),
    })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(cancelled).toBe(true);
  });

  test('redirects and HEAD fallback share the original deadline', async () => {
    const methods: string[] = [];
    const deadlines: Array<() => void> = [];
    const handles: Array<ReturnType<typeof setTimeout>> = [];
    const realSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      expect(delay).toBe(250);
      deadlines.push(callback);
      const handle = realSetTimeout(callback, 60000);
      handles.push(handle);
      return handle;
    }) as typeof setTimeout);
    const deps: GuardedHttpDependencies = { fetch: async (_, __, init) => {
      methods.push(init.method);
      if (methods.length === 1) return new Response(null, { status: 302, headers: { location: '/next' } });
      if (methods.length === 2) return new Response(null, { status: 405 });
      return new Promise<Response>((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        queueMicrotask(() => deadlines.at(-1)!());
      });
    } };
    try {
      await expect(fetchWithSSRFGuard('https://one.test', {
        ...probe, method: 'HEAD', headFallback: true, timeoutMs: 250,
      }, deps)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
      expect(methods).toEqual(['HEAD', 'HEAD', 'GET']);
      expect(deadlines).toHaveLength(1);
    } finally {
      timer.mockRestore();
      handles.forEach(handle => clearTimeout(handle));
    }
  });

  test.each(['identity', 'gzip', 'deflate', 'br'])('bounds decoded %s and supports ordinary data', async encoding => {
    const encode = (data: Buffer) => encoding === 'gzip' ? gzipSync(data)
      : encoding === 'deflate' ? deflateSync(data) : encoding === 'br' ? brotliCompressSync(data) : data;
    const makeResponse = (data: Buffer) => new Response(new Uint8Array(encode(data)), { headers: { 'content-encoding': encoding } });
    const r = await fetchWithSSRFGuard('https://one.test', { maxBytes: 8 }, { fetch: async () => makeResponse(Buffer.from('good')) });
    expect(r.body.toString()).toBe('good');
    await expect(fetchWithSSRFGuard('https://one.test', { maxBytes: 8 }, {
      fetch: async () => makeResponse(Buffer.alloc(65536)),
    })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });

  test('stream cap defeats missing and dishonest Content-Length', async () => {
    for (const length of [undefined, '1']) {
      let cancelled = false;
      await expect(fetchWithSSRFGuard('https://one.test', { maxBytes: 8 }, {
        fetch: async () => new Response(new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array(32)); },
          cancel() { cancelled = true; },
        }), { headers: length ? { 'content-length': length } : {} }),
      })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
      expect(cancelled).toBe(true);
    }
  });

  test('unsupported and stacked content encodings are rejected', async () => {
    for (const encoding of ['zstd', 'gzip, br']) {
      await expect(fetchWithSSRFGuard('https://one.test', { maxBytes: 8 }, {
        fetch: async () => new Response('unused', { headers: { 'content-encoding': encoding } }),
      })).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });
    }
  });

  test('malformed compressed response fails without hanging', async () => {
    await expect(fetchWithSSRFGuard('https://one.test', { maxBytes: 8 }, {
      fetch: async () => new Response('invalid', { headers: { 'content-encoding': 'gzip' } }),
    })).rejects.toThrow();
  });

  test('a body limit is mandatory and invalid request options fail before DNS', async () => {
    await expect(fetchWithSSRFGuard('https://one.test')).rejects.toThrow('maxBytes');
    await expect(fetchWithSSRFGuard('https://one.test', { ...probe, timeoutMs: NaN })).rejects.toThrow();
    await expect(fetchWithSSRFGuard('https://one.test', { ...probe, method: 'GET', body: 'x' })).rejects.toThrow();
  });
});
