/**
 * Search / eval / subagent / probe check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { loadConfig, type GBrainConfig } from '../../../core/config.ts';
// Leaf module (no flag surface of its own) — see that file for why this
// isn't imported from extract-conversation-facts.ts directly (#4135).
import { ALLOWED_TYPES } from '../../../core/facts/conversation-types.ts';

function hasNonEmptyChatFallbackChain(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
  }
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
    }
  } catch {
    // `config set` stores raw strings; any non-empty non-JSON value is set.
  }
  return true;
}

/**
 * `chat_fallback_chain` is accepted by config and reaches the gateway config,
 * but no production chat path consumes it. Keep the warning in doctor rather
 * than config loading so ordinary commands stay quiet. Returning null for an
 * empty value keeps clean doctor reports silent instead of adding an OK line.
 */
export async function checkChatFallbackChainInert(
  engine: BrainEngine,
  effectiveConfig: Pick<GBrainConfig, 'chat_fallback_chain'> | null = loadConfig(),
): Promise<Check | null> {
  const fileOrEnvSet = hasNonEmptyChatFallbackChain(effectiveConfig?.chat_fallback_chain);
  const dbValue = await engine.getConfig('chat_fallback_chain').catch(() => null);
  if (!fileOrEnvSet && !hasNonEmptyChatFallbackChain(dbValue)) return null;
  return {
    name: 'chat_fallback_chain_inert',
    status: 'warn',
    message:
      '`chat_fallback_chain` is set but currently has no effect: no production chat path consumes it. ' +
      'If you set it expecting fallback behavior, clear it from every plane that still holds a value: ' +
      'the DB (`gbrain config unset chat_fallback_chain`), `~/.gbrain/config.json`, and `GBRAIN_CHAT_FALLBACK_CHAIN`.',
  };
}

/**
 * v0.32.3 [CDX-20]: surface mode + per-key override drift.
 *
 * Original contract: status stays `ok` (never warns; never docks health
 * score); the hint lives in `message`, including a paste-ready
 * `gbrain search modes --reset` consolidation command whenever per-key
 * overrides exist.
 *
 * #3657/#4382 sunset amendment: the reset advice was a foot-gun on brains
 * whose overrides exist precisely to hold the reranker OFF the sunsetting
 * mode-bundle default — `--reset` clears `search.reranker.*` (they are in
 * SEARCH_MODE_CONFIG_KEYS) while preserving `search.mode`, silently
 * re-arming a provider gbrain itself knows is shutting down. So:
 *   - the ACTIVE resolved reranker (mode bundle + overrides, the same
 *     plane hybrid search reranks with) matching RERANKER_SUNSETS → WARN
 *     with the sunset date + the paste-ready replacement;
 *   - overrides present AND the PURE-BUNDLE resolution (what `--reset`
 *     restores) matching RERANKER_SUNSETS → keep `ok`, but WITHHOLD the
 *     reset recommendation and name the overrides load-bearing;
 *   - otherwise the original [CDX-20] behavior is unchanged.
 */

export async function checkSearchMode(engine: BrainEngine): Promise<Check> {
  try {
    const mode = await engine.getConfig('search.mode');
    const overrides = await engine.listConfigKeys('search.');
    // Exclude search.mode itself + the upgrade-notice state key from the
    // override roster — they aren't knobs.
    const overrideKeys = overrides.filter(k => k !== 'search.mode' && k !== 'search.mode_upgrade_notice_shown');

    // #3657/#4382: resolve the active reranker AND what a reset would arm.
    let activeSunset: import('../../../core/ai/defaults.ts').RerankerSunset | null = null;
    let resetSunset: import('../../../core/ai/defaults.ts').RerankerSunset | null = null;
    let activeReranker: string | undefined;
    let resetReranker: string | undefined;
    try {
      const { loadSearchModeConfig, resolveSearchMode } = await import('../../../core/search/mode.ts');
      const { rerankerSunset } = await import('../../../core/ai/defaults.ts');
      const loaded = await loadSearchModeConfig(engine);
      const active = resolveSearchMode(loaded);
      if (active.reranker_enabled) {
        activeReranker = active.reranker_model;
        activeSunset = rerankerSunset(active.reranker_model);
      }
      // Pure bundle for the same mode — `search modes --reset` clears the
      // per-key overrides but deliberately preserves search.mode.
      const bundle = resolveSearchMode({ mode: loaded.mode });
      if (bundle.reranker_enabled) {
        resetReranker = bundle.reranker_model;
        resetSunset = rerankerSunset(bundle.reranker_model);
      }
    } catch {
      // Mode resolution failed — make no sunset claim; legacy copy below.
    }

    const context = !mode
      ? 'search.mode is unset (using balanced fallback). Run `gbrain search modes` to see what is running and pick a mode explicitly.'
      : overrideKeys.length === 0
        ? `Mode: ${mode} (no per-key overrides — mode bundle is canonical).`
        : `Mode: ${mode} with ${overrideKeys.length} per-key override(s) (${overrideKeys.join(', ')}).`;

    if (activeSunset) {
      return {
        name: 'search_mode',
        status: 'warn',
        message:
          `${context} The active reranker (${activeReranker}) is on a provider with an announced ` +
          `shutdown: the hosted API dies on ${activeSunset.date}, after which rerank calls fail open ` +
          `to unreranked order. Fix: gbrain config set search.reranker.model ${activeSunset.replacement} ` +
          `(or disable: gbrain config set search.reranker.enabled false).`,
      };
    }

    if (!mode || overrideKeys.length === 0) {
      return { name: 'search_mode', status: 'ok', message: context };
    }

    if (resetSunset) {
      // Overrides are what keep this brain OFF the sunsetting bundle default
      // — recommending a reset here re-arms a dying provider (#4382).
      return {
        name: 'search_mode',
        status: 'ok',
        message:
          `${context} These override(s) are load-bearing: a mode-bundle reset would restore ` +
          `reranker_model=${resetReranker}, whose provider shuts down on ${resetSunset.date} — ` +
          `so no consolidation is recommended. To consolidate later, first re-set ` +
          `search.reranker.model to a live provider after resetting.`,
      };
    }

    return {
      name: 'search_mode',
      status: 'ok',
      message: `${context} To consolidate to the pure mode bundle: gbrain search modes --reset`,
    };
  } catch (e) {
    return {
      name: 'search_mode',
      status: 'ok',
      message: `Could not read search mode config (${(e as Error).message ?? 'unknown'}).`,
    };
  }
}

/**
 * v0.32.3 [CDX-6]: surface when retrieval-affecting files have changed
 * since the most recent published eval. Curated watch-list in
 * src/core/eval/drift-watch.ts; additions to that list require a
 * CHANGELOG line.
 *
 * Status stays `ok` — operator-facing reminder, not a hard gate.
 */
export async function checkEvalDrift(engine: BrainEngine): Promise<Check> {
  try {
    const { watchedFilesDrifted } = await import('../../../core/eval/drift-watch.ts');
    // Working tree vs HEAD (uncommitted retrieval changes). The fuller
    // version (vs the commit of the last published eval) is wired when
    // eval_results lands; today we just probe for uncommitted retrieval
    // changes so the operator sees them before re-running evals.
    const repoRoot = process.cwd();
    const drifted = watchedFilesDrifted(repoRoot);
    if (drifted.length === 0) {
      return {
        name: 'eval_drift',
        status: 'ok',
        message: 'No retrieval-affecting files changed in working tree.',
      };
    }
    const summary = drifted.slice(0, 3).join(', ') + (drifted.length > 3 ? ', …' : '');
    return {
      name: 'eval_drift',
      status: 'ok',
      message: `${drifted.length} retrieval-affecting file(s) changed since HEAD: ${summary}. Re-run \`gbrain eval run-all\` after committing these changes.`,
    };
  } catch (e) {
    return {
      name: 'eval_drift',
      status: 'ok',
      message: `Could not probe retrieval drift (${(e as Error).message ?? 'unknown'}).`,
    };
  }
}

/**
 * v0.31.12 — surface a warn when models.tier.subagent or models.default
 * resolves to a non-Anthropic provider. The subagent loop in
 * src/core/minions/handlers/subagent.ts uses Anthropic Messages API with
 * prompt caching on system + tools; non-Anthropic providers would break
 * the loop at runtime. This check makes the configuration drift visible
 * before a job is submitted.
 */

/**
 * v0.41.2.1 — embedding_env_override (D9 #9). Defense-in-depth for the
 * ze-switch env-override class (the 716K-chunk damage incident from
 * PR #1421's description).
 *
 * GBRAIN_EMBEDDING_MODEL / GBRAIN_EMBEDDING_DIMENSIONS win over DB+file
 * config in loadConfig(). When env disagrees with DB, the gateway embeds
 * with the env-selected model — even after ze-switch wrote a different
 * value to DB. This check surfaces that disagreement on every hourly
 * doctor run so users can spot the drift before the embed sweep corrupts
 * vectors at the wrong width.
 *
 * Uses Check.details (NOT Check.issues, which has a different schema)
 * so the structured `mismatches[]` payload is consumable by monitoring
 * pipelines without ad-hoc type widening.
 *
 * Cross-surface parity: wired into BOTH buildChecks() and
 * doctorReportRemote() — operators running thin-client doctor against
 * a remote brain see the server's env, which is the env that matters
 * for the embed pipeline running there.
 */
export async function checkEmbeddingEnvOverride(engine: BrainEngine): Promise<Check> {
  const envModel = process.env.GBRAIN_EMBEDDING_MODEL?.trim();
  const envDim = process.env.GBRAIN_EMBEDDING_DIMENSIONS?.trim();
  if (!envModel && !envDim) {
    return {
      name: 'embedding_env_override',
      status: 'ok',
      message: 'no embedding env overrides set',
    };
  }
  let dbModel: string | null = null;
  let dbDim: string | null = null;
  try {
    dbModel = await engine.getConfig('embedding_model');
    dbDim = await engine.getConfig('embedding_dimensions');
  } catch (err) {
    return {
      name: 'embedding_env_override',
      status: 'warn',
      message: `couldn't read DB config to compare env: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const mismatches: Array<{ key: string; env: string; db: string }> = [];
  if (envModel && dbModel && envModel !== dbModel) {
    mismatches.push({ key: 'GBRAIN_EMBEDDING_MODEL', env: envModel, db: dbModel });
  }
  if (envDim && dbDim && envDim !== dbDim) {
    mismatches.push({ key: 'GBRAIN_EMBEDDING_DIMENSIONS', env: envDim, db: dbDim });
  }
  if (mismatches.length === 0) {
    // Informational nuance (D10): agreeing env vars are still an override —
    // the file plane is the durable home; say so instead of a bare ok.
    const envSet = Boolean(envModel || envDim);
    return {
      name: 'embedding_env_override',
      status: 'ok',
      message: envSet
        ? 'env vars agree with DB config today — note they override the file plane at runtime; prefer the file plane (or keep env in sync everywhere gbrain runs)'
        : 'env vars agree with DB config',
    };
  }
  return {
    name: 'embedding_env_override',
    status: 'warn',
    message:
      `${mismatches.length} embedding env var(s) disagree with DB config (env wins at runtime). ` +
      `Fix: \`unset ${mismatches.map((m) => m.key).join(' ')}\` in your shell profile / .env, ` +
      `or update DB config to match.`,
    details: { mismatches },
  };
}

/**
 * Surface the (previously write-only) embedding-migration state marker: a
 * live marker means a migration is in flight or was interrupted — the brain
 * is mid-transition and retrieval may be degraded until it drains. Warn with
 * the exact resume + status commands.
 */
export async function checkEmbeddingMigrationState(engine: BrainEngine): Promise<Check> {
  try {
    const { readMigrationState, migrationSignature, renderResumeCommand } = await import('../../../core/embedding-migration.ts');
    const marker = await readMigrationState(engine);
    if (marker.corrupt) {
      return {
        name: 'embedding_migration_state',
        status: 'warn',
        message: 'embedding-migration state marker is corrupt. Inspect: gbrain migrate embeddings --status; re-running the migration rewrites it.',
      };
    }
    if (!marker.state) {
      return { name: 'embedding_migration_state', status: 'ok', message: 'no embedding migration in flight' };
    }
    const s = marker.state;
    let staleNote = '';
    try {
      const stale = await engine.countStaleChunks({
        signature: migrationSignature(s.to_model, s.to_dims),
        includeNullSignature: true,
      });
      staleNote = `; ${stale} chunk(s) not yet in the target space`;
    } catch { /* count is best-effort */ }
    return {
      name: 'embedding_migration_state',
      status: 'warn',
      message:
        `an embedding migration to ${s.to_model} (${s.to_dims}d) started ${s.started_at} is in flight or was interrupted${staleNote}. ` +
        `Resume: ${renderResumeCommand(s)}. ` +
        `Status: gbrain migrate embeddings --status`,
      details: { to_model: s.to_model, to_dims: s.to_dims, started_at: s.started_at },
    };
  } catch (err) {
    return {
      name: 'embedding_migration_state',
      status: 'warn',
      message: `could not read migration state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function checkSubagentCapability(engine: BrainEngine): Promise<Check> {
  try {
    const { classifyCapabilities } = await import('../../../core/ai/capabilities.ts');
    const modelsSubagent = await engine.getConfig('models.subagent');
    const tierSubagent = await engine.getConfig('models.tier.subagent');
    const modelsDefault = await engine.getConfig('models.default');

    // Helper: explain a verdict in user-facing terms.
    const explain = (resolved: string, source: string): Check | null => {
      const verdict = classifyCapabilities(resolved);
      if (verdict === 'unusable:no_tools') {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `${source} is "${resolved}" but that provider/model lacks native tool calling. ` +
            `The subagent loop cannot run on this model — runtime will fall back to claude-sonnet-4-6. ` +
            `Fix: \`gbrain config set ${source} <provider>:<model-with-tools>\` (e.g. anthropic:claude-sonnet-4-6 or openai:gpt-5.2).`,
        };
      }
      if (verdict === 'unknown') {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `${source} is "${resolved}" which references an unknown provider. ` +
            `Use a recipe-declared provider. ` +
            `Fix: \`gbrain config set ${source} anthropic:claude-sonnet-4-6\` or pick another known provider.`,
        };
      }
      if (verdict === 'unusable:no_subagent_loop') {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `${source} is "${resolved}" but that provider's recipe declares supports_subagent_loop: false — ` +
            `its tool calling is not stable enough across crashes/replays to drive the subagent loop. ` +
            `The subagent loop cannot run on this model — ` +
            (source === 'models.subagent'
              ? `jobs are refused at dispatch. `
              : `runtime will fall back to claude-sonnet-4-6. `) +
            `Fix: \`gbrain config set ${source} <provider>:<model>\` with a provider whose recipe declares ` +
            `supports_subagent_loop: true (e.g. anthropic:claude-sonnet-4-6).`,
        };
      }
      if (verdict === 'degraded:no_caching') {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `${source} is "${resolved}" — provider does not support prompt caching. ` +
            `The subagent loop runs hot (cost scales linearly with conversation length). ` +
            `For lower cost on long loops, use an Anthropic model: ` +
            `\`gbrain config set models.tier.subagent anthropic:claude-sonnet-4-6\`.`,
        };
      }
      return null;
    };

    let resolvedSource: string | null = null;
    let resolvedModel: string | null = null;
    if (modelsSubagent) {
      resolvedSource = 'models.subagent';
      resolvedModel = modelsSubagent;
      const issue = explain(modelsSubagent, resolvedSource);
      if (issue) return issue;
    } else if (modelsDefault) {
      resolvedSource = 'models.default';
      resolvedModel = modelsDefault;
      const issue = explain(modelsDefault, 'models.default');
      if (issue) return issue;
    } else if (tierSubagent) {
      resolvedSource = 'models.tier.subagent';
      resolvedModel = tierSubagent;
      const issue = explain(tierSubagent, resolvedSource);
      if (issue) return issue;
    }
    // v0.37 (T10 / D7) + v0.38 (D7 capability rename): warn when the configured
    // chat_model is non-Anthropic AND ANTHROPIC_API_KEY isn't set. With
    // agent.use_gateway_loop=false (the v0.38 default), subagent jobs still
    // require Anthropic at runtime; without the key, gbrain dream / gbrain
    // agent run / gbrain autopilot will all fail at job submission. Catches
    // the post-init drift case the init-time caveat would have shown if init
    // had been re-run.
    try {
      const { loadConfig } = await import('../../../core/config.ts');
      const cfg = loadConfig();
      const chatModel = cfg?.chat_model;
      const { isConfigTruthy } = await import('../../../core/config.ts');
      const gatewayLoopRaw = await engine.getConfig('agent.use_gateway_loop').catch(() => null);
      const gatewayLoopEnabled = isConfigTruthy(gatewayLoopRaw);
      const { isAnthropicProvider } = await import('../../../core/model-config.ts');
      if (chatModel && !isAnthropicProvider(chatModel) && !process.env.ANTHROPIC_API_KEY && !gatewayLoopEnabled) {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `chat_model is "${chatModel}" (non-Anthropic) and ANTHROPIC_API_KEY is not set. ` +
            `Subagent features (gbrain dream, gbrain agent run, gbrain autopilot) will fail at job submission ` +
            `unless agent.use_gateway_loop=true. Chat alone (gbrain think) still works. ` +
            `Either set ANTHROPIC_API_KEY or enable: \`gbrain config set agent.use_gateway_loop true\`.`,
        };
      }
    } catch { /* loadConfig may throw; fall through */ }

    return {
      name: 'subagent_capability',
      status: 'ok',
      message: resolvedModel && resolvedSource
        ? `Subagent model resolves via ${resolvedSource} to "${resolvedModel}" with full tool-loop capability`
        : `Subagent tier resolves to default (claude-sonnet-4-6) — full tool-loop capability`,
    };
  } catch (e) {
    return {
      name: 'subagent_capability',
      status: 'warn',
      message: `Could not check subagent capability: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// v0.38 — `checkSubagentProvider` was renamed to `checkSubagentCapability` (D7).
// Back-compat alias preserved for any external doctor extensions importing it.
const checkSubagentProvider = checkSubagentCapability;
void checkSubagentProvider;

/**
 * v0.40.1.0 Track D / T7 — pure function form of the nightly_quality_probe_health
 * check. Extracted from the inline runDoctor block so tests can drive every
 * branch (disabled / enabled-no-events / enabled-all-pass / enabled-with-failures)
 * without spinning up the audit JSONL or a real config file.
 */
/**
 * Pure function form of the conversation_parser_probe_health check.
 * Mirrors computeNightlyQualityProbeHealthCheck: skip-with-hint when the
 * probe is off and silent, surface the last 7 days of audit events when
 * it has run, WARN on any non-pass outcome.
 *
 * `effectiveEnabled` folds the D10 mode-gate in: explicitly enabled OR
 * search.mode=tokenmax (where the probe is default-on).
 */
export function computeConversationParserProbeHealthCheck(
  effectiveEnabled: boolean,
  events: ReadonlyArray<{ outcome: string; ts: string; reason?: string }>,
): Check {
  const name = 'conversation_parser_probe_health';
  if (!effectiveEnabled && events.length === 0) {
    return {
      name,
      status: 'ok',
      message:
        'disabled (opt-in; default-on only for search.mode=tokenmax). Enable with: ' +
        '`gbrain config set autopilot.conversation_parser_probe.enabled true`',
    };
  }
  if (events.length === 0) {
    return {
      name,
      status: 'ok',
      message: 'enabled but no probe events in the last 7 days (next run by autopilot; fixtures require a source-checkout install).',
    };
  }
  const bad = events.filter(e => e.outcome !== 'pass');
  const latest = events[events.length - 1]!;
  if (bad.length > 0) {
    return {
      name,
      status: 'warn',
      message:
        `${bad.length}/${events.length} probe run(s) in the last 7 days did not pass; ` +
        `latest: ${latest.outcome}${latest.reason ? ` (${latest.reason})` : ''}`,
    };
  }
  return {
    name,
    status: 'ok',
    message: `${events.length} probe run(s) in the last 7 days, all pass (latest ${latest.ts}).`,
  };
}

export function computeNightlyQualityProbeHealthCheck(
  probeEnabled: boolean,
  events: ReadonlyArray<{ outcome: string; ts: string; detail?: string }>,
): Check {
  const name = 'nightly_quality_probe_health';
  if (!probeEnabled && events.length === 0) {
    // Quiet skip — surface enable hint only when explicitly asked to.
    return {
      name,
      status: 'ok',
      message: `disabled (opt-in). Enable with: gbrain config set autopilot.nightly_quality_probe.enabled true`,
    };
  }
  if (events.length === 0) {
    return {
      name,
      status: 'ok',
      message: `enabled but no probe events in the last 7 days (next run by autopilot).`,
    };
  }
  // v0.40.1.0 Track D (codex CDX-5): any non-PASS outcome is bad signal.
  // Previously only fail / error / budget_exceeded triggered warn —
  // no_embedding_key / rate_limited / inconclusive were silently reported
  // as PASS, hiding real misconfigurations.
  const bad = events.filter(e => e.outcome !== 'pass');
  const latest = events[events.length - 1]!;
  if (bad.length > 0) {
    const counts =
      `pass=${events.filter(e => e.outcome === 'pass').length} ` +
      `fail=${events.filter(e => e.outcome === 'fail').length} ` +
      `error=${events.filter(e => e.outcome === 'error').length} ` +
      `inconclusive=${events.filter(e => e.outcome === 'inconclusive').length} ` +
      `budget=${events.filter(e => e.outcome === 'budget_exceeded').length} ` +
      `no_embed_key=${events.filter(e => e.outcome === 'no_embedding_key').length} ` +
      `rate_limited=${events.filter(e => e.outcome === 'rate_limited').length}`;
    return {
      name,
      status: 'warn',
      message: `${bad.length} non-PASS run${bad.length === 1 ? '' : 's'} in last 7d (${counts}). Latest: ${latest.outcome} at ${latest.ts}${latest.detail ? ` (${latest.detail})` : ''}.`,
    };
  }
  return {
    name,
    status: 'ok',
    message: `${events.length} PASS run${events.length === 1 ? '' : 's'} in last 7d. Latest: ${latest.ts}.`,
  };
}

/**
 * v0.41.11.0 — conversation_facts_backlog doctor check.
 *
 * 3-state status:
 *   - SKIPPED when cycle.conversation_facts_backfill.enabled=false
 *     (with paste-ready enable hint). No backlog enumeration; cheap probe.
 *     This is the Eng-v2 C9 "don't degrade health for opt-out users" gate.
 *   - OK when enabled=true AND backlog==0 OR no eligible pages exist.
 *   - WARN when enabled=true AND backlog>10.
 *
 * Backlog uses versioned, source-scoped outcomes. Regular pages bind the marker
 * to pages.updated_at; raw-transcript sidecars carry a SHA-256 snapshot token
 * and are revalidated by the extraction command before it skips model work.
 * Legacy/unversioned rows and partial extraction remain in backlog.
 */
export async function computeConversationFactsBacklogCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'conversation_facts_backlog';
  try {
    // Read the same config the cycle phase reads (Eng-v2 A2 single SoT).
    const enabledRaw = await engine.getConfig(
      'cycle.conversation_facts_backfill.enabled',
    );
    const enabled = enabledRaw != null &&
      !['false', '0', 'no', 'off', ''].includes(enabledRaw.trim().toLowerCase());

    if (!enabled) {
      return {
        name,
        status: 'ok',
        message:
          'disabled (opt-in). Enable with: gbrain config set cycle.conversation_facts_backfill.enabled true',
      };
    }

    // Resolve types from same key as cycle phase + CLI default.
    const typesRaw = await engine.getConfig(
      'cycle.conversation_facts_backfill.types',
    );
    // Default mirrors ALLOWED_TYPES — the single source of truth for the
    // conversation-facts type allowlist (#4135).
    let types: string[] = [...ALLOWED_TYPES];
    if (typesRaw) {
      try {
        const parsed = JSON.parse(typesRaw);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter(
            (t): t is string => typeof t === 'string',
          );
          if (filtered.length > 0) types = filtered;
        }
      } catch {
        // fall through to default
      }
    }

    const rows = await engine.executeRaw<{
      backlog: string | number;
      completed: string | number;
      non_extractable: string | number;
    }>(
      `WITH outcomes AS (
         SELECT
           p.source_id,
           p.slug,
           MAX(CASE WHEN f.source = 'cli:extract-conversation-facts:terminal:v2' THEN 1 ELSE 0 END) AS completed,
           MAX(CASE WHEN f.source = 'cli:extract-conversation-facts:non-extractable:v2' THEN 1 ELSE 0 END) AS non_extractable
         FROM pages p
         LEFT JOIN facts f
           ON f.source_id = p.source_id
          AND f.source_markdown_slug = p.slug
          AND f.source IN (
            'cli:extract-conversation-facts:terminal:v2',
            'cli:extract-conversation-facts:non-extractable:v2'
          )
          AND p.content_hash IS NOT NULL
          AND f.source_session = f.source || ':' || p.slug || ':page-' ||
            p.content_hash || '-' ||
            COALESCE(TO_CHAR(p.effective_date AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'none')
         WHERE p.type = ANY($1::text[])
           AND p.deleted_at IS NULL
           AND COALESCE(BTRIM(p.frontmatter->>'raw_transcript'), '') = ''
           AND p.content_hash IS NOT NULL
         GROUP BY p.source_id, p.slug
       )
       SELECT
         COALESCE(SUM(CASE WHEN completed = 0 AND non_extractable = 0 THEN 1 ELSE 0 END), 0) AS backlog,
         COALESCE(SUM(completed), 0) AS completed,
         COALESCE(SUM(CASE WHEN completed = 0 THEN non_extractable ELSE 0 END), 0) AS non_extractable
       FROM outcomes`,
      [types],
    );

    let backlog = Number(rows[0]?.backlog ?? 0);
    let completed = Number(rows[0]?.completed ?? 0);
    let nonExtractable = Number(rows[0]?.non_extractable ?? 0);

    // SQL cannot read raw_transcript files or reproduce the fallback hash for a
    // legacy NULL content_hash. Recompute those tokens through the command's
    // canonical verifier. Pagination keeps memory bounded.
    const { findFreshExtractionOutcomes } = await import(
      '../../extract-conversation-facts.ts'
    );
    const verifierSources = await engine.executeRaw<{ source_id: string }>(
      `SELECT DISTINCT source_id
         FROM pages
        WHERE type = ANY($1::text[])
          AND deleted_at IS NULL
          AND (
            COALESCE(BTRIM(frontmatter->>'raw_transcript'), '') <> ''
            OR content_hash IS NULL
          )
        ORDER BY source_id`,
      [types],
    );
    for (const { source_id: sourceId } of verifierSources) {
      for (const type of types) {
        let offset = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = await engine.listPages({
            type: type as NonNullable<Parameters<BrainEngine['listPages']>[0]>['type'],
            sourceId,
            limit: 10,
            offset,
          });
          if (batch.length === 0) break;
          const verifyInProcess = batch.filter((page) => {
            const raw = page.frontmatter?.raw_transcript;
            return (typeof raw === 'string' && raw.trim().length > 0) ||
              page.content_hash == null;
          });
          if (verifyInProcess.length > 0) {
            const outcomes = await findFreshExtractionOutcomes(
              engine,
              sourceId,
              verifyInProcess,
            );
            for (const page of verifyInProcess) {
              const outcome = outcomes.get(page.slug);
              if (outcome === 'complete') completed++;
              else if (outcome === 'non_extractable') nonExtractable++;
              else backlog++;
            }
          }
          offset += batch.length;
          if (batch.length < 10) break;
        }
      }
    }

    if (backlog === 0) {
      return {
        name,
        status: 'ok',
        message: 'all eligible pages have fresh durable extraction outcomes',
        details: {
          backlog,
          completed,
          scanned_not_extractable: nonExtractable,
          types,
          freshness_rule: 'v2 snapshot token (content hash + effective date or sidecar sha256)',
        },
      };
    }

    if (backlog > 10) {
      const fixHint =
        'gbrain extract-conversation-facts --background --max-cost-usd 5';
      return {
        name,
        status: 'warn',
        message: `${backlog} eligible pages without extraction. Fix: ${fixHint}`,
        details: {
          backlog,
          completed,
          scanned_not_extractable: nonExtractable,
          types,
          fix_hint: fixHint,
          freshness_rule: 'v2 snapshot token (content hash + effective date or sidecar sha256)',
        },
      };
    }

    return {
      name,
      status: 'ok',
      message: `${backlog} eligible page(s) below warn threshold (>10)`,
      details: {
        backlog,
        completed,
        scanned_not_extractable: nonExtractable,
        types,
        freshness_rule: 'v2 snapshot token (content hash + effective date or sidecar sha256)',
      },
    };
  } catch (err) {
    return {
      name,
      status: 'warn',
      message: `backlog query failed: ${(err as Error).message}`,
    };
  }
}
