/**
 * The dream cycle statements (src/core/engine-sql/dream-cycle.ts) other than the config rows (dream-config.ts): the
 * retriage, lock, child-job and synthesis-key reads over the store's jobs and cycle locks
 * (rust/crates/gbrain-store/src/jobs/dream_reads.rs), and the provenance stamp, consolidation, atom, synthesis, pre-run
 * revision and journal reads over its pages, facts, takes, versions and write journal
 * (rust/crates/gbrain-store/src/dream_reads.rs). rust/docs/store/dream.md maps each statement.
 *
 * The store returns timestamps as ISO text; these members give them back as Dates, as PGLite does. The
 * `request` of `listCommittedOutputRequests` stays as `row_to_json` writes it, timestamps as text.
 *
 * Export only BrainEngine members from this file (index.ts spreads the module into STORE_MEMBERS); helpers stay
 * unexported.
 */
import type * as DreamCycleSql from '../../engine-sql/dream-cycle.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { privacyAliasSql, privatePagesFilterFragment, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { requestRow } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import { ownerOnlyFormIn } from './private-provenance.ts';

/** The no-caller page policy of `privatePagesFilterFragment`, which decides whether an atom page is private. */
function atomPolicy() {
  const fragment = privatePagesFilterFragment('p');
  return {
    honorAliases: fragment.includes(privacyAliasSql('p')),
    entityPrivacy: fragment.includes(privateSnapshotFilterFragment('p')),
    ownerOnly: ownerOnlyFormIn(fragment, 'pages', 'p'),
  };
}

const date = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string));
const numbers = (ids: readonly number[]) => ids.map(Number);

export const listDreamQueueCandidates: StoreMember<[], DreamCycleSql.DreamQueueCandidate[]> = brain =>
  storeCall({ member: 'listDreamQueueCandidates' }, () => brain.listDreamQueueCandidates());

export const listLiveDreamCycleLocks: StoreMember<[graceSecs: number], DreamCycleSql.LiveDreamCycleLock[]> = async (brain, graceSecs) => {
  const secs = Number(graceSecs);
  if (!Number.isFinite(secs)) throw new Error(`listLiveDreamCycleLocks: the steal grace must be a number, got ${String(graceSecs)}`);
  return storeCall({ member: 'listLiveDreamCycleLocks' }, () => brain.listLiveDreamCycleLocks(secs));
};

export const readDreamJobStatus: StoreMember<[id: number], { status: string } | null> = (brain, id) =>
  storeCall({ member: 'readDreamJobStatus' }, () => brain.readDreamJobStatus(Number(id)));

export const stampDreamPageProvenance: StoreMember<[stamp: DreamCycleSql.DreamPageProvenanceStamp], void> = async (brain, stamp) => {
  await storeCall({ member: 'stampDreamPageProvenance' }, () => brain.stampDreamPageProvenance({
    slug: stamp.slug,
    sourceId: stamp.sourceId,
    cycleDate: stamp.cycleDate,
    firstWriteAt: stamp.firstWriteAt?.toISOString() ?? null,
    clearSeat: stamp.clearSeat,
    frontmatter: stamp.frontmatter,
  }));
};

export const listDreamPageIds: StoreMember<[slug: string, sourceId: string], Array<{ id: number }>> = (brain, slug, sourceId) =>
  storeCall({ member: 'listDreamPageIds' }, () => brain.listDreamPageIds(sourceId, slug));

export const countDreamProvenancePages: StoreMember<
  [sourceId: string, cycleDate: string, summarySlug: string, writtenSlugs: string[]],
  DreamCycleSql.DreamProvenanceCounts | null
> = (brain, sourceId, cycleDate, summarySlug, writtenSlugs) =>
  storeCall({ member: 'countDreamProvenancePages' }, () =>
    brain.countDreamProvenancePages({ sourceId, cycleDate, summarySlug, writtenSlugs: [...writtenSlugs] }));

export const listConsolidationClaimValues: StoreMember<[ids: number[]], DreamCycleSql.ConsolidationClaimValue[]> = (brain, ids) =>
  storeCall({ member: 'listConsolidationClaimValues' }, () => brain.listConsolidationClaimValues(numbers(ids)));

export const setConsolidatedFactValidUntil: StoreMember<[validUntil: Date, id: number], void> = async (brain, validUntil, id) => {
  await storeCall({ member: 'setConsolidatedFactValidUntil' }, () =>
    brain.setConsolidatedFactValidUntil(validUntil.toISOString(), Number(id)));
};

export const listReadersSourcedFactIds: StoreMember<[ids: number[]], Array<{ id: number }>> = (brain, ids) =>
  storeCall({ member: 'listReadersSourcedFactIds' }, () => brain.listReadersSourcedFactIds(numbers(ids)));

export const findConsolidationPageIds: StoreMember<[sourceId: string, slug: string], Array<{ id: number }>> = (brain, sourceId, slug) =>
  storeCall({ member: 'findConsolidationPageIds' }, () => brain.listDreamPageIds(sourceId, slug));

export const readConsolidationTakesMaxRowNum: StoreMember<[pageId: number], number> = (brain, pageId) =>
  storeCall({ member: 'readConsolidationTakesMaxRowNum' }, () => brain.readConsolidationTakesMaxRowNum(Number(pageId)));

export const findConsolidatedTakes: StoreMember<[pageId: number, claim: string], DreamCycleSql.ConsolidatedTake[]> = async (brain, pageId, claim) => {
  const rows: Array<{ id: number; resolved_at: string | null }> = await storeCall({ member: 'findConsolidatedTakes' }, () =>
    brain.findConsolidatedTakes(Number(pageId), claim));
  return rows.map(row => ({ id: row.id, resolved_at: date(row.resolved_at) }));
};

export const refreshConsolidatedTakeSource: StoreMember<[source: string, id: number], void> = async (brain, source, id) => {
  await storeCall({ member: 'refreshConsolidatedTakeSource' }, () => brain.refreshConsolidatedTakeSource(source, Number(id)));
};

export const findConsolidatedTakeIds: StoreMember<[pageId: number, rowNum: number], Array<{ id: number }>> = (brain, pageId, rowNum) =>
  storeCall({ member: 'findConsolidatedTakeIds' }, () => brain.findConsolidatedTakeIds(Number(pageId), Number(rowNum)));

export const listConsolidationClaimShapes: StoreMember<[ids: number[]], DreamCycleSql.ConsolidationClaimShapeRow[]> = (brain, ids) =>
  storeCall({ member: 'listConsolidationClaimShapes' }, () => brain.listConsolidationClaimShapes(numbers(ids)));

export const listRetainedDreamOutputSources: StoreMember<[sourceId: string], Array<{ raw_source: string }>> = (brain, sourceId) =>
  storeCall({ member: 'listRetainedDreamOutputSources' }, () => brain.listRetainedDreamOutputSources(sourceId));

export const listDreamAtomPages: StoreMember<[sourceId: string], DreamCycleSql.DreamAtomPage[]> = (brain, sourceId) =>
  storeCall({ member: 'listDreamAtomPages' }, () => brain.listDreamAtomPages(sourceId, atomPolicy()));

export const listSynthesisPageBodies: StoreMember<
  [sourceId: string, slugs: string[]],
  Array<{ slug: string; title: string | null; body: string | null }>
> = (brain, sourceId, slugs) =>
  storeCall({ member: 'listSynthesisPageBodies' }, () => brain.listSynthesisPageBodies(sourceId, [...slugs]));

export const readDreamVerifyEpoch: StoreMember<[], unknown> = async brain =>
  date(await storeCall({ member: 'readDreamVerifyEpoch' }, () => brain.readDreamVerifyEpoch()));

export const listDreamJobCreatedAt: StoreMember<[ids: number[]], Array<{ id: number | string; created_at: unknown }>> = async (brain, ids) => {
  const rows: Array<{ id: number; created_at: string }> = await storeCall({ member: 'listDreamJobCreatedAt' }, () =>
    brain.listDreamJobCreatedAt(numbers(ids)));
  return rows.map(row => ({ id: row.id, created_at: date(row.created_at) }));
};

export const readDreamPreRunRevision: StoreMember<
  [slug: string, sourceId: string, sinceIso: string],
  DreamCycleSql.DreamPreRunRevision | null
> = (brain, slug, sourceId, sinceIso) =>
  storeCall({ member: 'readDreamPreRunRevision' }, () => brain.readDreamPreRunRevision(sourceId, slug, sinceIso));

export const listCompletedSynthJobs: StoreMember<[key: string], Array<{ id: number; idempotency_key: string }>> = (brain, key) =>
  storeCall({ member: 'listCompletedSynthJobs' }, () => brain.listCompletedSynthJobs(key));

export const countCoalescibleSynthJobs: StoreMember<[keys: string[]], number> = (brain, keys) =>
  storeCall({ member: 'countCoalescibleSynthJobs' }, () => brain.countCoalescibleSynthJobs([...keys]));

export const listWaitingChildJobIds: StoreMember<[queue: string], Array<{ id: number }>> = (brain, queue) =>
  storeCall({ member: 'listWaitingChildJobIds' }, () => brain.listWaitingChildJobIds(queue));

export const listDreamChildJobTimings: StoreMember<[ids: number[]], DreamCycleSql.DreamChildJobTiming[]> = async (brain, ids) => {
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'listDreamChildJobTimings' }, () =>
    brain.listDreamChildJobTimings(numbers(ids)));
  return rows.map(row => ({
    created_at: date(row.created_at)!,
    started_at: date(row.started_at),
    finished_at: date(row.finished_at),
    tokens_input: row.tokens_input as number | null,
    tokens_output: row.tokens_output as number | null,
    tokens_cache_read: row.tokens_cache_read as number | null,
  }));
};

export const countRecentDreamSynthSubmissions: StoreMember<[sourceId: string], number> = (brain, sourceId) =>
  storeCall({ member: 'countRecentDreamSynthSubmissions' }, () => brain.countRecentDreamSynthSubmissions(sourceId));
