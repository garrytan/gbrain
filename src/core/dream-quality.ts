import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from './types.ts';

export type DreamPromotionOwner =
  | 'seascape-hub'
  | 'sawyer-hub'
  | 'seascape-ops'
  | 'seascape-vacations-site'
  | 'gbrain'
  | 'unknown';

export interface DreamQualityPageScore {
  slug: string;
  score: number;
  passed: boolean;
  checks: Record<string, boolean>;
  reasons: string[];
  promotion_owner: DreamPromotionOwner;
  promotion_reason: string | null;
  needs_promotion_review: boolean;
}

export interface DreamQualityReceipt {
  schema_version: 1;
  ts: string;
  summary_slug: string | null;
  source: 'summary' | 'slugs';
  pages_scored: number;
  pages_passed: number;
  pages_failed: number;
  promotion_candidates: number;
  verdict: 'pass' | 'fail' | 'inconclusive';
  min_score: number;
  average_score: number;
  pages: DreamQualityPageScore[];
  promotion_queue: Array<{
    slug: string;
    owner: DreamPromotionOwner;
    reason: string;
    next_step: string;
  }>;
  receipt_sha8: string;
}

const OWNER_PATTERNS: Array<{
  owner: DreamPromotionOwner;
  re: RegExp;
  reason: string;
  next: string;
}> = [
  {
    owner: 'seascape-vacations-site',
    re: /\b(public site|vacations site|stay page|owner page|seo copy|landing page|article|guide)\b/i,
    reason: 'Mentions public-site or SEO/page-copy knowledge that may belong in seascape-vacations-site.',
    next: 'Verify against site repo/runtime proof, then write the smallest public-site update if still true.',
  },
  {
    owner: 'seascape-ops',
    re: /\b(runtime|operator|worker|outlook|drive|hostaway|pricelabs|guest|owner lead|automation|scheduler)\b/i,
    reason: 'Mentions operational/runtime knowledge that may belong in seascape-ops.',
    next: 'Verify against ops code, logs, or receipts before writing an ops update.',
  },
  {
    owner: 'seascape-hub',
    re: /\b(seascape hub|strategy|canon|decision packet|owner demand|pricing strategy|business canon)\b/i,
    reason: 'Mentions Seascape strategy/canon knowledge that may belong in seascape-hub.',
    next: 'Verify against Hub packet/canon and source runtime proof before writing a Hub update.',
  },
  {
    owner: 'sawyer-hub',
    re: /\b(sawyer hub|today'?s focus|personal orchestration|control room|review board|home\.md)\b/i,
    reason: 'Mentions Sawyer personal orchestration knowledge that may belong in sawyer-hub.',
    next: 'Verify against Sawyer Hub current surfaces before writing a small orchestration update.',
  },
];

export function extractDreamSummarySlugs(markdown: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]\|#]+)(?:[|#][^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const slug = match[1]?.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

export function scoreDreamPage(page: Page): DreamQualityPageScore {
  const frontmatter = page.frontmatter ?? {};
  const text = `${page.title}\n${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`;
  const frontmatterText = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${formatFrontmatterValue(value)}`)
    .join('\n');
  const checks: Record<string, boolean> = {
    dreamGenerated: frontmatter.dream_generated === true || frontmatter.dream_generated === 'true',
    substantial: text.trim().length >= 900,
    hasHeading: /^#\s+\S/m.test(text),
    hasCrossLink: /\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)/.test(text),
    hasEvidenceMarker: /\b(Session|Origin|Proof|Receipt|Decision|What Happened|Related)\b/i.test(text),
    hasNonGenericTitle: page.title.trim().length >= 12 && !/^untitled|note$/i.test(page.title.trim()),
    hasTraceability: /\b(session_id|started_at|session_started|source_path|source_hash_suffix|transcript_suffix|Origin|Source|Transcript|Date|Repo)\b/i
      .test(`${frontmatterText}\n${text}`),
  };

  const passedCount = Object.values(checks).filter(Boolean).length;
  const score = Math.round((passedCount / Object.keys(checks).length) * 100);
  const owner = inferPromotionOwner(text);
  const needsPromotion = owner.owner !== 'gbrain' && owner.owner !== 'unknown';
  const reasons = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return {
    slug: page.slug,
    score,
    passed: score >= 72,
    checks,
    reasons,
    promotion_owner: owner.owner,
    promotion_reason: needsPromotion ? owner.reason : null,
    needs_promotion_review: needsPromotion,
  };
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatFrontmatterValue).join(', ');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => `${key}: ${formatFrontmatterValue(inner)}`)
      .join(', ');
  }
  if (value == null) return '';
  return String(value);
}

function inferPromotionOwner(text: string): { owner: DreamPromotionOwner; reason: string | null; next: string | null } {
  for (const p of OWNER_PATTERNS) {
    if (p.re.test(text)) return { owner: p.owner, reason: p.reason, next: p.next };
  }
  if (/\bgbrain|dream|memory|retrieval|agent|workflow|loop\b/i.test(text)) {
    return { owner: 'gbrain', reason: null, next: null };
  }
  return { owner: 'unknown', reason: null, next: null };
}

export function buildDreamQualityReceipt(input: {
  pages: Page[];
  summarySlug?: string | null;
  source: 'summary' | 'slugs';
  now?: Date;
}): DreamQualityReceipt {
  const scores = input.pages.map(scoreDreamPage);
  const passed = scores.filter((p) => p.passed).length;
  const avg = scores.length
    ? Math.round(scores.reduce((sum, p) => sum + p.score, 0) / scores.length)
    : 0;
  const min = scores.length ? Math.min(...scores.map((p) => p.score)) : 0;
  const promotionQueue = scores
    .filter((p) => p.needs_promotion_review && p.promotion_reason)
    .map((p) => {
      const owner = OWNER_PATTERNS.find((o) => o.owner === p.promotion_owner);
      return {
        slug: p.slug,
        owner: p.promotion_owner,
        reason: p.promotion_reason!,
        next_step: owner?.next ?? 'Verify against the owning repo/proof surface before writing any update.',
      };
    });

  const base: Omit<DreamQualityReceipt, 'receipt_sha8'> = {
    schema_version: 1,
    ts: (input.now ?? new Date()).toISOString(),
    summary_slug: input.summarySlug ?? null,
    source: input.source,
    pages_scored: scores.length,
    pages_passed: passed,
    pages_failed: scores.length - passed,
    promotion_candidates: promotionQueue.length,
    verdict: scores.length === 0 ? 'inconclusive' : scores.every((p) => p.passed) ? 'pass' : 'fail',
    min_score: min,
    average_score: avg,
    pages: scores,
    promotion_queue: promotionQueue,
  };
  const receiptSha8 = createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 8);
  return { ...base, receipt_sha8: receiptSha8 };
}

export function writeDreamQualityReceipt(path: string, receipt: DreamQualityReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
}

export function readSummarySlugsFromFile(path: string): string[] {
  if (!existsSync(path)) throw new Error(`summary file not found: ${path}`);
  return extractDreamSummarySlugs(readFileSync(path, 'utf8'));
}

export function defaultDreamQualityReceiptPath(now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return join(process.env.GBRAIN_AUDIT_DIR ?? join(process.env.HOME ?? '.', '.gbrain', 'audit'), `dream-quality-${date}.json`);
}
