/**
 * Managed publication of `synthesize_concepts` output (#5484).
 *
 * On a managed brain the phase publishes each concept page through the
 * maintenance coordinator (`publishMaintenancePage`) instead of the legacy
 * `importFromContent` writer, which a managed brain refuses. The caller keeps
 * the #5525 order: publish private, bank provenance edges, then promote.
 */
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { Page } from '../types.ts';
import { serializeMarkdown, parseMarkdown } from '../markdown.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, replaceOrInsertFactsFence, stripFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, stripTakesFence } from '../takes-fence.ts';
import { isDbOnly, loadStorageConfig } from '../storage-config.ts';
import { publishMaintenancePage, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';

/** Error code for a concept held because republication could lose canonical material. */
export const CONCEPT_PRESERVATION_CODE = 'concept_preservation_hold';
/** Codes that mean the page moved under a concurrent writer; the next run retries. */
export const CONCEPT_DEFERRAL_CODES = new Set(['revision_conflict', 'page_identity_changed']);
/** Codes that hold a concept until an operator imports or repairs its page. */
export const CONCEPT_HOLD_CODES = new Set(['source_changed', CONCEPT_PRESERVATION_CODE]);

function conceptHoldError(message: string): Error { return Object.assign(new Error(message), { code: CONCEPT_PRESERVATION_CODE }); }

/**
 * Publish one concept page through the maintenance coordinator. A concept
 * keeps the storage shape it already has: a row with a recorded source file is
 * republished to that file (a database-only update would leave the file stale
 * for the next sync to resurrect); new concepts and file-less rows stay
 * database-only, which is what the legacy writer produced. A declared
 * `db_only` storage tier always wins.
 */
export async function publishManagedConcept(engine: BrainEngine, authority: MaintenanceAuthority,
  slug: string, synthesized: Record<string, unknown>, narrative: string, expectedRevision: string | null, brainDir?: string): Promise<string | null> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: authority.writer.sourceId, includeDeleted: true });
  // The narrative was synthesized from the revision read before the model call
  // (or the previous publication's result); an intervening edit wins.
  if ((snapshot?.revision ?? null) !== expectedRevision) {
    throw Object.assign(new Error('The concept page changed during synthesis.'), { code: 'revision_conflict' });
  }
  let dbOnly = !snapshot?.page.source_path;
  if (!dbOnly) {
    try {
      const storage = loadStorageConfig(brainDir);
      dbOnly = storage !== null && isDbOnly(slug, storage);
    } catch {
      // Unreadable gbrain.yml: keep the recorded file; sync reports the config.
    }
  }
  const title = slug.split('/').pop()!.replace(/-/g, ' ');
  const markdown = snapshot && !snapshot.page.deleted_at
    ? composeConceptRepublication(snapshot.page, snapshot.tags, synthesized, narrative)
    : serializeMarkdown(synthesized, narrative, '', { type: 'concept', title, tags: [] });
  const receipt = await publishMaintenancePage(engine, authority, slug, markdown,
    { expectedRevision: snapshot?.revision ?? null, file: !dbOnly });
  return typeof receipt.revision === 'string' ? receipt.revision : null;
}

/** Provenance edges inside a coordinated transaction scoped to the concept's source. */
export async function addManagedProvenanceLinks(engine: BrainEngine, sourceId: string, links: LinkBatchInput[]): Promise<number> {
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () =>
    tx.addLinksBatch(links, { auditSite: 'cycle.synthesize_concepts.provenance' }))); // gbrain-allow-direct-insert: concept-provenance edges derived from the synthesis itself, inside the coordinated transaction
}

/**
 * The synthesized narrative is the only part of a concept page this phase
 * owns. Republishing an existing concept keeps everything else the page
 * already carries: its `## Facts` / `## Takes` fences (the system of record
 * for those rows; dropping them would expire every fact and delete every take
 * on publication), its timeline, its tags, and any frontmatter keys the
 * synthesis does not set.
 */
export function composeConceptRepublication(page: Pick<Page, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>,
  tags: string[], synthesized: Record<string, unknown>, narrative: string): string {
  const compiled = preserveCanonicalFences(page, narrative);
  const { type: _type, title: _title, tags: _tags, ...kept } = (page.frontmatter ?? {}) as Record<string, unknown>;
  return serializeMarkdown({ ...kept, ...synthesized }, compiled, (page.timeline ?? '').trim(),
    { type: page.type ?? 'concept', title: page.title, tags });
}

/**
 * Carry a page's existing `## Facts` / `## Takes` fences into a replacement
 * body written by a model or a synthesis phase, which owns only the prose. Any
 * fence in the replacement is dropped and the original blocks are inserted
 * verbatim, so publication neither expires fence facts nor deletes takes.
 * Throws a hold (`concept_preservation_hold`) when the original fences are
 * ambiguous or the result would not carry exactly the original rows.
 */
export function preserveCanonicalFences(page: Pick<Page, 'compiled_truth' | 'timeline'>, replacement: string): string {
  const hold = conceptPreservationHold(page);
  if (hold) throw conceptHoldError(hold);
  const body = page.compiled_truth ?? '';
  let compiled = stripTakesFence(stripFactsFence(replacement)).trim();
  const facts = fenceBlock(body, FACTS_FENCE_BEGIN, FACTS_FENCE_END);
  if (facts) compiled = replaceOrInsertFactsFence(compiled, facts).trimEnd();
  const takes = fenceBlock(body, TAKES_FENCE_BEGIN, TAKES_FENCE_END);
  if (takes) compiled = `${compiled}\n\n## Takes\n\n${takes}`;
  const out = parseMarkdown(serializeMarkdown({}, compiled, (page.timeline ?? '').trim(), { type: 'note', title: 'x', tags: [] }), 'page');
  if (JSON.stringify(canonicalRows(out.compiled_truth)) !== JSON.stringify(canonicalRows(body))
    || (out.timeline ?? '').trim() !== (page.timeline ?? '').trim()) {
    throw conceptHoldError('CONCEPT_REPUBLICATION_LOSSY: composed page would not preserve the existing fences or timeline');
  }
  return compiled;
}

function canonicalRows(body: string): { facts: unknown[]; takes: unknown[] } {
  return { facts: parseFactsFence(body).facts, takes: parseTakesFence(body).takes };
}

/**
 * Why an existing concept page cannot be republished losslessly, or null.
 * Each fence must occur at most once, be balanced, parse without warnings and
 * sit above the timeline sentinel; anything else holds the concept untouched.
 */
export function conceptPreservationHold(page: Pick<Page, 'compiled_truth' | 'timeline'>): string | null {
  const body = page.compiled_truth ?? '';
  const timeline = page.timeline ?? '';
  for (const [name, begin, end] of [['FACTS', FACTS_FENCE_BEGIN, FACTS_FENCE_END], ['TAKES', TAKES_FENCE_BEGIN, TAKES_FENCE_END]] as const) {
    if (timeline.includes(begin) || timeline.includes(end)) return `CONCEPT_${name}_FENCE_BELOW_SENTINEL: a ${name.toLowerCase()} fence marker sits in the timeline`;
    const begins = body.split(begin).length - 1, ends = body.split(end).length - 1;
    if (begins > 1 || ends > 1) return `CONCEPT_${name}_FENCE_DUPLICATE: more than one ${name.toLowerCase()} fence`;
    if (begins !== ends) return `CONCEPT_${name}_FENCE_UNBALANCED: ${name.toLowerCase()} fence begin/end markers do not pair`;
  }
  const warnings = [...parseFactsFence(body).warnings, ...parseTakesFence(body).warnings];
  return warnings.length ? `CONCEPT_FENCE_UNPARSEABLE: ${warnings[0]}` : null;
}

function fenceBlock(body: string, begin: string, end: string): string | null {
  const start = body.indexOf(begin);
  if (start === -1) return null;
  const stop = body.indexOf(end, start + begin.length);
  return stop === -1 ? null : body.slice(start, stop + end.length);
}
