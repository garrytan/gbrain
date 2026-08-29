/**
 * Graph / brainstorm / embedding-width check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

/**
 * v0.40.4 graph_signals_coverage doctor check.
 *
 * Surfaces whether the brain's link density is high enough for the
 * v0.40.4 graph-signals stage to meaningfully fire. Logic:
 *
 *   1. Resolve the active graph_signals setting (config override OR
 *      mode-bundle default). When OFF → silent ok (no metric noise on
 *      installs that don't use the feature).
 *
 *   2. When ON, compute the global density: % of pages with >=1
 *      inbound link. This is a STRUCTURAL lower bound — top-K
 *      subgraphs need at least some edges to fire any signal.
 *      Codex outside-voice #14 noted this is an imperfect proxy
 *      (T-todo-5 will replace it with actual fire-rate measurement
 *      from search-stats after 30 days of data).
 *
 *   3. >=30% → ok with the percentage.
 *      <10%  → warn (mismatch: signal enabled but link graph is too
 *              sparse to fire often; fix: `gbrain extract all` to
 *              populate the link graph from frontmatter + markdown).
 *      10-29% → ok with note (signal will fire occasionally).
 *
 * Errors during the SQL count → warn with the underlying message.
 * Best-effort: this check never breaks doctor.
 */
export async function checkGraphSignalsCoverage(engine: BrainEngine): Promise<Check> {
  try {
    // Resolve the active graph_signals setting. Read the config key
    // explicitly; when unset, fall through to the mode bundle default.
    const cfgVal = await engine.getConfig('search.graph_signals');
    let enabled: boolean;
    if (cfgVal !== null && cfgVal !== undefined) {
      // v0.40.4 codex F1 — case-insensitive + trim, parity with
      // loadOverridesFromConfig in src/core/search/mode.ts. Without
      // this, `gbrain config set search.graph_signals TRUE` enables
      // the feature in production but doctor reports "disabled".
      const v = cfgVal.trim().toLowerCase();
      enabled = v === 'true' || v === '1';
    } else {
      // Mode bundle default. Read search.mode (case-insensitive + trim
      // parity with isSearchMode + DEFAULT_SEARCH_MODE fallback).
      const modeRaw = await engine.getConfig('search.mode');
      const modeVal = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : '';
      const mode = modeVal === 'conservative' || modeVal === 'tokenmax' ? modeVal : 'balanced';
      // Hardcoded knowledge of the mode bundle defaults — keeps the
      // doctor check from pulling in the full search/mode.ts surface.
      enabled = mode !== 'conservative';
    }

    if (!enabled) {
      return {
        name: 'graph_signals_coverage',
        status: 'ok',
        message: 'graph_signals disabled — coverage not checked',
      };
    }

    // Compute global inbound-link density. Counts DISTINCT pages with
    // at least one inbound edge / total pages.
    const totalRows = await engine.executeRaw(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    const totalPages = Number((totalRows as any)[0]?.n ?? 0);

    if (totalPages === 0) {
      return {
        name: 'graph_signals_coverage',
        status: 'ok',
        message: 'Empty brain — no pages to compute coverage against',
      };
    }

    const linkedRows = await engine.executeRaw(
      `SELECT COUNT(DISTINCT l.to_page_id)::int AS n
       FROM links l
       JOIN pages p ON p.id = l.to_page_id
       WHERE p.deleted_at IS NULL`
    );
    const linkedPages = Number((linkedRows as any)[0]?.n ?? 0);
    const pct = (linkedPages / totalPages) * 100;
    const pctStr = pct.toFixed(1);

    if (pct < 10) {
      return {
        name: 'graph_signals_coverage',
        status: 'warn',
        message: `graph_signals enabled but only ${pctStr}% of pages have inbound links (<10%). Signal will rarely fire. Fix: \`gbrain extract all\` to populate the link graph from frontmatter + markdown.`,
      };
    }

    return {
      name: 'graph_signals_coverage',
      status: 'ok',
      message: pct >= 30
        ? `${pctStr}% of pages have inbound links (>=30% — graph signals fire on most queries)`
        : `${pctStr}% of pages have inbound links (10-29% — graph signals fire occasionally)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'graph_signals_coverage',
      status: 'warn',
      message: `Could not check graph_signals_coverage: ${msg}`,
    };
  }
}

/**
 * v0.37.0 brainstorm_health doctor check.
 *
 * Surfaces three readiness signals for `gbrain brainstorm` / `gbrain lsd`:
 *
 *   1. Migration v79 applied — the `pages.last_retrieved_at` column exists.
 *      If missing, LSD's stale-page signal degrades silently (corpus-sampling
 *      fallback only). Fix: `gbrain apply-migrations --yes`.
 *
 *   2. search.track_retrieval — when explicitly off, LSD never accumulates
 *      stale signal (every page stays at NULL last_retrieved_at). Default-on
 *      is fine; explicit-off is a warning so the user notices the setting.
 *      Fix: `gbrain config set search.track_retrieval true`.
 *
 *   3. Calibration cold-start — the latest calibration profile has empty
 *      `active_bias_tags`. brainstorm + LSD judge fall back to no-anti-bias
 *      mode with a stderr warning at run time; this surfaces it earlier.
 *      Fix: `gbrain calibration --regenerate` once enough takes are resolved.
 *
 * Returns the FIRST non-ok signal as the status — column-missing dominates,
 * then disabled-tracking, then cold-start. All three are non-blocking warnings;
 * brainstorm + LSD still work, just with degraded signal.
 */
export async function checkBrainstormHealth(engine: BrainEngine): Promise<Check> {
  // (1) Column probe — fast, single-query.
  try {
    const probeRows = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'pages' AND column_name = 'last_retrieved_at'
       ) AS exists`,
      []
    );
    const columnPresent = probeRows[0]?.exists === true;
    if (!columnPresent) {
      return {
        name: 'brainstorm_health',
        status: 'warn',
        message: `pages.last_retrieved_at column missing. LSD stale-bias degraded to corpus-sampling. Fix: \`gbrain apply-migrations --yes\``,
      };
    }
  } catch (e) {
    // Information schema may not be queryable on every engine variant.
    // Don't fail the doctor over this — degrade to skip.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'brainstorm_health',
      status: 'warn',
      message: `Could not probe pages.last_retrieved_at (${msg}); brainstorm/lsd may run with degraded signal.`,
    };
  }

  // (2) search.track_retrieval — explicit-off surfaces as a warning.
  try {
    const trackCfg = await engine.getConfig('search.track_retrieval');
    if (trackCfg === 'false' || trackCfg === '0' || trackCfg === 'off' || trackCfg === 'no') {
      return {
        name: 'brainstorm_health',
        status: 'warn',
        message: `search.track_retrieval is explicitly off — LSD's stale-page signal never accumulates. Fix: \`gbrain config set search.track_retrieval true\` (or accept and use brainstorm only).`,
      };
    }
  } catch {
    // Config read miss is benign; default-on applies.
  }

  // (3) Calibration cold-start — empty active_bias_tags.
  try {
    const calibRows = await engine.executeRaw<{ active_bias_tags: string[] | null }>(
      `SELECT active_bias_tags
         FROM calibration_profiles
         ORDER BY generated_at DESC
         LIMIT 1`,
      []
    );
    if (calibRows.length === 0) {
      return {
        name: 'brainstorm_health',
        status: 'ok',
        message: `Migration v79 applied; tracking enabled. Calibration profile not yet generated — brainstorm/lsd will run unbiased until enough takes are resolved.`,
      };
    }
    const tags = calibRows[0].active_bias_tags;
    if (!Array.isArray(tags) || tags.length === 0) {
      return {
        name: 'brainstorm_health',
        status: 'ok',
        message: `Migration v79 applied; tracking enabled. Calibration cold-start (no active_bias_tags) — judge runs unbiased. Fix when ready: \`gbrain calibration --regenerate\`.`,
      };
    }
    return {
      name: 'brainstorm_health',
      status: 'ok',
      message: `Migration v79 applied; tracking enabled; calibration profile with ${tags.length} bias tag(s) loaded.`,
    };
  } catch {
    // Pre-v0.36.1 brain (no calibration_profiles table). Brainstorm/lsd still
    // work without anti-bias context — orchestrator stderr-warns at run time.
    return {
      name: 'brainstorm_health',
      status: 'ok',
      message: `Migration v79 applied; tracking enabled. calibration_profiles table missing (pre-v0.36.1 brain) — judge runs unbiased.`,
    };
  }
}

/**
 * v0.36.0.0 (A5): ze_embedding_health doctor check.
 *
 * When the configured embedding_model starts with `zeroentropyai:`, verify
 * the API key is set. Doesn't make a network call by default — the existing
 * `gbrain models doctor` probe covers that, and we don't want every
 * `gbrain doctor` run to spend tokens. Surfaces a paste-ready fix when the
 * key is missing.
 */
export async function checkZeEmbeddingHealth(engine: BrainEngine): Promise<Check> {
  try {
    // v0.37 fix wave (Lane E.3 + CDX2-10): read from gateway, not DB.
    // The file plane is canonical post-v0.37; the DB config table is
    // schema-applied metadata. Reading DB here would skip the warning
    // when the user has a fresh install with no DB config row yet.
    const { getEmbeddingModel } = await import('../../../core/ai/gateway.ts');
    const { loadConfigFileOnly } = await import('../../../core/config.ts');
    let model = '';
    try { model = getEmbeddingModel(); } catch { /* gateway unconfigured */ }
    if (!model.startsWith('zeroentropyai:')) {
      return {
        name: 'ze_embedding_health',
        status: 'ok',
        message: `Configured embedding model "${model || 'default'}" is not ZeroEntropy — skip.`,
      };
    }
    const envKey = process.env.ZEROENTROPY_API_KEY;
    // File plane: zeroentropy_api_key on GBrainConfig (added by C.3).
    const fileKey = loadConfigFileOnly()?.zeroentropy_api_key;
    if (!envKey && !fileKey) {
      // Migration-first: when the provider has an announced shutdown, the fix
      // for a missing key is to migrate OFF, not to sign up. The key path
      // survives as the secondary note for someone who needs the remaining
      // hosted window. (Generic on recipe.sunset so the copy self-corrects if
      // the recipe ever changes; the whole check is deleted in v0.47.)
      const { getRecipe } = await import('../../../core/ai/recipes/index.ts');
      const sunset = getRecipe('zeroentropyai')?.sunset;
      if (sunset) {
        const { renderCanonicalMigrationCommands } = await import('../../../core/ai/defaults.ts');
        return {
          name: 'ze_embedding_health',
          status: 'warn',
          message:
            `embedding_model="${model}" but ZEROENTROPY_API_KEY is not set — and the ` +
            `hosted API shuts down on ${sunset.date}. Fix: migrate off it: ` +
            `${renderCanonicalMigrationCommands().recommendedDryRun}. If you need hosted ` +
            `ZeroEntropy for the remaining weeks, set the key via ` +
            `\`export ZEROENTROPY_API_KEY=...\` or "zeroentropy_api_key" in ` +
            `~/.gbrain/config.json (gbrain config set writes the DB plane, which the embed pipeline ignores).`,
        };
      }
      return {
        name: 'ze_embedding_health',
        status: 'warn',
        message:
          `embedding_model="${model}" but ZEROENTROPY_API_KEY is not set. ` +
          `Fix: \`export ZEROENTROPY_API_KEY=...\` or edit ~/.gbrain/config.json ` +
          `to add "zeroentropy_api_key": "...". (gbrain config set writes the DB plane, which the embed pipeline ignores.)`,
      };
    }
    return {
      name: 'ze_embedding_health',
      status: 'ok',
      message: `embedding_model="${model}" with key configured`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'ze_embedding_health',
      status: 'warn',
      message: `Could not check ZE embedding health: ${msg}`,
    };
  }
}

/**
 * provider_sunset doctor check (#3390 follow-up).
 *
 * Detects a brain whose EFFECTIVE embedding model (gateway-resolved, which is
 * how default-config brains land on the shipped default) is on a provider
 * with an announced hosted-API shutdown, and prints a paste-ready migration
 * command with the brain's ACTUAL `content_chunks.embedding` column width
 * filled in — not the config value, which can drift. Keeping the current
 * width avoids a needless dimension transition + index rebuild when the
 * target supports it.
 *
 * Unlike the one-shot upgrade banner (`ze_sunset_notice_shown`), this fires
 * on every `gbrain doctor` run until the brain is off the provider —
 * warn before the shutdown date; fail after it ONLY when the brain is
 * actually exposed (embedded vectors exist in the affected column, so
 * retrieval is genuinely down). A zero-vector brain whose config merely
 * RESOLVES to the dead default stays warn — otherwise every stock fresh
 * install (and every doctor-as-CI-gate) starts exiting 1 on the date with
 * no code change. Suppress entirely (accepted-risk installs) via
 * `gbrain config set doctor.suppress_provider_sunset true`.
 * No network call; one catalog query for the column width.
 *
 * `now` is injectable so tests can pin BOTH sides of the date without
 * waiting for the calendar (the date itself is a compile-time constant).
 */
export async function checkProviderSunset(engine: BrainEngine, now: number = Date.now()): Promise<Check> {
  const name = 'provider_sunset';
  try {
    const suppressed = await engine.getConfig('doctor.suppress_provider_sunset').catch(() => null);
    if (suppressed === 'true' || suppressed === '1') {
      return {
        name,
        status: 'ok',
        message: 'Check suppressed via doctor.suppress_provider_sunset (unset it to re-enable).',
      };
    }
    const { DEFAULT_EMBEDDING_MODEL, ZEROENTROPY_SUNSET_DATE, sunsetDateHasPassed } = await import('../../../core/ai/defaults.ts');
    // Effective model: gateway when configured (file/env plane, the runtime
    // truth); the shipped default otherwise — an unset-config brain resolves
    // to the default at runtime, so it is just as affected.
    let model = DEFAULT_EMBEDDING_MODEL;
    try {
      const { getEmbeddingModel } = await import('../../../core/ai/gateway.ts');
      model = getEmbeddingModel();
    } catch {
      // Gateway unconfigured — runtime resolves the shipped default.
    }
    // Effective reranker: resolve through the SAME plane search actually
    // reranks with — resolveSearchMode (mode bundle + search.reranker.*
    // config overrides; hybrid.ts passes `resolvedMode.reranker_model`).
    // The gateway plane is unset by default while balanced/tokenmax rerank
    // with the bundle's zeroentropyai model — reading the gateway here
    // would false-ok the exact brains this check exists to protect.
    let reranker: string | undefined;
    try {
      const { loadSearchModeConfig, resolveSearchMode } = await import('../../../core/search/mode.ts');
      const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
      if (knobs.reranker_enabled) reranker = knobs.reranker_model;
    } catch {
      // Mode resolution failed — make no reranker-exposure claim.
    }
    const onSunsetEmbedding = model.startsWith('zeroentropyai:');
    const onSunsetReranker = !!reranker?.startsWith('zeroentropyai:');
    // Custom embedding columns can route queries through a ZE-backed model
    // even when the primary embedding + reranker are clear — without this arm
    // the check reports ok while those columns die on the date.
    let zeColumns: string[] = [];
    try {
      const { detectZeCustomColumns } = await import('../../../core/ze-exposure.ts');
      zeColumns = (await detectZeCustomColumns(engine)).columns;
    } catch {
      // Probe failed — make no custom-column claim.
    }
    const onSunsetColumns = zeColumns.length > 0;
    if (!onSunsetEmbedding && !onSunsetReranker && !onSunsetColumns) {
      return {
        name,
        status: 'ok',
        message: `No configured provider has an announced shutdown (embedding: ${model}).`,
      };
    }
    // Shared date-itself-counts comparison with the gateway's rerank
    // short-circuit (defaults.ts:sunsetDateHasPassed) — the two cannot drift.
    const past = sunsetDateHasPassed(ZEROENTROPY_SUNSET_DATE, new Date(now));
    const parts: string[] = [];
    let hasVectors = false;
    if (onSunsetEmbedding) {
      let dims: number | null = null;
      try {
        const { readContentChunksEmbeddingDim } = await import('../../../core/embedding-dim-check.ts');
        dims = (await readContentChunksEmbeddingDim(engine)).dims;
      } catch {
        // Column probe failed (fresh/odd brain) — omit --dim from the hint.
      }
      try {
        const rows = await engine.executeRaw(
          `SELECT 1 AS one FROM content_chunks WHERE embedding IS NOT NULL LIMIT 1`,
        );
        hasVectors = rows.length > 0;
      } catch {
        // Probe failed (fresh/odd brain) — no exposure claim, warn-only.
      }
      parts.push(
        past
          ? hasVectors
            ? `embedding_model="${model}": the hosted API shut down on ${ZEROENTROPY_SUNSET_DATE} — semantic retrieval is offline (queries can no longer be embedded against your existing vectors).`
            : `embedding_model="${model}": the hosted API shut down on ${ZEROENTROPY_SUNSET_DATE}. No embedded vectors exist yet, so retrieval is not impacted — but embedding will fail until the config points elsewhere.`
          : `embedding_model="${model}": the hosted API shuts down on ${ZEROENTROPY_SUNSET_DATE}. On that date semantic retrieval stops entirely — existing vectors become unqueryable (query embedding uses the same endpoint), not just new content.`,
      );
      // v0.46.3: the paste-ready fix is TARGET-AWARE on dimensions via the
      // canonical renderer (defaults.ts) — Voyage's valid widths are
      // {256, 512, 1024, 2048}, so the recommended command always carries
      // --dim 1024; the keep-width OpenAI form renders only when valid there.
      const { renderCanonicalMigrationCommands } = await import('../../../core/ai/defaults.ts');
      const cmds = renderCanonicalMigrationCommands({ colDims: dims ?? null });
      parts.push(
        `Two fixes, either works: ` +
        `[1] self-host the same model — zembed-1 weights are Apache-2.0; keep the zeroentropyai:zembed-1 id and point provider_base_urls.zeroentropyai at a ZE-wire-compatible endpoint (NOT a generic OpenAI-compatible server — the id speaks ZE's /models/embed dialect). Keeps every existing vector, no re-embed (docs/guides/embedding-migration.md). ` +
        `[2] migrate (resumable; preview cost first): ${cmds.recommendedDryRun}` +
        (cmds.note ? ` ${cmds.note}` : '') +
        (cmds.openaiAlternative ? ` Keep-width alternative: ${cmds.openaiAlternative}.` : ''),
      );
    }
    if (onSunsetReranker) {
      parts.push(
        `The reranker (${reranker}) is on the same provider; after the shutdown search falls back to unreranked ordering. ` +
        `Fix: gbrain config set search.reranker.model voyage:rerank-2.5 (needs VOYAGE_API_KEY), or disable: gbrain config set search.reranker.enabled false.`,
      );
    }
    if (onSunsetColumns) {
      parts.push(
        `Custom embedding column(s) backed by the shutting-down provider: ${zeColumns.join(', ')}. ` +
        `No automated off-ramp exists for custom columns yet (migrate embeddings covers the primary column only) — ` +
        `re-declare them on a new provider and re-embed (skills/migrations/v0.46.3.0.md).`,
      );
    }
    if (onSunsetEmbedding || onSunsetReranker || onSunsetColumns) {
      parts.push('Accepted the risk? Silence this check: gbrain config set doctor.suppress_provider_sunset true');
    }
    // fail = retrieval is ACTUALLY down (past the date AND embedded vectors
    // exist on the dead provider). Reranker-only exposure stays warn — search
    // fails open to unreranked ordering (degraded, not down).
    const failNow = past && onSunsetEmbedding && hasVectors;
    return { name, status: failNow ? 'fail' : 'warn', message: parts.join(' ') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, status: 'warn', message: `Could not check provider sunset status: ${msg}` };
  }
}

/**
 * v0.36.0.0 (A5): embedding_width_consistency doctor check.
 *
 * Cross-checks that `config.embedding_dimensions` matches the actual
 * `vector(N)` width on `content_chunks.embedding`. Drift means a width
 * transition was interrupted mid-flight (schema changed but config write
 * crashed, or vice versa). Surfaces the engine-kind-branched recovery recipe
 * from embeddingMismatchMessage — NOT a ze-switch hint; that command is a
 * refusal shim now.
 */
export async function checkEmbeddingWidthConsistency(engine: BrainEngine): Promise<Check> {
  try {
    // v0.37 fix wave (Lane E.1 + CDX-8): read from gateway, not DB. The
    // file plane is canonical post-v0.37; the DB config table is
    // schema-applied metadata. Reading DB here silently skipped the
    // check on fresh installs whose DB config row hadn't been written
    // yet.
    const { getEmbeddingDimensions, getEmbeddingModel } = await import('../../../core/ai/gateway.ts');
    let configDim: number;
    let resolvedModel: string;
    try {
      configDim = getEmbeddingDimensions();
      resolvedModel = getEmbeddingModel();
    } catch {
      return {
        name: 'embedding_width_consistency',
        status: 'ok',
        message: 'gateway not configured — skipping width check.',
      };
    }
    if (!Number.isFinite(configDim) || configDim <= 0) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: `gateway returned non-positive embedding dimension "${configDim}".`,
      };
    }

    // Read the actual column width via the existing helper (shared with
    // init.ts and embed.ts dim-mismatch pre-flight). One source of truth.
    const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../../../core/embedding-dim-check.ts');
    const existing = await readContentChunksEmbeddingDim(engine);
    if (!existing.exists) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: 'content_chunks.embedding column not found. Fix: run `gbrain init --migrate-only` or check schema.',
      };
    }
    if (existing.dims === null) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: 'content_chunks.embedding is not a vector type. Schema may be corrupt.',
      };
    }
    if (existing.dims !== configDim) {
      // E.2: use the engine-kind-branched recipe instead of pointing at
      // the no-op `gbrain config set` path. The recipe is paste-ready
      // for the brain's actual engine.
      const databasePath = (engine as { _savedConfig?: { database_path?: string } })._savedConfig?.database_path;
      const recipe = embeddingMismatchMessage({
        currentDims: existing.dims,
        requestedDims: configDim,
        requestedModel: resolvedModel,
        source: 'doctor',
        engineKind: engine.kind,
        databasePath,
      });
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message:
          `Schema width mismatch: content_chunks.embedding is vector(${existing.dims}) but ` +
          `gateway resolved embedding_dimensions = ${configDim}.\n\n${recipe}`,
      };
    }
    return {
      name: 'embedding_width_consistency',
      status: 'ok',
      message: `Schema width (${existing.dims}d) matches gateway embedding_dimensions`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'embedding_width_consistency',
      status: 'warn',
      message: `Could not check embedding width: ${msg}`,
    };
  }
}

/**
 * v0.41.15.0 (T6, codex #19/#20) — facts.embedding column drift check.
 *
 * Parallel surface to `checkEmbeddingWidthConsistency` but for the
 * facts table. Migration v40 creates `facts.embedding` from
 * `config.embedding_dimensions` AT MIGRATION TIME — if the user later
 * swaps embedding providers (e.g. OpenAI 1536 → zembed-1 1280) without
 * re-running migrations, the column width drifts. The first insert
 * dies with the opaque pgvector "expected vector(N), got vector(M)"
 * error.
 *
 * Covers BOTH vector(N) AND halfvec(N) shapes (codex #19 — v40 falls
 * back to vector on pgvector < 0.7). Surfaces the paste-ready DROP
 * INDEX → ALTER USING → CREATE INDEX recipe from
 * `buildFactsAlterRecipe` instead of the unsafe REINDEX-only path
 * codex #18 caught in the original plan.
 */
export async function checkFactsEmbeddingWidthConsistency(engine: BrainEngine): Promise<Check> {
  // PGLite ships a single pgvector version; column + config wire
  // together at initSchema time. No possible drift.
  if (engine.kind !== 'postgres') {
    return {
      name: 'facts_embedding_width_consistency',
      status: 'ok',
      message: 'Skipped on PGLite (single bundled pgvector version).',
    };
  }

  try {
    const {
      readFactsEmbeddingDim,
      buildFactsAlterRecipe,
    } = await import('../../../core/embedding-dim-check.ts');

    const col = await readFactsEmbeddingDim(engine);
    if (!col.exists) {
      return {
        name: 'facts_embedding_width_consistency',
        status: 'ok',
        message: 'facts.embedding column not present (pre-v40 brain or migration pending).',
      };
    }
    if (col.dims === null || col.columnType === null) {
      return {
        name: 'facts_embedding_width_consistency',
        status: 'warn',
        message: 'facts.embedding column type is unrecognized (not vector or halfvec). Schema may be corrupt.',
      };
    }

    let configDim: number;
    let resolvedModel = 'unknown';
    try {
      const { getEmbeddingDimensions, getEmbeddingModel } = await import('../../../core/ai/gateway.ts');
      configDim = getEmbeddingDimensions();
      resolvedModel = getEmbeddingModel();
    } catch {
      return {
        name: 'facts_embedding_width_consistency',
        status: 'ok',
        message: 'gateway not configured — facts.embedding width check skipped.',
      };
    }
    if (!Number.isFinite(configDim) || configDim <= 0) {
      return {
        name: 'facts_embedding_width_consistency',
        status: 'warn',
        message: `gateway returned non-positive embedding dimension "${configDim}".`,
      };
    }

    if (col.dims === configDim) {
      return {
        name: 'facts_embedding_width_consistency',
        status: 'ok',
        message:
          `facts.embedding is ${col.columnType}(${col.dims}) — matches gateway embedding_dimensions ` +
          `(${resolvedModel}).`,
      };
    }

    // Drift detected. Surface the paste-ready ALTER recipe.
    const recipe = buildFactsAlterRecipe(col.dims, configDim, col.columnType);
    return {
      name: 'facts_embedding_width_consistency',
      status: 'warn',
      message:
        `facts.embedding is ${col.columnType}(${col.dims}) but gateway resolved ` +
        `embedding_dimensions = ${configDim} (${resolvedModel}). ` +
        `New fact inserts will fail with an opaque pgvector error.\n\n` +
        recipe,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'facts_embedding_width_consistency',
      status: 'warn',
      message: `Could not check facts.embedding width: ${msg}`,
    };
  }
}


// ---------------------------------------------------------------------------
// #4222 junk_entity_hubs — near-empty entity pages with huge edge counts
// ---------------------------------------------------------------------------

/**
 * Default thresholds for the junk-hub heuristic: a page with almost no
 * content of its own (<= JUNK_HUB_MAX_CHUNKS chunks) but a very large edge
 * count (> JUNK_HUB_EDGE_THRESHOLD links in either direction) is almost
 * always an extractor-minted generic-token entity ("Will", "Info") that the
 * by-mention auto-linker turned into a mega-hub. Exported so tests and
 * out-of-tree tooling reference the shipped numbers instead of copying them.
 */
export const JUNK_HUB_EDGE_THRESHOLD = 1000;
export const JUNK_HUB_MAX_CHUNKS = 2;

/**
 * #4222 junk_entity_hubs doctor check.
 *
 * Surfaces (warn + list — NEVER auto-delete) pages whose edge count dwarfs
 * their content: chunks <= maxChunks AND total edges (from + to) >
 * edgeThreshold. These poison graph signals and relational recall. The
 * mint gate (enrichEntity) and gazetteer drop (buildGazetteer) stop NEW
 * accretion; this check finds hubs that predate those gates so the owner
 * can review/merge/delete them deliberately.
 *
 * `opts` exists for tests (small corpora can't reach 1000 edges); the
 * production call site uses the exported defaults.
 */
export async function checkJunkEntityHubs(
  engine: BrainEngine,
  opts?: { edgeThreshold?: number; maxChunks?: number },
): Promise<Check> {
  const edgeThreshold = opts?.edgeThreshold ?? JUNK_HUB_EDGE_THRESHOLD;
  const maxChunks = opts?.maxChunks ?? JUNK_HUB_MAX_CHUNKS;
  try {
    const rows = await engine.executeRaw<{
      slug: string;
      source_id: string | null;
      edges: number;
      chunks: number;
    }>(
      `WITH edge_counts AS (
         SELECT page_id, COUNT(*)::int AS edges FROM (
           SELECT from_page_id AS page_id FROM links
           UNION ALL
           SELECT to_page_id AS page_id FROM links
         ) e
         GROUP BY page_id
         HAVING COUNT(*) > $1
       ),
       chunk_counts AS (
         SELECT page_id, COUNT(*)::int AS chunks
         FROM content_chunks
         GROUP BY page_id
       )
       SELECT p.slug, p.source_id, ec.edges, COALESCE(cc.chunks, 0)::int AS chunks
       FROM edge_counts ec
       JOIN pages p ON p.id = ec.page_id AND p.deleted_at IS NULL
       LEFT JOIN chunk_counts cc ON cc.page_id = ec.page_id
       WHERE COALESCE(cc.chunks, 0) <= $2
       ORDER BY ec.edges DESC
       LIMIT 20`,
      [edgeThreshold, maxChunks],
    );

    if (rows.length === 0) {
      return {
        name: 'junk_entity_hubs',
        status: 'ok',
        message: `No junk entity hubs (pages with <=${maxChunks} chunks and >${edgeThreshold} edges)`,
      };
    }

    const list = rows
      .map(r => `  ${r.slug}${(r.source_id ?? 'default') !== 'default' ? ` [${r.source_id}]` : ''} — ${r.edges} edges, ${r.chunks} chunk(s)`)
      .join('\n');
    return {
      name: 'junk_entity_hubs',
      status: 'warn',
      message:
        `${rows.length} near-empty page(s) with >${edgeThreshold} edges — likely generic-token entities ` +
        `("Will", "Info") minted by an extractor and inflated by mention auto-links:\n${list}\n` +
        `Review each page and merge/delete deliberately (nothing is auto-deleted). ` +
        `New accretion is already gated: enrichEntity refuses generic single-token mints and ` +
        `buildGazetteer drops single-generic-token person titles.`,
      details: {
        hubs: rows.map(r => ({
          slug: r.slug,
          source_id: r.source_id ?? 'default',
          edges: r.edges,
          chunks: r.chunks,
        })),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'junk_entity_hubs',
      status: 'warn',
      message: `Could not check for junk entity hubs: ${msg}`,
    };
  }
}
