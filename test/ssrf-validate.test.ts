// Commit 0 (D19): SSRF validation with DNS resolution.
//
// Covers the gap that `isInternalUrl` in src/core/url-safety.ts leaves open:
// DNS rebinding. validateAndResolveUrl does its own DNS lookup and rejects
// hostnames whose resolved IPs land internal.
//
// Tests use the __setDnsLookupForTests seam so the real network is never hit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  SSRFError,
  __setDnsLookupForTests,
  validateAndResolveUrl,
} from '../src/core/ssrf-validate.ts';

type DnsRecord = { address: string; family: number };
let stubAddrs: Map<string, DnsRecord[]> = new Map();

beforeEach(() => {
  stubAddrs = new Map();
  __setDnsLookupForTests((async (host: string, _opts: any) => {
    const recs = stubAddrs.get(host);
    if (!recs) {
      const err = new Error(`stub: no DNS records for ${host}`);
      (err as any).code = 'ENOTFOUND';
      throw err;
    }
    return recs;
  }) as any);
});

afterEach(() => {
  __setDnsLookupForTests(undefined);
});

describe('validateAndResolveUrl — static rejections (via isInternalUrl)', () => {
  test('rejects http://127.0.0.1 (loopback)', async () => {
    await expect(validateAndResolveUrl('http://127.0.0.1/img.png')).rejects.toBeInstanceOf(SSRFError);
  });
  test('rejects http://169.254.169.254 (AWS metadata)', async () => {
    await expect(validateAndResolveUrl('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(SSRFError);
  });
  test('rejects http://2130706433 (decimal-encoded 127.0.0.1)', async () => {
    await expect(validateAndResolveUrl('http://2130706433/')).rejects.toBeInstanceOf(SSRFError);
  });
  test('rejects http://0x7f000001 (hex-encoded 127.0.0.1)', async () => {
    await expect(validateAndResolveUrl('http://0x7f000001/')).rejects.toBeInstanceOf(SSRFError);
  });
  test('rejects metadata.google.internal hostname', async () => {
    await expect(validateAndResolveUrl('http://metadata.google.internal/')).rejects.toBeInstanceOf(SSRFError);
  });
  test('rejects localhost. (trailing dot)', async () => {
    await expect(validateAndResolveUrl('http://localhost./')).rejects.toBeInstanceOf(SSRFError);
  });
  test('rejects IPv6 link-local fe80::1', async () => {
    await expect(validateAndResolveUrl('http://[fe80::1]/')).rejects.toBeInstanceOf(SSRFError);
  });
});

describe('validateAndResolveUrl — scheme + credentials', () => {
  test('rejects file:// scheme', async () => {
    const err = await validateAndResolveUrl('file:///etc/passwd').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    // file:// is caught by static `isInternalUrl` first (it returns true for non-http(s))
    expect(['INVALID_SCHEME', 'INTERNAL_HOST']).toContain(err.code);
  });
  test('rejects gopher:// scheme', async () => {
    const err = await validateAndResolveUrl('gopher://example.com/').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(['INVALID_SCHEME', 'INTERNAL_HOST']).toContain(err.code);
  });
  test('rejects credentials embedded in URL', async () => {
    stubAddrs.set('example.com', [{ address: '93.184.216.34', family: 4 }]);
    const err = await validateAndResolveUrl('http://user:pass@example.com/').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(err.code).toBe('CREDENTIALS_IN_URL');
  });
});

describe('validateAndResolveUrl — DNS rebinding defense', () => {
  test('rejects when hostname resolves to 127.0.0.1', async () => {
    stubAddrs.set('attacker.com', [{ address: '127.0.0.1', family: 4 }]);
    const err = await validateAndResolveUrl('http://attacker.com/img.png').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(err.code).toBe('DNS_RESOLVED_INTERNAL');
  });
  test('rejects when hostname resolves to 169.254.169.254 (AWS metadata)', async () => {
    stubAddrs.set('attacker.com', [{ address: '169.254.169.254', family: 4 }]);
    const err = await validateAndResolveUrl('http://attacker.com/').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(err.code).toBe('DNS_RESOLVED_INTERNAL');
  });
  test('rejects when ANY resolved record points internal (DNS rebinding multi-record)', async () => {
    stubAddrs.set('mixed.com', [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 }, // private — rejects whole set
    ]);
    const err = await validateAndResolveUrl('http://mixed.com/').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(err.code).toBe('DNS_RESOLVED_INTERNAL');
  });
  test('rejects IPv6 ULA resolved record', async () => {
    stubAddrs.set('attacker.com', [{ address: 'fc00::1', family: 6 }]);
    const err = await validateAndResolveUrl('http://attacker.com/').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(err.code).toBe('DNS_RESOLVED_INTERNAL');
  });
});

describe('validateAndResolveUrl — happy path', () => {
  test('resolves public IPv4 address and returns target', async () => {
    stubAddrs.set('example.com', [{ address: '93.184.216.34', family: 4 }]);
    const target = await validateAndResolveUrl('https://example.com/img.png');
    expect(target.resolvedIp).toBe('93.184.216.34');
    expect(target.originalHost).toBe('example.com');
    expect(target.ipv6).toBe(false);
    expect(target.resolvedUrl).toContain('93.184.216.34');
  });
  test('public IP literal passes through without DNS lookup', async () => {
    const target = await validateAndResolveUrl('https://93.184.216.34/img.png');
    expect(target.resolvedIp).toBe('93.184.216.34');
    expect(target.originalHost).toBe(''); // literal — no original hostname
  });
  test('public IPv6 literal passes through', async () => {
    const target = await validateAndResolveUrl('https://[2606:2800:220:1::1]/');
    expect(target.resolvedIp).toBe('2606:2800:220:1::1');
    expect(target.ipv6).toBe(true);
  });
});

describe('validateAndResolveUrl — DNS resolution failures', () => {
  test('rejects when DNS lookup fails (ENOTFOUND)', async () => {
    const err = await validateAndResolveUrl('http://nonexistent.invalid/').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(err.code).toBe('DNS_RESOLUTION_FAILED');
  });
  test('rejects when DNS lookup returns empty records', async () => {
    stubAddrs.set('empty.com', []);
    const err = await validateAndResolveUrl('http://empty.com/').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(err.code).toBe('DNS_RESOLUTION_FAILED');
  });
});

describe('validateAndResolveUrl — malformed URLs', () => {
  test('rejects unparseable URL', async () => {
    const err = await validateAndResolveUrl('not a url at all').catch(e => e);
    expect(err).toBeInstanceOf(SSRFError);
    expect(err.code).toBe('INVALID_URL');
  });
});
