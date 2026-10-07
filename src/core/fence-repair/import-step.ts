/**
 * #6188 (E7): Tier 1 inside `importFromContent`, after the screen and before
 * the remote hidden-row merge and the withdrawal preservation, so the merge
 * restores private rows into a fence that already parses.
 *
 * The screen decided the verdict without the database. This step reuses the
 * screen's normalized sections when nothing it knows changes the answer, and
 * otherwise normalizes again with what only the import knows: the rows a
 * remote caller could not see (never renumbered), and the page's stored
 * facts/takes rows, loaded only when a `renumber` fix is planned so a freed
 * number is never reused and a stored row keeps its number.
 */
import type { BrainEngine } from '../engine.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { parseTakesFence } from '../takes-fence.ts';
import { screenFenceCtx, type ContentRefusal, type FenceScreen, type ImportScreenResult } from '../import-screen.ts';
import type { ParsedMarkdown, ParseOpts } from '../markdown.ts';
import { VERSION } from '../../version.ts';
import { fencesNormalizeEnabled } from './config.ts';
import { fenceRefusal, scanCanonicalFences, targetFenceRefusal } from './refusal.ts';
import { effectiveVisibility } from '../search/private-visibility.ts';
import { fenceIssuesWire, fenceStep, residualLocation, type FenceIssueWire, type FenceStep } from './tier1.ts';
import type { FenceCtx, FenceFix, FenceKind, FencePage, StoredRowMap } from './types.ts';

/** Row numbers a remote caller never saw on the stored page: non-world facts rows and every takes row (remote reads hide takes). */
export function hiddenFenceRows(existing: FencePage): Set<number> {
  const rows = new Set<number>();
  for (const text of [existing.compiled_truth ?? '', existing.timeline ?? '']) {
    for (const fact of parseFactsFence(text).facts) if (fact.visibility !== 'world') rows.add(fact.rowNum);
    for (const take of parseTakesFence(text).takes) rows.add(take.rowNum);
  }
  return rows;
}

/** The page's stored canonical rows (row number to claim) for prior-aware renumbering. */
export async function storedFenceRows(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, pageId: number | null): Promise<StoredRowMap> {
  const facts = await engine.executeRaw<{ row_num: number; fact: string }>(
    'SELECT row_num, fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL ORDER BY id', [sourceId, slug]);
  const takes = pageId === null ? [] : await engine.executeRaw<{ row_num: number; claim: string }>('SELECT row_num, claim FROM takes WHERE page_id=$1', [pageId]);
  return { facts: new Map(facts.map(r => [Number(r.row_num), r.fact])), takes: new Map(takes.map(r => [Number(r.row_num), r.claim])) };
}

export interface ImportFenceInput {
  engine: Pick<BrainEngine, 'executeRaw'>;
  sourceId: string;
  slug: string;
  /** The sections as they will be stored (after text sanitizing). */
  page: FencePage;
  /** What the screen normalized. */
  screen: { before: FencePage; after: FencePage; fixes: readonly FenceFix[] };
  ctx: FenceCtx;
  /** The stored page this import replaces, if any. */
  existing: (FencePage & { id: number }) | null;
  remote: boolean;
}

export async function settleImportFences(input: ImportFenceInput): Promise<FenceStep<FencePage>> {
  const hidden = input.remote && input.existing ? hiddenFenceRows(input.existing) : undefined;
  const ctx: FenceCtx = { ...input.ctx, ...(hidden?.size ? { hiddenRows: hidden } : {}) };
  const renumber = (fixes: readonly FenceFix[]) => fixes.some(f => f.class === 'renumber');
  const same = input.screen.before.compiled_truth === input.page.compiled_truth && input.screen.before.timeline === input.page.timeline;
  if (same && !hidden?.size && !renumber(input.screen.fixes)) return { status: 'normalized', page: input.screen.after, fixes: [...input.screen.fixes] };
  const first = fenceStep(input.page, ctx, { normalize: true });
  if (first.status !== 'normalized' || !renumber(first.fixes)) return first;
  const storedRows = await storedFenceRows(input.engine, input.sourceId, input.slug, input.existing?.id ?? null);
  return fenceStep(input.page, { ...ctx, storedRows }, { normalize: true });
}

export interface ImportFences {
  /** Coordinated paths: the typed refusal for a residual fence. */
  refusal?: ContentRefusal;
  /** The sections to store when Tier 1 rewrote a fence. */
  page?: FencePage;
  fixes: FenceFix[];
  /** Lenient paths: a residual fence stored as written. */
  warnings: FenceIssueWire[];
}

/**
 * `importFromContent`'s fence step (E7), run before the hidden-row merge: the
 * normalized sections replace the parsed ones in place, so the merge, the
 * withdrawal preservation and the content hash all see the normalized body.
 * Returns the coordinated refusal as the import's result, or the fields to report.
 */
export async function applyImportFences(input: Omit<Parameters<typeof resolveImportFences>[0], 'screen' | 'existing'> & {
  screen: ImportScreenResult; parsed: { compiled_truth: string; timeline: string; type: ParsedMarkdown['type']; frontmatter: ParsedMarkdown['frontmatter'] };
  existing: { id: number; compiled_truth: string; timeline?: string | null; deleted_at?: Date | null } | null;
}): Promise<{ refused?: { slug: string; status: 'error'; chunks: 0; error: string; refusal: ContentRefusal; skip_reason: 'invalid_fence' }; fields: { fences_normalized?: FenceFix[]; fence_issues?: FenceIssueWire[] } }> {
  const existing = input.existing && input.existing.deleted_at == null ? { id: input.existing.id, compiled_truth: input.existing.compiled_truth, timeline: input.existing.timeline ?? '' } : null;
  const fences = await resolveImportFences({ ...input, screen: (input.screen as { fences?: FenceScreen }).fences, existing });
  if (fences.refusal) return { refused: { slug: input.slug, status: 'error', chunks: 0, error: fences.refusal.message, refusal: fences.refusal, skip_reason: 'invalid_fence' }, fields: {} };
  if (fences.page) ({ compiled_truth: input.parsed.compiled_truth, timeline: input.parsed.timeline } = fences.page);
  return { fields: { ...(fences.fixes.length ? { fences_normalized: fences.fixes } : {}), ...(fences.warnings.length ? { fence_issues: fences.warnings } : {}) } };
}

/**
 * The whole fence decision of one `importFromContent` call. `screened` is a
 * caller's verdict for the same bytes (its switch already settled); otherwise
 * the import's own screen verdict is used and `fences.normalize` is read only
 * when it has something to rewrite.
 */
export async function resolveImportFences(input: {
  engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>; sourceId: string; slug: string; mode: 'coordinated' | 'lenient';
  screened: FenceScreen | null | undefined; screen: FenceScreen | undefined;
  parsed: Pick<ParsedMarkdown, 'compiled_truth' | 'timeline' | 'type' | 'frontmatter'>; activePack?: ParseOpts['activePack'];
  existing: (FencePage & { id: number }) | null; remote: boolean;
}): Promise<ImportFences> {
  const verdict = input.screened !== undefined ? input.screened ?? undefined : input.screen;
  if (!verdict) return { fixes: [], warnings: [] };
  const ctx = screenFenceCtx(input.parsed, input.activePack);
  const refuse = (step: Extract<FenceStep<FencePage>, { status: 'residual' }>): ImportFences => {
    const issues = fenceIssuesWire([...step.issues, ...step.fixable]);
    if (step.issues.some(issue => issue.reason === 'normalizer_failed')) console.warn(`[gbrain] #6188 fence normalizer failed on ${input.slug} (gbrain ${VERSION}); the fence was not rewritten.`);
    return input.mode === 'coordinated' ? { refusal: { ...fenceRefusal(step.location), fence_issues: issues }, fixes: [], warnings: [] } : { fixes: [], warnings: issues };
  };
  if (!verdict.fixes.length) return { fixes: [], warnings: verdict.issues };
  if (input.screened === undefined && !await fencesNormalizeEnabled(input.engine)) {
    const off = fenceStep(verdict.before, ctx, { normalize: false });
    return off.status === 'residual' ? refuse(off) : { fixes: [], warnings: [] };
  }
  const step = await settleImportFences({ engine: input.engine, sourceId: input.sourceId, slug: input.slug, screen: verdict, ctx, existing: input.existing, remote: input.remote,
    page: { compiled_truth: input.parsed.compiled_truth, timeline: input.parsed.timeline ?? '' } });
  if (step.status === 'normalized') return { page: step.page, fixes: step.fixes, warnings: [] };
  return step.status === 'residual' ? refuse(step) : { fixes: [], warnings: [] };
}

/**
 * #6188 (TD2, D20): an append verb (remember, extract_facts, takes_add /
 * takes_update, facts relink) normalizes its target page's stored fences in
 * the same coordinated write. Returns the page to append to and the fixes
 * applied. A residual in the verb's own fence kind (or a fixable one with
 * `fences.normalize` off) refuses `target_fence_malformed` with the location
 * and the issues; a residual only in the other kind leaves the page as it is,
 * as the verb never reads that fence.
 */
export async function normalizeTargetFences(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>, input: StoredPageInput & { kind: FenceKind }): Promise<{ page: FencePage; fixes: FenceFix[] }> {
  const { page, step } = await storedPageStep(engine, input);
  if (step.status === 'normalized') return { page: step.page, fixes: step.fixes };
  if (step.status === 'clean') return { page, fixes: [] };
  const own = (fence: FenceKind) => fence === input.kind;
  if (!step.issues.some(issue => own(issue.fence)) && !step.fixable.some(fix => own(fix.fence)) && !scanCanonicalFences(page).defects.some(d => own(d.fence))) return { page, fixes: [] };
  const mine = step.issues.filter(issue => own(issue.fence));
  const location = mine.length ? residualLocation(mine) : step.location;
  throw targetFenceRefusal(location, input.slug, input.sourceId, fenceIssuesWire([...step.issues, ...step.fixable]) as unknown as Array<Record<string, unknown>>);
}

interface StoredPageInput { sourceId: string; slug: string; page: FencePage & { id: number; type?: string | null; frontmatter?: unknown } }

/** Tier 1 over a page body the caller is about to write (switch read only when there is a fix; stored rows only for `renumber`). */
async function storedPageStep(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>, input: StoredPageInput): Promise<{ page: FencePage; step: FenceStep<FencePage> }> {
  const page = { compiled_truth: input.page.compiled_truth ?? '', timeline: input.page.timeline ?? '' };
  const ctx: FenceCtx = { pageVisibility: effectiveVisibility({ kind: 'page', page: { type: input.page.type ?? null, frontmatter: input.page.frontmatter } }) };
  let step = fenceStep(page, ctx, { normalize: true });
  if (step.status === 'normalized' && !await fencesNormalizeEnabled(engine)) step = fenceStep(page, ctx, { normalize: false });
  if (step.status === 'normalized' && step.fixes.some(f => f.class === 'renumber')) {
    step = fenceStep(page, { ...ctx, storedRows: await storedFenceRows(engine, input.sourceId, input.slug, input.page.id) }, { normalize: true });
  }
  return { page, step };
}

/** #6188: Tier 1 before a maintenance writer compiles a body (synthesize verify); null when nothing changed or a fence stays residual. */
export async function normalizePageFences(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>, input: StoredPageInput): Promise<{ page: FencePage; fixes: FenceFix[] } | null> {
  const { step } = await storedPageStep(engine, input);
  return step.status === 'normalized' ? { page: step.page, fixes: step.fixes } : null;
}
