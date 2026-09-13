/**
 * SSRF defense helpers — extracted from src/commands/integrations.ts (v0.28).
 *
 * Lives in src/core/ so anything in src/core/ (e.g. git-remote.ts) can call
 * the gate without inverting the layering boundary. integrations.ts re-exports
 * for backward compat with existing imports + tests.
 *
 * The helpers are responsible for catching the bypass forms commonly used
 * to defeat naive private-IP filters: IPv4-mapped IPv6, hex/octal/single-int
 * encodings, IPv6 loopback, metadata hostnames, scheme allowlist, and CGNAT
 * 100.64/10 (which is what hits when reaching a Tailscale host).
 */

/** Parse an IPv4 octet from decimal, hex (0x prefix), or octal (leading 0) notation. */
export function parseOctet(s: string): number {
  if (s.length === 0) return NaN;
  if (s.startsWith('0x') || s.startsWith('0X')) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(s)) return NaN;
    return parseInt(s, 16);
  }
  if (s.length > 1 && s.startsWith('0')) {
    if (!/^0[0-7]+$/.test(s)) return NaN;
    return parseInt(s, 8);
  }
  if (!/^\d+$/.test(s)) return NaN;
  return parseInt(s, 10);
}

/**
 * Convert an IPv4 hostname to 4 octets. Handles bypass encodings:
 *   - Dotted decimal: 127.0.0.1
 *   - Single decimal: 2130706433 (= 0x7f000001)
 *   - Hex: 0x7f000001
 *   - Per-octet hex/octal: 0x7f.0.0.1, 0177.0.0.1
 * Returns null for non-IP hostnames (fall through to hostname-based checks).
 */
export function hostnameToOctets(hostname: string): number[] | null {
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    return null;
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    return null;
  }
  const parts = hostname.split('.');
  if (parts.length === 4) {
    const octets = parts.map(parseOctet);
    if (octets.every(o => Number.isFinite(o) && o >= 0 && o <= 255)) return octets;
  }
  return null;
}

/** Classify an IPv4 address as nonpublic, including reserved and multicast ranges. */
export function isPrivateIpv4(octets: number[]): boolean {
  if (octets.length !== 4 || !octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255)) return true;
  const [a, b, c, d] = octets;
  if (a === 127) return true;              // 127.0.0.0/8 loopback
  if (a === 10) return true;               // 10.0.0.0/8 RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. AWS metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (Tailscale)
  if (a === 0) return true;                // 0.0.0.0/8 unspecified
  if (a >= 224) return true;              // Multicast, reserved, and limited broadcast
  // https://www.iana.org/assignments/iana-ipv4-special-registry/
  // Preserve the two globally reachable anycast exceptions in 192.0.0.0/24.
  if (a === 192 && b === 0 && c === 0) return d !== 9 && d !== 10;
  if (a === 192 && b === 0 && c === 2) return true; // Documentation
  if (a === 192 && b === 88 && c === 99) return true; // Deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // Documentation
  if (a === 203 && b === 0 && c === 113) return true; // Documentation
  return false;
}

/** The URL parser has already canonicalized IPv6, including any dotted IPv4 tail. */
function isNonpublicIpv6(host: string): boolean {
  const parts = host.split('::');
  if (parts.length > 2) return true;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const omitted = 8 - left.length - right.length;
  if ((parts.length === 1 && omitted !== 0) || (parts.length === 2 && omitted < 1)) return true;
  const tuples = [...left, ...Array(omitted).fill('0'), ...right];
  if (tuples.length !== 8 || !tuples.every(t => /^[0-9a-f]{1,4}$/.test(t))) return true;
  const words = tuples.map(t => parseInt(t, 16));
  const embeddedV4 = [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff];
  // Mapped addresses and the globally routed NAT64 well-known prefix inherit
  // the embedded IPv4 policy, so alternate encodings cannot reach private IPv4.
  if (words.slice(0, 5).every(w => w === 0) && words[5] === 0xffff) return isPrivateIpv4(embeddedV4);
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(w => w === 0)) return isPrivateIpv4(embeddedV4);

  // Current global unicast allocation is 2000::/3. This excludes unspecified,
  // discard, local translation, ULA, link/site-local, multicast, and reserved space.
  // https://www.iana.org/assignments/ipv6-address-space/
  if ((words[0] & 0xe000) !== 0x2000) return true;
  // https://www.iana.org/assignments/iana-ipv6-special-registry/
  if (words[0] === 0x2001 && words[1] < 0x200) {
    // The IETF protocol block is nonpublic except these globally reachable
    // anycast, AMT, AS112, ORCHIDv2, and drone-identifier allocations.
    if (words[1] === 1 && words.slice(2, 7).every(w => w === 0) && words[7] >= 1 && words[7] <= 3) return false;
    if (words[1] === 3 || (words[1] === 4 && words[2] === 0x112)) return false;
    if (words[1] >= 0x20 && words[1] <= 0x3f) return false;
    return true;
  }
  if (words[0] === 0x2001 && words[1] === 0xdb8) return true; // Documentation
  if (words[0] === 0x2002) return true; // Deprecated 6to4; embedded destinations are not confined
  if (words[0] === 0x3fff && words[1] < 0x1000) return true; // Documentation 3fff::/20
  return false;
}

/** Returns true if the URL targets an internal/metadata endpoint or uses a non-http(s) scheme. Fail-closed on parse errors. */
export function isInternalUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return true; // malformed → block
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

  let host = url.hostname.toLowerCase().replace(/\.$/, '');

  const metadataHostnames = new Set([
    'metadata.google.internal',
    'metadata.google',
    'metadata',
    'instance-data',
    'instance-data.ec2.internal',
  ]);
  if (metadataHostnames.has(host)) return true;

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host.includes(':')) return isNonpublicIpv6(host);

  const octets = hostnameToOctets(host);
  if (octets && isPrivateIpv4(octets)) return true;

  return false;
}
