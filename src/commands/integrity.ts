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
 *   gbrain integrity --dry-run          Same as auto, no writes
 *
 * Three-bucket confidence (contract with x_handle_to_tweet resolver):
 *   >= 0.8 → auto-repair through BrainWriter transaction
 *   0.5–0.8 → append to ~/.gbrain/integrity-review.md for human review
 *   < 0.5 → skip, log to ~/.gbrain/integrity.log.jsonl
 *
 * Progress is durable at ~/.gbrain/integrity-progress.jsonl. Re-running
 * after a kill resumes from the last checkpoint within each slug; completed
 * pages are not revisited.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

import { loadConfig, toEngineConfig } from '../core/config.ts';
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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DEFAULT_GBRAIN_DIR = join(homedir(), '.gbrain');

function getGbrainDir(): string {
  const override = process.env.GBRAIN_INTEGRITY_DIR?.trim();
  return override && override.length > 0 ? override : DEFAULT_GBRAIN_DIR;
}

function getReviewFile(): string {
  return join(getGbrainDir(), 'integrity-review.md');
}

function getLogFile(): string {
  return join(getGbrainDir(), 'integrity.log.jsonl');
}

function getProgressFile(): string {
  return join(getGbrainDir(), 'integrity-progress.jsonl');
}

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

export function findBareTweetHits(compiledTruth: string, slug: string): BareTweetHit[] {
  const hits: BareTweetHit[] = [];
  const lines = compiledTruth.split('\n');
  let insideFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (insideFence) {
      if (line.startsWith(fenceMarker)) insideFence = false;
      continue;
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      insideFence = true;
      fenceMarker = line.startsWith('```') ? '```' : '~~~';
      continue;
    }
    // If the line already contains a tweet URL, it's cited — skip
    if (URL_NEARBY_RE.test(line)) continue;
    for (const re of BARE_TWEET_PHRASES) {
      const m = line.match(re);
      if (m) {
        hits.push({ slug, line: i + 1, rawLine: line.trim(), phrase: m[0] });
        break; // one finding per line is enough
      }
    }
  }
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

export function findExternalLinks(compiledTruth: string, slug: string): ExternalLinkHit[] {
  const hits: ExternalLinkHit[] = [];
  const lines = compiledTruth.split('\n');
  let insideFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (insideFence) {
      if (line.startsWith(fenceMarker)) insideFence = false;
      continue;
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      insideFence = true;
      fenceMarker = line.startsWith('```') ? '```' : '~~~';
      continue;
    }
    MD_LINK_EXTERNAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_LINK_EXTERNAL_RE.exec(line)) !== null) {
      hits.push({ slug, line: i + 1, url: m[1] });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

interface ProgressEntry {
  slug: string;
  status: 'repaired' | 'reviewed' | 'skipped' | 'error' | 'done';
  timestamp: string;
  kind?: 'bare_tweet_hit' | 'dead_link_scan' | 'complete';
  hitIndex?: number;
}

interface SlugProgressState {
  complete: boolean;
  bareTweetHitIndex: number;
  deadLinksScanned: boolean;
}

function loadProgressState(): Map<string, SlugProgressState> {
  const progressFile = getProgressFile();
  if (!existsSync(progressFile)) return new Map<string, SlugProgressState>();
  const progress = new Map<string, SlugProgressState>();
  const content = readFileSync(progressFile, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ProgressEntry;
      if (typeof entry.slug !== 'string' || entry.slug.length === 0) continue;
      const state = progress.get(entry.slug) ?? {
        complete: false,
        bareTweetHitIndex: -1,
        deadLinksScanned: false,
      };
      if (entry.kind === 'bare_tweet_hit' && Number.isInteger(entry.hitIndex)) {
        state.bareTweetHitIndex = Math.max(state.bareTweetHitIndex, entry.hitIndex!);
      } else if (entry.kind === 'dead_link_scan') {
        state.deadLinksScanned = true;
      } else if (entry.kind === 'complete') {
        state.complete = true;
      } else {
        // Legacy format (pre-checkpoint kinds): any status entry means slug was complete.
        state.complete = true;
      }
      progress.set(entry.slug, state);
    } catch {
      /* skip malformed lines */
    }
  }
  return progress;
}

function appendProgress(entry: ProgressEntry): void {
  const progressFile = getProgressFile();
  ensureDir(progressFile);
  appendFileSync(progressFile, JSON.stringify(entry) + '\n', 'utf-8');
}

function clearProgress(): void {
  const progressFile = getProgressFile();
  if (existsSync(progressFile)) writeFileSync(progressFile, '', 'utf-8');
}

function ensureDir(path: string): void {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runIntegrity(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
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
  printHelp();
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
      }, null, 2));
      return;
    }

    console.log(`Scanned ${res.pagesScanned} pages.`);
    console.log(`Bare-tweet phrases: ${res.bareHits.length}`);
    console.log(`External links (for optional dead-link check): ${res.externalHits.length}`);
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
}

export interface IntegrityScanResult {
  pagesScanned: number;
  bareHits: BareTweetHit[];
  externalHits: ExternalLinkHit[];
  /** Top 10 pages sorted by bare-tweet hit count, descending. */
  topPages: Array<{ slug: string; count: number }>;
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
  const { limit = Infinity, typeFilter } = opts;
  const allSlugs = [...(await engine.getAllSlugs())].sort();

  const bareHits: BareTweetHit[] = [];
  const externalHits: ExternalLinkHit[] = [];
  let pagesScanned = 0;

  for (const slug of allSlugs) {
    if (typeFilter && !slug.startsWith(`${typeFilter}/`)) continue;
    if (pagesScanned >= limit) break;
    const page = await engine.getPage(slug);
    if (!page) continue;
    // Skip grandfathered pages (opted out of brain-integrity enforcement)
    if ((page.frontmatter as Record<string, unknown> | undefined)?.validate === false) continue;
    pagesScanned++;
    bareHits.push(...findBareTweetHits(page.compiled_truth, slug));
    externalHits.push(...findExternalLinks(page.compiled_truth, slug));
  }

  const byPage = new Map<string, number>();
  for (const h of bareHits) byPage.set(h.slug, (byPage.get(h.slug) ?? 0) + 1);
  const topPages = [...byPage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([slug, count]) => ({ slug, count }));

  return { pagesScanned, bareHits, externalHits, topPages };
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

  mkdirSync(getGbrainDir(), { recursive: true });

  const engine = await connect();
  const registry = getDefaultRegistry();
  registerBuiltinResolvers(registry);
  const writer = new BrainWriter(engine, { strictMode: 'off' });

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

  const progress = resume ? loadProgressState() : (clearProgress(), new Map<string, SlugProgressState>());

  let bucketAuto = 0;
  let bucketReview = 0;
  let bucketSkip = 0;
  let bucketErr = 0;
  let pagesProcessed = 0;

  try {
    const allSlugs = [...(await engine.getAllSlugs())].sort();
    for (const slug of allSlugs) {
      if (pagesProcessed >= limit) break;
      const state = progress.get(slug) ?? {
        complete: false,
        bareTweetHitIndex: -1,
        deadLinksScanned: false,
      };
      if (state.complete) continue;

      const page = await engine.getPage(slug);
      if (!page) continue;

      pagesProcessed++;
      let slugHasRepair = false;
      let slugHasReview = false;
      let slugHasSkip = false;
      let slugHasError = false;
      let bareTweetDone = skipTweet;
      let deadLinksDone = skipUrls || state.deadLinksScanned;

      // Bare-tweet handling
      if (!skipTweet) {
        const hits = findBareTweetHits(page.compiled_truth, slug);
        const handle = extractXHandleFromFrontmatter(page.frontmatter);
        const startHitIndex = Math.max(0, state.bareTweetHitIndex + 1);
        if (hits.length > 0 && handle) {
          for (let i = startHitIndex; i < hits.length; i++) {
            const hit = hits[i]!;
            let checkpointStatus: ProgressEntry['status'];
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
                  writer, engine, slug, hit, result, handle, dryRun,
                });
                bucketAuto++;
                slugHasRepair = true;
                checkpointStatus = 'repaired';
              } else if (result.confidence >= reviewLower) {
                appendReview({ slug, hit, result, handle });
                bucketReview++;
                slugHasReview = true;
                checkpointStatus = 'reviewed';
              } else {
                logSkip({ slug, hit, reason: `confidence ${result.confidence.toFixed(2)} below threshold ${reviewLower}` });
                bucketSkip++;
                slugHasSkip = true;
                checkpointStatus = 'skipped';
              }
            } catch (e) {
              bucketErr++;
              logSkip({ slug, hit, reason: `resolver error: ${e instanceof Error ? e.message : String(e)}` });
              slugHasError = true;
              checkpointStatus = 'error';
            }
            if (!dryRun) {
              appendProgress({
                slug,
                status: checkpointStatus,
                timestamp: new Date().toISOString(),
                kind: 'bare_tweet_hit',
                hitIndex: i,
              });
              state.bareTweetHitIndex = i;
            }
          }
        } else if (hits.length > 0 && !handle) {
          // Can't repair without a handle; log once per page
          for (let i = startHitIndex; i < hits.length; i++) {
            const hit = hits[i]!;
            logSkip({ slug, hit, reason: 'no x_handle in frontmatter to search from' });
            if (!dryRun) {
              appendProgress({
                slug,
                status: 'skipped',
                timestamp: new Date().toISOString(),
                kind: 'bare_tweet_hit',
                hitIndex: i,
              });
              state.bareTweetHitIndex = i;
            }
          }
          bucketSkip += Math.max(0, hits.length - startHitIndex);
          if (hits.length > startHitIndex) slugHasSkip = true;
        }
        bareTweetDone = hits.length === 0 || state.bareTweetHitIndex >= hits.length - 1;
      }

      // Dead-link handling (no auto-repair; just surface)
      if (!skipUrls && !state.deadLinksScanned) {
        const externalHits = findExternalLinks(page.compiled_truth, slug);
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
              bucketReview++;
              slugHasReview = true;
            }
          } catch {
            /* transient; don't fail the run */
          }
        }
        if (!dryRun) {
          appendProgress({
            slug,
            status: 'reviewed',
            timestamp: new Date().toISOString(),
            kind: 'dead_link_scan',
          });
          state.deadLinksScanned = true;
        }
        deadLinksDone = true;
      }

      if (!dryRun && bareTweetDone && deadLinksDone) {
        const finalStatus: ProgressEntry['status'] = slugHasError
          ? 'error'
          : slugHasRepair
            ? 'repaired'
            : slugHasReview
              ? 'reviewed'
              : slugHasSkip
                ? 'skipped'
                : 'done';
        appendProgress({
          slug,
          status: finalStatus,
          timestamp: new Date().toISOString(),
          kind: 'complete',
        });
        state.complete = true;
      }
      progress.set(slug, state);
    }

    // Summary
    console.log('');
    console.log(`=== integrity auto summary${dryRun ? ' (DRY RUN)' : ''} ===`);
    console.log(`Pages processed: ${pagesProcessed}`);
    console.log(`Auto-repaired (≥${confidenceThreshold}): ${bucketAuto}`);
    console.log(`Review queue (≥${reviewLower} <${confidenceThreshold}): ${bucketReview}`);
    console.log(`Skipped (<${reviewLower}): ${bucketSkip}`);
    if (bucketErr > 0) console.log(`Resolver errors: ${bucketErr}`);
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
  const reviewFile = getReviewFile();
  if (!existsSync(reviewFile)) {
    console.log(`No review queue yet. Run: gbrain integrity auto --confidence 0.8`);
    return;
  }
  const content = readFileSync(reviewFile, 'utf-8');
  const count = (content.match(/^## /gm) ?? []).length;
  console.log(`Review queue: ${reviewFile}`);
  console.log(`Entries: ${count}`);
  console.log(`\nOpen with: $EDITOR ${reviewFile}`);
}

// ---------------------------------------------------------------------------
// Repair primitives
// ---------------------------------------------------------------------------

interface RepairArgs {
  writer: BrainWriter;
  engine: BrainEngine;
  slug: string;
  hit: BareTweetHit;
  result: ResolverResult<{ url?: string; tweet_id?: string; created_at?: string }>;
  handle: string;
  dryRun: boolean;
}

async function repairBareTweet(args: RepairArgs): Promise<void> {
  const { writer, engine, slug, hit, result, handle, dryRun } = args;
  const tweetId = result.value.tweet_id!;
  const createdAt = result.value.created_at!;
  const dateISO = createdAt.slice(0, 10);

  // Build the citation using Scaffolder (deterministic URL from API).
  const cite = tweetCitation({ handle, tweetId, dateISO });

  if (dryRun) {
    console.log(`[dry-run] ${slug}:${hit.line} would write citation + enable validators: ${cite}`);
    return;
  }

  const current = await engine.getPage(slug);
  if (!current) {
    throw new Error(`repairBareTweet: page not found: ${slug}`);
  }
  const nextCompiledTruth = addCitationToLine(current.compiled_truth, hit.line, cite);

  // Keep the repair atomic: mutate compiled_truth + clear grandfather mode in
  // the same transaction so repaired pages re-enter validator coverage.
  await writer.transaction(async (tx) => {
    if (nextCompiledTruth !== current.compiled_truth) {
      await tx.setCompiledTruth(slug, nextCompiledTruth);
    }
    await tx.setFrontmatterField(slug, 'validate', true);
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
  const reviewFile = getReviewFile();
  ensureDir(reviewFile);
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
  appendFileSync(reviewFile, block, 'utf-8');
}

interface SkipArgs { slug: string; hit: BareTweetHit; reason: string }
function logSkip(args: SkipArgs): void {
  const logFile = getLogFile();
  ensureDir(logFile);
  const entry = {
    timestamp: new Date().toISOString(),
    slug: args.slug,
    line: args.hit.line,
    phrase: args.hit.phrase,
    raw: args.hit.rawLine.slice(0, 200),
    reason: args.reason,
  };
  appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
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

function addCitationToLine(compiledTruth: string, lineNumber: number, citation: string): string {
  const lines = compiledTruth.split('\n');
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lines.length) return compiledTruth;
  const line = lines[idx] ?? '';
  if (URL_NEARBY_RE.test(line) || line.includes(citation)) return compiledTruth;
  const trailing = line.match(/\s*$/)?.[0] ?? '';
  const base = line.slice(0, line.length - trailing.length);
  const sep = base.length > 0 && !base.endsWith(' ') ? ' ' : '';
  lines[idx] = `${base}${sep}${citation}${trailing}`;
  return lines.join('\n');
}

function printHelp(): void {
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
