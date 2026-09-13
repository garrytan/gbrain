import { afterEach, describe, expect, test } from 'bun:test';
import { isInternalUrl, isPrivateIpv4 } from '../src/core/url-safety.ts';
import { __setDnsLookupForTests, validateAndResolveUrl } from '../src/core/ssrf-validate.ts';

// IANA special-purpose registries, checked September 2026. These tests never dial a target.
const NONPUBLIC_V4 = [
  '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1',
  '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.0', '192.0.0.8',
  '192.0.0.11', '192.0.0.170', '192.0.0.171', '192.0.2.1', '192.88.99.1',
  '192.88.99.2', '192.168.0.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
  '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
];
const PUBLIC_V4 = [
  '8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255',
  '172.32.0.0', '192.0.0.9', '192.0.0.10', '192.31.196.1', '192.52.193.1',
  '192.175.48.1', '198.17.255.255', '198.20.0.0', '198.51.99.255', '203.0.114.1',
  '223.255.255.254',
];
const NONPUBLIC_V6 = [
  '::', '::1', '::127.0.0.1', '64:ff9b:1::1', '100::1', '100:0:0:1::1',
  '2001::1', '2001:1::4', '2001:2::1', '2001:10::1', '2001:1f::1', '2001:100::1',
  '2001:db8::1', '2002:7f00:1::1', '3fff::1', '3fff:fff:ffff::1', '5f00::1',
  'fc00::1', 'fdff:ffff::1', 'fe80::1', 'febf:ffff::1', 'fec0::1', 'feff:ffff::1',
  'ff00::1', 'ff02::1', 'ffff:ffff::1',
];
const PUBLIC_V6 = [
  '2606:4700:4700::1111', '2001:4860:4860::8888', '2606:2800:220:1::1',
  '2001:1::1', '2001:1::2', '2001:1::3', '2001:3::1', '2001:4:112::1',
  '2001:20::1', '2001:2f:ffff::1', '2001:30::1', '2001:3f:ffff::1',
  '2001:200::1', '2620:4f:8000::1', '3fff:1000::1',
];

afterEach(() => __setDnsLookupForTests(undefined));

describe('shared public-address boundary', () => {
  for (const [blocked, addresses] of [[true, NONPUBLIC_V4], [false, PUBLIC_V4]] as const) {
    test.each(addresses)('IPv4 and mapped/translated forms preserve classification: %s', address => {
      expect(isPrivateIpv4(address.split('.').map(Number))).toBe(blocked);
      expect(isInternalUrl(`http://${address}/`)).toBe(blocked);
      // WHATWG normalization converts dotted mapped tails to hex; both inputs must agree.
      const mapped = new URL(`http://[::ffff:${address}]/`).href;
      expect(isInternalUrl(`http://[::ffff:${address}]/`)).toBe(blocked);
      expect(isInternalUrl(mapped)).toBe(blocked);
      const octets = address.split('.').map(Number);
      const tail = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
      expect(isInternalUrl(`http://[64:ff9b::${tail}]/`)).toBe(blocked);
    });
  }
  test.each(NONPUBLIC_V6)('rejects nonpublic IPv6 %s', address => {
    expect(isInternalUrl(`http://[${address}]/`)).toBe(true);
  });
  test.each(PUBLIC_V6)('preserves public IPv6 %s', address => {
    expect(isInternalUrl(`http://[${address}]/`)).toBe(false);
  });
  test.each([...NONPUBLIC_V4, ...NONPUBLIC_V6])('rejects an otherwise-public DNS answer set containing %s', async address => {
    __setDnsLookupForTests((async () => [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]) as any);
    await expect(validateAndResolveUrl('https://synthetic.example/')).rejects.toMatchObject({ code: 'DNS_RESOLVED_INTERNAL' });
  });
  test('malformed octet arrays fail closed', () => {
    for (const octets of [[], [8, 8, 8], [8, 8, 8, -1], [8, 8, 8, 256], [8, 8, 8, 1.5], [8, 8, 8, NaN]]) {
      expect(isPrivateIpv4(octets)).toBe(true);
    }
  });
  test.each(['localhost.', 'nested.localhost.', 'metadata.google.internal.', 'metadata.'])('canonical trailing-dot hostname is blocked: %s', hostname => {
    expect(isInternalUrl(`http://${hostname}/`)).toBe(true);
  });
});
