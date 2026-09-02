/**
 * Extraction + sync-lag check cluster (incl. checkSyncFreshness) — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import type { BrainEngine } from '../../../core/engine.ts';
import { probeSourceGitState } from '../../../core/git-head.ts';
// v0.41.32.0: remote staleness reads the stored newest_content_at column via
// this pure comparator (no git subprocess on the HTTP MCP doctor path).
import { lagFromContentMs, resolveStalenessCeilingSeconds } from '../../../core/source-health.ts';
import { resolveEnvNumber, resolveHoursEnv, warnOnceForEnv } from '../../../core/env-number.ts';
import { CHUNKER_VERSION } from '../../../core/chunkers/code.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../../core/link-extraction.ts';
import { isUndefinedColumnError } from '../../../core/utils.ts';
import {
  loadStorageConfig,
  effectiveDbOnlyDirs,
  DERIVE_PHASE_DB_ONLY_DEFAULTS,
  findDbOnlyCollisions,
} from '../../../core/storage-config.ts';
import { slugifyPath, slugifyCodePath, isCodeFilePath } from '../../../core/sync.ts';
import { resolveSourceLocalFilePath } from '../../../core/markdown.ts';
import { unverifiedExtractionFragment } from '../../../core/extraction-review.ts';
import type { Check } from '../../doctor.ts';

/** Local aliases; the shared warn-once memo lives in core so it can't fork per module. */
const _resolveEnvNumber = resolveEnvNumber;
const _resolveSyncFreshnessHours = resolveHoursEnv;

/**
 * v0.42.7 (#1696): single source of truth for the extraction-lag warn
 * threshold (percent). Both the `links_extraction_lag` doctor check AND the
 * end-of-sync nudge (`sync.ts:maybeExtractionNudge`) resolve through this +
 * `_resolveEnvNumber` so "the nudge fires iff doctor would warn" can't drift.
 */
export const EXTRACTION_LAG_WARN_PCT_DEFAULT = 20;
/** Min non-deleted page count below which extraction-lag is vacuous-skipped
 *  (unless an explicit --source scope is set). Shared by doctor + the sync
 *  nudge (D6/C4) so their skip predicates match exactly. */
export const EXTRACTION_LAG_MIN_PAGES = 100;

/**
 * Sync freshness check (v0.32.4) — verify that sources with local_path have
 * been synced recently. Detects the silent failure mode where `gbrain sync`
 * stopped running and brain search now misses recent pages.
 *
 * Pure staleness check. Reads `sources.last_sync_at` only — no filesystem
 * access. Filesystem-vs-DB drift detection is intentionally out of scope:
 *   - doctorReportRemote runs in the HTTP MCP server (src/commands/serve-http.ts);
 *     walking arbitrary DB-supplied paths from a remote-callable endpoint
 *     crosses a trust boundary (OAuth write scope could mutate local_path).
 *   - Drift detection belongs in `multi_source_drift` which already has
 *     GBRAIN_DRIFT_LIMIT + GBRAIN_DRIFT_TIMEOUT_MS guards.
 *
 * Thresholds (env-overridable, default = 24h warn / 72h fail):
 *   - GBRAIN_SYNC_FRESHNESS_WARN_HOURS
 *   - GBRAIN_SYNC_FRESHNESS_FAIL_HOURS
 * Invalid values (NaN, ≤0) fall back to defaults with a once-per-process warn.
 *
 * Edge cases handled:
 *   - last_sync_at IS NULL → fail "never synced"
 *   - last_sync_at > now() (clock skew / corrupted timestamp) → warn
 *   - mixed sources → highest-severity drives the overall status
 *   - executeRaw throws → outer-catch warn so doctor keeps running
 *
 * Failure messages embed `source.id` so the fix command
 * `gbrain sync --source <id>` matches what the user copy-pastes.
 */

/**
 * v0.42.7 (#1696) — links_extraction_lag doctor check.
 *
 * The signal that surfaces the "imported ≠ curated" root cause: pages whose
 * link/timeline extraction is stale (never run, edited-since, or extractor
 * bumped). Without it, a brain can run for months at 0% typed-edge coverage
 * with nothing warning the operator.
 *
 * Warn-only by DEFAULT (>20% stale). Hard-fail ONLY when the operator opts in
 * via GBRAIN_EXTRACTION_LAG_FAIL_PCT — so a just-upgraded 280K-page brain
 * (every page NULL → 100% stale) gets a loud WARN, never a non-zero exit that
 * would break a CI/cron pipeline gating on `gbrain doctor`.
 *
 * Vacuous-skip on tiny brains (<100 pages, no --source) like orphan_ratio.
 * Pre-v112 brains (column missing) degrade to OK via isUndefinedColumnError.
 * Strictly SQL — no filesystem/git access — so it's safe to wire into the
 * thin-client doctorReportRemote path (CDX-5 trust boundary).
 *
 * `opts.sourceId` scopes both the denominator and the stale count to one
 * source (the explicit-only `--source` parse, like orphan_ratio).
 */
export async function checkLinksExtractionLag(
  engine: BrainEngine,
  opts?: { sourceId?: string },
): Promise<Check> {
  const name = 'links_extraction_lag';
  const sourceId = opts?.sourceId;
  const fix = "Run: gbrain extract --stale";
  try {
    const totalRows = await engine.executeRaw<{ count: number }>(
      sourceId
        ? `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL AND source_id = $1`
        : `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL`,
      sourceId ? [sourceId] : [],
    );
    const total = Number(totalRows[0]?.count ?? 0);
    if (total === 0) {
      return { name, status: 'ok', message: 'Extraction lag not applicable (no pages)' };
    }
    // Vacuous-skip tiny brains unless explicitly source-scoped. Shared floor
    // const so the sync nudge (D6/C4) skips on the exact same predicate.
    if (total < EXTRACTION_LAG_MIN_PAGES && !sourceId) {
      return { name, status: 'ok', message: `Extraction lag not applicable (${total} pages — too few to assess)` };
    }

    const stale = await engine.countStalePagesForExtraction({ sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS });
    const pct = (stale / total) * 100;
    const pctStr = pct.toFixed(0);
    const scope = sourceId ? ` in source '${sourceId}'` : '';

    const warnPct = _resolveEnvNumber('GBRAIN_EXTRACTION_LAG_WARN_PCT', EXTRACTION_LAG_WARN_PCT_DEFAULT, { unit: '%' });
    // Fail threshold is DISABLED unless explicitly set (warn-only default). A
    // bare unset env var → no hard-fail; invalid value → warn-once + disabled.
    let failPct: number | undefined;
    const failRaw = process.env.GBRAIN_EXTRACTION_LAG_FAIL_PCT;
    if (failRaw !== undefined && failRaw !== '') {
      const n = Number(failRaw);
      if (Number.isFinite(n) && n > 0) {
        failPct = n;
      } else {
        warnOnceForEnv(
          'GBRAIN_EXTRACTION_LAG_FAIL_PCT',
          `[gbrain] Ignoring invalid GBRAIN_EXTRACTION_LAG_FAIL_PCT=${failRaw}; hard-fail stays disabled.`,
        );
      }
    }

    const details = { total, stale, pct: Number(pctStr), warn_pct: warnPct, fail_pct: failPct ?? null, source_id: sourceId ?? null };
    if (failPct !== undefined && pct > failPct) {
      return { name, status: 'fail', message: `${stale}/${total} pages (${pctStr}%)${scope} need link/timeline extraction (> ${failPct}% fail threshold). ${fix}`, details };
    }
    if (pct > warnPct) {
      return { name, status: 'warn', message: `${stale}/${total} pages (${pctStr}%)${scope} have un-extracted edges. ${fix}`, details };
    }
    return { name, status: 'ok', message: `Extraction current: ${stale}/${total} pages (${pctStr}%) stale${scope}`, details };
  } catch (e) {
    // Pre-v112 brain: links_extracted_at column doesn't exist yet. Graceful OK
    // (migration/bootstrap adds it; nothing to assess until then).
    if (isUndefinedColumnError(e, 'links_extracted_at')) {
      return { name, status: 'ok', message: 'links_extracted_at not present (pre-v112 brain)' };
    }
    return { name, status: 'warn', message: `Could not check links_extraction_lag: ${(e as Error).message}` };
  }
}

/**
 * issue #160 — unverified_extractions doctor check.
 *
 * The extraction quarantine lane parks auto-extracted entity stubs
 * (frontmatter `provenance: 'auto-extracted'` + `status: 'unverified'`)
 * until the owner promotes or rejects them. A queue nobody reviews decays
 * into invisible clutter, so this check counts stubs older than N days
 * (default 7) and nudges toward the review surface. Exported for direct
 * testing (mirrors checkLinksExtractionLag).
 */
export async function checkUnverifiedExtractions(
  engine: BrainEngine,
  opts?: { sourceId?: string; days?: number },
): Promise<Check> {
  const name = 'unverified_extractions';
  const days = opts?.days ?? 7;
  const sourceId = opts?.sourceId;
  try {
    const params: unknown[] = [String(days)];
    let srcClause = '';
    if (sourceId) {
      params.push(sourceId);
      srcClause = 'AND p.source_id = $2';
    }
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM pages p
       WHERE p.deleted_at IS NULL
         AND ${unverifiedExtractionFragment('p')}
         AND p.created_at < now() - ($1 || ' days')::interval
         ${srcClause}`,
      params,
    );
    const n = Number(rows[0]?.n ?? 0);
    return {
      name,
      status: n > 0 ? 'warn' : 'ok',
      message: n > 0
        ? `${n} unverified auto-extracted entity stub(s) older than ${days} days awaiting review. List with 'gbrain extraction-pending'; promote/reject with 'gbrain extraction-review <promote|reject> --slugs <slug,...>'.`
        : 'No stale unverified extraction stubs',
      details: { count: n, days, source_id: sourceId ?? null },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check unverified_extractions: ${(e as Error).message}` };
  }
}

/**
 * issue #2250 (reported by @615Works) — content_hash_duplicates.
 *
 * `gbrain import` run from the wrong root (one level too deep) drops the
 * path prefix from every slug, leaving `people/x` and `x` coexisting with
 * identical content. `dream --phase purge` never removes them (they aren't
 * file-backed orphans) and nothing surfaced the condition. One GROUP BY —
 * never an N² hash comparison — flags hash groups that contain BOTH a bare
 * slug (no '/') and a path-prefixed slug.
 */
export async function checkContentHashDuplicates(engine: BrainEngine): Promise<Check> {
  const name = 'content_hash_duplicates';
  const fix = 'Fix: gbrain pages delete <bare-slug> for each pair, then gbrain pages purge-deleted --older-than 0';
  try {
    // #3946: no shape predicates — EVERY same-source duplicate-content group
    // surfaces (HAVING count(*) > 1 alone). Classification happens at render:
    // a group holding BOTH a bare and a path-prefixed slug is the wrong-root
    // import pattern (the bare slug is the accident, so the delete hint is
    // safe); a group WITHOUT that shape (all-nested, or distinct bare slugs)
    // is listed with NO delete hint (#3942 — either copy may be the canonical
    // one that links point at, so deleting one automatically is a guess).
    const rows = await engine.executeRaw<{ source_id: string; content_hash: string; slugs: string }>(
      `SELECT source_id, content_hash,
              string_agg(slug, '|' ORDER BY length(slug), slug) AS slugs
         FROM pages
        WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash <> ''
        GROUP BY source_id, content_hash
       HAVING count(*) > 1
        LIMIT 50`,
    );
    if (rows.length === 0) {
      return { name, status: 'ok', message: 'No same-source content-hash duplicate groups' };
    }
    let pairCount = 0;
    const samples: string[] = [];
    let otherGroupCount = 0;
    const otherSamples: string[] = [];
    for (const r of rows) {
      const slugs = String(r.slugs).split('|');
      const bare = slugs.filter(s => !s.includes('/'));
      const prefixed = slugs.filter(s => s.includes('/'));
      if (bare.length > 0 && prefixed.length > 0) {
        for (const b of bare) {
          const twin = prefixed.find(p => p.endsWith('/' + b)) ?? prefixed[0];
          pairCount++;
          if (samples.length < 5) samples.push(`${b} <-> ${twin}`);
        }
      } else {
        otherGroupCount++;
        if (otherSamples.length < 5) otherSamples.push(slugs.join(' == '));
      }
    }
    const parts: string[] = [];
    if (pairCount > 0) {
      parts.push(
        `${pairCount} content-hash duplicate pair(s) detected (same content, differing slug forms — ` +
        `usually an import run from the wrong root, which drops the path prefix). ` +
        `Sample: ${samples.join('; ')}. ${fix}`,
      );
    }
    if (otherGroupCount > 0) {
      parts.push(
        `${otherGroupCount} duplicate-content group(s) with distinct slugs (no bare/nested wrong-root shape). ` +
        `Sample: ${otherSamples.join('; ')}. Review which slug is canonical and consolidate manually — ` +
        `no automatic delete hint (either copy may be the one links point at).`,
      );
    }
    return {
      name,
      status: 'warn',
      message: parts.join(' '),
      details: {
        pair_count: pairCount,
        hash_groups: rows.length,
        sample_pairs: samples,
        distinct_slug_group_count: otherGroupCount,
        sample_distinct_slug_groups: otherSamples,
      },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check content-hash duplicates: ${(e as Error).message}` };
  }
}

/**
 * issue #3970 — code_chunk_metadata.
 *
 * Code pages whose chunks carry NO symbol metadata (symbol_name IS NULL AND
 * language IS NULL) were chunked before the v0.19/v0.21 code chunker or
 * re-imported through the markdown path — `code-def`, `code-refs`, and
 * `query --lang/--symbol-kind` silently miss them. A plain sync or
 * `reindex-code` never heals them (importCodeFile's content_hash
 * short-circuit skips unchanged pages), so the cure is
 * `gbrain reindex-code --force`. Raw SQL only (works on both engines).
 */
export async function checkCodeChunkMetadata(engine: BrainEngine): Promise<Check> {
  const name = 'code_chunk_metadata';
  try {
    const rows = await engine.executeRaw<{ chunks: string | number; pages: string | number }>(
      `SELECT COUNT(*)::text AS chunks, COUNT(DISTINCT c.page_id)::text AS pages
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE p.type = 'code' AND p.deleted_at IS NULL
          AND c.symbol_name IS NULL AND c.language IS NULL`,
    );
    const chunks = Number(rows[0]?.chunks ?? 0);
    const pages = Number(rows[0]?.pages ?? 0);
    if (chunks === 0) {
      return { name, status: 'ok', message: 'All code-page chunks carry symbol metadata' };
    }
    return {
      name,
      status: 'warn',
      message:
        `${chunks} chunk(s) on ${pages} code page(s) have no symbol metadata ` +
        `(symbol_name and language both NULL) — code-def/code-refs and ` +
        `--lang/--symbol-kind filters miss them. A plain sync/reindex skips ` +
        `unchanged pages via the content_hash short-circuit. ` +
        `Fix: gbrain reindex-code --force`,
      details: { chunks_missing_metadata: chunks, pages_affected: pages },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check code chunk metadata: ${(e as Error).message}` };
  }
}

/** Walk a repo for markdown files and return their slugified (lowercased) slugs. */
function collectMarkdownSlugs(root: string): Set<string> {
  const out = new Set<string>();
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // Hidden directories can contain canonical, tracked knowledge (for
      // example `.archive/`). Only implementation metadata is never a page.
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else if (/\.mdx?$/i.test(e.name)) out.add(slugifyPath(childRel).toLowerCase());
      // #3766: code files are pages too (code-slug shape). Legacy code rows
      // backfilled by migration 25 carry page_kind='markdown' without a
      // type='code' re-stamp, so their slugs must count as file-backed or
      // every one of them false-positives as "DB-only".
      else if (isCodeFilePath(e.name)) out.add(slugifyCodePath(childRel).toLowerCase());
    }
  }
  return out;
}

/**
 * issue #2784 (reported by @alexputici) — undeclared_db_only_pages.
 *
 * A markdown page with no backing file that sits outside every declared
 * db_only path is invisible to any file-lane backup/recovery reasoning: an
 * operator auditing "what would survive a DB loss" gets a silently wrong
 * answer. The engine's own derive-phase output prefixes
 * (DERIVE_PHASE_DB_ONLY_DEFAULTS) count as implicitly declared so the check
 * stays quiet on healthy brains. Deliberately allowed to stat the source
 * repo (the one thing the SQL-only check registry could never see).
 */
export async function checkUndeclaredDbOnlyPages(engine: BrainEngine): Promise<Check> {
  const name = 'undeclared_db_only_pages';
  try {
    // #3880: archived sources are out of scope for filesystem audits (v34
    // legacy fallback, house style per pickSoleNonDefaultSource).
    let sources: Array<{ id: string; local_path: string | null }>;
    try {
      sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
      );
    } catch {
      sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
      );
    }
    const checkable = sources.filter(s => s.local_path && existsSync(s.local_path));
    if (checkable.length === 0) {
      return { name, status: 'ok', message: 'Not applicable (no sources with a local repo path on this host)' };
    }
    let total = 0;
    const samples: string[] = [];
    const perSource: Record<string, number> = {};
    for (const src of checkable) {
      let declared: string[] = [];
      try {
        declared = loadStorageConfig(src.local_path)?.db_only ?? [];
      } catch {
        // invalid gbrain.yml — treated as no declarations; the sync path
        // already surfaces the config error itself.
      }
      const dbOnlyDirs = effectiveDbOnlyDirs(declared);
      // #3766: skip properly-stamped code pages (type='code') — they live on
      // the code lane, not the markdown backup story. Legacy code rows from
      // the migration-25 backfill (page_kind='markdown', type never
      // re-stamped) still flow through and match via the code-slug backed
      // set collected below.
      const rows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
        `SELECT slug, source_path FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND page_kind = 'markdown' AND type IS DISTINCT FROM 'code'`,
        [src.id],
      );
      if (rows.length === 0) continue;
      let backedWithoutSourcePath: Set<string> | null = null;
      for (const { slug, source_path: sourcePath } of rows) {
        if (dbOnlyDirs.some(dir => slug.startsWith(dir))) continue;
        if (sourcePath) {
          const filePath = resolveSourceLocalFilePath(src.local_path!, sourcePath);
          if (filePath && existsSync(filePath)) continue;
        } else {
          backedWithoutSourcePath ??= collectMarkdownSlugs(src.local_path!);
          if (backedWithoutSourcePath.has(slug.toLowerCase())) continue;
        }
        total++;
        perSource[src.id] = (perSource[src.id] ?? 0) + 1;
        if (samples.length < 5) samples.push(`${slug} (src=${src.id})`);
      }
    }
    if (total === 0) {
      return {
        name,
        status: 'ok',
        message: `Every DB page is file-backed or under a declared/default db_only path (derive-phase defaults: ${DERIVE_PHASE_DB_ONLY_DEFAULTS.join(' ')})`,
      };
    }
    return {
      name,
      status: 'warn',
      message: `${total} DB page(s) have no backing file and sit outside every declared/default db_only path — invisible to file-lane backup/recovery. Sample: ${samples.join('; ')}. Fix: restore or export the files, or declare their prefixes under storage.db_only in gbrain.yml (derive-phase defaults already cover: ${DERIVE_PHASE_DB_ONLY_DEFAULTS.join(' ')})`,
      details: { total, per_source: perSource, sample_slugs: samples },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check undeclared db-only pages: ${(e as Error).message}` };
  }
}

/**
 * issue #2788 (reported by @alexputici) — db_only_collector_collision.
 *
 * Declaring a collector's output dir in storage.db_only silently kills its
 * ingestion: manageGitignore auto-gitignores the dir, the git-walking sync
 * never sees the files, and import honors .gitignore too — everything stays
 * green while nothing reaches the DB (a 7-week outage in the field). The
 * recipe's `output_paths` frontmatter is the ground truth; the same warning
 * also fires at .gitignore-write time inside sync's manageGitignore.
 */
export async function checkDbOnlyCollectorCollision(
  engine: BrainEngine,
  opts?: { collectors?: Array<{ id: string; output_path: string }> },
): Promise<Check> {
  const name = 'db_only_collector_collision';
  try {
    let collectors = opts?.collectors;
    if (!collectors) {
      const { getConfiguredCollectorOutputs } = await import('../../integrations.ts');
      collectors = getConfiguredCollectorOutputs();
    }
    if (collectors.length === 0) {
      return { name, status: 'ok', message: 'No configured collectors declare output paths' };
    }
    // #3880: skip archived sources (v34 legacy fallback).
    let sources: Array<{ id: string; local_path: string | null }>;
    try {
      sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
      );
    } catch {
      sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
      );
    }
    const hits: string[] = [];
    for (const src of sources) {
      if (!src.local_path || !existsSync(src.local_path)) continue;
      let dbOnly: string[] = [];
      try {
        dbOnly = loadStorageConfig(src.local_path)?.db_only ?? [];
      } catch {
        continue;
      }
      if (dbOnly.length === 0) continue;
      for (const hit of findDbOnlyCollisions(collectors, dbOnly)) {
        hits.push(`collector '${hit.id}' writes to '${hit.output_path}' which is inside db_only path '${hit.db_only_dir}' (source ${src.id})`);
      }
    }
    if (hits.length === 0) {
      return { name, status: 'ok', message: 'No collector output dir falls inside a db_only path' };
    }
    return {
      name,
      status: 'warn',
      message: `${hits.length} collector/db_only collision(s): ${hits.join('; ')}. db_only dirs are auto-gitignored, so sync AND import silently skip files there — the collector runs green while nothing reaches the DB. Fix: remove the prefix from storage.db_only in gbrain.yml, or move the collector output.`,
      details: { collisions: hits },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check collector/db_only collisions: ${(e as Error).message}` };
  }
}

type ExtractAtomsBacklogCounter = (engine: BrainEngine, sourceId?: string) => Promise<number | null>;

async function countExtractAtomsBacklogBySource(
  engine: BrainEngine,
  countBacklog: ExtractAtomsBacklogCounter,
): Promise<Array<{ source_id: string; backlog: number }> | null> {
  try {
    const sources = await engine.executeRaw<{ source_id: string }>(
      `SELECT DISTINCT source_id FROM pages WHERE deleted_at IS NULL ORDER BY source_id`,
    );
    const rows: Array<{ source_id: string; backlog: number }> = [];
    for (const src of sources) {
      const backlog = await countBacklog(engine, src.source_id);
      if (backlog === null) return null;
      if (backlog > 0) rows.push({ source_id: src.source_id, backlog });
    }
    return rows;
  } catch {
    return null;
  }
}

function buildExtractAtomsDrainCommand(
  bySource: Array<{ source_id: string; backlog: number }> | null,
): string {
  if (!bySource || bySource.length === 0) {
    return `gbrain dream --phase extract_atoms --drain --source <source-id> --window 120`;
  }
  if (bySource.length === 1) {
    return `gbrain dream --phase extract_atoms --drain --source ${bySource[0]!.source_id} --window 120`;
  }
  const sources = bySource.map((row) => row.source_id).join(', ');
  return `gbrain dream --phase extract_atoms --drain --source ${bySource[0]!.source_id} --window 120 (repeat for backlog source(s): ${sources})`;
}

function buildExtractAtomsBacklogFixHint(
  bySource: Array<{ source_id: string; backlog: number }> | null,
): string {
  const drain = buildExtractAtomsDrainCommand(bySource);
  if (bySource && bySource.length > 1) {
    // Multi-source form already ends in a parenthetical — fold the
    // declare-suggestion into it.
    return drain.replace(/\)$/, '; or declare extract_atoms in your active schema pack)');
  }
  return `${drain} (or declare extract_atoms in your active schema pack)`;
}

/**
 * #4576 — evidence that a full routine cycle actually completes on this host.
 * Reads the most recent `last_full_cycle_at` across local_path sources — the
 * canonical "this whole cycle completed" stamp runCycle's exit hook writes
 * and `cycle_freshness` reads. Freshness window is the same
 * GBRAIN_CYCLE_FRESHNESS_WARN_HOURS knob (default 6h) cycle_freshness warns
 * at. `unknown` (sources unreadable) is fail-open: callers must not warn on it.
 */
type FullCycleEvidence =
  | { state: 'fresh' | 'stale'; latestIso: string; ageHours: number; warnHours: number }
  | { state: 'never'; latestIso: null; warnHours: number }
  | { state: 'unknown' };

async function latestFullCycleEvidence(
  engine: BrainEngine,
  nowMs = Date.now(),
): Promise<FullCycleEvidence> {
  const warnHours = _resolveSyncFreshnessHours('GBRAIN_CYCLE_FRESHNESS_WARN_HOURS', 6);
  try {
    const sources = await engine.listAllSources({ localPathOnly: true });
    let latest = Number.NEGATIVE_INFINITY;
    let latestIso: string | null = null;
    for (const src of sources) {
      const raw = src.config?.last_full_cycle_at;
      if (typeof raw !== 'string') continue;
      const t = new Date(raw).getTime();
      if (Number.isFinite(t) && t > latest) {
        latest = t;
        latestIso = raw;
      }
    }
    if (latestIso === null) return { state: 'never', latestIso: null, warnHours };
    const ageHours = Math.max(0, Math.floor((nowMs - latest) / 3_600_000));
    // Future timestamps (clock skew) count as fresh — cycle_freshness owns
    // the clock-skew signal; this check only needs "does anything run?".
    const state = nowMs - latest <= warnHours * 3_600_000 ? 'fresh' : 'stale';
    return { state, latestIso, ageHours, warnHours };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * #4576 review fix: can this brain's shape produce per-source
 * last_full_cycle_at stamps at all? Two lanes write them:
 *   - the per-source cycle (autopilot fanout / dream --source / dream --dir
 *     matching a registered local_path) stamps that local_path source;
 *   - the #4700 implicit-default lane stamps the resolved implicit default.
 * A brain with ZERO local_path sources and NO implicit default (the legacy
 * unscoped-dream shape — everything in 'default', dir via sync.repo_path)
 * has neither lane, so evidence state 'never' is a property of the SHAPE,
 * not evidence that nothing runs. Fail-open: a probe error reads as
 * cannot-verify (false), keeping the pre-#4576 ok-with-reassurance.
 */
async function brainShapeCanCarryCycleStamps(engine: BrainEngine): Promise<boolean> {
  try {
    const sources = await engine.listAllSources({ localPathOnly: true });
    if (sources.length > 0) return true;
    const { resolveImplicitDefaultSourceId } = await import('../../../core/source-resolver.ts');
    const implicitDefault = await resolveImplicitDefaultSourceId(engine);
    // dream only runs the stamping implicit lane for a NON-'default' target.
    return implicitDefault !== null && implicitDefault !== 'default';
  } catch {
    return false;
  }
}

/**
 * issue #1678 — extract_atoms_backlog doctor check.
 *
 * Closes the "silent backlog" gap: extract_atoms is pack-gated, so on a brain
 * whose active pack doesn't declare the phase it NEVER runs in the routine
 * cycle and pages accumulate forever with zero signal (the cycle reports a
 * clean `skipped`). This check counts the eligible-but-unextracted pages and,
 * when the pack doesn't run the phase AND the backlog is real, WARNs with the
 * exact `--drain` command.
 *
 * PAGE-BACKLOG-ONLY (Codex #11): extract_atoms also discovers transcript files
 * at runtime; this counts DB pages only — labeled in details. No
 * synthesize_concepts sibling this wave (Codex #12: that phase is a stub with
 * no real eligibility predicate; a check would be a fake signal).
 */
export async function computeExtractAtomsBacklogCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'extract_atoms_backlog';
  const approx = 'page backlog only; transcript corpus not counted';
  try {
    const { countExtractAtomsBacklog } = await import('../../../core/cycle/extract-atoms.ts');
    const backlog = await countExtractAtomsBacklog(engine); // brain-wide
    if (backlog === null) {
      return { name, status: 'warn', message: 'backlog query failed (could not count eligible pages)' };
    }

    const { packDeclaresPhase } = await import('../../../core/cycle.ts');
    let declared = false;
    try { declared = await packDeclaresPhase(engine, 'extract_atoms'); } catch { declared = false; }

    if (backlog === 0) {
      return {
        name, status: 'ok',
        message: 'no pages awaiting atom extraction',
        details: { backlog, pack_declares_phase: declared, known_approximation: approx },
      };
    }

    // The incident: pack does NOT run the phase but a real backlog exists →
    // it will grow forever without a signal. WARN with the drain command.
    if (!declared && backlog > 10) {
      const backlogBySource = await countExtractAtomsBacklogBySource(engine, countExtractAtomsBacklog);
      const fix = buildExtractAtomsBacklogFixHint(backlogBySource);
      return {
        name, status: 'warn',
        message: `${backlog} pages eligible for atom extraction but the active pack does not run extract_atoms — backlog growing. Fix: ${fix}`,
        details: { backlog, backlog_by_source: backlogBySource ?? undefined, pack_declares_phase: false, fix_hint: fix, known_approximation: approx },
      };
    }

    if (declared) {
      // #4576: "the pack runs it each cycle" is only reassurance when
      // something actually RUNS the cycle. Gate the OK on evidence — on a
      // host with no autopilot/cron install nothing runs the phase, the
      // backlog grows forever, and this branch used to report ok the whole
      // time (the same silent-backlog failure mode #1678 closed for the
      // !declared branch, reopened through a different door).
      const evidence = backlog > 10 ? await latestFullCycleEvidence(engine) : null;
      // #4576 review fix: 'never' only indicts the scheduler when the brain
      // shape can actually produce stamps. On the legacy unscoped-dream shape
      // (no local_path sources, no implicit default) no lane ever writes
      // last_full_cycle_at, so 'never' would be a permanent false warn —
      // keep the old ok-with-reassurance there instead.
      if (evidence && evidence.state === 'never' && !(await brainShapeCanCarryCycleStamps(engine))) {
        return {
          name, status: 'ok',
          message: `${backlog} page(s) pending; active pack runs extract_atoms each cycle`,
          details: { backlog, pack_declares_phase: true, cycle_evidence: 'unavailable', known_approximation: approx },
        };
      }
      if (evidence && (evidence.state === 'never' || evidence.state === 'stale')) {
        const backlogBySource = await countExtractAtomsBacklogBySource(engine, countExtractAtomsBacklog);
        const drain = buildExtractAtomsDrainCommand(backlogBySource);
        const since = evidence.state === 'never'
          ? 'no full cycle has ever completed'
          : `no full cycle has completed in ${evidence.ageHours}h (warn window ${evidence.warnHours}h)`;
        return {
          name, status: 'warn',
          message:
            `${backlog} page(s) pending and the active pack declares extract_atoms, but ${since} — ` +
            `nothing appears to run the cycle. Install the scheduler: gbrain autopilot --install. ` +
            `Or drain now: ${drain}`,
          details: {
            backlog,
            backlog_by_source: backlogBySource ?? undefined,
            pack_declares_phase: true,
            cycle_evidence: evidence.state,
            last_full_cycle_at: evidence.latestIso ?? undefined,
            fix_hint: drain,
            known_approximation: approx,
          },
        };
      }
      // Pack runs it AND a cycle completed recently (or the backlog is small,
      // or evidence is unreadable — fail-open). Informational.
      return {
        name, status: 'ok',
        message: `${backlog} page(s) pending; active pack runs extract_atoms each cycle`,
        details: { backlog, pack_declares_phase: true, known_approximation: approx },
      };
    }

    // Not declared but below the warn threshold.
    return {
      name, status: 'ok',
      message: `${backlog} page(s) eligible (below warn threshold; pack does not run extract_atoms)`,
      details: { backlog, pack_declares_phase: false, known_approximation: approx },
    };
  } catch (err) {
    return { name, status: 'warn', message: `extract_atoms_backlog check failed: ${(err as Error).message}` };
  }
}

/**
 * atom_provenance_drift doctor check (#4566).
 *
 * The mirror of extract_atoms_backlog. That check counts pages waiting to be
 * extracted; this one counts atoms whose provenance no longer resolves.
 *
 * extract_atoms stamps `frontmatter.source_hash` with the first 16 chars of the
 * source page's content_hash, and discovery skips a page while an atom with the
 * matching hash exists. Editing the page moves its content_hash, so the atom is
 * left pointing at a hash no live page carries. Nothing reclaims those atoms:
 * re-extraction mints under a deterministic slug built from the atom TITLE, so
 * it only upserts in place when the new pass happens to produce the same title.
 * A reworded claim lands on a new slug and the old atom stays, unreferenced.
 *
 * Why this needs a signal: a drifted atom is still returned by search, still
 * carries a `source_quote`, and still reads as sourced — but its quote can no
 * longer be located in any current page. It is the one class of derived page
 * that silently diverges from the corpus it claims to summarize.
 *
 * Measured on a 17-source brain (30.7k pages, 4.0k atoms) before shipping this:
 * 1,001 of 3,999 atoms (25.0%) had drifted; 932 still had a live source page
 * that had merely been edited, 69 had lost the source page entirely. The
 * youngest drifted atom was 6.0 days old and the mean was 16.5 days, i.e. the
 * population is NOT extraction lag working itself out — it accumulates.
 *
 * Diagnostic only. It reports and hints; it never deletes. `source_gone` and
 * `source_changed` are split because they warrant different handling and the
 * second is by far the larger group — a naive GC keyed on drift alone would
 * delete mostly-recoverable knowledge.
 */
export async function computeAtomProvenanceDriftCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'atom_provenance_drift';
  // Both must trip: the ratio alone flaps on brains with a handful of atoms,
  // and the count alone fires on large healthy brains mid-cycle.
  const MIN_DRIFTED = 25;
  const WARN_RATIO = 0.1;
  try {
    const rows = await engine.executeRaw<{
      total: string | number; drifted: string | number;
      source_changed: string | number; source_gone: string | number;
      oldest_ext: string | null;
    }>(
      // extracted_at stays TEXT end to end (review fix): an unguarded
      // ::timestamptz cast let ONE malformed frontmatter value (hand edit,
      // truncation) abort the whole aggregate and permanently degrade this
      // check to a spurious "check failed" warn. The ISO-shape regex drops
      // garbage from the min(); the age math happens in TS where Date
      // parsing can never throw (semantically-invalid dates become NaN →
      // metric omitted, verdict untouched).
      `WITH atom AS (
         SELECT a.source_id,
                a.frontmatter->>'source_hash' AS sh,
                a.frontmatter->>'source_slug' AS ss,
                CASE WHEN a.frontmatter->>'extracted_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                     THEN a.frontmatter->>'extracted_at' END AS ext
           FROM pages a
          WHERE a.type = 'atom'
            AND a.deleted_at IS NULL
            AND a.frontmatter->>'source_hash' IS NOT NULL
            -- in-flight marker written before the extraction commits
            AND a.frontmatter->>'source_hash' NOT LIKE 'pending:%'
       ), drift AS (
         SELECT atom.*,
                NOT EXISTS (
                  SELECT 1 FROM pages p
                   WHERE p.source_id = atom.source_id AND p.deleted_at IS NULL
                     AND substring(p.content_hash from 1 for 16) = atom.sh
                ) AS drifted,
                EXISTS (
                  SELECT 1 FROM pages p
                   WHERE p.source_id = atom.source_id AND p.deleted_at IS NULL
                     AND p.slug = atom.ss
                ) AS src_alive
           FROM atom
       )
       SELECT count(*) AS total,
              count(*) FILTER (WHERE drifted) AS drifted,
              count(*) FILTER (WHERE drifted AND src_alive) AS source_changed,
              count(*) FILTER (WHERE drifted AND NOT src_alive) AS source_gone,
              -- lexicographic min of ISO-shaped strings ≈ chronological min
              -- (oldest); informational only, never verdict-bearing
              min(ext) FILTER (WHERE drifted) AS oldest_ext
         FROM drift`,
      [],
    );
    const r = rows?.[0];
    if (!r) return { name, status: 'warn', message: 'atom provenance query returned no rows' };

    const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
    const total = num(r.total);
    const drifted = num(r.drifted);
    const sourceChanged = num(r.source_changed);
    const sourceGone = num(r.source_gone);
    const oldestExtMs = r.oldest_ext ? new Date(String(r.oldest_ext)).getTime() : NaN;
    const oldestDays = Number.isFinite(oldestExtMs)
      ? Math.round(((Date.now() - oldestExtMs) / 86_400_000) * 10) / 10
      : null;
    const ratio = total > 0 ? drifted / total : 0;
    const details = {
      total_atoms: total,
      drifted,
      source_changed: sourceChanged,
      source_gone: sourceGone,
      drift_pct: total > 0 ? Math.round(ratio * 1000) / 10 : 0,
      oldest_drifted_days: oldestDays ?? undefined,
    };

    if (total === 0) return { name, status: 'ok', message: 'no atoms to check', details };
    if (drifted === 0) return { name, status: 'ok', message: `${total} atom(s), all provenance-resolved`, details };

    if (drifted >= MIN_DRIFTED && ratio > WARN_RATIO) {
      const fix =
        "review before acting — most drift is an edited source, not a dead one. " +
        "List them with: SELECT slug, frontmatter->>'source_slug' FROM pages a WHERE a.type='atom' " +
        "AND a.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id " +
        "AND p.deleted_at IS NULL AND substring(p.content_hash from 1 for 16)=a.frontmatter->>'source_hash')";
      return {
        name, status: 'warn',
        message:
          `${drifted}/${total} atom(s) (${details.drift_pct}%) reference a source_hash no live page carries ` +
          `— ${sourceChanged} whose source page still exists (edited), ${sourceGone} whose source page is gone` +
          (oldestDays != null ? `; oldest ${oldestDays}d` : '') +
          `. These still surface in search with a source_quote that no current page contains. Fix: ${fix}`,
        details,
      };
    }

    return {
      name, status: 'ok',
      message: `${drifted}/${total} atom(s) drifted (below warn threshold)`,
      details,
    };
  } catch (err) {
    return { name, status: 'warn', message: `atom_provenance_drift check failed: ${(err as Error).message}` };
  }
}

/**
 * v0.42 — extract_health doctor check.
 *
 * Reads the extract_rollup_7d table (migration v106) for the last 7 days
 * and reports per-kind aggregates. Stable JSON envelope schema_version:1.
 *
 * 3-state status:
 *   - OK when rollup is empty (no extractions yet) OR every per-kind
 *     halt rate is below the warn threshold.
 *   - WARN when any per-kind halt rate exceeds 10% (operator-visible
 *     signal that an extractor is failing too often).
 *   - WARN when rollup_write_failures > 0 (audit JSONL is the source of
 *     truth but operator should know the DB cache is degraded).
 *
 * Per-kind columns (per plan A5 + D-EXTRACT-32 spec):
 *   cost_7d_usd, eval_pass_count, eval_fail_count, halt_count,
 *   round_completed_count, last_updated_at
 *
 * The check is empty-rollup-tolerant: a brain that has never extracted
 * shows OK with `kinds: []` rather than warning. Doctor latency stays
 * under 100ms regardless of brain size because the rollup table
 * pre-aggregates (rolled-up at audit-emitter time per F-OUT-19).
 *
 * Empty rollup short-circuits BEFORE hitting the rollup_write_failures
 * branch so a brand-new brain doesn't surface a "0 failures" warning.
 */
export async function computeExtractHealthCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'extract_health';
  try {
    type RollupRow = {
      kind: string;
      cost_7d_usd: number;
      eval_pass_count: number;
      eval_fail_count: number;
      halt_count: number;
      round_completed_count: number;
      expected_limit_count: number;
      rollup_write_failures: number;
      last_updated_at: Date | string | null;
    };

    // #4482: expected_limit_count (migration v141) counts runs that stopped
    // at an EXPECTED budget/deadline cap — successful partial progress, not
    // failures. Pre-v141 brains lack the column; retry without it (caps read
    // as 0, i.e. "unknown" — old conflated halt rows keep today's semantics).
    const rollupQuery = (withExpected: boolean) =>
      `SELECT
         kind,
         SUM(cost_usd) AS cost_7d_usd,
         SUM(eval_pass_count) AS eval_pass_count,
         SUM(eval_fail_count) AS eval_fail_count,
         SUM(halt_count) AS halt_count,
         SUM(round_completed_count) AS round_completed_count,
         ${withExpected ? 'SUM(expected_limit_count)' : '0'} AS expected_limit_count,
         SUM(rollup_write_failures) AS rollup_write_failures,
         MAX(updated_at) AS last_updated_at
       FROM extract_rollup_7d
       WHERE day >= CURRENT_DATE - 7
       GROUP BY kind
       ORDER BY kind`;
    let rows: RollupRow[];
    try {
      rows = await engine.executeRaw<RollupRow>(rollupQuery(true), []);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (!/expected_limit_count/i.test(msg)) throw err;
      rows = await engine.executeRaw<RollupRow>(rollupQuery(false), []);
    }

    if (rows.length === 0) {
      return {
        name,
        status: 'ok',
        message: 'no extractions in last 7 days',
        details: {
          schema_version: 1,
          kinds: [],
        },
      };
    }

    type KindAggregate = {
      kind: string;
      cost_7d_usd: number;
      eval_pass_count: number;
      eval_fail_count: number;
      halt_count: number;
      round_completed_count: number;
      expected_limit_count: number;
      halt_rate: number;
      last_updated_at: string | null;
    };

    const kinds: KindAggregate[] = rows.map(r => {
      const halts = Number(r.halt_count) || 0;
      const completed = Number(r.round_completed_count) || 0;
      const expectedLimits = Number(r.expected_limit_count) || 0;
      // #4482: cap stops join the DENOMINATOR (they are runs, and successful
      // ones) but not the numerator — the failure rate measures failures,
      // not self-imposed capacity limits. A backlog-bigger-than-budget brain
      // whose every run banks progress and stops at the cap reads 0%.
      const total = halts + completed + expectedLimits;
      return {
        kind: r.kind,
        cost_7d_usd: Number(r.cost_7d_usd) || 0,
        eval_pass_count: Number(r.eval_pass_count) || 0,
        eval_fail_count: Number(r.eval_fail_count) || 0,
        halt_count: halts,
        round_completed_count: completed,
        expected_limit_count: expectedLimits,
        halt_rate: total > 0 ? halts / total : 0,
        last_updated_at: r.last_updated_at
          ? new Date(r.last_updated_at).toISOString()
          : null,
      };
    });

    const totalRollupFailures = rows.reduce(
      (acc, r) => acc + (Number(r.rollup_write_failures) || 0),
      0,
    );

    // High halt rates: per F-OUT-19 doctor surfaces extractor health
    // distinctly from rollup write health.
    const highHaltKinds = kinds.filter(k => k.halt_rate > 0.10);

    if (highHaltKinds.length > 0) {
      // Each row's halt_count/round_completed_count are 7-day SUMS (the
      // rollup table is one row per kind per day), so a kind whose most
      // recent activity is near the edge of the 7-day window can show a
      // high halt rate from entirely historical failures with nothing
      // currently wrong — the operator has no way to tell "actively
      // failing" from "hasn't run since a bug that's already fixed" without
      // this. last_updated_at is already computed (MAX(updated_at) above)
      // but wasn't surfaced in the message text, only in `details`.
      const top3 = [...highHaltKinds]
        .sort((a, b) => b.halt_rate - a.halt_rate)
        .slice(0, 3)
        .map(k => {
          const ageDays = k.last_updated_at
            ? Math.floor((Date.now() - new Date(k.last_updated_at).getTime()) / 86_400_000)
            : null;
          const ageSuffix = ageDays === null ? '' : ageDays <= 0 ? ', today' : `, ${ageDays}d ago`;
          return `${k.kind}=${(k.halt_rate * 100).toFixed(1)}%${ageSuffix}`;
        })
        .join(', ');
      return {
        name,
        status: 'warn',
        message: `${highHaltKinds.length} kind(s) with halt rate > 10% (top: ${top3})`,
        details: {
          schema_version: 1,
          kinds,
          rollup_write_failures_7d: totalRollupFailures,
        },
      };
    }

    if (totalRollupFailures > 0) {
      return {
        name,
        status: 'warn',
        // #3697: this hint used to name `gbrain extract status --rebuild-rollup`,
        // which does not exist (the JSONL→rollup rebuild is a planned self-heal,
        // not a shipped command). Say what is true instead of sending the
        // operator to a usage error.
        message: `${totalRollupFailures} rollup write failure(s) in last 7d. The rollup table is a best-effort cache — the audit JSONL under ~/.gbrain/audit/ is the source of truth, and counts here may undercount until the 7-day window rolls past the failures. No action needed unless failures keep accumulating (then check DB connectivity/permissions).`,
        details: {
          schema_version: 1,
          kinds,
          rollup_write_failures_7d: totalRollupFailures,
        },
      };
    }

    // #4482: cap-hits stay observable as a capacity signal (backlog bigger
    // than the per-run budget — will drain over future runs), without being
    // conflated with the failure-rate warning above.
    const totalExpectedLimits = kinds.reduce((acc, k) => acc + k.expected_limit_count, 0);
    const capNote = totalExpectedLimits > 0
      ? `; ${totalExpectedLimits} run(s) stopped at expected budget/deadline caps (capacity, not failures)`
      : '';
    return {
      name,
      status: 'ok',
      message: `${kinds.length} kind(s) tracked, all halt rates below 10%${capNote}`,
      details: {
        schema_version: 1,
        kinds,
        rollup_write_failures_7d: totalRollupFailures,
      },
    };
  } catch (err) {
    // Pre-v106 brains lack the extract_rollup_7d table. Don't warn — the
    // bootstrap-coverage / migration framework brings the schema forward
    // and the next run resolves naturally. Stay quiet.
    const msg = (err as Error).message || String(err);
    if (/extract_rollup_7d.*does not exist|no such table/i.test(msg)) {
      return {
        name,
        status: 'ok',
        message: 'extract_rollup_7d not yet present (pre-v0.42 brain or fresh init)',
      };
    }
    return {
      name,
      status: 'warn',
      message: `rollup query failed: ${msg}`,
    };
  }
}

export async function checkSyncFreshness(
  engine: BrainEngine,
  opts?: { nowMs?: number; localOnly?: boolean },
): Promise<Check> {
  try {
    // v0.41.27.0: SELECT widens to carry last_commit + chunker_version so
    // the git short-circuit gate (below) can compare against what
    // `gbrain sync`'s up-to-date predicate at sync.ts:1057+1075 checks.
    // Columns existed pre-v0.41 (writeSyncAnchor / writeChunkerVersion);
    // no schema migration needed.
    type FreshnessSourceRow = {
      id: string;
      name: string;
      local_path: string | null;
      last_sync_at: Date | null;
      last_commit: string | null;
      chunker_version: string | null;
      newest_content_at: Date | null;
    };
    // v0.41.32.0: newest_content_at feeds the REMOTE (non-localOnly) lag so
    // doctorReportRemote never shells out to git on a DB-supplied local_path.
    // #3880: archived sources don't participate in freshness health (v34
    // legacy fallback).
    let sources: FreshnessSourceRow[];
    try {
      sources = await engine.executeRaw<FreshnessSourceRow>(
        `SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
      );
    } catch {
      sources = await engine.executeRaw<FreshnessSourceRow>(
        `SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at FROM sources WHERE local_path IS NOT NULL`,
      );
    }

    if (sources.length === 0) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: 'No federated sources to sync',
        details: { unchanged_count: 0, synced_recently_count: 0, stale_count: 0 },
      };
    }

    const warnHours = _resolveSyncFreshnessHours('GBRAIN_SYNC_FRESHNESS_WARN_HOURS', 24);
    const failHours = _resolveSyncFreshnessHours('GBRAIN_SYNC_FRESHNESS_FAIL_HOURS', 72);
    const warnMs = warnHours * 60 * 60 * 1000;
    const failMs = failHours * 60 * 60 * 1000;

    // `opts.nowMs` is a test-only injection seam for the boundary tests.
    // Without it, the two `Date.now()` calls (one in the test's `agoMs`
    // helper, one here) drift apart by microseconds-to-milliseconds, which
    // pushes "exactly 72h ago" above the strict `>` threshold and flips the
    // status from warn to fail (CI-flaky, see PR #1138 ship). Production
    // callers omit `nowMs` and get live wall-clock semantics.
    const now = opts?.nowMs ?? Date.now();

    // v0.41.27.0: D4 trust boundary. The git short-circuit runs ONLY when
    // the caller explicitly opts in via `localOnly: true`. Default (false)
    // preserves the v0.32.4 trust boundary for `doctorReportRemote` (the
    // HTTP MCP path) — a remote-callable code path must NOT walk
    // DB-supplied `local_path` values with subprocess calls. runDoctor
    // (local CLI) passes true; doctorReportRemote keeps the default.
    const localOnly = opts?.localOnly === true;

    // v0.41.27.0: D7 narrowed predicate. The CHUNKER_VERSION caller-side
    // check mirrors sync.ts:1057's chunker-version gate so doctor agrees
    // with sync on "is there work to do?". `sources.chunker_version` is
    // a TEXT column storing String(CHUNKER_VERSION).
    const currentChunkerVersion = String(CHUNKER_VERSION);

    const issues: string[] = [];
    // v0.41.27.0: D6 three-bucket count math. Every source falls into
    // EXACTLY ONE bucket per iteration. Invariant pinned by unit test:
    //   unchanged_count + synced_recently_count + stale_count === sources.length
    // Stale subsumes warn + fail + never-synced + future-timestamp; we keep
    // hasWarnings/hasFailures for the existing return-status logic.
    let unchanged_count = 0;
    let synced_recently_count = 0;
    let stale_count = 0;
    let hasWarnings = false;
    let hasFailures = false;

    // BUG 4 (v0.42.x): a source with a LIVE, non-expired per-source sync lock is
    // actively syncing RIGHT NOW — it must not read as stale or never-synced.
    // The live lock is the only honest "in progress" signal. Checkpoint banking
    // is NOT usable: a blocked sync banks the good files then writes no anchor
    // (test/sync-resumable-import.serial.test.ts), so banking can't tell
    // in-progress from wedged. A blocked/failed sync's process has exited (no
    // lock row) and a wedged holder stops refreshing (TTL lapses), so either
    // correctly falls through to the stale path and is NEVER masked. Same
    // dynamic import as the stale_locks check; any throw (stub engine in unit
    // tests, pre-lock-table brain) is swallowed to false, so this can only ADD
    // an in-progress verdict, never suppress a real stale one.
    // Notes for sources caught actively syncing (surfaced in the result
    // message so the operator sees "in progress", not just a silent healthy
    // bucket). Empty when nothing is syncing — keeps the steady-state messages
    // byte-for-byte unchanged.
    const inProgress: string[] = [];
    let liveSyncSnap: (sourceId: string) => Promise<{ holder_pid: number; holder_host: string; age_ms: number } | null> =
      async () => null;
    try {
      const { inspectLock, syncLockId } = await import('../../../core/db-lock.ts');
      liveSyncSnap = async (sourceId: string) => {
        try {
          const snap = await inspectLock(engine, syncLockId(sourceId));
          return snap && !snap.ttl_expired
            ? { holder_pid: snap.holder_pid, holder_host: snap.holder_host, age_ms: snap.age_ms }
            : null;
        } catch {
          return null;
        }
      };
    } catch {
      /* db-lock unavailable — skip in-progress detection, staleness stands. */
    }

    // One ceiling for the whole report: hoisted out of the loop so every
    // source is judged against the same number (and the env read + warn-once
    // machinery runs once, not once per source).
    const stalenessCeilingSeconds = resolveStalenessCeilingSeconds();
    for (const source of sources) {
      // Embed source.id in user-visible messages so `gbrain sync --source <id>`
      // matches what the user copy-pastes. Show display name in parens when set.
      const display = source.name && source.name !== source.id
        ? `'${source.id}' (${source.name})`
        : `'${source.id}'`;

      // BUG 4: actively syncing (live lock) → healthy, count as synced_recently
      // and skip the staleness checks. Keeps the 3-bucket invariant intact.
      //
      // ...but ONLY up to the staleness ceiling. `withRefreshingLock` bumps the
      // heartbeat on its own timer regardless of whether the import is making
      // forward progress (`liveSyncStatus`'s docstring is explicit: callers may
      // report "running", NOT "healthy"). So a holder blocked inside a query
      // keeps refreshing forever, and an uncapped in-progress verdict would
      // mask that source from every staleness check indefinitely — the same
      // invisible-failure class this whole pass exists to close, just reached
      // through the lock table instead of the freshness column.
      const liveSnap = await liveSyncSnap(source.id);
      if (liveSnap) {
        const ceilingMs = stalenessCeilingSeconds * 1000;
        if (liveSnap.age_ms <= ceilingMs) {
          inProgress.push(`${display} sync in progress (pid ${liveSnap.holder_pid} on ${liveSnap.holder_host})`);
          synced_recently_count++;
          continue;
        }
        // Sub-hour ceilings are legal (fractional env override), and an alarm
        // that names a zero duration ("held the lock for 0h") reads as broken.
        const heldFor = liveSnap.age_ms >= 3600_000
          ? `${Math.floor(liveSnap.age_ms / 3600_000)}h`
          : `${Math.max(1, Math.floor(liveSnap.age_ms / 60_000))}m`;
        issues.push(
          `Source ${display} has held the sync lock for ${heldFor} ` +
          `(pid ${liveSnap.holder_pid} on ${liveSnap.holder_host}) — heartbeating but not finishing. ` +
          `Run \`gbrain sync --break-lock --source ${source.id}\` after confirming the holder is wedged.`,
        );
        hasFailures = true;
        stale_count++;
        continue;
      }

      if (!source.last_sync_at) {
        issues.push(`Source ${display} has never been synced`);
        hasFailures = true;
        stale_count++;
        continue;
      }

      const lastSync = new Date(source.last_sync_at).getTime();
      const ageMs = now - lastSync;

      if (ageMs < 0) {
        issues.push(
          `Source ${display} has future last_sync_at — clock skew or corrupted timestamp`,
        );
        hasWarnings = true;
        stale_count++;
        continue;
      }

      // v0.41.27.0: git short-circuit (D4 + D7 combined). Only fires when:
      //   1. caller opted in via localOnly=true (trust boundary)
      //   2. HEAD === last_commit (no new commits to sync)
      //   3. working tree has no TRACKED changes — untracked files ignored
      //      (v0.41.32.0: `'ignore-untracked'`. Sync's incremental path keys off
      //      the commit diff and never imports untracked files, so a quiet repo
      //      with stray untracked dirs is genuinely caught up. The pre-v0.41.30
      //      `true` mode counted those as dirty and produced the false-SEVERE
      //      alarm this wave fixes.)
      //   4. chunker_version matches CURRENT (no post-upgrade re-chunk pending —
      //      still ANDed, so a re-chunk need is never masked)
      // All four must hold; otherwise fall through to the time-based check.
      // The chunker version match is computed here (not in the helper)
      // because it depends on engine state, not git state.
      //
      // Clone-unavailable fallback: on stateless deploys (Docker on EB /
      // K8s / Fly — the platforms the cloud recipes produce), a container
      // restart wipes `local_path` and each clone is only re-materialized
      // when that source's next sync job runs. Until then the HEAD probe
      // cannot run at all ('unavailable'), which previously fell through to
      // raw wall-clock age — and since a no-op sync doesn't advance
      // `last_sync_at`, every QUIET source read as stale/FAIL after a
      // restart (score-sinking alert storm; observed live: 16-source brain,
      // 12 clones gone after a config-update restart, doctor 70→30).
      // 'unavailable' + chunker match now reuses the v0.41.32.0 REMOTE lag
      // signal (newest_content_at) below — DB-only, no subprocess, and it
      // still reports staleness whenever content really is newer than the
      // last sync. 'changed' (readable clone with real work) keeps
      // wall-clock exactly as before, and a chunker mismatch is never
      // masked (D7): it disables the fallback too.
      let cloneUnavailable = false;
      if (localOnly) {
        const gitState = probeSourceGitState(
          source.local_path,
          source.last_commit,
          { requireCleanWorkingTree: 'ignore-untracked' },
        );
        const chunkerMatch = source.chunker_version === currentChunkerVersion;
        if (gitState === 'unchanged' && chunkerMatch) {
          unchanged_count++;
          continue;
        }
        cloneUnavailable = gitState === 'unavailable' && chunkerMatch;
      }

      // v0.41.32.0: REMOTE path (doctorReportRemote, !localOnly) computes lag
      // from the stored newest_content_at column — NO git subprocess on a
      // DB-supplied local_path (preserves the v0.41.27.0 trust boundary). A
      // quiet repo whose newest commit predates its last sync reports 0; NULL
      // column → wall-clock fallback. LOCAL fall-through keeps wall-clock when
      // the clone is READABLE: the short-circuit failed on real evidence
      // (HEAD moved / dirty tree), so the source genuinely has work and
      // "hours since last sync" is the right staleness measure. A local clone
      // that is UNAVAILABLE (not yet re-materialized, see above) carries no
      // evidence either way, so it borrows this same DB-only lag. The
      // `ageMs < 0` skew check above still runs on raw wall-clock for both
      // paths (A1).
      let thresholdAgeMs = ageMs;
      if (!localOnly || cloneUnavailable) {
        const contentMs = source.newest_content_at
          ? new Date(source.newest_content_at).getTime()
          : null;
        const lagSec = lagFromContentMs(
          contentMs !== null && Number.isFinite(contentMs) ? contentMs : null,
          lastSync,
          now,
          stalenessCeilingSeconds,
        );
        thresholdAgeMs = lagSec === null ? ageMs : lagSec * 1000;
      }

      const ageHours = Math.floor(thresholdAgeMs / (1000 * 60 * 60));
      const ageDays = Math.floor(ageHours / 24);

      if (thresholdAgeMs > failMs) {
        issues.push(`Source ${display} last synced ${ageDays}d ago — brain search is stale!`);
        hasFailures = true;
        stale_count++;
      } else if (thresholdAgeMs > warnMs) {
        issues.push(`Source ${display} last synced ${ageHours}h ago`);
        hasWarnings = true;
        stale_count++;
      } else {
        synced_recently_count++;
      }
    }

    // D6 invariant: every source incremented exactly one bucket.
    const details = { unchanged_count, synced_recently_count, stale_count };
    // BUG 4: append in-progress context when any source is actively syncing.
    // Empty otherwise, so steady-state messages are byte-for-byte unchanged.
    const inProgressNote = inProgress.length ? `. ${inProgress.join('; ')}` : '';

    if (hasFailures) {
      return {
        name: 'sync_freshness',
        status: 'fail',
        message: `${issues.join('; ')}. Run \`gbrain sync --source <id>\` for each stale source${inProgressNote}`,
        details,
      };
    }
    if (hasWarnings) {
      return {
        name: 'sync_freshness',
        status: 'warn',
        message: `${issues.join('; ')}. Run \`gbrain sync --source <id>\` to refresh${inProgressNote}`,
        details,
      };
    }
    // v0.41.27.0: D2 ok-message reshape. Three branches surface what the
    // git short-circuit actually did so operators understand "unchanged
    // since last sync" vs "synced recently".
    if (unchanged_count === sources.length) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: `All ${sources.length} federated source(s) up to date (no new commits since last sync)${inProgressNote}`,
        details,
      };
    }
    if (unchanged_count > 0) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: `${sources.length} federated source(s): ${synced_recently_count} synced recently, ${unchanged_count} unchanged since last sync${inProgressNote}`,
        details,
      };
    }
    return {
      name: 'sync_freshness',
      status: 'ok',
      message: `All ${sources.length} federated source(s) synced recently${inProgressNote}`,
      details,
    };
  } catch (e) {
    return {
      name: 'sync_freshness',
      status: 'warn',
      message: `Could not check sync freshness: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
