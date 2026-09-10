/**
 * Real local TLS and proxy-trap tests. Public localhost-only test certificate
 * from oven-sh/bun bun-v1.3.11 test/regression/issue/27890 (MIT); its SAN contains
 * DNS:localhost only, so accidentally verifying the dialled IP cannot pass.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createPinnedHttpFetch } from '../src/core/guarded-http.ts';
import { fetchWithSSRFGuard, type ResolvedTarget } from '../src/core/ssrf-validate.ts';

const certPath = join(import.meta.dir, 'fixtures/guarded-http-localhost.crt');
const tls = {
  cert: readFileSync(certPath, 'utf8'),
  key: readFileSync(join(import.meta.dir, 'fixtures/guarded-http-localhost.key'), 'utf8'),
};

function localTarget(url: URL): ResolvedTarget {
  const resolved = new URL(url);
  resolved.hostname = '127.0.0.1';
  return { resolvedUrl: resolved.href, resolvedIp: '127.0.0.1', originalHost: url.hostname, ipv6: false };
}

describe('pinned native HTTP transport', () => {
  test('original hostname cert and Host port survive IP pinning; wrong identity is rejected', async () => {
    const hosts: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0, tls,
      fetch(req) { hosts.push(req.headers.get('host')!); return new Response('verified'); },
    });
    const nativeFetch = globalThis.fetch;
    const request = createPinnedHttpFetch(((url, options) => nativeFetch(url, {
      ...options, tls: { ...(options as any).tls, ca: tls.cert },
    })) as typeof fetch);
    try {
      const original = new URL(`https://localhost:${server.port}/hello`);
      const result = await fetchWithSSRFGuard(original.href, { maxBytes: 64 }, {
        resolve: async () => localTarget(original), fetch: request,
      });
      expect(result.body.toString()).toBe('verified');
      expect(hosts).toEqual([`localhost:${server.port}`]);

      const wrong = new URL(`https://wrong.example:${server.port}/hello`);
      await expect(fetchWithSSRFGuard(wrong.href, { maxBytes: 64 }, {
        resolve: async () => localTarget(wrong), fetch: request,
      })).rejects.toThrow();
      // An untrusted chain still fails when the DNS name matches.
      await expect(fetchWithSSRFGuard(original.href, { maxBytes: 64 }, {
        resolve: async () => localTarget(original),
      })).rejects.toThrow();
      expect(hosts).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });

  test('ambient proxies fail closed in a fresh runtime, including NO_PROXY=*', async () => {
    let trapHits = 0;
    let directHits = 0;
    const trap = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { trapHits++; return new Response('proxy', { status: 502 }); } });
    const direct = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { directHits++; return new Response('direct'); } });
    const secure = Bun.serve({ hostname: '127.0.0.1', port: 0, tls, fetch() { directHits++; return new Response('secure'); } });
    const adapterPath = join(import.meta.dir, '../src/core/guarded-http.ts');
    const proxy = `http://127.0.0.1:${trap.port}`;
    // A child gives proxy env settings a chance to take effect at runtime startup.
    const script = `
      import { createPinnedHttpFetch } from ${JSON.stringify(adapterPath)};
      import { readFileSync } from 'node:fs';
      const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
      if (!proxyKeys.some(key => process.env[key] === ${JSON.stringify(proxy)})) {
        throw new Error('Proxy fixture did not reach subprocess');
      }
      const nativeFetch = globalThis.fetch;
      const request = createPinnedHttpFetch((url, opts) => nativeFetch(url, {
        ...opts, tls: { ...opts.tls, ca: readFileSync(${JSON.stringify(certPath)}, 'utf8') },
      }));
      for (const [scheme, port] of [['http', ${direct.port}], ['https', ${secure.port}]]) {
        const url = new URL(scheme + '://localhost:' + port + '/');
        const target = { resolvedUrl: scheme + '://127.0.0.1:' + port + '/', resolvedIp: '127.0.0.1', originalHost: 'localhost', ipv6: false };
        try {
          await request(target, url, { method: 'GET', headers: new Headers(), signal: AbortSignal.timeout(3000) });
          throw new Error('Unexpected connection');
        } catch (err) {
          if (err.code !== 'PROXY_NOT_SUPPORTED') throw err;
          console.log(err.code);
        }
      }
    `;
    // Windows environment names are case-insensitive: an empty lowercase alias
    // can overwrite the populated uppercase key (or vice versa) during spawn.
    // Remove every spelling before adding just the variant under test.
    const proxyEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].includes(key.toLowerCase())));
    try {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        const proc = Bun.spawn([process.execPath, '--no-env-file', '--eval', script], {
          env: { ...proxyEnv, NO_PROXY: '*', [key]: proxy },
          stdout: 'pipe', stderr: 'pipe',
        });
        const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        expect({ exit, err }).toEqual({ exit: 0, err: '' });
        expect(out.trim().split('\n')).toEqual(['PROXY_NOT_SUPPORTED', 'PROXY_NOT_SUPPORTED']);
      }
      expect(directHits).toBe(0);
      expect(trapHits).toBe(0);
    } finally {
      await Promise.all([trap.stop(true), direct.stop(true), secure.stop(true)]);
    }
  });

  test.each(['overflow', 'header-only'])('%s closes a real response without consuming the full body', async mode => {
    let closed = false;
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch() {
        let timer: ReturnType<typeof setInterval>;
        return new Response(new ReadableStream({
          start(controller) { timer = setInterval(() => controller.enqueue(new Uint8Array(128)), 5); },
          cancel() { clearInterval(timer); closed = true; },
        }));
      },
    });
    try {
      const original = new URL(`http://localhost:${server.port}/`);
      const result = fetchWithSSRFGuard(original.href, { maxBytes: 8, headerOnly: mode === 'header-only' }, {
        resolve: async () => localTarget(original),
      });
      if (mode === 'overflow') await expect(result).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
      else expect((await result).body.byteLength).toBe(0);
      for (let i = 0; i < 30 && !closed; i++) await Bun.sleep(5);
      expect(closed).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test.each(['gzip', 'deflate', 'br'])('native %s responses are decoded exactly once and bounded', async encoding => {
    const payload = Buffer.from('bounded test payload');
    const compressed = encoding === 'gzip' ? gzipSync(payload)
      : encoding === 'deflate' ? deflateSync(payload) : brotliCompressSync(payload);
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch() { return new Response(new Uint8Array(compressed), { headers: { 'content-encoding': encoding } }); },
    });
    try {
      const original = new URL(`http://localhost:${server.port}/`);
      const deps = { resolve: async () => localTarget(original) };
      const response = await fetchWithSSRFGuard(original.href, { maxBytes: payload.length }, deps);
      expect(response.body).toEqual(payload);
      await expect(fetchWithSSRFGuard(original.href, { maxBytes: payload.length - 1 }, deps))
        .rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    } finally {
      await server.stop(true);
    }
  });
});
