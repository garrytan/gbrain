/**
 * Health / occupancy probes for `gbrain mcp expose`, peeled from
 * `mcp-expose.ts`: one bounded `tryFetch` that never throws, the `/health`
 * bar (`probeHealth`), the "does ANYTHING listen" bar (`probeOccupied`), the
 * wall-clock poller (`pollHealth`) and the name-resolution verdict behind the
 * `verify.tailnet` warn.
 *
 * Why a resolver call and not just the fetch error: Bun's `fetch` rejects an
 * unresolvable host with the SAME error as a refused connection
 * (`Unable to connect. Is the computer able to access the url?`, code
 * `ConnectionRefused`), so a message match alone never fires in production.
 * After a rejection the URL's hostname is handed to `deps.lookup` (default
 * `dns.promises.lookup`) and ITS error decides; the message regex stays a
 * secondary hint for runtimes that do spell the cause out. IP literals and
 * `localhost` never involve the resolver and are skipped.
 *
 * Every side effect is injected through `ProbeDeps` (a narrow slice of
 * `mcp-expose.ts`'s resolved deps) so tests run with a fake fetch, a fake
 * TCP probe and a fake resolver.
 */
import { lookup } from 'node:dns/promises';
import { createConnection, isIP } from 'node:net';
import { TAILSCALE_ACCEPT_DNS_COMMAND } from '../core/tailscale.ts';

export type ProbeFetch = (url: string, init?: { signal?: AbortSignal; redirect?: 'manual' | 'error' | 'follow' }) => Promise<{ ok: boolean; status: number }>;
/** Bounded TCP connect to `host:port` (true on connect, false on refusal / timeout). */
export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;
/** Resolves when `hostname` resolves on THIS host; rejects with the resolver's error (`code` `ENOTFOUND`, `EAI_AGAIN`, …) otherwise. */
export type HostLookup = (hostname: string) => Promise<void>;

export interface ProbeDeps {
  fetch: ProbeFetch;
  tcpProbe: TcpProbe;
  lookup: HostLookup;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  healthIntervalMs: number;
}

/** A fetch rejection whose MESSAGE already names a resolution failure (a secondary hint; Bun's does not). */
const NAME_RESOLUTION_RE = /ENOTFOUND|getaddrinfo|EAI_AGAIN|failed to resolve|Unable to connect.*resolve/i;
/** Resolver error codes that mean "this host cannot resolve the name" (a resolver outage — `EAI_AGAIN` — counts: the verdict is about THIS host). */
const UNRESOLVED_LOOKUP_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA', 'DNS_ENOTFOUND']);
const UNRESOLVED_LOOKUP_RE = /ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA|DNS_ENOTFOUND/;

/** Default `tcpProbe`: one connect attempt, the socket destroyed on every outcome. Any listener — HTTP or not — accepts the connect. */
export function defaultTcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const sock = createConnection({ host, port });
    const done = (v: boolean) => { if (settled) return; settled = true; sock.destroy(); resolve(v); };
    sock.setTimeout(Math.max(1, timeoutMs), () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Default `lookup`: the system resolver (`getaddrinfo`), the same one `fetch` consults. */
export const defaultLookup: HostLookup = async (hostname) => { await lookup(hostname); };

export interface FetchOutcome {
  /** The response (whatever its status), or null when the fetch rejected (connection refused / timeout / unresolved name). */
  res: { ok: boolean } | null;
  /** The rejection was a name-resolution failure: this host cannot resolve the name, which says nothing about the server. */
  unresolved: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A rejection from `deps.lookup` that means the name does not resolve here (by `code`, else by message token). */
export function isUnresolvedLookupError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && UNRESOLVED_LOOKUP_CODES.has(code)) return true;
  return UNRESOLVED_LOOKUP_RE.test(errorMessage(error));
}

/**
 * Whether a fetch REJECTION for `url` means this host cannot resolve the
 * name. The resolver is asked directly (bounded by `timeoutMs`; a lookup that
 * does not answer in time proves nothing and falls through), skipped for IP
 * literals and `localhost`; the fetch message is the secondary hint.
 */
async function nameUnresolved(d: ProbeDeps, url: string, error: unknown, timeoutMs: number): Promise<boolean> {
  let host = '';
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { host = ''; }
  if (host && host.toLowerCase() !== 'localhost' && isIP(host) === 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, timeoutMs)); });
    try {
      await Promise.race([d.lookup(host), deadline]);
    } catch (lookupError) {
      if (isUnresolvedLookupError(lookupError)) return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return NAME_RESOLUTION_RE.test(errorMessage(error));
}

/** One bounded fetch, never throws. */
export async function tryFetch(d: ProbeDeps, url: string, timeoutMs: number): Promise<FetchOutcome> {
  // The resolver check after a rejection spends only what the fetch left of
  // the same budget, so one attempt never exceeds `timeoutMs` even when a
  // timed-out fetch is followed by a stalled resolver.
  const started = Date.now();
  try {
    return { res: await d.fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }), unresolved: false };
  } catch (error) {
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    return { res: null, unresolved: await nameUnresolved(d, url, error, remaining) };
  }
}

/** Health: the fetch resolved AND answered 2xx (`res.ok`). Used by `verify.*` and `--status`. */
export async function probeHealth(d: ProbeDeps, url: string, timeoutMs = 1_500): Promise<boolean> {
  return (await tryFetch(d, url, timeoutMs)).res?.ok === true;
}

/**
 * Occupancy: does ANYTHING listen on the port? True when a TCP connect to
 * `127.0.0.1:<port>` is accepted OR the fetch resolves with any status (2xx,
 * 404, 500 …); false only when both are refused / time out. A foreign server
 * that 404s `/health`, or one that does not speak HTTP at all, still owns the
 * port, so the foreign-listener guard and the `--no-service` "does something
 * listen" logic use this, never `probeHealth`.
 */
export async function probeOccupied(d: ProbeDeps, port: number, url: string, timeoutMs = 1_500): Promise<boolean> {
  const [tcp, http] = await Promise.all([
    d.tcpProbe('127.0.0.1', port, timeoutMs).catch(() => false),
    tryFetch(d, url, timeoutMs),
  ]);
  return tcp || http.res !== null;
}

/**
 * Poll until `budgetMs` of wall-clock time (from `d.now()`) has elapsed; each
 * probe's timeout is sized to `min(1500, remaining)` so the last attempt never
 * overruns the budget. Always probes at least once. The attempt cap is a
 * backstop for a clock that does not advance (tests inject a frozen `now`).
 * `unresolved` carries the LAST probe's name-resolution verdict so the caller
 * can tell "this host cannot resolve the name" from "still pending".
 */
export async function pollHealth(d: ProbeDeps, url: string, budgetMs: number): Promise<{ ok: boolean; unresolved: boolean }> {
  const deadline = d.now().getTime() + Math.max(0, budgetMs);
  const maxAttempts = Math.max(1, Math.ceil(budgetMs / Math.max(1, d.healthIntervalMs)));
  let unresolved = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = deadline - d.now().getTime();
    if (attempt > 0 && remaining <= 0) break;
    const probe = await tryFetch(d, url, Math.max(1, Math.min(1_500, remaining)));
    if (probe.res?.ok === true) return { ok: true, unresolved: false };
    unresolved = probe.unresolved;
    const left = deadline - d.now().getTime();
    if (left <= 0) break;
    await d.sleep(Math.min(d.healthIntervalMs, left));
  }
  return { ok: false, unresolved };
}

/** `verify.tailnet` / `--status` detail when this host cannot resolve the MagicDNS name — a warn, never `pending`. */
export function unresolvedDetail(dnsName: string): string {
  return `this host cannot resolve ${dnsName} (MagicDNS may be off here: \`${TAILSCALE_ACCEPT_DNS_COMMAND}\`); devices that do resolve it may already reach the server`;
}
