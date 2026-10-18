/**
 * gbrain integrity — scan, report, and repair brain-integrity issues.
 *
 * The user-visible shipping milestone for the Knowledge Runtime delta.
 * Uses PR 1's resolver SDK + PR 2's BrainWriter to target two known pain
 * points quantified in brain/CITATIONS.md:
 *
 *   1. Bare tweet references: "Garry tweeted about X" with no URL
 *      (CITATIONS.md: 1,424 out of 3,115 people pages)
 *   2. Dead or rotted URLs in existing citations
 *
 * Subcommands:
 *   gbrain integrity check              Read-only report to stdout
 *   gbrain integrity auto               Three-bucket repair with confidence
 *   gbrain integrity auto --dry-run     Same as auto, no writes
 *
 * Three-bucket confidence (contract with x_handle_to_tweet resolver):
 *   >= 0.8 → auto-repair through BrainWriter transaction
 *   0.5–0.8 → append to ~/.gbrain/integrity-review.md for human review
 *   < 0.5 → skip, log to ~/.gbrain/integrity.log.jsonl
 *
 * Progress is durable at ~/.gbrain/integrity-progress.jsonl. Re-running
 * after a kill resumes from the last processed slug; already-repaired pages
 * are not revisited.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { loadConfig, toEngineConfig, gbrainPath } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';
import { BrainWriter } from '../core/output/writer.ts';
import {
  getDefaultRegistry,
  type ResolverContext,
  type ResolverResult,
} from '../core/resolvers/index.ts';
import { registerBuiltinResolvers } from './resolvers.ts';
import { tweetCitation } from '../core/output/scaffold.ts';
import { INTEGRITY_SUBCOMMANDS, ROUTERS, subcommandHelpRequested } from '../cli/subcommands.ts';
import { OperationError } from '../core/ops/contract.ts';
import { isSegmentedPage } from '../core/page-body/page-shape.ts';
import type { BodyStorage } from '../core/page-body/types.ts';
import { bodyLines } from '../core/page-body/segment-lines.ts';
import { detachedValue } from '../core/page-body/segment-blocks.ts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Lazy: GBRAIN_HOME may be set after module load.
const getReviewFile = () => gbrainPath('integrity-review.md');
const getLogFile = () => gbrainPath('integrity.log.jsonl');
const getProgressFile = () => gbrainPath('integrity-progress.jsonl');

// ---------------------------------------------------------------------------
// Bare-tweet detection
// ---------------------------------------------------------------------------

/**
 * Phrases that plausibly reference a tweet without actually linking to one.
 * Case-insensitive. We explicitly REQUIRE an X handle on the page (via
 * frontmatter.x_handle or inline @handle) before repair — otherwise there's
 * no seed to search from and confidence would be zero.
 */
const BARE_TWEET_PHRASES = [
  /\btweeted about\b/i,
  /\bin (?:a |the )?(?:recent |viral )?tweet\b/i,
  /\bon (?:a |the )?(?:recent |viral )?tweet\b/i,
  /\bwrote (?:a |the )?(?:tweet|post)\b/i,
  /\bposted on X\b/i,
  /\bvia X\b(?!\s*\/)/i, // "via X" but not "via X/handle" (already cited)
  /\bhis (?:recent |)tweet\b/i,
  /\bher (?:recent |)tweet\b/i,
  /\btheir (?:recent |)tweet\b/i,
];

const URL_NEARBY_RE = /https?:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+/;

export interface BareTweetHit {
  slug: string;
  line: number;
  rawLine: string;
  phrase: string;
}

interface FenceState { inside: boolean; marker: string; line: number }
const fenceState = (): FenceState => ({ inside: false, marker: '', line: 0 });

/** Calls `visit` with each line outside a ``` or ~~~ fence and its 1-based number; `state` carries across calls, so lines may arrive in runs. */
function unfencedLines(lines: readonly string[], state: FenceState, visit: (line: string, n: number) => void): void {
  for (const line of lines) {
    state.line++;
    if (state.inside) {
      if (line.startsWith(state.marker)) state.inside = false;
      continue;
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      state.inside = true;
      state.marker = line.startsWith('```') ? '```' : '~~~';
      continue;
    }
    visit(line, state.line);
  }
}

function bareTweetHit(line: string, n: number, slug: string): BareTweetHit | null {
  // If the line already contains a tweet URL, it's cited — skip
  if (URL_NEARBY_RE.test(line)) return null;
  // If the line carries an explicit source citation (e.g.
  // "[Source: X, @handle, 2026-05-28]"), it's already attributed — skip.
  // Catches instructional/example lines in recipe docs that demonstrate
  // the CORRECT citation format. (v0.42.x)
  if (/\[\s*source:/i.test(line)) return null;
  // Strip inline-code spans (`...`) before matching: phrases shown as
  // inline-code templates in docs are examples, not bare claims. The
  // fenced-code skip above only covers ``` blocks, not inline backticks.
  const lineForMatch = line.replace(/`[^`]*`/g, '');
  for (const re of BARE_TWEET_PHRASES) {
    const m = lineForMatch.match(re);
    if (m) return { slug, line: n, rawLine: line.trim(), phrase: m[0] }; // one finding per line is enough
  }
  return null;
}

export function findBareTweetHits(compiledTruth: string, slug: string): BareTweetHit[] {
  const hits: BareTweetHit[] = [];
  unfencedLines(compiledTruth.split('\n'), fenceState(), (line, n) => {
    const hit = bareTweetHit(line, n, slug);
    if (hit) hits.push(hit);
  });
  return hits;
}

// ---------------------------------------------------------------------------
// Dead-link detection
// ---------------------------------------------------------------------------

const MD_LINK_EXTERNAL_RE = /\[[^\]]+\]\((https?:\/\/[^)]+)\)/g;

export interface ExternalLinkHit {
  slug: string;
  line: number;
  url: string;
}

function externalLinkHits(line: string, n: number, slug: string, hits: ExternalLinkHit[]): void {
  MD_LINK_EXTERNAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK_EXTERNAL_RE.exec(line)) !== null) {
    hits.push({ slug, line: n, url: m[1] });
  }
}

export function findExternalLinks(compiledTruth: string, slug: string): ExternalLinkHit[] {
  const hits: ExternalLinkHit[] = [];
  unfencedLines(compiledTruth.split('\n'), fenceState(), (line, n) => externalLinkHits(line, n, slug, hits));
  return hits;
}

/** A page the scan could not read; the run goes on without it. */
export interface IntegritySkippedPage { slug: string; source_id: string; reason: string; message: string }

/**
 * Bare-tweet and external-link hits of a page's compiled truth. A segmented
 * page (Wave B) is read block by block (`bodyLines` over its truth region),
 * with fence state and line numbers carried across blocks, so it gets the
 * hits the same text held as one string gets.
 */
async function integrityHitsOf(engine: BrainEngine, page: { id: number; slug: string; body_storage?: BodyStorage | null; compiled_truth?: string | null },
  sourceId: string): Promise<{ bare: BareTweetHit[]; external: ExternalLinkHit[] }> {
  if (!isSegmentedPage(page)) {
    const text = page.compiled_truth ?? '';
    return { bare: findBareTweetHits(text, page.slug), external: findExternalLinks(text, page.slug) };
  }
  const bare: BareTweetHit[] = [];
  const external: ExternalLinkHit[] = [];
  const bareState = fenceState(), externalState = fenceState();
  for await (const lines of bodyLines(engine, { id: Number(page.id), slug: page.slug, source_id: sourceId }, { regions: ['truth'] })) {
    unfencedLines(lines, bareState, (line, n) => {
      const hit = bareTweetHit(line, n, page.slug);
      if (hit) bare.push(detachedValue(hit));
    });
    unfencedLines(lines, externalState, (line, n) => {
      const found: ExternalLinkHit[] = [];
      externalLinkHits(line, n, page.slug, found);
      external.push(...found.map(detachedValue));
    });
  }
  return { bare, external };
}

/** A per-page refusal (a segmented page whose run is too long to read as one block) becomes a skipped page; anything else propagates. */
function skippedPage(error: unknown, page: { slug: string; source_id: string }): IntegritySkippedPage {
  if (error instanceof OperationError && error.code === 'page_body_segmented') return { slug: page.slug, source_id: page.source_id, reason: error.code, message: error.message };
  throw error;
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

interface ProgressEntry {
  slug: string;
  /**
   * Source the row belongs to. Progress used to be keyed by slug alone, so a
   * resume SKIPPED same-slug pages in every other source (the scan iterates
   * (slug, source_id) pairs). Legacy entries without source_id are treated as
   * default-source only.
   */
  source_id?: string;
  status: 'repaired' | 'reviewed' | 'skipped' | 'error';
  timestamp: string;
}

/** Composite progress key — (source, slug), tab-separated (tabs can't appear in either). */
function progressKey(sourceId: string | undefined, slug: string): string {
  return `${sourceId ?? 'default'}\t${slug}`;
}

function loadProgress(): Set<string> {
  if (!existsSync(getProgressFile())) return new Set();
  const seen = new Set<string>();
  const content = readFileSync(getProgressFile(), 'utf-8');
  let legacy = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ProgressEntry;
      if (entry.source_id == null) legacy++;
      seen.add(progressKey(entry.source_id, entry.slug));
    } catch {
      /* skip malformed lines */
    }
  }
  if (legacy > 0) {
    // Pre-(source_id, slug) ledger entries key as default-source only, so a
    // resume re-scans non-default-source pages they may have covered. Say so
    // once — a silent partial re-scan reads as "resume is broken".
    console.error(
      `integrity: ${legacy} resume-ledger entr${legacy === 1 ? 'y' : 'ies'} predate source tracking; ` +
      `matching them to the default source only (non-default-source pages re-scan — idempotent, just slower).`,
    );
  }
  return seen;
}

function appendProgress(entry: ProgressEntry): void {
  ensureDir(getProgressFile());
  appendFileSync(getProgressFile(), JSON.stringify(entry) + '\n', 'utf-8');
}

function clearProgress(): void {
  if (existsSync(getProgressFile())) writeFileSync(getProgressFile(), '', 'utf-8');
}

function ensureDir(path: string): void {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export { INTEGRITY_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';

export async function runIntegrity(args: string[]): Promise<void> {
  const sub = args[0] as (typeof INTEGRITY_SUBCOMMANDS)[number] | undefined;

  if (!sub || subcommandHelpRequested(args, ROUTERS.integrity)) {
    printUsage();
    return;
  }

  if (sub === 'check') {
    await cmdCheck(args.slice(1));
    return;
  }
  if (sub === 'auto') {
    await cmdAuto(args.slice(1));
    return;
  }
  if (sub === 'review') {
    cmdReview();
    return;
  }
  if (sub === 'reset-progress') {
    clearProgress();
    console.log('Cleared progress log:', getProgressFile());
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  printUsage();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// check — read-only scan
// ---------------------------------------------------------------------------

async function cmdCheck(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const limit = extractIntFlag(args, '--limit') ?? Infinity;
  const typeFilter = extractFlag(args, '--type');

  const engine = await connect();
  try {
    const res = await scanIntegrity(engine, { limit, typeFilter });

    if (jsonMode) {
      console.log(JSON.stringify({
        pagesScanned: res.pagesScanned,
        bareTweetHits: res.bareHits,
        externalLinkCount: res.externalHits.length,
        ...(res.skipped.length ? { skipped: res.skipped } : {}),
      }, null, 2));
      return;
    }

    console.log(`Scanned ${res.pagesScanned} pages.`);
    console.log(`Bare-tweet phrases: ${res.bareHits.length}`);
    console.log(`External links (for optional dead-link check): ${res.externalHits.length}`);
    if (res.skipped.length > 0) {
      console.log(`Pages not scanned: ${res.skipped.length}`);
      for (const skipped of res.skipped) console.log(`  ${skipped.source_id}:${skipped.slug} (${skipped.reason}): ${skipped.message}`);
    }
    if (res.topPages.length > 0) {
      console.log('\nTop 10 pages with bare-tweet references:');
      for (const { slug, count } of res.topPages) {
        console.log(`  ${slug}: ${count} hit${count === 1 ? '' : 's'}`);
      }
    }
  } finally {
    await engine.disconnect();
  }
}

// ---------------------------------------------------------------------------
// scanIntegrity — pure library function, callable from doctor
// ---------------------------------------------------------------------------

export interface IntegrityScanOptions {
  /** Max pages to scan. Default Infinity. Doctor passes a sample limit (~500). */
  limit?: number;
  /** Slug prefix filter (e.g. "people") — matches slugs starting with `${typeFilter}/`. */
  typeFilter?: string;
  /**
   * When true (default), batch-load pages via a single SQL query instead of
   * sequential getPage() calls. Falls back to sequential on error (e.g. PGLite).
   * Eliminates 500 round-trips through PgBouncer that caused doctor timeouts.
   */
  batchLoad?: boolean;
}

export interface IntegrityScanResult {
  pagesScanned: number;
  bareHits: BareTweetHit[];
  externalHits: ExternalLinkHit[];
  /** Top 10 pages sorted by bare-tweet hit count, descending. */
  topPages: Array<{ slug: string; count: number }>;
  /** Pages the scan could not read (a per-page refusal); counted in pagesScanned, no hits. */
  skipped: IntegritySkippedPage[];
}

/**
 * Read-only integrity scan over the engine's pages. No network, no writes,
 * no resolver calls. Called by `gbrain integrity check` for the full report
 * and by `gbrain doctor` (non-fast) for a sampled health signal.
 *
 * Caller owns the engine lifecycle.
 */
export async function scanIntegrity(
  engine: BrainEngine,
  opts: IntegrityScanOptions = {},
): Promise<IntegrityScanResult> {
  const { limit = Infinity, typeFilter, batchLoad = true } = opts;

  // Fast path: single SQL query instead of N sequential getPage() calls.
  // Eliminates ~500 round-trips through PgBouncer that caused doctor to
  // timeout on transaction-mode pooling. Postgres-only: PGLite runs in
  // process, where the sequential walk costs no network round-trips.
  if (batchLoad && limit !== Infinity && engine.kind === 'postgres') {
    try {
      return await scanIntegrityBatch(engine, limit, typeFilter);
    } catch (err) {
      // GBRAIN_DEBUG=1 surfaces real Postgres errors (deadlock, connection
      // drop, SQL bug) that would otherwise vanish into the sequential
      // fallback. Quiet by default since the fallback is harmless.
      if (process.env.GBRAIN_DEBUG) {
        console.error(
          '[integrity] batch path failed, falling back to sequential:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // v0.32.8: listAllPageRefs replaces getAllSlugs+getPage N+1 pattern that
  // silently defaulted to source_id='default' for non-default-source pages.
  // Now we enumerate (slug, source_id) pairs and thread sourceId to getPage.
  const allRefs = (await engine.listAllPageRefs()).sort((a, b) =>
    a.slug.localeCompare(b.slug) || a.source_id.localeCompare(b.source_id)
  );

  const bareHits: BareTweetHit[] = [];
  const externalHits: ExternalLinkHit[] = [];
  let pagesScanned = 0;

  const skipped: IntegritySkippedPage[] = [];

  for (const { slug, source_id } of allRefs) {
    if (typeFilter && !slug.startsWith(`${typeFilter}/`)) continue;
    if (pagesScanned >= limit) break;
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    // Skip grandfathered pages (opted out of brain-integrity enforcement)
    if ((page.frontmatter as Record<string, unknown> | undefined)?.validate === false) continue;
    pagesScanned++;
    try {
      const hits = await integrityHitsOf(engine, page, source_id);
      bareHits.push(...hits.bare);
      externalHits.push(...hits.external);
    } catch (error) {
      skipped.push(skippedPage(error, { slug, source_id }));
    }
  }

  const byPage = new Map<string, number>();
  for (const h of bareHits) byPage.set(h.slug, (byPage.get(h.slug) ?? 0) + 1);
  const topPages = [...byPage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([slug, count]) => ({ slug, count }));

  return { pagesScanned, bareHits, externalHits, topPages, skipped };
}

/**
 * Batch-load integrity scan: fetches all candidate pages in a single SQL
 * query, then scans in-memory. Reduces PgBouncer round-trips from ~500 to 1.
 * A segmented page's body is read block by block from the same engine.
 */
async function scanIntegrityBatch(
  engine: BrainEngine,
  limit: number,
  typeFilter?: string,
): Promise<IntegrityScanResult> {
  const params: unknown[] = [limit];
  const typeCondition = typeFilter ? `AND slug LIKE $${params.push(`${typeFilter}/%`)}` : '';
  // Boolean validate is the documented contract; stringly-typed 'false' (quoted
  // YAML) diverges from the sequential path's strict === false check. Intentional
  // — gbrain lint should reject stringly-typed validate at write time.
  const validateCondition = `AND (frontmatter->>'validate' IS NULL OR frontmatter->>'validate' != 'false')`;

  // v0.32.8: scan ONE row per (source_id, slug) pair, not one per slug.
  // Pre-fix used DISTINCT ON (slug) which collapsed multi-source rows into
  // one — that was the bug class. Now batch parity matches the sequential
  // listAllPageRefs() walk: integrity violations in non-default-source pages
  // get reported instead of silently shadowed by their default-source twin.
  // deleted_at IS NULL: the sequential walk (listAllPageRefs + getPage) never
  // sees a soft-deleted page, so the batch must not either — otherwise the
  // sampled doctor check reports hits from tombstones and, once they
  // outnumber `limit`, stops reaching live pages.
  const rows = await engine.executeRaw<Record<string, unknown>>(`
    SELECT id, source_id, slug, compiled_truth, body_storage
    FROM pages
    WHERE deleted_at IS NULL ${typeCondition} ${validateCondition}
    ORDER BY source_id, slug
    LIMIT $1
  `, params);

  const bareHits: BareTweetHit[] = [];
  const externalHits: ExternalLinkHit[] = [];

  const skipped: IntegritySkippedPage[] = [];

  for (const row of rows) {
    const page = { id: Number(row.id), source_id: row.source_id as string, slug: row.slug as string,
      compiled_truth: row.compiled_truth as string | null, body_storage: row.body_storage as BodyStorage };
    try {
      const hits = await integrityHitsOf(engine, page, page.source_id);
      bareHits.push(...hits.bare);
      externalHits.push(...hits.external);
    } catch (error) {
      skipped.push(skippedPage(error, page));
    }
  }

  const byPage = new Map<string, number>();
  for (const h of bareHits) byPage.set(h.slug, (byPage.get(h.slug) ?? 0) + 1);
  const topPages = [...byPage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([slug, count]) => ({ slug, count }));

  return { pagesScanned: rows.length, bareHits, externalHits, topPages, skipped };
}

// ---------------------------------------------------------------------------
// auto — three-bucket repair
// ---------------------------------------------------------------------------

async function cmdAuto(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const confidenceThreshold = extractFloatFlag(args, '--confidence') ?? 0.8;
  const reviewLower = extractFloatFlag(args, '--review-lower') ?? 0.5;
  const limit = extractIntFlag(args, '--limit') ?? Infinity;
  const skipTweet = args.includes('--skip-bare-tweet');
  const skipUrls = args.includes('--skip-urls');
  const resume = !args.includes('--fresh');

  if (confidenceThreshold < reviewLower) {
    console.error('--confidence must be >= --review-lower');
    process.exit(1);
  }

  ensureDir(gbrainPath());

  const engine = await connect();
  const registry = getDefaultRegistry();
  registerBuiltinResolvers(registry);
  // One writer PER SOURCE: BrainWriter scopes every read/write (and
  // addTimelineEntry) to its sourceId — a single default-scoped writer used
  // for every source's pages was the unscoped-check/scoped-write bug class.
  const writersBySource = new Map<string, BrainWriter>();
  const writerFor = (sourceId: string): BrainWriter => {
    let w = writersBySource.get(sourceId);
    if (!w) {
      w = new BrainWriter(engine, { strictMode: 'off', sourceId });
      writersBySource.set(sourceId, w);
    }
    return w;
  };

  const ctx: ResolverContext = {
    engine,
    config: {},
    logger: {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
      error: (msg) => console.error(msg),
    },
    requestId: `integrity-auto-${Date.now()}`,
    remote: false,
  };

  const seen = resume ? loadProgress() : (clearProgress(), new Set<string>());

  let bucketAuto = 0;
  let bucketReview = 0;
  let bucketSkip = 0;
  let bucketErr = 0;
  let bucketDeadLink = 0;
  let pagesProcessed = 0;
  const skippedPages: IntegritySkippedPage[] = [];

  const { createProgress } = await import('../core/progress.ts');
  const { getCliOptions, cliOptsToProgressOptions } = await import('../core/cli-options.ts');
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  try {
    // v0.32.8: listAllPageRefs enumerates (slug, source_id) pairs so we
    // can thread sourceId to getPage. Pre-fix this defaulted to 'default'
    // and silently skipped non-default-source pages.
    const allRefs = (await engine.listAllPageRefs()).sort((a, b) =>
      a.slug.localeCompare(b.slug) || a.source_id.localeCompare(b.source_id)
    );
    const toScan = allRefs.filter(r => !seen.has(progressKey(r.source_id, r.slug)));
    progress.start('integrity.auto', toScan.length);
    for (const { slug, source_id } of allRefs) {
      if (pagesProcessed >= limit) break;
      if (seen.has(progressKey(source_id, slug))) continue;
      const writer = writerFor(source_id);

      const page = await engine.getPage(slug, { sourceId: source_id });
      if (!page) continue;

      pagesProcessed++;
      progress.tick(1, slug);

      let found: Awaited<ReturnType<typeof integrityHitsOf>>;
      try {
        found = await integrityHitsOf(engine, page, source_id);
      } catch (error) {
        skippedPages.push(skippedPage(error, { slug, source_id }));
        continue;
      }

      // Bare-tweet handling
      if (!skipTweet) {
        const hits = found.bare;
        const handle = extractXHandleFromFrontmatter(page.frontmatter);
        if (hits.length > 0 && handle) {
          for (const hit of hits) {
            try {
              const result = await registry.resolve<{ handle: string; keywords: string }, {
                url?: string; tweet_id?: string; text?: string; created_at?: string;
                candidates: Array<{ tweet_id: string; text: string; created_at: string; score: number; url: string }>;
              }>(
                'x_handle_to_tweet',
                { handle, keywords: hit.rawLine.slice(0, 150) },
                ctx,
              );
              if (result.confidence >= confidenceThreshold && result.value.url && result.value.tweet_id && result.value.created_at) {
                await repairBareTweet({
                  writer, slug, hit, result, handle, dryRun,
                });
                bucketAuto++;
                // Dry-run must NOT persist 'repaired' — the follow-on real
                // run needs to revisit these slugs and actually write.
                if (!dryRun) {
                  appendProgress({ slug, source_id, status: 'repaired', timestamp: new Date().toISOString() });
                }
              } else if (result.confidence >= reviewLower) {
                appendReview({ slug, hit, result, handle });
                bucketReview++;
                if (!dryRun) {
                  appendProgress({ slug, source_id, status: 'reviewed', timestamp: new Date().toISOString() });
                }
              } else {
                logSkip({ slug, hit, reason: `confidence ${result.confidence.toFixed(2)} below threshold ${reviewLower}` });
                bucketSkip++;
                if (!dryRun) {
                  appendProgress({ slug, source_id, status: 'skipped', timestamp: new Date().toISOString() });
                }
              }
            } catch (e) {
              bucketErr++;
              logSkip({ slug, hit, reason: `resolver error: ${e instanceof Error ? e.message : String(e)}` });
              if (!dryRun) {
                appendProgress({ slug, source_id, status: 'error', timestamp: new Date().toISOString() });
              }
            }
          }
        } else if (hits.length > 0 && !handle) {
          // Can't repair without a handle; log once per page
          for (const hit of hits) {
            logSkip({ slug, hit, reason: 'no x_handle in frontmatter to search from' });
          }
          bucketSkip += hits.length;
          if (!dryRun) {
            appendProgress({ slug, source_id, status: 'skipped', timestamp: new Date().toISOString() });
          }
        }
      }

      // Dead-link handling (no auto-repair; just surface)
      if (!skipUrls) {
        const externalHits = found.external;
        // Limit to first few per page to keep the default run fast; --check
        // gives the full picture.
        for (const hit of externalHits.slice(0, 3)) {
          try {
            const result = await registry.resolve<
              { url: string },
              { reachable: boolean; status?: number; reason?: string }
            >('url_reachable', { url: hit.url }, ctx);
            if (!result.value.reachable) {
              logSkip({
                slug,
                hit: { slug, line: hit.line, rawLine: hit.url, phrase: 'dead-link' },
                reason: `dead link: ${result.value.reason ?? 'unknown'}`,
              });
              // Dead links have no confidence score and are never written to
              // the review file (appendReview() is only called from the
              // bare-tweet path above) — they land in the skip log via
              // logSkip() a few lines up. Count them separately so the
              // printed "Review queue" total only ever reflects what's
              // actually in ~/.gbrain/integrity-review.md.
              bucketDeadLink++;
            }
          } catch {
            /* transient; don't fail the run */
          }
        }
      }
    }

    progress.finish();

    // Summary
    console.log('');
    console.log(`=== integrity auto summary${dryRun ? ' (DRY RUN)' : ''} ===`);
    console.log(`Pages processed: ${pagesProcessed}`);
    console.log(`Auto-repaired (≥${confidenceThreshold}): ${bucketAuto}`);
    console.log(`Review queue (≥${reviewLower} <${confidenceThreshold}): ${bucketReview}`);
    console.log(`Skipped (<${reviewLower}): ${bucketSkip}`);
    if (bucketErr > 0) console.log(`Resolver errors: ${bucketErr}`);
    if (bucketDeadLink > 0) console.log(`Dead links surfaced (see skipped log): ${bucketDeadLink}`);
    if (skippedPages.length > 0) {
      console.log(`Pages not scanned: ${skippedPages.length}`);
      for (const skipped of skippedPages) console.log(`  ${skipped.source_id}:${skipped.slug} (${skipped.reason}): ${skipped.message}`);
    }
    console.log(`\nReview queue: ${getReviewFile()}`);
    console.log(`Skipped log:  ${getLogFile()}`);
    console.log(`Progress:     ${getProgressFile()}`);
  } finally {
    await engine.disconnect();
  }
}

// ---------------------------------------------------------------------------
// review — print the review queue location + count
// ---------------------------------------------------------------------------

function cmdReview(): void {
  if (!existsSync(getReviewFile())) {
    console.log(`No review queue yet. Run: gbrain integrity auto --confidence 0.8`);
    return;
  }
  const content = readFileSync(getReviewFile(), 'utf-8');
  const count = (content.match(/^## /gm) ?? []).length;
  console.log(`Review queue: ${getReviewFile()}`);
  console.log(`Entries: ${count}`);
  console.log(`\nOpen with: $EDITOR ${getReviewFile()}`);
}

// ---------------------------------------------------------------------------
// Repair primitives
// ---------------------------------------------------------------------------

interface RepairArgs {
  writer: BrainWriter;
  slug: string;
  hit: BareTweetHit;
  result: ResolverResult<{ url?: string; tweet_id?: string; created_at?: string }>;
  handle: string;
  dryRun: boolean;
}

async function repairBareTweet(args: RepairArgs): Promise<void> {
  const { writer, slug, hit, result, handle, dryRun } = args;
  const tweetId = result.value.tweet_id!;
  const createdAt = result.value.created_at!;
  const dateISO = createdAt.slice(0, 10);

  // Build the citation using Scaffolder (deterministic URL from API).
  const cite = tweetCitation({ handle, tweetId, dateISO });

  if (dryRun) {
    console.log(`[dry-run] ${slug}:${hit.line} would append ${cite}`);
    return;
  }

  // Read current, append citation to the flagged line, write back through
  // BrainWriter so the transaction is atomic and the writer's grandfather
  // opt-out can be cleared if validators pass post-repair.
  const current = await (args.writer as unknown as { engine: BrainEngine })['engine']?.getPage?.(slug);
  // fall back: use a direct engine handle via writer's internal ref is ugly;
  // instead, use writer.transaction and read/write inside
  await writer.transaction(async (tx) => {
    // We can't read inside a transaction without engine access; set-wise,
    // we fetch via the outer engine reference captured on the writer.
    // Simpler: perform a read outside via setCompiledTruth which already
    // handles "page not found" + merges with existing content server-side.
    // However BrainWriter.setCompiledTruth requires the new body — we need
    // to read first. Do the read here via the engine on the tx's context
    // (the tx uses the same engine instance).
    //
    // Workaround: use setFrontmatterField + appendTimeline pattern. We
    // leave the bare phrase alone and append a timeline entry with the
    // citation. That's honest — we're adding evidence, not rewriting
    // prose. Pages with `validate: false` in frontmatter stay flagged
    // until a more thorough repair pass removes the bare phrase.
    await tx.appendTimeline(slug, {
      date: dateISO,
      source: 'gbrain integrity --auto',
      summary: `Bare-tweet reference repaired (line ${hit.line}): "${truncate(hit.rawLine, 80)}"`,
      detail: cite,
    });
  }, {
    config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} },
    requestId: 'integrity-repair', remote: false,
  });

  console.log(`repaired ${slug}:${hit.line} → ${cite}`);
  // Silence unused var from earlier refactor
  void current;
}

// ---------------------------------------------------------------------------
// Review queue + skip log
// ---------------------------------------------------------------------------

interface ReviewArgs {
  slug: string;
  hit: BareTweetHit;
  result: ResolverResult<{
    url?: string;
    candidates: Array<{ tweet_id: string; text: string; created_at: string; score: number; url: string }>;
  }>;
  handle: string;
}

function appendReview(args: ReviewArgs): void {
  ensureDir(getReviewFile());
  const { slug, hit, result, handle } = args;
  const block = [
    `## ${slug}:${hit.line}  (confidence ${result.confidence.toFixed(2)})`,
    ``,
    `Handle: @${handle}`,
    `Phrase: \`${hit.rawLine}\``,
    ``,
    `Candidates:`,
    ...result.value.candidates.slice(0, 5).map((c, i) => `  ${i + 1}. ${c.url} — "${truncate(c.text, 80)}" (score ${c.score.toFixed(2)})`),
    ``,
    '---',
    '',
  ].join('\n');
  appendFileSync(getReviewFile(), block, 'utf-8');
}

interface SkipArgs { slug: string; hit: BareTweetHit; reason: string }
function logSkip(args: SkipArgs): void {
  ensureDir(getLogFile());
  const entry = {
    timestamp: new Date().toISOString(),
    slug: args.slug,
    line: args.hit.line,
    phrase: args.hit.phrase,
    raw: args.hit.rawLine.slice(0, 200),
    reason: args.reason,
  };
  appendFileSync(getLogFile(), JSON.stringify(entry) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function extractXHandleFromFrontmatter(fm: Record<string, unknown> | undefined): string | null {
  if (!fm) return null;
  const keys = ['x_handle', 'twitter', 'twitter_handle', 'x'];
  for (const k of keys) {
    const v = fm[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.trim().replace(/^@/, '');
    }
  }
  return null;
}

async function connect(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));
  return engine;
}

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.findIndex(a => a === flag || a.startsWith(`${flag}=`));
  if (idx === -1) return undefined;
  const arg = args[idx];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  return args[idx + 1];
}

function extractIntFlag(args: string[], flag: string): number | undefined {
  const v = extractFlag(args, flag);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function extractFloatFlag(args: string[], flag: string): number | undefined {
  const v = extractFlag(args, flag);
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

export function printUsage(): void {
  console.log(`Usage: gbrain integrity <subcommand> [options]

Subcommands:
  check                         Read-only report (pages scanned, bare tweets found)
  check --type people           Scope to people/ pages
  check --limit N --json        JSON output for N pages

  auto [options]                Three-bucket repair loop
    --confidence 0.8            Auto-repair threshold (default 0.8)
    --review-lower 0.5          Review-queue lower bound (default 0.5)
    --dry-run                   Report what would change, no writes
    --limit N                   Process at most N pages (resumable)
    --fresh                     Ignore progress file; start over
    --skip-bare-tweet           Skip bare-tweet detection
    --skip-urls                 Skip dead-link detection

  review                        Print review-queue path + entry count
  reset-progress                Clear ~/.gbrain/integrity-progress.jsonl

Paths:
  Review queue: ~/.gbrain/integrity-review.md
  Skip log:     ~/.gbrain/integrity.log.jsonl
  Progress:     ~/.gbrain/integrity-progress.jsonl
`);
}
