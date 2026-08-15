/**
 * Base-URL fault classifier for openai-compatible proxies, used by
 * `gbrain models doctor` when a chat/embed/rerank probe fails with an `auth`
 * (401/403) or `model_not_found` (404) error. It probes the shared `/models`
 * endpoint at the configured base URL and each canonical version off its root,
 * then classifies the status codes into one targeted verdict, so the doctor
 * points at the real fault (missing or wrong version prefix, wrong endpoint, or
 * a plain credential / model-name problem) instead of a bare error.
 *
 * PROVIDER-AGNOSTIC BY DESIGN. The classifier never hardcodes which providers
 * serve a `/models` list; it reads the actual status and reasons from that.
 * This is deliberate, because openai-compatible endpoints fall into classes that
 * behave differently and the set churns:
 *
 *   - AUTHENTICATED `/models` (litellm, ollama, llama-server, most hosted
 *     OpenAI-shaped APIs). The canonical missing-`/v1` case lives here: bare
 *     `/models` 404s or 401s while `/v1/models` 200s, so append/switch. On an
 *     auth failure the control-probe (an unauthenticated GET on the winning
 *     path) confirms the key when `/models` requires auth, upgrading the hint to
 *     a definite "the key authenticates at /v1".
 *   - PUBLIC `/models` (OpenRouter serves `https://openrouter.ai/api/v1/models`
 *     with no key). A bad key still 200s the configured `/models`, yielding
 *     `key-or-model` ("URL works, check the key"); and the control-probe returns
 *     200 unauthenticated, so we fall to the honest `switch-or-key` rather than
 *     a false "the key authenticates". Correct with no special-casing, because
 *     we read the observed statuses.
 *   - NO `/models` LIST (Voyage serves only `/v1/embeddings`; zeroentropyai, the
 *     default reranker, only `/v1/models/rerank`). Every probed `/models` 404s.
 *     On an auth failure that is `wrong-endpoint`, whose wording leads with the
 *     key (the base URL is demonstrably reachable, since the real call already
 *     401'd); on a `model_not_found` failure the classifier stays SILENT, so a
 *     Voyage model-name typo never gets a misleading "fix your base URL".
 *
 * Because every verdict comes from observed `/models` status, adding or changing
 * a provider needs no change here. `probeOpenAICompat` in `./probes.ts` is a
 * separate concern (the providers wizard's unauthenticated, JSON-shape-
 * validating, fixed `/v1/models`, boolean-verdict local detector).
 */

import { resolveRecipe } from './model-resolver.ts';
import type { AIGatewayConfig } from './types.ts';

/** Which doctor failure triggered the sweep. Shapes wording and control-probe use. */
type Trigger = 'auth' | 'model_not_found';

/**
 * Canonical version prefixes probed against an openai-compatible proxy's
 * `/models` endpoint. `/v1` is the OpenAI default; `/v1beta` covers Gemini-shaped
 * routes. Each is tried off the base URL's version-root, so they serve both the
 * "append to a bare base" and "switch a wrong version" cases. Extend here, not at
 * a call site.
 */
const V1_SUFFIX_CANDIDATES = ['/v1', '/v1beta'] as const;

/**
 * The base URL with a trailing `/vN` version segment (optional channel suffix
 * like `/v1beta`, optional trailing slash) removed: `http://h/v4` -> `http://h`;
 * a bare `http://h` is returned unchanged. Canonical candidates are probed off
 * this root so a wrong configured version becomes a swap, not an append.
 */
export function versionRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v\d+[a-z]*$/i, '');
}

/**
 * GET `url` with the given headers; return the HTTP status, or `null` on any
 * transport error (DNS, connection refused, timeout). Never throws. Uses
 * `AbortSignal.timeout` to match the gateway's fetch-timeout idiom, and
 * `redirect: 'manual'` so a 3xx is never followed: the classifier only reads
 * {200,401,403,404}, so following a redirect buys nothing and could forward the
 * bearer to another origin.
 */
async function fetchProbeStatus(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch {
    return null;
  }
}

/**
 * The diagnosis a `/models` probe sweep supports. Most kinds are auth-only;
 * `model-name` is model_not_found-only; `use-verified` carries its trigger
 * because its wording differs. `undefined` (returned separately) means the
 * statuses were inconclusive.
 */
type BaseUrlVerdict =
  | { kind: 'use-verified'; recommend: string; trigger: Trigger } // an alternate's /models 200s: the route is there
  | { kind: 'switch-or-key'; recommend: string }                 // auth: configured unauthorized + alt 200 that is public/unconfirmed
  | { kind: 'use-and-key'; recommend: string; status: number }   // auth: configured 404, alt 401/403: wrong version AND creds rejected
  | { kind: 'key-or-model' }                                     // auth: configured 200: URL reaches a working endpoint
  | { kind: 'key-only'; status: number }                         // auth: configured 401/403, no other version serves /models
  | { kind: 'wrong-endpoint' }                                   // auth: no /models at the configured path or any probed version
  | { kind: 'model-name' };                                      // model_not_found: configured 200: URL correct, the model id is wrong

/**
 * Probe `/models` at the configured base URL AND each canonical version off its
 * root, with the SAME bearer, in parallel, and classify what the status codes
 * prove. A `200` means that path serves a models list for the request we sent;
 * a `404` means the path is absent; a `401`/`403` means the path exists but
 * rejected the credentials. Other statuses (5xx, 429) and transport errors
 * prove nothing.
 *
 * The `trigger` splits behavior: on `auth` the full verdict set runs (including
 * a control-probe that confirms the key when an alternate authenticates); on
 * `model_not_found` only a real 200 speaks (append/switch, or "URL correct,
 * check the model name"), because the key is not in question and a redirect to
 * a check-the-key message would misdirect.
 */
async function classifyBaseUrlProbe(
  baseURL: string,
  headers: Record<string, string>,
  candidates: readonly string[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
  trigger: Trigger,
): Promise<BaseUrlVerdict | undefined> {
  const base = baseURL.replace(/\/+$/, '');
  const root = versionRoot(base);

  // Probe set: the configured URL as-is, plus each canonical version off the
  // root. Dedup so an already-`/v1` base does not probe `/v1` twice.
  const targets: Array<{ suffix: string; configured: boolean }> = [];
  const seen = new Set<string>();
  const add = (suffix: string, configured: boolean) => {
    const url = `${root}${suffix}/models`;
    if (!seen.has(url)) {
      seen.add(url);
      targets.push({ suffix, configured });
    }
  };
  add(base.slice(root.length), true); // configured: '' when bare, else '/vX'
  for (const cand of candidates) add(cand, false);

  const statuses = await Promise.all(
    targets.map(t => fetchProbeStatus(`${root}${t.suffix}/models`, headers, fetchImpl, timeoutMs)),
  );
  const items = targets.map((t, i) => ({ ...t, status: statuses[i] }));
  const authReject = (s: number | null) => s === 401 || s === 403;
  const configured = items.find(t => t.configured)!;
  const alternates = items.filter(t => !t.configured);
  const working = alternates.find(t => t.status === 200);

  // model_not_found: the key is not in question, so speak only on positive URL
  // evidence (a real 200) and stay silent on everything else.
  if (trigger === 'model_not_found') {
    if (configured.status === 200) return { kind: 'model-name' };
    if (working) return { kind: 'use-verified', recommend: working.suffix, trigger };
    return undefined;
  }

  // auth trigger.
  // Configured /models serves a list: the base URL reaches a working route, so
  // the failure is credentials or model access, not the URL shape.
  if (configured.status === 200) return { kind: 'key-or-model' };

  if (working) {
    // A version answers 200 with the key. Disambiguate "the key is valid there"
    // (confident switch) from "that /models is public, key unproven" (both
    // signals) with one unauthenticated control-probe.
    const { Authorization: _drop, ...noAuthHeaders } = headers;
    const noAuth = await fetchProbeStatus(`${root}${working.suffix}/models`, noAuthHeaders, fetchImpl, timeoutMs);
    if (authReject(noAuth)) {
      // /models requires auth AND accepted the key -> the key is valid there.
      return { kind: 'use-verified', recommend: working.suffix, trigger };
    }
    // public or unconfirmed -> name both signals.
    return { kind: 'switch-or-key', recommend: working.suffix };
  }

  // Configured path is absent (404).
  if (configured.status === 404) {
    const rejected = alternates.find(t => authReject(t.status));
    if (rejected) return { kind: 'use-and-key', recommend: rejected.suffix, status: rejected.status! };
    if (alternates.every(t => t.status === 404)) return { kind: 'wrong-endpoint' };
  }

  // Configured path exists and rejects the credentials, and no other version
  // serves /models: the URL shape is fine, the problem is the key/permissions.
  if (authReject(configured.status) && alternates.every(t => t.status === 404 || t.status === null)) {
    return { kind: 'key-only', status: configured.status! };
  }

  return undefined; // inconclusive: 401-everywhere, 5xx/429, or transport errors
}

/** Render a verdict into the operator-facing `fix:` line. */
function verdictHint(verdict: BaseUrlVerdict, baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '');
  const root = versionRoot(base);
  const from = base.slice(root.length); // '' when the base is bare, else '/vX'
  const move = (recommend: string) =>
    from ? `switch ${from} to ${recommend} (base URL ${root}${recommend})` : `append ${recommend} (base URL ${root}${recommend})`;
  switch (verdict.kind) {
    case 'use-verified': {
      const target = `${root}${verdict.recommend}`;
      if (verdict.trigger === 'model_not_found') {
        return `${target}/models responds 200 while ${base}/models does not, so the openai-compatible route is at ` +
          `${verdict.recommend} — ${move(verdict.recommend)}. That explains the model-not-found (the request reached the wrong path).`;
      }
      return `The API key authenticates at ${target} (its /models requires auth and accepted the key), but the ` +
        `configured ${base} does not serve that route, so the base URL ${from ? 'has the wrong' : 'is missing its'} ` +
        `version prefix — ${move(verdict.recommend)}.`;
    }
    case 'switch-or-key':
      return `The request was unauthorized, so check the API key first. Separately, ${root}${verdict.recommend}/models ` +
        `responds 200 (possibly an unauthenticated route), so if the key is correct the base URL should carry ` +
        `${verdict.recommend} — ${move(verdict.recommend)}.`;
    case 'use-and-key':
      return `The openai-compatible route appears to be at ${root}${verdict.recommend} (its /models responds ` +
        `${verdict.status} while the configured ${base}/models returns 404), so ${move(verdict.recommend)}. That route ` +
        `also rejects the current credentials (${verdict.status}), so verify the API key or permissions too.`;
    case 'key-or-model':
      return `${base}/models responds 200 with the configured credentials, so the base URL reaches a working ` +
        `openai-compatible endpoint. The failure is the API key or the model's access, not the URL shape.`;
    case 'key-only':
      return `${base}/models responds ${verdict.status} (the endpoint exists and rejected the credentials) and no ` +
        `other common version prefix serves /models, so the base URL shape is not the problem. Check the API key or permissions.`;
    case 'wrong-endpoint':
      return `The request was unauthorized and no /models list answered at ${base} or the common version prefixes ` +
        `(all 404), so this is most likely a key or permissions problem — check the API key. Some providers do not serve ` +
        `a /models list; if you expected one, verify the base URL host and path.`;
    case 'model-name':
      return `${base}/models responds 200, so the base URL is correct. The model-not-found is most likely a wrong or ` +
        `unavailable model name — check the model id (and that your key or plan can access it).`;
  }
}

/**
 * The mutable probe result `maybeAttachVersionSuffixHint` reads and annotates.
 * The doctor's `ProbeResult` is structurally compatible; kept minimal here so
 * this module does not depend on the command layer.
 */
export interface HintTarget {
  status: string;
  fix?: string;
}

/**
 * Injected config/transport for tests + a per-run memo cache. Real callers pass
 * the cache (created once per doctor run) so several probe sites sharing a base
 * URL do not each re-run the sweep.
 */
export interface HintDeps {
  cfg?: AIGatewayConfig;
  fetchImpl?: typeof fetch;
  cache?: Map<string, string | undefined>;
}

/**
 * On an `auth` (401/403) or `model_not_found` (404) probe failure against an
 * openai-compatible proxy, probe `/models` at the configured base URL and each
 * canonical version and attach a targeted `fix:` line.
 *
 * The base URL and bearer resolve through the same `applyOpenAICompatConfig` /
 * `applyResolveAuth` / `authToHeaders` seams the live gateway uses (read from
 * the live merged config via the gateway's own `requireConfig`, not a config-file
 * re-read, which would miss the DB-plane `base_urls` merge), so the probe hits
 * the exact path production does, on the same host the operator already trusts
 * with the key. Native providers and Azure-templated recipes (bespoke
 * `resolveOpenAICompatConfig`) are skipped. Fail-open: any resolution or
 * transport error yields no hint and never breaks the probe.
 *
 * @internal exported for tests.
 */
export async function maybeAttachVersionSuffixHint(
  target: HintTarget,
  modelStr: string,
  touchpoint: 'embedding' | 'expansion' | 'chat' | 'reranker',
  deps: HintDeps = {},
): Promise<void> {
  const trigger: Trigger | undefined =
    target.status === 'auth' ? 'auth' : target.status === 'model_not_found' ? 'model_not_found' : undefined;
  if (!trigger) return;
  try {
    const { requireConfig, applyOpenAICompatConfig, applyResolveAuth, authToHeaders } = await import('./gateway.ts');
    // Reuse the gateway's own live-config accessor (the DB + file + env merge),
    // not a file re-read. requireConfig throws if the gateway is unconfigured;
    // that path can't happen once doctor is probing models, and the fail-open
    // catch below absorbs it either way.
    const cfg = deps.cfg ?? requireConfig();
    const { recipe } = resolveRecipe(modelStr);
    if (recipe.tier !== 'openai-compat') return; // native provider — no base-URL trap
    if (recipe.resolveOpenAICompatConfig) return; // Azure-templated, non-/vN shape
    const { baseURL } = applyOpenAICompatConfig(recipe, cfg);
    if (!baseURL || !baseURL.trim()) return;

    // Per-run memo: verdicts depend only on (trigger, base URL, recipe), so
    // several probe sites sharing a proxy reuse one sweep. Key is non-secret.
    const cacheKey = `${trigger}\n${baseURL}\n${recipe.id}`;
    if (deps.cache?.has(cacheKey)) {
      const cached = deps.cache.get(cacheKey);
      if (cached) target.fix = cached;
      return;
    }

    const headers = authToHeaders(applyResolveAuth(recipe, cfg, touchpoint));
    const verdict = await classifyBaseUrlProbe(
      baseURL,
      headers,
      V1_SUFFIX_CANDIDATES,
      deps.fetchImpl ?? globalThis.fetch,
      2000,
      trigger,
    );
    const fix = verdict ? verdictHint(verdict, baseURL) : undefined;
    deps.cache?.set(cacheKey, fix);
    if (fix) target.fix = fix;
  } catch {
    // fail open — no hint
  }
}
