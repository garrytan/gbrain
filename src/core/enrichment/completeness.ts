/**
 * CompletenessScorer — per-entity-type rubrics, 0.0–1.0 score per page.
 *
 * Replaces Garry's OpenClaw's length-based heuristic ("compiled_truth > 500 chars")
 * with a weighted rubric that actually reflects whether a page would be
 * useful to answer a query. Runs on demand; BrainWriter invokes it on
 * write to cache the score in frontmatter.
 *
 * Seven core rubrics + a default for user-registered types. Each dimension
 * returns 0.0–1.0 and the page score is the weighted sum. Weights sum to 1.0
 * per rubric (checked at module load).
 */

import type { Page, PageType } from '../types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletenessDimension {
  name: string;
  weight: number;
  check: (page: Page) => number;
}

export interface Rubric {
  entityType: PageType | 'default';
  dimensions: CompletenessDimension[];
}

export interface CompletenessScore {
  slug: string;
  entityType: string;
  score: number;
  dimensionScores: Record<string, number>;
  rubric: PageType | 'default';
}

// ---------------------------------------------------------------------------
// Shared dimension helpers
// ---------------------------------------------------------------------------

function hasTimelineEntries(page: Page): number {
  const tl = (page.timeline ?? '').trim();
  if (tl.length === 0) return 0;
  const bulletCount = (tl.match(/^\s*-\s/gm) ?? []).length;
  return bulletCount > 0 ? 1 : 0.5;
}

function hasCitations(page: Page): number {
  const body = page.compiled_truth ?? '';
  const count = (body.match(/\[Source:[^\]]*\]/g) ?? []).length;
  const urlLinkCount = (body.match(/\]\(https?:\/\/[^)]+\)/g) ?? []).length;
  const total = count + urlLinkCount;
  if (total === 0) return 0;
  if (total >= 3) return 1;
  return total / 3;
}

function hasSourceUrls(page: Page): number {
  const body = page.compiled_truth ?? '';
  const urls = (body.match(/https?:\/\/[^\s)\]]+/g) ?? []).length;
  if (urls === 0) return 0;
  if (urls >= 2) return 1;
  return 0.6;
}

function hasFrontmatterField(page: Page, keys: string[]): number {
  const fm = page.frontmatter ?? {};
  for (const k of keys) {
    const v = fm[k];
    if (typeof v === 'string' && v.trim().length > 0) return 1;
    if (typeof v === 'number' && Number.isFinite(v)) return 1;
    if (Array.isArray(v) && v.length > 0) return 1;
  }
  return 0;
}

function hasBacklinkHint(page: Page): number {
  // Crude: count wikilinks out; a page that links out is much more likely
  // to have inbound references. Real backlink count requires an engine call
  // (we stay pure here). If the rubric needs engine-backed signal, a later
  // variant of scorer can inject backlinkCount.
  const body = page.compiled_truth ?? '';
  const wikiLinks = (body.match(/\[[^\]]+\]\([^)]*\.md\)/g) ?? []).length;
  if (wikiLinks === 0) return 0;
  if (wikiLinks >= 3) return 1;
  return wikiLinks / 3;
}

function recencyScore(page: Page): number {
  // Prefer frontmatter.last_verified → page.updated_at → 0.
  const fm = page.frontmatter ?? {};
  const verified = typeof fm.last_verified === 'string' ? parseDate(fm.last_verified) : null;
  const updated = page.updated_at instanceof Date ? page.updated_at : null;
  const reference = verified ?? updated;
  if (!reference) return 0;
  const ageDays = Math.floor((Date.now() - reference.getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays <= 90) return 1;
  if (ageDays <= 180) return 0.7;
  if (ageDays <= 365) return 0.4;
  return 0.1;
}

function nonRedundancy(page: Page): number {
  const body = page.compiled_truth ?? '';
  if (body.length < 200) return 0.5;
  const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return 0;
  const unique = new Set(lines);
  return unique.size / lines.length;
}

function hasTitle(page: Page): number {
  return page.title && page.title.trim().length > 0 ? 1 : 0;
}

function hasBody(page: Page): number {
  return (page.compiled_truth ?? '').trim().length > 0 ? 1 : 0;
}

function parseDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Seven core rubrics + default
// ---------------------------------------------------------------------------

export const personRubric: Rubric = {
  entityType: 'person',
  dimensions: [
    { name: 'has_role_and_company', weight: 0.20, check: p => hasFrontmatterField(p, ['role', 'title', 'company']) },
    { name: 'has_source_urls', weight: 0.20, check: hasSourceUrls },
    { name: 'has_timeline_entries', weight: 0.15, check: hasTimelineEntries },
    { name: 'has_citations', weight: 0.15, check: hasCitations },
    { name: 'has_backlinks', weight: 0.10, check: hasBacklinkHint },
    { name: 'recency_score', weight: 0.10, check: recencyScore },
    { name: 'non_redundancy', weight: 0.10, check: nonRedundancy },
  ],
};

export const companyRubric: Rubric = {
  entityType: 'company',
  dimensions: [
    { name: 'has_description', weight: 0.20, check: hasBody },
    { name: 'has_founders', weight: 0.15, check: p => hasFrontmatterField(p, ['founders', 'founder', 'ceo']) },
    { name: 'has_funding', weight: 0.15, check: p => hasFrontmatterField(p, ['funding', 'raised', 'round', 'investors']) },
    { name: 'has_source_urls', weight: 0.15, check: hasSourceUrls },
    { name: 'has_citations', weight: 0.15, check: hasCitations },
    { name: 'has_employees_or_investors', weight: 0.10, check: hasBacklinkHint },
    { name: 'recency_score', weight: 0.10, check: recencyScore },
  ],
};

export const projectRubric: Rubric = {
  entityType: 'project',
  dimensions: [
    { name: 'has_description', weight: 0.25, check: hasBody },
    { name: 'has_owners', weight: 0.20, check: p => hasFrontmatterField(p, ['owner', 'owners', 'lead']) },
    { name: 'has_timeline_entries', weight: 0.15, check: hasTimelineEntries },
    { name: 'has_citations', weight: 0.15, check: hasCitations },
    { name: 'has_status', weight: 0.15, check: p => hasFrontmatterField(p, ['status', 'state', 'phase']) },
    { name: 'recency_score', weight: 0.10, check: recencyScore },
  ],
};

export const dealRubric: Rubric = {
  entityType: 'deal',
  dimensions: [
    { name: 'has_company', weight: 0.25, check: p => hasFrontmatterField(p, ['company', 'target']) },
    { name: 'has_terms', weight: 0.25, check: p => hasFrontmatterField(p, ['terms', 'amount', 'valuation', 'round']) },
    { name: 'has_date', weight: 0.15, check: p => hasFrontmatterField(p, ['date', 'closed', 'announced']) },
    { name: 'has_source_urls', weight: 0.15, check: hasSourceUrls },
    { name: 'has_citations', weight: 0.20, check: hasCitations },
  ],
};

export const conceptRubric: Rubric = {
  entityType: 'concept',
  dimensions: [
    { name: 'has_definition', weight: 0.35, check: hasBody },
    { name: 'has_citations', weight: 0.30, check: hasCitations },
    { name: 'has_examples', weight: 0.20, check: p => countListItems(p.compiled_truth) >= 2 ? 1 : countListItems(p.compiled_truth) / 2 },
    { name: 'has_related', weight: 0.15, check: hasBacklinkHint },
  ],
};

export const sourceRubric: Rubric = {
  entityType: 'source',
  dimensions: [
    { name: 'has_url', weight: 0.35, check: p => hasFrontmatterField(p, ['url', 'link', 'source_url']) },
    { name: 'has_author', weight: 0.20, check: p => hasFrontmatterField(p, ['author', 'authors', 'by']) },
    { name: 'has_date', weight: 0.20, check: p => hasFrontmatterField(p, ['date', 'published', 'year']) },
    { name: 'has_summary', weight: 0.25, check: hasBody },
  ],
};

export const mediaRubric: Rubric = {
  entityType: 'media',
  dimensions: [
    { name: 'has_type', weight: 0.20, check: p => hasFrontmatterField(p, ['media_type', 'type', 'format']) },
    { name: 'has_url', weight: 0.25, check: p => hasFrontmatterField(p, ['url', 'link']) },
    { name: 'has_title', weight: 0.20, check: hasTitle },
    { name: 'has_date', weight: 0.15, check: p => hasFrontmatterField(p, ['date', 'published', 'recorded']) },
    { name: 'has_transcript_or_summary', weight: 0.20, check: hasBody },
  ],
};

export const defaultRubric: Rubric = {
  entityType: 'default',
  dimensions: [
    { name: 'has_title', weight: 0.30, check: hasTitle },
    { name: 'has_content', weight: 0.30, check: hasBody },
    { name: 'has_source_urls', weight: 0.20, check: hasSourceUrls },
    { name: 'has_citations', weight: 0.20, check: hasCitations },
  ],
};

const RUBRICS_BY_TYPE = new Map<PageType | 'default', Rubric>([
  ['person', personRubric],
  ['company', companyRubric],
  ['project', projectRubric],
  ['deal', dealRubric],
  ['concept', conceptRubric],
  ['source', sourceRubric],
  ['media', mediaRubric],
  ['default', defaultRubric],
]);

// Validate rubric weights at module load (catches copy-paste bugs).
for (const [type, rubric] of RUBRICS_BY_TYPE) {
  const sum = rubric.dimensions.reduce((acc, d) => acc + d.weight, 0);
  if (Math.abs(sum - 1.0) > 1e-6) {
    throw new Error(`Rubric for ${type} has dimension weights summing to ${sum}, not 1.0`);
  }
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export function scorePage(page: Page): CompletenessScore {
  const rubric = RUBRICS_BY_TYPE.get(page.type as PageType) ?? defaultRubric;
  const dimensionScores: Record<string, number> = {};
  let total = 0;
  for (const d of rubric.dimensions) {
    const raw = clamp(d.check(page), 0, 1);
    dimensionScores[d.name] = raw;
    total += raw * d.weight;
  }
  return {
    slug: page.slug,
    entityType: page.type,
    score: Math.round(total * 1000) / 1000,
    dimensionScores,
    rubric: rubric.entityType,
  };
}

export function getRubric(type: PageType | string): Rubric {
  const r = RUBRICS_BY_TYPE.get(type as PageType);
  return r ?? defaultRubric;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function countListItems(body: string): number {
  return (body.match(/^\s*[-*]\s/gm) ?? []).length;
}
