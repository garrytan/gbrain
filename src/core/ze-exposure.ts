/**
 * ZeroEntropy sunset exposure detection (v0.46.3).
 *
 * One shared answer to "is this brain still depending on ZeroEntropy?" —
 * consumed by the v0.46.3 version migration (detect-and-notify) and the
 * stage-2 upgrade banner. Standalone module by design: the ze-switch /
 * retrieval-upgrade subsystem is deleted in the September removal release and
 * this file must survive it.
 *
 * SCOPE: the brain the given engine is connected to + the HOST file plane
 * (~/.gbrain/config.json). apply-migrations is host-scoped (one global
 * completed.jsonl, no --brain flag), so the version migration covers the HOST
 * brain only; mounted/team brains are covered by the per-brain stage-2 banner
 * + doctor gates (their `ze_sunset_notice_v2_shown` lives in each brain's own
 * DB config).
 *
 * EXPOSURE = EFFECTIVE-MODEL RESOLUTION, NOT VECTOR EVIDENCE. Precedence:
 * env (GBRAIN_EMBEDDING_MODEL) → file `embedding_model` → the legacy
 * configless runtime fallback (DEFAULT_EMBEDDING_MODEL, still ZE until the
 * September cutover). A configless brain resolves to the ZE fallback
 * DETERMINISTICALLY — it is exposed even with zero vectors. Signatures and
 * column width feed only the blast radius: 1280d is NOT ZE-proof (OpenAI
 * text-3 supports arbitrary Matryoshka widths including 1280).
 *
 * TRI-STATE: a failed DB probe downgrades `status` to 'unknown', never to
 * 'clear'. Callers must nag on 'unknown' (fail-safe), and the migration
 * returns `complete` with an `exposure_unknown` detail rather than `partial`
 * — three consecutive partials would wedge the whole migration chain behind
 * `--force-retry` (apply-migrations.ts).
 */

import type { BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import { loadConfigFileOnly } from './config.ts';
import { DEFAULT_EMBEDDING_MODEL, ZEROENTROPY_SUNSET_DATE } from './ai/defaults.ts';
import {
  NEW_INSTALL_DEFAULT_EMBEDDING_MODEL,
  NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
  renderCanonicalMigrationCommands,
} from './ai/defaults.ts';
import { lookupEmbeddingPrice } from './embedding-pricing.ts';

const ZE_PREFIX = 'zeroentropyai:';

/** Strict column-name shape (mirrors the registry's validateColumnKey
 *  contract). Registry keys read here come from BOTH config planes — the DB
 *  plane can be written by another party on mounted/team brains, and these
 *  names are rendered verbatim into the agent-directed ACTION REQUIRED banner,
 *  so nonconforming names are dropped rather than echoed (text-injection
 *  hardening; sanctioned write paths already enforce this shape). */
const SAFE_COLUMN_KEY = /^[a-z_][a-z0-9_]{0,62}$/;

/** Blast-radius counts are LIMIT-capped so a million-chunk brain can't stall
 *  apply-migrations on a full-table COUNT. */
export const BLAST_RADIUS_CAP = 100_000;

export type ZeExposureStatus = 'exposed' | 'clear' | 'unknown';

export interface ZeBlastRadius {
  /** Pages whose embedding_signature is ZE-stamped (capped; null = probe failed). */
  zeSignedPages: number | null;
  zeSignedPagesCapped: boolean;
  /** Non-NULL embedded chunks (capped; null = probe failed / not ZE-exposed). */
  embeddedChunks: number | null;
  embeddedChunksCapped: boolean;
  /** Rough re-embed cost at the recommended target (~400 tokens/chunk). */
  estReembedUsd: number | null;
}

export interface ZeExposure {
  status: ZeExposureStatus;
  /** Effective embedding model resolves to zeroentropyai:* (and not disabled). */
  zeEmbedding: boolean;
  /** ...because file config names it explicitly. */
  zeExplicit: boolean;
  /** ...because nothing is configured and the legacy runtime fallback applies. */
  bareDefaultZe: boolean;
  /** Env override (GBRAIN_EMBEDDING_MODEL) names ZE — env wins over file, so
   *  the notice must tell the operator the env var itself has to change. */
  envOverride: boolean;
  /** The RESOLVED reranker (explicit config or still-legacy bundle default,
   *  when reranking is enabled for the active mode) is zeroentropyai:*. */
  zeReranker: boolean;
  /** Custom embedding_columns registry entries backed by a ZE model. */
  zeCustomColumns: string[];
  /** VOYAGE_API_KEY in env OR voyage_api_key in file config. */
  hasVoyageKey: boolean;
  /** provider_base_urls.zeroentropyai is overridden (file or DB plane) — the
   *  operator may be self-hosting a ZE-wire endpoint, so the HOSTED shutdown
   *  may not break them. Exposure stays exposed (fail-safe: we can't verify
   *  the endpoint), but the notice says so instead of claiming certain death. */
  selfHostBaseUrl: boolean;
  /** Names of probes that failed (drove status to 'unknown'). */
  unknownProbes: string[];
  blastRadius: ZeBlastRadius;
}

/** PRIVATE — both call sites pass hardcoded literal SQL; never pass dynamic
 *  or config-derived strings into `innerSql` (it is string-composed). If a
 *  future probe needs a parameter, add a fixed named query instead. */
async function cappedCount(engine: BrainEngine, innerSql: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (${innerSql} LIMIT ${BLAST_RADIUS_CAP + 1}) t`,
  );
  return Number(rows?.[0]?.n ?? 0);
}

function zeColumnsFromRegistry(registry: unknown, out: Set<string>): void {
  if (!registry || typeof registry !== 'object') return;
  for (const [name, entry] of Object.entries(registry as Record<string, unknown>)) {
    if (!SAFE_COLUMN_KEY.test(name)) continue; // never echo nonconforming names
    const provider = (entry as { provider?: unknown } | null)?.provider;
    if (typeof provider === 'string' && provider.startsWith(ZE_PREFIX)) out.add(name);
  }
}

/**
 * ZE-backed custom-column names for this brain (file + DB registry planes).
 * Shared by detectZeExposure and doctor's provider_sunset check — the doctor
 * must not report ok while a ZE-backed custom column is still live.
 */
export async function detectZeCustomColumns(
  engine: BrainEngine,
  fileCfgArg?: GBrainConfig | null,
): Promise<{ columns: string[]; probeFailed: boolean }> {
  const fileCfg = fileCfgArg !== undefined ? fileCfgArg : loadConfigFileOnly();
  const zeCols = new Set<string>();
  zeColumnsFromRegistry(fileCfg?.embedding_columns, zeCols);
  let probeFailed = false;
  try {
    const raw = await engine.getConfig('embedding_columns');
    if (raw) zeColumnsFromRegistry(JSON.parse(raw), zeCols);
  } catch {
    probeFailed = true;
  }
  return { columns: [...zeCols].sort(), probeFailed };
}

/**
 * Detect this brain's ZeroEntropy exposure. Every DB probe is individually
 * try/caught; a failure marks the probe unknown instead of throwing (a broken
 * schema must not turn detection into a crash — or into a false 'clear').
 */
export async function detectZeExposure(
  engine: BrainEngine,
  fileCfgArg?: GBrainConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ZeExposure> {
  const fileCfg = fileCfgArg !== undefined ? fileCfgArg : loadConfigFileOnly();
  const unknownProbes: string[] = [];

  // --- Embedding axis: pure config resolution, cannot fail -----------------
  const disabled = fileCfg?.embedding_disabled === true;
  const envModel = env.GBRAIN_EMBEDDING_MODEL?.trim() || undefined;
  const fileModel = fileCfg?.embedding_model;
  const effective = envModel ?? fileModel ?? DEFAULT_EMBEDDING_MODEL;
  const zeEmbedding = !disabled && effective.startsWith(ZE_PREFIX);
  const envOverride = !disabled && !!envModel?.startsWith(ZE_PREFIX);
  const zeExplicit = !disabled && !envModel && !!fileModel?.startsWith(ZE_PREFIX);
  const bareDefaultZe = !disabled && !envModel && !fileModel;

  // --- Reranker axis: resolve through the SAME plane search reranks with ---
  // (mode bundle + search.reranker.* config; env excluded). Detectable
  // precisely because the bundle default stays legacy-ZE until September.
  let zeReranker = false;
  try {
    const { loadSearchModeConfig, resolveSearchMode } = await import('./search/mode.ts');
    const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
    zeReranker = knobs.reranker_enabled && knobs.reranker_model.startsWith(ZE_PREFIX);
  } catch {
    unknownProbes.push('reranker_resolution');
  }

  // --- Custom-column axis: both planes (file + DB registry) ----------------
  const colProbe = await detectZeCustomColumns(engine, fileCfg);
  if (colProbe.probeFailed) unknownProbes.push('embedding_columns_db');
  const zeCustomColumns = colProbe.columns;

  const hasVoyageKey = !!(env.VOYAGE_API_KEY || fileCfg?.voyage_api_key);

  // --- Self-host signal (informational): base-URL override on either plane --
  let selfHostBaseUrl = !!fileCfg?.provider_base_urls?.zeroentropyai;
  if (!selfHostBaseUrl) {
    try {
      selfHostBaseUrl = !!(await engine.getConfig('provider_base_urls.zeroentropyai'));
    } catch {
      // Informational only — a failed probe never flips status here.
    }
  }

  // --- Blast radius (informational; failures do NOT flip status) -----------
  const blastRadius: ZeBlastRadius = {
    zeSignedPages: null,
    zeSignedPagesCapped: false,
    embeddedChunks: null,
    embeddedChunksCapped: false,
    estReembedUsd: null,
  };
  if (zeEmbedding) {
    try {
      const n = await cappedCount(
        engine,
        `SELECT 1 FROM pages WHERE embedding_signature LIKE '${ZE_PREFIX}%'`,
      );
      blastRadius.zeSignedPages = Math.min(n, BLAST_RADIUS_CAP);
      blastRadius.zeSignedPagesCapped = n > BLAST_RADIUS_CAP;
    } catch {
      // Pre-v108 schemas have no embedding_signature column — informational.
    }
    try {
      const n = await cappedCount(
        engine,
        `SELECT 1 FROM content_chunks WHERE embedding IS NOT NULL`,
      );
      blastRadius.embeddedChunks = Math.min(n, BLAST_RADIUS_CAP);
      blastRadius.embeddedChunksCapped = n > BLAST_RADIUS_CAP;
      const price = lookupEmbeddingPrice(NEW_INSTALL_DEFAULT_EMBEDDING_MODEL);
      if (price.kind === 'known' && blastRadius.embeddedChunks !== null) {
        // ~400 tokens/chunk repo-wide average (CLAUDE.md cost anchors).
        const tokens = blastRadius.embeddedChunks * 400;
        blastRadius.estReembedUsd = (tokens / 1_000_000) * price.pricePerMTok;
      }
    } catch {
      // Fresh/odd brains: no chunk count, no cost estimate. Informational.
    }
  }

  const exposed = zeEmbedding || zeReranker || zeCustomColumns.length > 0;
  const status: ZeExposureStatus = exposed
    ? 'exposed'
    : unknownProbes.length > 0
      ? 'unknown'
      : 'clear';

  return {
    status,
    zeEmbedding,
    zeExplicit,
    bareDefaultZe,
    envOverride,
    zeReranker,
    zeCustomColumns,
    hasVoyageKey,
    selfHostBaseUrl,
    unknownProbes,
    blastRadius,
  };
}

function fmtCount(n: number | null, capped: boolean): string {
  if (n === null) return 'unknown';
  return capped ? `${n.toLocaleString()}+` : n.toLocaleString();
}

/**
 * Render the shared ACTION REQUIRED body. Both the v0.46.3 migration notice
 * and the stage-2 upgrade banner wrap this text (DRY: the exposure story is
 * written once). Plain ASCII, <= 78 cols per repo convention.
 */
export function renderZeActionRequired(exposure: ZeExposure): string {
  const lines: string[] = [];
  lines.push(`ZeroEntropy stops working on ${ZEROENTROPY_SUNSET_DATE}.`);
  if (exposure.status === 'unknown' && !exposure.zeEmbedding && !exposure.zeReranker) {
    lines.push(
      `This brain's exposure could not be fully determined ` +
        `(failed probes: ${exposure.unknownProbes.join(', ')}). Treat it as affected ` +
        `until \`gbrain doctor\` reports provider_sunset ok.`,
    );
  }
  if (exposure.zeEmbedding) {
    const via = exposure.envOverride
      ? 'via the GBRAIN_EMBEDDING_MODEL env var'
      : exposure.zeExplicit
        ? 'via embedding_model in ~/.gbrain/config.json'
        : 'via the configless runtime fallback (nothing is configured)';
    lines.push(`This brain EMBEDS with ZeroEntropy (${via}).`);
    lines.push(
      `Blast radius: ${fmtCount(exposure.blastRadius.zeSignedPages, exposure.blastRadius.zeSignedPagesCapped)} ` +
        `ZE-stamped pages / ${fmtCount(exposure.blastRadius.embeddedChunks, exposure.blastRadius.embeddedChunksCapped)} ` +
        `embedded chunks` +
        (exposure.blastRadius.estReembedUsd !== null
          ? ` (${exposure.blastRadius.embeddedChunksCapped ? 'at least ' : ''}~$${exposure.blastRadius.estReembedUsd.toFixed(2)} to re-embed with ${NEW_INSTALL_DEFAULT_EMBEDDING_MODEL})`
          : ''),
    );
    lines.push(`Fix: ${renderCanonicalMigrationCommands().recommendedDryRun}`);
    lines.push(
      `  (Voyage's valid widths are 256/512/1024/2048 — legacy default brains are ` +
        `1280d and get a one-time rebuild to ${NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS}.`,
    );
    lines.push(
      `   OpenAI can keep widths up to 1536: --to openai:text-embedding-3-small --dim <width>.`,
    );
    lines.push(
      `   \`gbrain doctor\` prints this brain's exact width-aware command.)`,
    );
    if (exposure.envOverride) {
      lines.push(
        `NOTE: GBRAIN_EMBEDDING_MODEL currently forces the ZE model — the env var itself`,
      );
      lines.push(`must change; config edits alone cannot fix this brain.`);
    }
  }
  if (exposure.zeReranker) {
    lines.push(
      `Reranking currently resolves to ZE zerank-2 and dies the same day. Fix:`,
    );
    lines.push(
      `  gbrain config set search.reranker.model ${NEW_INSTALL_DEFAULT_RERANKER_MODEL}` +
        (exposure.hasVoyageKey ? '' : '   (needs VOYAGE_API_KEY)'),
    );
    lines.push(`  (or disable: gbrain config set search.reranker.enabled false)`);
  }
  if (exposure.zeCustomColumns.length > 0) {
    lines.push(
      `Custom embedding column(s) backed by ZeroEntropy: ${exposure.zeCustomColumns.join(', ')}.`,
    );
    lines.push(
      `No automated off-ramp exists for custom columns yet (migrate embeddings covers`,
    );
    lines.push(
      `the primary column only) — re-declare them on the new provider and re-embed.`,
    );
  }
  if (exposure.selfHostBaseUrl) {
    lines.push(
      `NOTE: provider_base_urls.zeroentropyai is overridden. If that endpoint is a`,
    );
    lines.push(
      `self-hosted ZE-wire-compatible server, the hosted shutdown does not break it —`,
    );
    lines.push(
      `but the zeroentropyai provider id is still slated for removal (see the`,
    );
    lines.push(`self-host continuity TODO in the playbook) — plan a migration anyway.`);
  }
  lines.push(`Nothing has been changed automatically; this brain keeps working until the date.`);
  lines.push(`Agent playbook: skills/migrations/v0.46.3.0.md`);
  return lines.join('\n');
}
