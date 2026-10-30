/**
 * client.ts — the outbound connector HTTP client.
 *
 * Modeled on `GitHubClient` (`../github-source.ts`): plain `fetch` against a
 * hardcoded base ORIGIN with an off-origin guard so the cookie/bearer never
 * leaks, redirects never followed, a browser User-Agent, refresh-once-on-401
 * (never on a 403: #7515), Retry-After backoff via the shared
 * `parseRetryAfterMs`, and a per-run request ceiling and deadline. NOT routed through `fetchWithSSRFGuard` — that
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
import type { ProbeResult } from './types.ts';

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

/** Raised on a 429 that outlasts its retries, or asks for a wait over MAX_RETRY_AFTER_MS: the run stops. */
export class ConnectorRateLimitedError extends Error {
  readonly code = 'rate_limited';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorRateLimitedError';
  }
}

/**
 * #7483: an auth header value no HTTP header can carry (CR, LF, NUL, other control or non-ASCII characters). The
 * message names the header, never its value.
 */
export class ConnectorCredentialFormatError extends Error {
  readonly code = 'invalid_header_value';
  constructor(header: string) {
    super(
      `connector: the ${header} credential holds a character an HTTP header cannot carry (a line break, control or ` +
        'non-ASCII character); copy it again and re-run `gbrain connectors auth`',
    );
    this.name = 'ConnectorCredentialFormatError';
  }
}

/** #7483: a request that failed before any response. The message carries the error's code, never the runtime's text. */
export class ConnectorNetworkError extends Error {
  readonly code = 'network';
  constructor(pathOrUrl: string, cause: unknown) {
    const c = cause as { code?: unknown; name?: unknown };
    const reason = typeof c?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(c.code) ? c.code : typeof c?.name === 'string' ? c.name : 'Error';
    super(`connector: request to ${pathOrUrl} failed (${reason})`);
    this.name = 'ConnectorNetworkError';
  }
}

/** Requests one run may make, whatever --max-requests asks for (#7515). At the 700 ms spacing this is about 2 hours. */
export const MAX_CONNECTOR_REQUESTS_PER_RUN = 10_000;

/** #7515: the run reached its request ceiling or its deadline; it stops before the next request. */
export class ConnectorRunLimitError extends Error {
  readonly code = 'run_limit';
  constructor(readonly reason: 'max_requests' | 'deadline', message: string) {
    super(message);
    this.name = 'ConnectorRunLimitError';
  }
}

/** A response that stayed non-OK after the client's bounded retries. `status` tells a provider outage (5xx) from an item error (4xx). */
export class ConnectorHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ConnectorHttpError';
  }
}

/** A probe's verdict for an error this client threw: one table for both providers and `connectors auth`. */
export function probeFailure(e: unknown): Exclude<ProbeResult, { ok: true }> {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof ConnectorAuthError) return { ok: false, kind: 'unauthorized', detail };
  if (e instanceof ConnectorForbiddenError) return { ok: false, kind: 'forbidden_fingerprint', detail };
  if (e instanceof ConnectorRateLimitedError) return { ok: false, kind: 'rate_limited', detail };
  if (e instanceof ConnectorCredentialFormatError) return { ok: false, kind: 'invalid_credential', detail };
  return { ok: false, kind: 'network', detail };
}

/** Printable ASCII only: a cookie or token never needs more, and Bun's fetch throws on anything else. */
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;

/** A desktop-browser UA so the request doesn't self-identify as a bot. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export interface ConnectorClientOpts {
  /** Compile-time base origin, e.g. `https://chatgpt.com`. */
  baseUrl: string;
  /** Auth headers (bearer and/or Cookie), re-read per request. */
  headers: () => Promise<Record<string, string>>;
  /**
   * 401 → this refreshes the credential (re-mint accessToken from cookie / oauth grant) → retry once. It is handed
   * this client so the refresh request gets the same origin guard, redirect refusal, pacing and request budget.
   */
  refresh?: (client: ConnectorClient) => Promise<boolean>;
  /** Requests this client may make; capped at MAX_CONNECTOR_REQUESTS_PER_RUN. */
  maxRequests?: number;
  /** Epoch ms after which no request (or retry wait) starts. */
  deadlineAt?: number;
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
/** #7482: a Retry-After longer than this stops the run instead of holding it. */
export const MAX_RETRY_AFTER_MS = 120_000;

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
  private readonly refresh?: (client: ConnectorClient) => Promise<boolean>;
  private readonly maxRequests: number;
  private readonly deadlineAt?: number;
  private requests = 0;
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
    this.maxRequests = Math.min(opts.maxRequests ?? MAX_CONNECTOR_REQUESTS_PER_RUN, MAX_CONNECTOR_REQUESTS_PER_RUN);
    this.deadlineAt = opts.deadlineAt;
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

  /** Stop before a request (or a retry wait of `waitMs`) that the run's ceiling or deadline does not allow. */
  private checkLimits(pathOrUrl: string, waitMs = 0): void {
    if (this.deadlineAt !== undefined && this.now() + waitMs >= this.deadlineAt) {
      throw new ConnectorRunLimitError('deadline', `connector: run deadline reached before ${pathOrUrl}`);
    }
    if (waitMs === 0 && this.requests >= this.maxRequests) {
      throw new ConnectorRunLimitError('max_requests', `connector: run stopped at its ${this.maxRequests}-request limit before ${pathOrUrl}`);
    }
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
   * A 403 or a redirect is terminal without a refresh (#7515). `headers`
   * replaces the auth headers for this request; `refresh: false` (the
   * refresh request itself) never refreshes.
   */
  async fetchJSON<T>(
    pathOrUrl: string,
    opts: { signal?: AbortSignal; headers?: Record<string, string>; refresh?: boolean } = {},
  ): Promise<T> {
    const url = this.resolve(pathOrUrl);
    let refreshed = false;
    let rateRetries = 0;

    for (;;) {
      const auth = opts.headers ?? await this.headers();
      for (const [name, value] of Object.entries(auth)) {
        if (!HEADER_VALUE_RE.test(value)) throw new ConnectorCredentialFormatError(name);
      }
      this.checkLimits(pathOrUrl);
      await this.pace(opts.signal);
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'application/json', ...auth },
          signal: opts.signal,
          redirect: 'manual',
        });
      } catch (e) {
        if (opts.signal?.aborted || (e as { name?: unknown })?.name === 'AbortError') throw e;
        throw new ConnectorNetworkError(pathOrUrl, e);
      }
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
        // A session-cookie 403 is a refusal a re-minted token cannot fix: stop instead of refreshing (#7515).
        if (this.refresh && !refreshed && res.status !== 403 && opts.refresh !== false) {
          this.log(`[connector] ${c.detail}; refreshing credential and retrying once`);
          refreshed = true;
          const ok = await this.refresh(this);
          if (ok) continue;
        }
        throw new ConnectorAuthError(`${c.detail} (${pathOrUrl})`);
      }

      if (c.kind === 'forbidden_fingerprint') {
        throw new ConnectorForbiddenError(`${c.detail} (${pathOrUrl})`);
      }

      if (c.kind === 'rate_limited') {
        const waitMs = c.retryAfterMs ?? 60_000;
        if (waitMs > MAX_RETRY_AFTER_MS) {
          throw new ConnectorRateLimitedError(
            `connector: rate limited on ${pathOrUrl}; the provider asked for a ${Math.round(waitMs / 1000)}s wait, over the ${MAX_RETRY_AFTER_MS / 1000}s cap`,
          );
        }
        if (rateRetries < MAX_RATE_RETRIES) {
          this.checkLimits(pathOrUrl, waitMs);
          rateRetries++;
          this.log(`[connector] ${c.detail}; retry ${rateRetries}/${MAX_RATE_RETRIES} in ${Math.round(waitMs / 1000)}s`);
          await this.sleep(waitMs, opts.signal);
          continue;
        }
        throw new ConnectorRateLimitedError(`connector: rate limited on ${pathOrUrl} after ${MAX_RATE_RETRIES} retries`);
      }

      // redirect: (fetch runs with redirect 'manual') never followed, so the cookie never leaves the origin; an API
      // that redirects is sending the session to a login page (#7515).
      if (res.status >= 300 && res.status < 400) {
        throw new ConnectorAuthError(`HTTP ${res.status} redirect not followed (${pathOrUrl}); the session likely expired`);
      }
      // server_error or drift: one bounded retry for transient 5xx, else throw.
      if (c.kind === 'server_error' && rateRetries < MAX_RATE_RETRIES) {
        this.checkLimits(pathOrUrl, 1000 * (rateRetries + 1));
        rateRetries++;
        await this.sleep(1000 * rateRetries, opts.signal);
        continue;
      }
      throw new ConnectorHttpError(`connector: ${c.detail} on ${pathOrUrl}`, res.status);
    }
  }
}
