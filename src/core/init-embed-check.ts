/**
 * Embedding-key validation at `gbrain init` (issue #1780 Gap 2).
 *
 * Before this, `gbrain init` persisted `--embedding-model` to config.json but
 * never checked the provider key was present/working. The failure surfaced only
 * at first sync (`embedBatch` throws, pages import but `embedded=0`), and
 * combined with Gap 1 the call graph silently never built.
 *
 * This runs two checks at init time, both non-fatal (loud warning, init still
 * exits 0 — `--no-embedding` is the deferred-setup escape hatch):
 *   1. `diagnoseEmbedding()` — config-only, zero-network. Catches a missing key
 *      for ANY provider.
 *   2. `liveTestEmbed()` — a best-effort 1-token embed (5s timeout) when a key
 *      IS present. Catches invalid/expired keys. Network/timeout/offline →
 *      warn only, never blocks.
 *
 * Both run against the EFFECTIVE gateway config — process.env overlaid with
 * file-plane keys (openai/anthropic/zeroentropy from config.json) and
 * `opts.apiKey`, plus provider base URLs — built via the same
 * `buildGatewayConfig` runtime uses. Without that, the config-only check would
 * false-warn on config.json-keyed users, and the live probe could hit the
 * wrong endpoint (custom OpenAI base URL, llama-server, etc.).
 *
 * Skips entirely on `--no-embedding`, `--skip-embed-check`, or
 * `GBRAIN_INIT_SKIP_EMBED_CHECK=1`. Warnings go to stderr; the caller folds the
 * returned `InitEmbedCheckResult` into init's `--json` envelope as
 * `embedding_check`.
 */

import type { GBrainConfig } from './config.ts';
import { loadConfigFileOnly } from './config.ts';
import { buildGatewayConfig } from './ai/build-gateway-config.ts';
import type { EmbeddingDiagnosis } from './ai/gateway.ts';

export interface InitEmbedCheckResult {
  /** config-level ok: provider key present + recipe valid. */
  ok: boolean;
  /** when the whole check was skipped, why. */
  skipped?: 'no_embedding' | 'flag' | 'env' | 'no_model';
  /** diagnosis reason when `ok === false`. */
  reason?: string;
  /** live test-embed result, undefined when not run. */
  live_ok?: boolean;
  /** live test-embed failure reason. */
  live_reason?: string;
}

export interface RunInitEmbedCheckOpts {
  resolvedModel?: string;
  resolvedDim?: number;
  expansionModel?: string;
  chatModel?: string;
  /** opts.apiKey from init (maps to openai_api_key). */
  apiKey?: string;
  noEmbedding?: boolean;
  /** --skip-embed-check flag. */
  skipFlag?: boolean;
  // ── test seams ──
  loadFileConfig?: () => GBrainConfig | null;
  /** default: console.error (stderr). */
  warn?: (msg: string) => void;
  /** skip the network probe (config-only); tests for the diagnose path. */
  skipLiveProbe?: boolean;
  liveTimeoutMs?: number;
}

/** Classify a live-probe error into a coarse, stable reason. */
function classifyLiveReason(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/timed out|timeout|abort/.test(msg)) return 'timeout';
  if (/auth|unauthor|401|403|api[_-]?key|credential/.test(msg)) return 'auth';
  if (/rate.?limit|429|too many/.test(msg)) return 'rate_limit';
  if (/network|econn|fetch failed|enotfound|dns/.test(msg)) return 'network';
  return 'unknown';
}

/**
 * Best-effort live test-embed against the currently-configured gateway.
 * 1 token, 5s timeout. Never throws — returns a tagged result.
 *
 * (Purpose-built rather than reusing `models.ts:probeEmbeddingReachability`,
 * which is private and returns the doctor-shaped `ProbeResult`. v0.42+ TODO:
 * unify the two onto one shared embed-probe core.)
 */
export async function liveTestEmbed(
  opts?: { timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const { embed } = await import('./ai/gateway.ts');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('embed probe timed out')), opts?.timeoutMs ?? 5000);
  try {
    await embed(['probe'], { inputType: 'query', abortSignal: controller.signal });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: classifyLiveReason(err), message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Init-specific warning for a non-ok diagnosis. Names `--no-embedding` +
 *  `--skip-embed-check` (NOT `--no-embed`, which is the sync/embed flag). */
function formatInitEmbedWarning(d: Exclude<EmbeddingDiagnosis, { ok: true }>): string {
  const lines: string[] = ['', '  Heads up: embedding is configured but not ready.'];
  switch (d.reason) {
    case 'missing_env':
      lines.push(`  Model "${d.model}" needs ${d.missingEnvVars.join(', ')} — not set in your shell or ~/.gbrain/config.json.`);
      lines.push('  Set it before first sync:');
      lines.push(`    export ${d.missingEnvVars[0]}=...`);
      break;
    case 'unknown_provider':
      lines.push(`  Model "${d.model}" uses unknown provider "${d.provider}".`);
      lines.push(`  ${d.message}`);
      break;
    case 'no_touchpoint':
      lines.push(`  Provider "${d.provider}" has no embedding touchpoint.`);
      break;
    case 'user_provided_model_unset':
      lines.push(`  Provider "${d.provider}" needs an explicit model id (provider:model).`);
      break;
    case 'no_model_configured':
      lines.push('  No embedding model is configured.');
      break;
    case 'no_gateway_config':
      lines.push('  Embedding gateway is not configured (startup-order bug — please file an issue).');
      break;
  }
  lines.push('  Without it, `gbrain sync` imports pages but embeds 0 (search + code graph stay empty).');
  lines.push('  Fixes:');
  lines.push('    • Set the key above, then run `gbrain sync`.');
  lines.push('    • Or defer embedding entirely: re-run init with --no-embedding.');
  lines.push('    • Or skip this check: --skip-embed-check (or GBRAIN_INIT_SKIP_EMBED_CHECK=1).');
  return lines.join('\n');
}

function formatLiveProbeWarning(p: { reason: string; message: string }, model: string): string {
  return [
    '',
    `  Heads up: an embedding key is set but a test embed failed (${p.reason}).`,
    `  Model: ${model}`,
    `  Error: ${p.message}`,
    '  `gbrain sync` may fail to embed. Verify the key/endpoint, or re-run init',
    '  with --skip-embed-check to bypass this probe.',
  ].join('\n');
}

/**
 * Run the init-time embedding validation. Configures the gateway with the
 * effective env, diagnoses config, then (if config ok and a key is present)
 * runs a best-effort live probe. Warns to stderr; never throws; init proceeds
 * regardless. Returns the result for the `--json` envelope.
 */
export async function runInitEmbedCheck(opts: RunInitEmbedCheckOpts): Promise<InitEmbedCheckResult> {
  const warn = opts.warn ?? ((m: string) => console.error(m));

  if (opts.noEmbedding) return { ok: true, skipped: 'no_embedding' };
  if (opts.skipFlag) return { ok: true, skipped: 'flag' };
  if (process.env.GBRAIN_INIT_SKIP_EMBED_CHECK === '1') return { ok: true, skipped: 'env' };
  // No model resolved means resolveAIOptions already fail-loud'd (or deferred);
  // nothing to validate here.
  if (!opts.resolvedModel) return { ok: true, skipped: 'no_model' };

  // Build the effective gateway config the SAME way runtime does so the check
  // sees the same keys AND provider base URLs (D1A + D7A).
  const loadFile = opts.loadFileConfig ?? loadConfigFileOnly;
  const fileCfg = loadFile() ?? ({} as GBrainConfig);
  const effective: GBrainConfig = {
    ...fileCfg,
    embedding_model: opts.resolvedModel,
    embedding_dimensions: opts.resolvedDim,
    expansion_model: opts.expansionModel ?? fileCfg.expansion_model,
    chat_model: opts.chatModel ?? fileCfg.chat_model,
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
  };

  const { configureGateway, diagnoseEmbedding } = await import('./ai/gateway.ts');
  configureGateway(buildGatewayConfig(effective));

  const diag = diagnoseEmbedding();
  if (!diag.ok) {
    warn(formatInitEmbedWarning(diag));
    return { ok: false, reason: diag.reason };
  }

  if (opts.skipLiveProbe) return { ok: true };

  const probe = await liveTestEmbed({ timeoutMs: opts.liveTimeoutMs });
  if (!probe.ok) {
    warn(formatLiveProbeWarning(probe, opts.resolvedModel));
    return { ok: true, live_ok: false, live_reason: probe.reason };
  }
  return { ok: true, live_ok: true };
}
