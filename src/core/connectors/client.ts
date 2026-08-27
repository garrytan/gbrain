/**
 * client.ts — the outbound connector HTTP client.
 *
 * Modeled on `GitHubClient` (`../github-source.ts`): plain `fetch` against a
 * hardcoded base ORIGIN with an off-origin guard so the cookie/bearer never
 * leaks, a browser User-Agent, refresh-once-on-401, and Retry-After backoff via
 * the shared `parseRetryAfterMs`. NOT routed through `fetchWithSSRFGuard` — that
 * rewrites the URL to a resolved IP and breaks SNI on Cloudflare-fronted hosts;
 * SSRF guards are for user-controlled URLs, and these base origins are
 * compile-time constants.
 *
 * Every failure classification goes through the pure `classifyResponse`
 * (`./classify.ts`), which distinguishes a Cloudflare fingerprint 403 (dead-end)
 * from an auth-expired 403 (re-auth) — the §2A distinction. `sleep`/`now` are
 * injectable so Retry-After/pacing tests don't wall-clock.
 */

import { classifyResponse } from './classify.ts';

/** Same shape as github-source's FetchImpl, re-declared to avoid a value import. */
export type ConnectorFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Raised on a 401 that survives one refresh — the user must re-authenticate. */
export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorAuthError';
  }
}

/** Raised on a Cloudflare-fingerprint 403 — server-side fetch is blocked. */
export class ConnectorForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorForbiddenError';
  }
}

/** A desktop-browser UA so the request doesn't self-identify as a bot. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export interface ConnectorClientOpts {
  /** Compile-time base origin, e.g. `https://chatgpt.com`. */
  baseUrl: string;
  /** Auth headers (bearer and/or Cookie), re-read per request. */
  headers: () => Promise<Record<string, string>>;
  /** 401 → this refreshes the credential (re-mint accessToken from cookie / oauth grant) → retry once. */
  refresh?: () => Promise<boolean>;
  /** Polite spacing between requests, ms. Default 700. */
  minDelayMs?: number;
  /** Test seam. Default global fetch. */
  fetchImpl?: ConnectorFetch;
  /** Injectable sleep so Retry-After tests don't wall-clock. Default setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable clock (for Retry-After HTTP-date parsing). Default Date.now. */
  now?: () => number;
  log?: (msg: string) => void;
}

const MAX_RATE_RETRIES = 4;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    }
  });
}

export class ConnectorClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly headers: () => Promise<Record<string, string>>;
  private readonly refresh?: () => Promise<boolean>;
  private readonly minDelayMs: number;
  private readonly fetchImpl: ConnectorFetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private lastRequestAt = 0;

  constructor(opts: ConnectorClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.origin = new URL(this.baseUrl).origin;
    this.headers = opts.headers;
    this.refresh = opts.refresh;
    this.minDelayMs = opts.minDelayMs ?? 700;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as ConnectorFetch);
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Resolve a relative path (or absolute same-origin URL) to a full URL, off-origin refused. */
  private resolve(pathOrUrl: string): string {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    if (new URL(url).origin !== this.origin) {
      throw new ConnectorForbiddenError(
        `refusing to send credential off-origin: ${url} is not ${this.origin}`,
      );
    }
    return url;
  }

  /** Cooperative pacing so we stay a polite client. */
  private async pace(signal?: AbortSignal): Promise<void> {
    const since = this.now() - this.lastRequestAt;
    if (this.lastRequestAt !== 0 && since < this.minDelayMs) {
      await this.sleep(this.minDelayMs - since, signal);
    }
    this.lastRequestAt = this.now();
  }

  /**
   * GET a URL and parse JSON. Handles pacing, 401→refresh→retry-once,
   * 429/Retry-After backoff, and the §2A 403 disambiguation. Throws
   * `ConnectorAuthError` / `ConnectorForbiddenError` on terminal states.
   */
  async fetchJSON<T>(pathOrUrl: string, opts: { signal?: AbortSignal } = {}): Promise<T> {
    const url = this.resolve(pathOrUrl);
    let refreshed = false;
    let rateRetries = 0;

    for (;;) {
      await this.pace(opts.signal);
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'application/json', ...(await this.headers()) },
        signal: opts.signal,
        redirect: 'manual',
      });
      const bodyText = await res.text();
      const c = classifyResponse(res, bodyText, this.now());

      if (c.kind === 'ok') {
        try {
          return JSON.parse(bodyText) as T;
        } catch {
          throw new Error(`connector: expected JSON on ${pathOrUrl} but body did not parse`);
        }
      }

      if (c.kind === 'auth_required') {
        if (this.refresh && !refreshed) {
          this.log(`[connector] ${c.detail}; refreshing credential and retrying once`);
          refreshed = true;
          const ok = await this.refresh();
          if (ok) continue;
        }
        throw new ConnectorAuthError(`${c.detail} (${pathOrUrl})`);
      }

      if (c.kind === 'forbidden_fingerprint') {
        throw new ConnectorForbiddenError(`${c.detail} (${pathOrUrl})`);
      }

      if (c.kind === 'rate_limited') {
        if (rateRetries < MAX_RATE_RETRIES) {
          rateRetries++;
          const waitMs = c.retryAfterMs ?? 60_000;
          this.log(`[connector] ${c.detail}; retry ${rateRetries}/${MAX_RATE_RETRIES} in ${Math.round(waitMs / 1000)}s`);
          await this.sleep(waitMs, opts.signal);
          continue;
        }
        throw new Error(`connector: rate limited on ${pathOrUrl} after ${MAX_RATE_RETRIES} retries`);
      }

      // server_error or drift: one bounded retry for transient 5xx, else throw.
      if (c.kind === 'server_error' && rateRetries < MAX_RATE_RETRIES) {
        rateRetries++;
        await this.sleep(1000 * rateRetries, opts.signal);
        continue;
      }
      throw new Error(`connector: ${c.detail} on ${pathOrUrl}`);
    }
  }
}
