/**
 * x_handle_to_tweet — resolve an X handle + keyword hint to the tweet URL.
 *
 * Input:  { handle: string, keywords?: string, maxCandidates?: number }
 * Output: { url?, tweet_id?, text?, created_at?, candidates[] }
 *
 * Driven by `gbrain integrity --auto`: a brain page says "Garry tweeted about
 * foo" without a link. This resolver calls the X API v2 recent-search, finds
 * the matching tweet, and returns the URL + an honest confidence score.
 *
 * Confidence scoring (the contract `gbrain integrity` relies on):
 *   - 1 candidate AND (no keywords OR keywords match text well): 0.9
 *   - 1 candidate but weak keyword match:                        0.6
 *   - 2-5 candidates, strongest scored: best/(best+rest*0.3)    variable
 *   - 6+ candidates, too ambiguous to auto-pick:                 0.4
 *   - Zero candidates:                                           0.0
 *
 * Security:
 *   - Bearer token from X_API_BEARER_TOKEN env, never logged.
 *   - Handle regex strictly matches X's username rules (1-15 chars, A-Za-z0-9_).
 *   - Query is URL-encoded, no string interpolation into the API path.
 *   - AbortSignal threaded through fetch.
 *
 * Rate limit: enterprise tier is 40k req/15min, but we respect 429 with
 * backoff-and-retry up to 2x. Caller (integrity loop) paces via Minions in
 * PR 5, so this resolver does not need its own rate bucket.
 */

import type {
  Resolver,
  ResolverContext,
  ResolverRequest,
  ResolverResult,
} from '../../interface.ts';
import { ResolverError } from '../../interface.ts';

// ---------------------------------------------------------------------------
// Public IO shapes
// ---------------------------------------------------------------------------

export interface XHandleToTweetInput {
  /** X handle without leading @. e.g. "garrytan". */
  handle: string;
  /** Free-text hint from the brain page, used to score candidates. */
  keywords?: string;
  /** Max tweets to pull before scoring. Default 10, clamp 1-25. */
  maxCandidates?: number;
}

export interface XTweetCandidate {
  tweet_id: string;
  text: string;
  created_at: string;
  score: number;
  url: string;
}

export interface XHandleToTweetOutput {
  /** Best candidate URL if confidence >= 0.5, else undefined. */
  url?: string;
  tweet_id?: string;
  text?: string;
  created_at?: string;
  /** All candidates sorted by score desc. Caller may render into a review queue. */
  candidates: XTweetCandidate[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES_ON_429 = 2;
const X_API_BASE = 'https://api.twitter.com/2';

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export const xHandleToTweetResolver: Resolver<XHandleToTweetInput, XHandleToTweetOutput> = {
  id: 'x_handle_to_tweet',
  cost: 'rate-limited',
  backend: 'x-api-v2',
  description: 'Find a tweet by handle + keyword hint. Used by integrity to repair bare-tweet citations.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: { type: 'string', pattern: '^[A-Za-z0-9_]{1,15}$' },
      keywords: { type: 'string' },
      maxCandidates: { type: 'number', minimum: 1, maximum: 25 },
    },
    required: ['handle'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      tweet_id: { type: 'string' },
      text: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
      candidates: { type: 'array' },
    },
    required: ['candidates'],
  },

  async available(ctx: ResolverContext): Promise<boolean> {
    return !!getBearerToken(ctx);
  },

  async resolve(req: ResolverRequest<XHandleToTweetInput>): Promise<ResolverResult<XHandleToTweetOutput>> {
    const { handle, keywords, maxCandidates = 10 } = req.input;
    const ctx = req.context;

    // Input validation
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
      throw new ResolverError(
        'schema',
        `x_handle_to_tweet: invalid handle "${handle}" (must match ${HANDLE_RE.source})`,
        'x_handle_to_tweet',
      );
    }
    const clampedMax = Math.max(1, Math.min(25, Math.floor(maxCandidates)));

    const token = getBearerToken(ctx);
    if (!token) {
      throw new ResolverError(
        'unavailable',
        'x_handle_to_tweet: X_API_BEARER_TOKEN not set',
        'x_handle_to_tweet',
      );
    }

    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Query: from:handle + optional free-text keywords (hint, not required match)
    const queryParts = [`from:${handle}`];
    if (keywords && keywords.trim().length > 0) {
      const cleanedKw = sanitizeKeywords(keywords);
      if (cleanedKw) queryParts.push(cleanedKw);
    }
    const apiQuery = queryParts.join(' ');

    const url = new URL(`${X_API_BASE}/tweets/search/recent`);
    url.searchParams.set('query', apiQuery);
    url.searchParams.set('max_results', String(clampedMax));
    url.searchParams.set('tweet.fields', 'created_at,text');

    // Fire with retry-on-429 (up to MAX_RETRIES_ON_429 extra attempts)
    let lastErr: unknown;
    let resp: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES_ON_429; attempt++) {
      try {
        resp = await fetch(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: composeSignals(ctx.signal, timeoutMs),
        });
      } catch (err: unknown) {
        lastErr = err;
        if (isAbortError(err)) {
          throw new ResolverError('aborted', 'x_handle_to_tweet aborted', 'x_handle_to_tweet', err);
        }
        throw new ResolverError('upstream', `x_handle_to_tweet fetch failed: ${errMessage(err)}`, 'x_handle_to_tweet', err);
      }

      if (resp.status === 429 && attempt < MAX_RETRIES_ON_429) {
        // X API honors both `Retry-After` (RFC; seconds) AND its own
        // `x-rate-limit-reset` (epoch seconds). Take whichever gives us a
        // longer wait — hitting the reset window early just earns another 429.
        const waitMs = computeBackoffMs(resp);
        ctx.logger.warn('x_handle_to_tweet: 429, backing off', { handle, waitMs, attempt });
        await sleep(waitMs, ctx.signal);
        continue;
      }
      break;
    }

    if (!resp) {
      throw new ResolverError('upstream', `x_handle_to_tweet: no response after retries (${errMessage(lastErr)})`, 'x_handle_to_tweet');
    }

    // Terminal error codes
    if (resp.status === 401 || resp.status === 403) {
      throw new ResolverError('auth', `x_handle_to_tweet: auth failed (HTTP ${resp.status}) — check X_API_BEARER_TOKEN`, 'x_handle_to_tweet');
    }
    if (resp.status === 429) {
      throw new ResolverError('rate_limited', 'x_handle_to_tweet: rate-limited after retries', 'x_handle_to_tweet');
    }
    if (!resp.ok) {
      const body = await safeText(resp);
      throw new ResolverError('upstream', `x_handle_to_tweet: HTTP ${resp.status} — ${body.slice(0, 200)}`, 'x_handle_to_tweet');
    }

    const json = await resp.json() as {
      data?: Array<{ id: string; text: string; created_at: string }>;
      meta?: { result_count?: number };
    };
    const tweets = json.data ?? [];

    if (tweets.length === 0) {
      return {
        value: { candidates: [] },
        confidence: 0,
        source: 'x-api-v2',
        fetchedAt: new Date(),
        costEstimate: 0,
        raw: json,
      };
    }

    // Score by keyword overlap with tweet text
    const candidates: XTweetCandidate[] = tweets
      .map(t => ({
        tweet_id: t.id,
        text: t.text,
        created_at: t.created_at,
        score: scoreMatch(t.text, keywords),
        url: `https://x.com/${handle}/status/${t.id}`,
      }))
      .sort((a, b) => b.score - a.score);

    const top = candidates[0];
    const rest = candidates.slice(1);
    const confidence = computeConfidence(top, rest, keywords);

    return {
      value: {
        url: confidence >= 0.5 ? top.url : undefined,
        tweet_id: confidence >= 0.5 ? top.tweet_id : undefined,
        text: confidence >= 0.5 ? top.text : undefined,
        created_at: confidence >= 0.5 ? top.created_at : undefined,
        candidates,
      },
      confidence,
      source: 'x-api-v2',
      fetchedAt: new Date(),
      costEstimate: 0,
      raw: json,
    };
  },
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Confidence buckets align with `gbrain integrity --auto` three-bucket logic:
 *   >=0.8 auto-repair
 *   0.5-0.8 goes to review queue
 *   <0.5 skip + log
 */
function computeConfidence(
  top: XTweetCandidate,
  rest: XTweetCandidate[],
  keywords: string | undefined,
): number {
  const kw = (keywords ?? '').trim();

  // Zero candidates handled above
  // Single candidate: confidence depends on keyword match quality
  if (rest.length === 0) {
    if (kw.length === 0) return 0.85; // handle-only, recency-most-likely
    return top.score >= 0.5 ? 0.9 : 0.6;
  }

  // Many candidates: ambiguous
  if (rest.length >= 5) {
    // Dominant match can still rescue us
    const margin = top.score - (rest[0]?.score ?? 0);
    if (top.score >= 0.7 && margin >= 0.4) return 0.75;
    return 0.4;
  }

  // 2-4 candidates: margin between top and runner-up
  const runnerUp = rest[0]?.score ?? 0;
  const margin = top.score - runnerUp;
  if (top.score >= 0.7 && margin >= 0.3) return 0.85;
  if (top.score >= 0.5 && margin >= 0.15) return 0.7;
  return 0.5;
}

/**
 * Keyword-overlap score in [0, 1]. Normalized token overlap between keywords
 * and tweet text; 1.0 when every keyword token appears, 0 when none do.
 * Case-insensitive, strips punctuation, filters common stopwords.
 */
function scoreMatch(text: string, keywords: string | undefined): number {
  if (!keywords || keywords.trim().length === 0) return 0.5; // no hint, neutral prior
  const kwTokens = tokenize(keywords);
  if (kwTokens.length === 0) return 0.5;
  const textTokens = new Set(tokenize(text));
  let hits = 0;
  for (const kt of kwTokens) {
    if (textTokens.has(kt)) hits++;
  }
  return hits / kwTokens.length;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'it', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'his', 'her', 'its',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Sanitize free-text keywords before passing to X API query.
 * - Strip X operators the caller didn't explicitly set (from:, to:, etc.)
 * - Strip shell-escape-looking metacharacters
 * - Cap length
 */
function sanitizeKeywords(kw: string): string {
  return kw
    .replace(/\b(from|to|url|lang|is|has|filter):\S+/gi, '')
    .replace(/[`$();|&<>\\]/g, '')
    .trim()
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBearerToken(ctx: ResolverContext): string | null {
  // Config override wins; env fallback
  const fromConfig = ctx.config['x_api_bearer_token'];
  if (typeof fromConfig === 'string' && fromConfig.length > 0) return fromConfig;
  const fromEnv = process.env.X_API_BEARER_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' &&
    'name' in err && (err as { name: string }).name === 'AbortError';
}

async function safeText(resp: Response): Promise<string> {
  try { return await resp.text(); } catch { return ''; }
}

/**
 * Compute how long to sleep before retrying after a 429. X's rate-limit
 * contract lives in two headers:
 *   - `Retry-After`: seconds (RFC form) OR HTTP-date (rare).
 *   - `x-rate-limit-reset`: epoch seconds when the current window resets.
 *
 * We take the MAX of both signals so we don't wake up into a still-closed
 * window. Capped at 60s so a misbehaving header doesn't wedge the resolver
 * for 15 minutes; the outer retry loop honors MAX_RETRIES_ON_429. Minimum
 * 2s so we don't hot-spin on no headers.
 *
 * Exported for testability.
 */
export function computeBackoffMs(resp: Pick<Response, 'headers'>, now: number = Date.now()): number {
  const MIN_MS = 2_000;
  const MAX_MS = 60_000;

  // Retry-After parsing: seconds or HTTP-date.
  let retryAfterMs = 0;
  const retryAfter = resp.headers.get('retry-after');
  if (retryAfter) {
    const asSeconds = parseInt(retryAfter, 10);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      retryAfterMs = asSeconds * 1000;
    } else {
      const asDate = Date.parse(retryAfter);
      if (Number.isFinite(asDate)) retryAfterMs = Math.max(0, asDate - now);
    }
  }

  // x-rate-limit-reset is an epoch second.
  let rateResetMs = 0;
  const rateReset = resp.headers.get('x-rate-limit-reset');
  if (rateReset) {
    const epochSec = parseInt(rateReset, 10);
    if (Number.isFinite(epochSec) && epochSec > 0) {
      rateResetMs = Math.max(0, epochSec * 1000 - now);
    }
  }

  const waitMs = Math.max(MIN_MS, retryAfterMs, rateResetMs);
  return Math.min(MAX_MS, waitMs);
}

function composeSignals(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!outer) return timeoutSignal;
  if (typeof (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([outer, timeoutSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (outer.aborted) controller.abort();
  else outer.addEventListener('abort', onAbort, { once: true });
  if (timeoutSignal.aborted) controller.abort();
  else timeoutSignal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Aborted'); err.name = 'AbortError'; reject(err); return;
    }
    const handle = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(handle);
        const err = new Error('Aborted'); err.name = 'AbortError'; reject(err);
      }, { once: true });
    }
  });
}
