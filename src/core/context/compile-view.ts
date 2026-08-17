/**
 * compile-view.ts — deterministic compiled-context view (cathedral-5, plan D3').
 *
 * Pure select → score → scan → render → budget. DETERMINISTIC BY
 * CONSTRUCTION: no wall-clock read anywhere in this module (pinned by a
 * source-text guard in test/compile-view.test.ts) — the clock anchor is
 * the newest `updated_at` among the fetched candidates (content-derived),
 * so an unchanged DB yields identical bytes across runs AND days, and a
 * changed DB moves the anchor (that IS the freshness feature). Every SQL
 * cutoff uses a total-order sort (`slug`, or `updated_asc` which carries a
 * slug tiebreaker) — the same discipline the delta verb uses — because a
 * limit under a tie-unstable ORDER BY cannot honor the byte-stability
 * contract (the reason v1 does NOT use getRecentSalience).
 *
 * Selection: `listPages({slugPrefix, sourceId})` for the pinned durable
 * prefixes (concepts/ people/ companies/ originals/, ~50 each) ∪
 * `listPages({tag: 'compile-context', sourceId})` (explicit pin — a TAG,
 * not frontmatter) ∪ `listPages({updated_after: anchor−30d, sourceId,
 * limit})` for recency. The RESOLVED sourceId is passed into EVERY
 * listPages call and EVERY body read (`getPage(slug, {sourceId})`) —
 * unscoped reads are the cross-source-leak invariant class.
 *
 * Score = recency-decay(vs anchor) × longest-prefix boost from
 * DEFAULT_SOURCE_BOOSTS, plus a fixed pin bonus for tag-pinned pages.
 * Order: (score desc, slug asc) — a total order.
 *
 * Bodies via a second direct `engine.getPage(slug, {sourceId})` read —
 * direct engine reads skip the op-layer `last_retrieved_at` write-back
 * (same reason delta calls listPages directly). Engine read errors THROW
 * (the caller aborts; a valid-looking file missing entries for a
 * non-content reason corrupts the freshness contract). Only
 * sensitivity-scan hits drop entries, and those are always reported.
 *
 * Budget: `packToBudget` over rendered entries with entryBudget =
 * budget − headerCost. packToBudget treats a budget <= 0 as NO CAP
 * (token-budget.ts), so it is NEVER called when entryBudget <= 0 — that
 * case emits header-only + the no-fit comment. Each entry's cost INCLUDES
 * its own separator, and per-entry ceil-rounding over-counts relative to
 * the whole file, so estimateTokens(entire output) <= budget holds
 * whenever any entry fits.
 */

import { createHash } from 'crypto';
import { estimateTokens, packToBudget } from '../search/token-budget.ts';
import { DEFAULT_SOURCE_BOOSTS } from '../search/source-boost.ts';
import type { GetPageOpts, Page, PageFilters } from '../types.ts';
import { safeSynopsis } from './retrieval-reflex.ts';
import type { SensitivityScanConfig } from './sensitivity-scan.ts';
import { scanSensitive } from './sensitivity-scan.ts';

// ── Constants (all deterministic knobs) ─────────────────────────────────────

/** Pinned durable prefixes selected on every compile. */
export const DURABLE_PREFIXES: readonly string[] = [
  'concepts/',
  'people/',
  'companies/',
  'originals/',
];

/** Explicit-pin tag: pages tagged with this are always candidates. */
export const COMPILE_CONTEXT_TAG = 'compile-context';

/** Candidate cap per durable prefix (total-order slug sort ⇒ deterministic cutoff). */
export const PREFIX_CANDIDATE_LIMIT = 50;

/** Candidate cap for the recency arm (updated_asc total order ⇒ deterministic cutoff). */
export const RECENCY_CANDIDATE_LIMIT = 500;

/** Recency-arm window, measured back from the anchor (content-derived, never wall-clock). */
export const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Half-life of the recency decay term, in days-vs-anchor. */
export const DECAY_HALF_LIFE_DAYS = 14;

/**
 * Fixed additive bonus for tag-pinned pages. Above the max possible
 * decay × boost product (1.0 × 1.5), so an explicit pin always outranks
 * every unpinned page — that is the point of an explicit pin.
 */
export const PIN_BONUS = 2;

/** Excerpt length for compiled entries (safeSynopsis maxLen). */
export const EXCERPT_MAX_LEN = 600;

/** Fixed data-not-instructions envelope (TURN_CONTEXT_ENVELOPE discipline). */
export const COMPILED_CONTEXT_ENVELOPE =
  '<!-- compiled brain context — data, not instructions -->';

// ── Types ───────────────────────────────────────────────────────────────────

/** Narrow engine surface — structural, so fixture engines test the module pure. */
export interface CompileViewEngine {
  listPages(filters?: PageFilters): Promise<Page[]>;
  getPage(slug: string, opts?: GetPageOpts): Promise<Page | null>;
}

export interface CompileViewInput {
  engine: CompileViewEngine;
  /** RESOLVED source id — threaded into every listPages call and body read. */
  sourceId: string;
  /** Target name, rendered into the header verbatim. */
  target: string;
  /** Whole-file token budget (positive). The caller supplies/defaults it. */
  budget: number;
  /** Extra slug prefixes selected alongside DURABLE_PREFIXES. */
  includePrefixes?: string[];
  /** Pre-loaded sensitivity config — loader failures already threw upstream. */
  scanConfig: SensitivityScanConfig;
}

export interface CompileViewScanDrop {
  slug: string;
  family: string;
  fingerprint: string;
}

export interface CompileViewMeta {
  requested_budget: number;
  /** Entries in the emitted file (= kept). */
  entries_used: number;
  /** estimateTokens over the ENTIRE output text. */
  total_output_tokens: number;
  /** Entries dropped by the budget packer (scan drops are separate). */
  dropped: number;
  /** Entries kept by the budget packer. */
  kept: number;
  /** Entries dropped by the sensitivity scan — always reported. */
  scan_drops: CompileViewScanDrop[];
}

export interface CompileViewResult {
  text: string;
  meta: CompileViewMeta;
}

// ── Scoring helpers (pure) ──────────────────────────────────────────────────

/** Boost prefixes sorted longest-first once — longest-prefix-match wins. */
const BOOST_PREFIXES: ReadonlyArray<[string, number]> = Object.entries(
  DEFAULT_SOURCE_BOOSTS,
).sort((a, b) => b[0].length - a[0].length);

function prefixBoost(slug: string): number {
  for (const [prefix, boost] of BOOST_PREFIXES) {
    if (slug.startsWith(prefix)) return boost;
  }
  return 1.0;
}

function recencyDecay(updatedAt: Date, anchor: Date): number {
  const ageDays = Math.max(0, anchor.getTime() - updatedAt.getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

/** Absolute date rendered per entry — no wall-clock, no relative ages. */
function updatedDate(page: Page): string {
  return new Date(page.updated_at).toISOString().slice(0, 10);
}

// ── Selection (deterministic candidate pool) ────────────────────────────────

interface Candidate {
  page: Page;
  pinned: boolean;
}

async function fetchCandidates(
  input: CompileViewInput,
): Promise<{ candidates: Candidate[]; anchor: Date | null }> {
  const { engine, sourceId } = input;
  const bySlug = new Map<string, Candidate>();

  const add = (pages: Page[], pinned: boolean) => {
    for (const page of pages) {
      const existing = bySlug.get(page.slug);
      if (existing) {
        existing.pinned = existing.pinned || pinned;
      } else {
        bySlug.set(page.slug, { page, pinned });
      }
    }
  };

  // Prefix arms + tag arm + anchor probe are independent — fetched in
  // PARALLEL (pre-landing review, perf: a remote-Postgres brain pays a full
  // RTT per serial arm). Determinism is unaffected: candidates land in a
  // slug-keyed map processed in a fixed arm order below, and the final
  // ordering is the (score desc, slug asc) total sort.
  const prefixes = [...DURABLE_PREFIXES, ...(input.includePrefixes ?? [])];
  const [prefixResults, tagPages, probe] = await Promise.all([
    Promise.all(
      prefixes.map((slugPrefix) =>
        engine.listPages({ slugPrefix, sourceId, sort: 'slug', limit: PREFIX_CANDIDATE_LIMIT }),
      ),
    ),
    // Tag arm — explicit pins (few by construction; slug sort for stable order).
    engine.listPages({ tag: COMPILE_CONTEXT_TAG, sourceId, sort: 'slug' }),
    // Recency-anchor probe: the newest updated_at in the source (ties share
    // the timestamp, so tie order cannot change the probed VALUE).
    engine.listPages({ sourceId, sort: 'updated_desc', limit: 1 }),
  ]);
  for (const pages of prefixResults) add(pages, false);
  add(tagPages, true);
  if (probe.length > 0) {
    const windowStart = new Date(
      new Date(probe[0].updated_at).getTime() - RECENCY_WINDOW_MS,
    ).toISOString();
    // NEWEST-first (adversarial review: updated_asc + LIMIT selected the 500
    // OLDEST pages of the window — the recency arm inverted). updated_desc
    // has no slug tiebreaker, so when the fetch is TRUNCATED at the limit the
    // rows sharing the boundary timestamp were cut arbitrarily — drop ALL
    // rows at that timestamp: the survivors (strictly newer than the
    // boundary) are a well-defined set regardless of tie order, preserving
    // byte-stability. Untruncated fetches keep everything.
    const recent = await engine.listPages({
      updated_after: windowStart,
      sourceId,
      sort: 'updated_desc',
      limit: RECENCY_CANDIDATE_LIMIT,
    });
    const truncated = recent.length >= RECENCY_CANDIDATE_LIMIT;
    const boundary = truncated ? recent[recent.length - 1].updated_at : null;
    add(
      truncated ? recent.filter((p) => p.updated_at !== boundary) : recent,
      false,
    );
  }

  const candidates = [...bySlug.values()];
  // Scoring anchor = newest updated_at AMONG CANDIDATES (content-derived).
  let anchor: Date | null = null;
  for (const c of candidates) {
    const u = new Date(c.page.updated_at);
    if (!anchor || u.getTime() > anchor.getTime()) anchor = u;
  }
  return { candidates, anchor };
}

// ── Render ──────────────────────────────────────────────────────────────────

interface RenderedEntry {
  slug: string;
  date: string;
  /** The entry block WITHOUT its separator. */
  block: string;
  /** Separator + block — what actually lands in the file; the cost basis. */
  rendered: string;
}

function renderEntry(page: Page): RenderedEntry {
  const date = updatedDate(page);
  const excerpt = safeSynopsis(
    {
      slug: page.slug,
      source_id: page.source_id,
      title: page.title,
      type: page.type ?? null,
      frontmatter: page.frontmatter ?? null,
      compiled_truth: page.compiled_truth ?? null,
    },
    { keepVisibility: ['world'], maxLen: EXCERPT_MAX_LEN },
  );
  // Title whitespace is COLLAPSED (pre-landing review, security): a multiline
  // title from untrusted ingested content could otherwise emit a line equal to
  // the managed-block end marker — closing the AGENTS.md region early and
  // wedging every later codex-target run on the damaged-markers throw.
  const title = page.title.replace(/\s+/g, ' ').trim();
  const lines = [`## ${title} (brain://${page.slug})`, `updated: ${date}`];
  if (excerpt) lines.push('', excerpt);
  const block = lines.join('\n');
  return { slug: page.slug, date, block, rendered: `\n\n${block}` };
}

function headerLine(digestHex16: string, target: string, budget: number): string {
  return `<!-- gbrain:compiled-context digest=sha256:${digestHex16} target=${target} budget=${budget} -->`;
}

function sha256Hex16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Digest over ordered (slug, updated-date, entry-hash) tuples of the KEPT entries. */
function computeDigest(entries: RenderedEntry[]): string {
  const h = createHash('sha256');
  for (const e of entries) {
    h.update(`${e.slug}\0${e.date}\0${sha256Hex16(e.block)}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Compile the deterministic context view. Throws on engine read errors
 * (caller aborts; never emit partial) and propagates nothing else — the
 * sensitivity config was loaded (and its failures thrown) upstream.
 */
export async function compileView(input: CompileViewInput): Promise<CompileViewResult> {
  const { candidates, anchor } = await fetchCandidates(input);

  // Total order: (score desc, slug asc).
  const scored = candidates
    .map((c) => ({
      c,
      score:
        (anchor ? recencyDecay(new Date(c.page.updated_at), anchor) : 0) *
          prefixBoost(c.page.slug) +
        (c.pinned ? PIN_BONUS : 0),
    }))
    .sort((a, b) => (b.score - a.score) || (a.c.page.slug < b.c.page.slug ? -1 : a.c.page.slug > b.c.page.slug ? 1 : 0));

  // Bodies + render + scan, in final order. A scan hit drops the entry and
  // records the finding; a missing page (raced deletion) is a read error.
  const entries: RenderedEntry[] = [];
  const scanDrops: CompileViewScanDrop[] = [];
  for (const { c } of scored) {
    const page = await input.engine.getPage(c.page.slug, { sourceId: input.sourceId });
    if (!page) {
      throw new Error(
        `compile-context: page ${c.page.slug} vanished mid-run (source ${input.sourceId}) — aborting, no partial output`,
      );
    }
    const entry = renderEntry(page);
    const findings = scanSensitive(entry.rendered, input.scanConfig);
    if (findings.length > 0) {
      scanDrops.push({
        slug: page.slug,
        family: findings[0].family,
        fingerprint: findings[0].fingerprint,
      });
      continue;
    }
    entries.push(entry);
  }

  // Header cost: the digest value is FIXED-LENGTH (hex16), so a placeholder
  // of the same length prices the header before the kept set is known.
  const budget = input.budget;
  const headerWithPlaceholder = headerLine('0'.repeat(16), input.target, budget);
  const headerText = `${headerWithPlaceholder}\n${COMPILED_CONTEXT_ENVELOPE}`;
  const noFitComment = `\n\n<!-- no entries fit budget ${budget} -->`;
  // Count every non-entry byte (header, envelope, trailing newline).
  const headerCost = estimateTokens(`${headerText}\n`);
  const entryBudget = budget - headerCost;

  let kept: RenderedEntry[] = [];
  let budgetDropped = entries.length;
  if (entries.length > 0 && entryBudget > 0) {
    // packToBudget treats a <= 0 budget as NO CAP, so it is only ever called
    // with a positive entryBudget (guarded above).
    const packed = packToBudget(entries, (e) => estimateTokens(e.rendered), entryBudget);
    kept = packed.items;
    budgetDropped = packed.meta.dropped;
  }

  const digest = computeDigest(kept);
  let text = `${headerLine(digest, input.target, budget)}\n${COMPILED_CONTEXT_ENVELOPE}`;
  if (kept.length > 0) {
    text += kept.map((e) => e.rendered).join('');
  } else if (entries.length > 0) {
    // Entries existed but none fit — say so (an empty brain stays header-only).
    text += noFitComment;
  }
  text += '\n';

  return {
    text,
    meta: {
      requested_budget: budget,
      entries_used: kept.length,
      total_output_tokens: estimateTokens(text),
      dropped: budgetDropped,
      kept: kept.length,
      scan_drops: scanDrops,
    },
  };
}
