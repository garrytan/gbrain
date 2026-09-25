/**
 * Graph / brainstorm / embedding-width check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import { loadConfigFileOnly } from '../../../core/config.ts';
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

export async function checkEmbeddingWidthConsistency(engine: BrainEngine): Promise<Check> {
  try {
    if (loadConfigFileOnly()?.embedding_disabled === true) {
      return { name: 'embedding_width_consistency', status: 'ok', message: 'Embeddings disabled — no active embedding width to reconcile.' };
    }
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
 * The shape this heuristic looks for — near-empty content, many inbound
 * edges — is also the intended shape of a deliberately thin index/hub page
 * (e.g. external tooling that creates a `topic/X` page via `capture`/
 * `put_page` specifically to aggregate mentions across many member pages).
 * Callers that mint such pages on purpose can opt them out with
 * `junk_hub_exempt: true` in frontmatter (optionally paired with a
 * `junk_hub_exempt_reason` string) — same "flag by default, let the owner
 * declare intent" idea as the `raw_trace_exempt` / `raw_trace_exempt_reason`
 * escape hatch `rawProvenanceCheck` (#1978) uses, though that one exempts on
 * key *presence* while this one requires the value `true` specifically.
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
         AND COALESCE(p.frontmatter ->> 'junk_hub_exempt', 'false') <> 'true'
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
        `buildGazetteer drops single-generic-token person titles. If a page is an intentional thin ` +
        `hub/index page, opt it out with junk_hub_exempt: true in frontmatter.`,
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
