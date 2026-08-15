/**
 * mcp-registration.ts — shared MCP-registration helpers for HTTP+bearer
 * wiring (extracted from src/commands/connect.ts for #4043 [F5]: the harness
 * lane in src/core/bootstrap/ needs these, and core must not import from
 * commands). connect.ts re-exports everything here, so its public surface
 * and tests are unchanged.
 */

export const REDACTED = '***';
export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export type UrlResult =
  | { ok: true; url: string; warning?: string }
  | { ok: false; error: string };

/**
 * Block link-local / cloud-metadata addresses — the one class of host that is
 * never a legitimate brain endpoint but IS a token-exfil target (e.g. the AWS/
 * GCP metadata service at 169.254.169.254). Deliberately does NOT block
 * localhost or RFC1918/LAN ranges: self-hosted brains on a private network are
 * a documented, supported topology (`gbrain serve --http --bind`).
 */
export function isLinkLocalOrMetadata(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // IPv4 link-local incl. cloud metadata
  if (h.startsWith('fe80:')) return true;                  // IPv6 link-local
  if (h === 'fd00:ec2::254') return true;                  // AWS IMDSv2 over IPv6
  // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254 dotted, or ::ffff:a9fe:xxxx
  // hex where a9fe == 169.254) must not slip past the dotted-IPv4 check.
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped) {
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(mapped[1])) return true;
    if (mapped[1].startsWith('a9fe:')) return true;
  }
  return false;
}

/** True for loopback hosts — the harness lane's `--url` guard [F3]. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * Normalize an MCP URL to a canonical `<scheme>//<host><path>` ending in /mcp.
 * Explicit spec (not best-effort) — see plan D-codex findings.
 */
export function normalizeMcpUrl(input: string): UrlResult {
  const raw = (input ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'Missing MCP URL. Usage: gbrain connect <https://host/mcp> --token <bearer>' };
  }
  // Require an explicit scheme. A bare `host:3131` parses as scheme `host:`
  // under WHATWG URL, so reject anything without `://`.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const guess = raw.replace(/^\/+/, '');
    return { ok: false, error: `Add an explicit scheme, e.g. https://${guess} (a bare host:port is ambiguous).` };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid URL: ${raw}` };
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, error: `Only http(s) URLs are supported (got ${u.protocol}).` };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Remove credentials from the URL (user:pass@host is not supported); pass the token via --token.' };
  }
  if (u.search) {
    return { ok: false, error: 'Remove the query string from the MCP URL.' };
  }
  if (isLinkLocalOrMetadata(u.hostname)) {
    return { ok: false, error: `Refusing to target a link-local / cloud-metadata address (${u.hostname}). Point the MCP URL at the brain host's real address.` };
  }
  const host = u.host; // host:port; hostname already lowercased by URL
  const path = u.pathname;
  const trimmed = path.replace(/\/+$/, '');
  const lower = trimmed.toLowerCase();
  let finalPath: string;
  if (path === '' || path === '/') {
    finalPath = '/mcp';
  } else if (lower === '/mcp') {
    finalPath = '/mcp';
  } else {
    return {
      ok: false,
      error: `Unexpected path '${path}'. Pass the full /mcp URL, e.g. ${scheme}//${host}${trimmed}/mcp`,
    };
  }
  const url = `${scheme}//${host}${finalPath}`;
  if (scheme === 'http:' && !isLoopbackHostname(u.hostname)) {
    return { ok: true, url, warning: 'Warning: http:// sends your bearer token unencrypted. Use https:// unless this is localhost.' };
  }
  return { ok: true, url };
}

/** The OAuth issuer is the server base — the /mcp endpoint's URL minus /mcp. */
export function issuerFromMcpUrl(url: string): string {
  return url.replace(/\/mcp$/, '');
}

export type TokenValidation = { ok: true } | { ok: false; error: string };

/** Reject empty/whitespace/control-char tokens (a newline is a header-injection vector). */
export function validateToken(token: string): TokenValidation {
  if (!token || !token.trim()) return { ok: false, error: 'Token is empty.' };
  if (/\s/.test(token)) return { ok: false, error: 'Token contains whitespace (space/tab/newline) — refusing (header-injection risk).' };
  if (/[\x00-\x1f\x7f]/.test(token)) return { ok: false, error: 'Token contains control characters — refusing (header-injection risk).' };
  return { ok: true };
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * `claude mcp add` argv for an HTTP+bearer registration. `scope` is optional
 * and appended only when given — the claude CLI's default is `local`, so the
 * harness lane MUST pass 'user' explicitly; the connect lane's historical
 * argv (no scope) is byte-identical when omitted.
 */
export function buildClaudeMcpAddArgv(p: {
  name: string;
  url: string;
  headerToken: string;
  scope?: 'local' | 'user' | 'project';
}): string[] {
  return [
    'mcp', 'add', p.name,
    ...(p.scope ? ['--scope', p.scope] : []),
    '-t', 'http', p.url,
    '-H', `Authorization: Bearer ${p.headerToken}`,
  ];
}

/** Codex reads the bearer from an env var at runtime — the token is NOT in argv. */
export function buildCodexMcpAddArgv(p: { name: string; url: string; envVar: string }): string[] {
  return ['mcp', 'add', p.name, '--url', p.url, '--bearer-token-env-var', p.envVar];
}

/**
 * POSIX single-quote any arg that isn't already shell-safe, so `$()`, backticks,
 * etc. in a token are inert literals when the block is pasted into a shell
 * (double-quoting would still allow command substitution).
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Render `<binary> <argv...>` as a copy-pasteable, shell-safe command string. */
export function cmdString(binary: string, argv: string[]): string {
  return `${binary} ${argv.map(shellQuote).join(' ')}`;
}

export function redactToken(s: string, token: string | null): string {
  // Exact-substring scrub of the known token, plus a defense-in-depth pass over
  // any `Bearer <value>` shape the SDK/CLI might echo in a transformed form the
  // exact match would miss.
  let out = token ? s.split(token).join(REDACTED) : s;
  out = out.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
  return out;
}
