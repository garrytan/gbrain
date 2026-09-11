/**
 * url_reachable — deterministic HEAD-check resolver.
 *
 * Input:  { url: string }
 * Output: { reachable: boolean, status?: number, finalUrl?: string }
 *
 * Used by `gbrain integrity` to detect dead-link citations on brain pages.
 * Always confidence=1.0 when the backend answers (status codes are ground
 * truth); confidence=0 only when the HTTP call itself fails (DNS, timeout)
 * and we genuinely don't know.
 *
 * Security:
 * - SSRF guard pins every validated DNS target and preserves its TLS identity.
 * - Redirect chain is followed manually (max 5 hops) with per-hop
 *   re-validation; matches the integrations.ts pattern so no new SSRF
 *   bypass surface.
 * - HEAD first, GET fallback when server rejects HEAD (405 / 501).
 *   Abort token threads through both.
 */

import { fetchWithSSRFGuard, HttpProxyError, SSRFError, validateAndResolveUrl } from '../../ssrf-validate.ts';
import type {
  Resolver,
  ResolverContext,
  ResolverRequest,
  ResolverResult,
} from '../interface.ts';
import { ResolverError } from '../interface.ts';

export interface UrlReachableInput {
  url: string;
}

export interface UrlReachableOutput {
  reachable: boolean;
  status?: number;
  /** URL after redirect chain. Only set if different from input.url. */
  finalUrl?: string;
  /** Set when reachable=false and we have a human-readable reason. */
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

export const urlReachableResolver: Resolver<UrlReachableInput, UrlReachableOutput> = {
  id: 'url_reachable',
  cost: 'free',
  backend: 'head-check',
  description: 'HEAD-check a URL, follow redirects, detect dead links. SSRF-protected.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', format: 'uri' } },
    required: ['url'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      reachable: { type: 'boolean' },
      status: { type: 'number' },
      finalUrl: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['reachable'],
  },

  async available(_ctx: ResolverContext): Promise<boolean> {
    // Nothing to check — fetch is globally available in Bun.
    return true;
  },

  async resolve(req: ResolverRequest<UrlReachableInput>): Promise<ResolverResult<UrlReachableOutput>> {
    const { url } = req.input;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = req.context.signal;

    if (typeof url !== 'string' || url.length === 0) {
      throw new ResolverError('schema', 'url_reachable: url must be a non-empty string', 'url_reachable');
    }

    try {
      const resp = await fetchWithSSRFGuard(url, {
        method: 'HEAD',
        headerOnly: true,
        headFallback: true,
        maxRedirects: MAX_REDIRECTS,
        timeoutMs,
        signal,
      });
      const missingLocation = resp.status >= 300 && resp.status < 400 && !resp.headers.get('location');
      const reachable = resp.status >= 200 && resp.status < 400 && !missingLocation;
      return {
        value: {
          reachable,
          status: resp.status,
          finalUrl: resp.url !== url ? resp.url : undefined,
          reason: missingLocation ? 'redirect without Location header' : reachable ? undefined : `HTTP ${resp.status}`,
        },
        confidence: 1,
        source: 'head-check',
        fetchedAt: new Date(),
      };
    } catch (err) {
      if (err instanceof SSRFError && ['REQUEST_ABORTED', 'REQUEST_TIMEOUT'].includes(err.code)) {
        throw new ResolverError('aborted', 'url_reachable aborted', 'url_reachable', err);
      }
      return {
        value: {
          reachable: false,
          reason: err instanceof SSRFError || err instanceof HttpProxyError
            ? `blocked: ${err.message}` : 'fetch error: request failed',
        },
        confidence: 1,
        source: 'head-check',
        fetchedAt: new Date(),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Compatibility helper; the shared validator is the only address policy. */
export async function checkDnsRebinding(urlStr: string): Promise<string | null> {
  try {
    await validateAndResolveUrl(urlStr);
    return null;
  } catch (err) {
    return errMessage(err);
  }
}
