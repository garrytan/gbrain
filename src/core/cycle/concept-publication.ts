/**
 * Managed publication of `synthesize_concepts` output (#5484).
 *
 * On a managed brain the phase publishes each concept page through the
 * maintenance coordinator (`publishMaintenancePage`) instead of the legacy
 * `importFromContent` writer, which a managed brain refuses. The caller keeps
 * the #5525 order: publish private, bank provenance edges, then promote.
 */
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { preservedConceptSections, stripPreservedConceptSections } from './concept-sections.ts';
import type { Page } from '../types.ts';
import { assertInlineBody, isSegmentedPage, pageBodySegmentedError } from '../page-body/page-shape.ts';
import { serializeMarkdown, parseMarkdown } from '../markdown.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, replaceOrInsertFactsFence, stripFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, stripTakesFence } from '../takes-fence.ts';
import { isDbOnly, loadStorageConfig } from '../storage-config.ts';
import { publishMaintenancePage, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { acquirePageLock } from '../page-lock.ts';
import { derivedFileTarget, writeDerivedPageThrough } from './derived-write-through.ts';
import { fileDatabaseDriftToken, replaceableFile } from '../facts/file-body-guard.ts';
import { declareDerivation, deriveTrust, lowerDerivedPage } from '../trust/taint.ts';

/** #5575 I2: the narrative carries the tier of the member atoms its prompt was built from (capped at agent_written). */
const conceptDerivation = (engine: BrainEngine, sourceId: string, members: readonly string[]) =>
  deriveTrust(engine, [...new Set(members)].map(slug => ({ table: 'pages' as const, sourceId, slug })), { channel: 'derive:concepts' });

/** Error code for a concept held because republication could lose canonical material. */
export const CONCEPT_PRESERVATION_CODE = 'concept_preservation_hold';
/** Codes that mean the page moved under a concurrent writer; the next run retries. */
export const CONCEPT_DEFERRAL_CODES = new Set(['revision_conflict', 'page_identity_changed']);
/** Error code for a concept whose database row published but whose file write failed. */
export const CONCEPT_WRITE_THROUGH_FAILED_CODE = 'concept_write_through_failed';
/** Codes that hold a concept until an operator imports or repairs its page (`page_body_segmented`: its body moved to segments during synthesis). */
export const CONCEPT_HOLD_CODES = new Set(['source_changed', CONCEPT_PRESERVATION_CODE, CONCEPT_WRITE_THROUGH_FAILED_CODE, 'page_body_segmented']);

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
  slug: string, synthesized: Record<string, unknown>, narrative: string, expectedRevision: string | null, brainDir?: string,
  members?: readonly string[]): Promise<string | null> {
  const derivation = members ? await conceptDerivation(engine, authority.writer.sourceId, members) : null;
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
    { expectedRevision: snapshot?.revision ?? null, file: !dbOnly, ...(derivation ? { derivation: declareDerivation(derivation.trust, derivation.inputs) } : {}) });
  return typeof receipt.revision === 'string' ? receipt.revision : null;
}

/**
 * A published concept's provenance edges (#4589; GBRA-161 PR 5, C-4): banks `links` and retires the concept-provenance
 * edges to atoms that left the member group, in one transaction (coordinated on a managed brain) and only while the concept
 * is still at `expectedRevision`, the revision its publication produced (null: read here, right after an unmanaged
 * publication released its page lock). Edges retire only here, when a concept generation replaced the previous one; a
 * concept that moved since changes no edge (`moved`) and the next run reconciles it.
 */
export async function replaceConceptProvenanceLinks(engine: BrainEngine, sourceId: string, conceptSlug: string, links: LinkBatchInput[],
  opts: { expectedRevision: string | null; managed: boolean }): Promise<{ inserted: number; retired: number } | 'moved'> {
  const members = [...new Set(links.filter(link => link.from_slug === conceptSlug).map(link => link.to_slug))];
  const expectedRevision = opts.expectedRevision ?? (await engine.readPageSnapshot(conceptSlug, { sourceId }))?.revision ?? null;
  const write = async (tx: BrainEngine) => {
    const [current] = await tx.executeRaw<{ revision: string }>(
      'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR SHARE', [sourceId, conceptSlug]);
    if (!current || current.revision !== expectedRevision) return 'moved' as const;
    const stale = await tx.executeRaw<{ from_slug: string; to_slug: string; link_type: string; from_source_id: string; to_source_id: string }>(
      `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, f.source_id AS from_source_id, t.source_id AS to_source_id
         FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
        WHERE l.link_source = 'concept-provenance'
          AND ((f.source_id = $1 AND f.slug = $2 AND NOT (t.source_id = $1 AND t.slug = ANY($3::text[])))
            OR (t.source_id = $1 AND t.slug = $2 AND NOT (f.source_id = $1 AND f.slug = ANY($3::text[]))))`, [sourceId, conceptSlug, members]);
    let retired = 0;
    for (const edge of stale) {
      retired += await tx.removeLink(edge.from_slug, edge.to_slug, edge.link_type, 'concept-provenance', { fromSourceId: edge.from_source_id, toSourceId: edge.to_source_id });
    }
    const inserted = links.length ? await tx.addLinksBatch(links, { auditSite: 'cycle.synthesize_concepts.provenance' }) : 0; // gbrain-allow-direct-insert: concept-provenance edges derived from the synthesis itself, under the concept's revision fence
    return { inserted, retired };
  };
  if (!opts.managed) return engine.transaction(write);
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => write(tx), attribution));
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
 * Curated `## Facets` / `## Merged` sections (#6161: the record of a concept
 * merge) are carried the same way. Throws a hold
 * (`concept_preservation_hold`) when the original fences are ambiguous or the
 * result would not carry exactly the original rows and sections. A segmented
 * page refuses with `page_body_segmented`: its fences live in segments.
 */
export function preserveCanonicalFences(page: Pick<Page, 'compiled_truth' | 'timeline' | 'body_storage'>, replacement: string): string {
  assertInlineBody(page, 'preserveCanonicalFences');
  const hold = conceptPreservationHold(page);
  if (hold) throw conceptHoldError(hold);
  const body = page.compiled_truth ?? '';
  let compiled = stripPreservedConceptSections(stripTakesFence(stripFactsFence(replacement))).trim();
  const sections = preservedConceptSections(body);
  if (sections.length) compiled = [compiled, ...sections].join('\n\n');
  const facts = fenceBlock(body, FACTS_FENCE_BEGIN, FACTS_FENCE_END);
  if (facts) compiled = replaceOrInsertFactsFence(compiled, facts).trimEnd();
  const takes = fenceBlock(body, TAKES_FENCE_BEGIN, TAKES_FENCE_END);
  if (takes) compiled = `${compiled}\n\n## Takes\n\n${takes}`;
  const out = parseMarkdown(serializeMarkdown({}, compiled, (page.timeline ?? '').trim(), { type: 'note', title: 'x', tags: [] }), 'page');
  if (JSON.stringify(canonicalRows(out.compiled_truth)) !== JSON.stringify(canonicalRows(body))
    || JSON.stringify(preservedConceptSections(out.compiled_truth)) !== JSON.stringify(sections)
    || (out.timeline ?? '').trim() !== (page.timeline ?? '').trim()) {
    throw conceptHoldError('CONCEPT_REPUBLICATION_LOSSY: composed page would not preserve the existing fences, curated sections or timeline');
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

/**
 * The hold publication would raise for an existing concept page, as the
 * `<code>: <message>` the phase records, or null when it can be republished:
 * a segmented body (`page_body_segmented`) or fences it cannot carry
 * losslessly (`concept_preservation_hold`). Checked before any model spend.
 */
export function conceptPublicationHold(page: Pick<Page, 'compiled_truth' | 'timeline' | 'body_storage' | 'slug' | 'source_id'>): string | null {
  if (isSegmentedPage(page)) return `page_body_segmented: ${pageBodySegmentedError(page, 'synthesize_concepts').message}`;
  const hold = conceptPreservationHold(page);
  return hold ? `${CONCEPT_PRESERVATION_CODE}: ${hold}` : null;
}

function fenceBlock(body: string, begin: string, end: string): string | null {
  const start = body.indexOf(begin);
  if (start === -1) return null;
  const stop = body.indexOf(end, start + begin.length);
  return stop === -1 ? null : body.slice(start, stop + end.length);
}

/**
 * A page body without its `## Facts` / `## Takes` sections (each fence block
 * and its heading): the part of an atom or concept this phase reads as
 * narrative. The member hash, the synthesis prompt and the concurrent-change
 * check all use it, so a fact or take added to a page is not a narrative
 * change.
 */
export function stripFenceSections(body: string): string {
  return stripTakesFence(stripFactsFence(body ?? ''))
    .split('\n').filter((line) => !/^##\s+(?:facts|takes)\s*$/i.test(line.trim())).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Publish one concept page on an unmanaged brain (D-N3). Under the page lock
 * the fence writers take, the page is re-read: when its narrative changed
 * since `baseline` (the narrative the synthesis started from) or another
 * writer took it over, nothing is written and the concept is deferred
 * (`revision_conflict`) to the next run. #6982: when the page's canonical
 * file exists and holds anything the database lacks (`replaceableFile`: it
 * equals neither the page nor one of its recent versions, which covers a hand
 * edit sync has not imported and an unindexed file at a new concept's path),
 * nothing is written and the concept is deferred (`revision_conflict`, its
 * message naming the page with `file_database_drift` and the fix).
 * Otherwise the new narrative is composed with the page's latest `## Facts`
 * / `## Takes` fences, timeline, tags and frontmatter from the database, so
 * a take or fact appended during synthesis survives. The page's file is
 * rewritten when it already has one (a stale file would otherwise be synced
 * back over the new narrative) or when `cycle.synthesize_concepts.write_through`
 * is on (#5041). `importPage` writes the composed markdown to the database;
 * the file write is then bound to the bytes compared under the lock, so an
 * edit made while the import ran is kept and the concept deferred, and a
 * failed file write holds the concept (`concept_write_through_failed`).
 * Returns the narrative now on the page (the next call's baseline).
 */
export async function publishClassicConcept(engine: BrainEngine, slug: string, sourceId: string,
  synthesized: Record<string, unknown>, narrative: string, baseline: string,
  opts: { writeThrough: boolean; importPage: (markdown: string) => Promise<unknown>; members?: readonly string[] }): Promise<string> {
  const lock = await acquirePageLock(slug, { timeoutMs: 5_000 });
  if (!lock) throw Object.assign(new Error('The concept page is locked by another writer.'), { code: 'revision_conflict' });
  try {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    const page = snapshot?.page ?? null;
    if (stripFenceSections(page?.compiled_truth ?? '') !== stripFenceSections(baseline)
      || (page && !String(page.frontmatter?.synthesized_by ?? '').startsWith('synthesize_concepts'))) {
      throw Object.assign(new Error('The concept narrative changed during synthesis.'), { code: 'revision_conflict' });
    }
    const title = slug.split('/').pop()!.replace(/-/g, ' ');
    const resolved = await derivedFileTarget(engine, slug, sourceId);
    const file = resolved.ok ? await replaceableFile(engine, sourceId, slug, resolved.target.filePath) : null;
    if (file && !file.ok) {
      throw Object.assign(new Error(fileDatabaseDriftToken(slug, sourceId, 'before', 'the concept was not published')), { code: 'revision_conflict' });
    }
    const markdown = page
      ? composeConceptRepublication(page, snapshot!.tags, synthesized, narrative)
      : serializeMarkdown(synthesized, narrative, '', { type: 'concept', title, tags: [] });
    await opts.importPage(markdown);
    // The import stamps the page by its own channel; the derivation lowers it to the members' taint and records the edges.
    if (opts.members) await lowerDerivedPage(engine, await conceptDerivation(engine, sourceId, opts.members), sourceId, slug);
    if (file && (file.expectedFileBytes !== null || opts.writeThrough)) {
      const written = await writeDerivedPageThrough(engine, slug, sourceId, { expectedFileBytes: file.expectedFileBytes });
      if (written.skipped === 'file_changed') {
        throw Object.assign(new Error('The concept file changed while the page was published; the edit was kept.'), { code: 'revision_conflict' });
      }
      if (written.error) {
        throw Object.assign(new Error(`The concept file was not written: ${written.error}`), { code: CONCEPT_WRITE_THROUGH_FAILED_CODE });
      }
    }
    return narrative;
  } finally {
    await lock.release();
  }
}

export function conceptProvenanceLinks(sourceId: string, conceptSlug: string, members: readonly string[]): LinkBatchInput[] {
  return [...new Set(members)].flatMap(atomSlug => [
    { from_slug: conceptSlug, to_slug: atomSlug, link_type: 'synthesized_from', link_source: 'concept-provenance', context: 'member atom', from_source_id: sourceId, to_source_id: sourceId },
    { from_slug: atomSlug, to_slug: conceptSlug, link_type: 'synthesizes', link_source: 'concept-provenance', context: 'concept synthesized from this atom', from_source_id: sourceId, to_source_id: sourceId },
  ]);
}

/** Complete a cached generation with the native revision-fenced provenance writer. */
export async function repairConceptProvenance(engine: BrainEngine, sourceId: string, conceptSlug: string,
  members: readonly string[], managed: boolean, expectedRevision: string): Promise<{ added: number; complete: boolean }> {
  const links = conceptProvenanceLinks(sourceId, conceptSlug, members);
  const key = (l: Pick<LinkBatchInput, 'from_source_id' | 'from_slug' | 'to_source_id' | 'to_slug' | 'link_type'>) =>
    JSON.stringify([l.from_source_id, l.from_slug, l.to_source_id, l.to_slug, l.link_type]);
  const complete = async () => {
    const rows = (await Promise.all([engine.getLinks(conceptSlug, { sourceId }), engine.getBacklinks(conceptSlug, { sourceId })])).flat();
    const banked = new Set(rows.filter(l => l.link_source === 'concept-provenance').map(key));
    return links.every(l => banked.has(key(l)));
  };
  if (await complete()) return { added: 0, complete: true };
  const lock = await acquirePageLock(conceptSlug, { timeoutMs: 5_000 });
  if (!lock) throw Object.assign(new Error('The concept is locked by another writer.'), { code: 'revision_conflict' });
  try {
    const resolved = await derivedFileTarget(engine, conceptSlug, sourceId);
    if (resolved.ok && !(await replaceableFile(engine, sourceId, conceptSlug, resolved.target.filePath)).ok)
      throw Object.assign(new Error('The concept file differs from its indexed generation.'), { code: 'revision_conflict' });
    const result = await replaceConceptProvenanceLinks(engine, sourceId, conceptSlug, links, { expectedRevision, managed });
    if (result === 'moved') throw Object.assign(new Error('The cached concept changed.'), { code: 'revision_conflict' });
    return { added: result.inserted, complete: await complete() };
  } finally { await lock.release(); }
}
