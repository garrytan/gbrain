/**
 * #9653: a concept the input purge hid is rebuilt as a new page. purge's hideDerivedRows soft-deletes a concept derived
 * from a purged input and marks it needs_rederive with marked_at equal to the deleted_at it set; while that mark is open
 * the automatic purge keeps the tombstone (purge-deleted.ts readRederiveHeldConcepts). The next synthesis, after its
 * model call, hard-purges that one tombstone through the purge's own code and writes a fresh concept at the slug from
 * the current members only. Unmanaged, both run in one transaction under the page lock; managed, the retention purge
 * is submitted pinned to the tombstone's revision and the publish follows only once its receipt shows it committed.
 * A purged slug is written again by any later synthesis, so a run that stops between the two leaves nothing a person
 * must fix. A concept carrying anything a person or an agent stated, or whose fresh access would be wider than the
 * tombstone's, is never rebuilt: it stays hidden and held. The rebuild's retention purge is no person's delete, so any
 * later record of "a person deleted this concept" must stay outside it. Everything lives in the database, so a
 * repo-less brain gets it unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine, PageSnapshot } from '../engine.ts';
import type { MaintenanceAuthority } from './prepared-maintenance.ts';
import type { ClaimPhaseClock } from './claim-phase.ts';
import type { GBrainConfig } from '../config.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { linkStreamSlugs, redactExpiredPageJournal } from './page-purge.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import { withBeliefBatch } from '../belief/ledger.ts';
import { markBeliefCommits } from '../belief/append.ts';
import { pendingRequestId } from '../cycle/dream-write-deferral.ts';
import { PRIVACY_ALIASES } from '../search/private-visibility.ts';
import { preservedConceptSections } from '../cycle/concept-sections.ts';
import { BOUNDED_PREFIX_BYTES } from '../page-window/document.ts';
import type { RebuildAccess } from '../engine-sql/concept-rebuild.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';

/** The tombstone a synthesis rebuilds: its row, delete instant and revision, and the members (at the revisions read). */
export interface ConceptRebuild { page_id: number; deleted_us: string; revision: string; members: Array<{ slug: string; revision: string }> }

/** Why a held concept is not rebuilt: something a person or an agent stated (with the kinds), no model, or wider access. */
export type RebuildKept = { source_id: string; slug: string } & ({ reason: 'stated'; kinds: string[] } | { reason: 'no_model' } | { reason: 'access'; why: string });


/** Frontmatter keys only an owner or an agent sets on a concept (synthesis writes visibility alone): any of them is stated. */
const STATED_LABEL_KEYS: readonly string[] = [...Object.keys(PRIVACY_ALIASES), 'readable_by', 'pinned_question', 'derived_from'];

/** Link provenances a reconciler derives from page text; any other one (add_link's 'manual' or a caller's tag) is stated. */
const DERIVED_LINK_SOURCES = ['markdown', 'frontmatter', 'mentions', 'wikilink-resolved', 'concept-provenance'];

/**
 * Every store a hard purge of a page removes rows from, keyed as the purge receipt names them
 * (test/concept-purge-rebuild-9653.test.ts fails on a receipt key missing here). `stated`: a row there was stated by a
 * person or an agent, and a concept with one is never rebuilt (statedKinds checks each). `derived`: rows built from the
 * page's own body or kept as telemetry, which the purge drops and the fresh page rebuilds as needed.
 */
export const REBUILD_STORES: Readonly<Record<string, 'stated' | 'derived'>> = {
  facts: 'stated', takes: 'stated', timeline_entries: 'stated', page_aliases: 'stated', slug_aliases: 'stated', tags: 'stated',
  files: 'stated', raw_data: 'stated', secret_store: 'stated', secret_store_occurrence: 'stated', core_edit_notices: 'stated', write_gate_holds: 'stated', write_gate_receipts: 'stated', links: 'stated', labels: 'stated',
  pages: 'derived', page_versions: 'derived', content_chunks: 'derived', query_cache: 'derived', take_proposals: 'derived', open_loops: 'derived',
  slug_rename_history: 'derived', trust_proposals: 'derived', decide_proposals: 'derived', decide_review_queue: 'derived',
  decide_review_proposals: 'derived', persistence_requests: 'derived', persistence_effects: 'derived', derived_generations: 'derived',
  derived_generation_items: 'derived', retrieval_event_pages: 'derived', retrieval_event_links: 'derived', retrieval_feedback: 'derived',
  retrieval_weights: 'derived', 'eval_candidates.retrieved_slugs': 'derived', mention_gazetteer_entries: 'derived',
  context_volunteer_events: 'derived', op_checkpoints: 'derived', belief_events: 'derived',
  page_body_manifest: 'derived', page_body_stagings: 'derived', page_segment_texts: 'derived',
};

/**
 * Every column of links (test/concept-purge-rebuild-9653.test.ts fails on one missing here, and on a carried one
 * engine-sql/concept-rebuild.ts CARRIED_LINK_COLUMNS does not list). An incoming link the fresh page takes over keeps each carried column; to_page_id, and an origin_page_id naming the old row, point at the fresh row.
 */
export const REBUILD_LINK_COLUMNS: Readonly<Record<string, 'carried' | 'regenerated'>> = {
  id: 'regenerated', from_page_id: 'carried', to_page_id: 'carried', link_type: 'carried', context: 'carried', link_source: 'carried',
  link_kind: 'carried', origin_page_id: 'carried', origin_field: 'carried', resolution_type: 'carried', created_at: 'carried', assertion_tense: 'carried',
};

/** Frontmatter keys synthesis and its write path set on a concept (synthesize-concepts.ts, serializeMarkdown, the trust stamp); any other key keeps it hidden. */
const SYNTHESIS_KEYS: readonly string[] = ['type', 'title', 'trust_tier', 'tier', 'mention_count', 'composite_score', 'synthesis_mode', 'member_hash',
  'synthesized_at', 'synthesized_by', 'visibility', 'unverified_claims'];

const WIDER = 'its current members are all world-readable and the hidden concept was not';


/** What the concept carries that synthesis did not write, as kinds; empty when it carries nothing else. */
export async function statedKinds(engine: Pick<BrainEngine, 'readConceptStatedKinds'>, pageId: number, sourceId: string, slug: string): Promise<string[]> {
  const row = await engine.readConceptStatedKinds(pageId, sourceId, slug, { derivedLinkSources: DERIVED_LINK_SOURCES, statedLabelKeys: STATED_LABEL_KEYS, synthesisKeys: SYNTHESIS_KEYS });
  // A body past the bounded lead is not scanned, so it may hold curated sections and counts as if it did.
  const unread = row?.segmented === true || (row?.lead ?? '').length >= BOUNDED_PREFIX_BYTES;
  return [...row?.kinds ?? [], ...unread || preservedConceptSections(row?.lead ?? '').length ? ['curated_sections'] : []];
}

/** Whether the tombstone `pageId` is still held for a rebuild at the delete `deletedUs` recorded when synthesis read it. */
export async function stillHeld(engine: Pick<BrainEngine, 'isConceptStillHeld'>, pageId: number, deletedUs: string): Promise<boolean> {
  return engine.isConceptStillHeld(pageId, deletedUs);
}

/**
 * Under a managed retention purge's lock: why the purge of a concept tombstone held at `hold` must not run (it is no
 * longer held at that delete, or something was stated on it since), or null. `hold` is the purge's internal concept_hold.
 */
export async function conceptPurgeRefusal(tx: BrainEngine, sourceId: string, slug: string, hold: unknown): Promise<string | null> {
  const { page_id: pageId, deleted_us: deletedUs } = (hold ?? {}) as { page_id?: unknown; deleted_us?: unknown };
  if (typeof pageId !== 'number' || typeof deletedUs !== 'string') return 'its concept hold is malformed';
  if (!await stillHeld(tx, pageId, deletedUs)) return 'the concept is no longer held for a rebuild (a person or sync deleted, restored or purged it)';
  const kinds = await statedKinds(tx, pageId, sourceId, slug);
  return kinds.length ? `something was stated on the concept since synthesis read it (${kinds.join(', ')})` : null;
}

/** Whether every member is live at the revision its body was read at; inside a transaction it locks them against a purge. */
export async function membersUnchanged(engine: Pick<BrainEngine, 'lockLiveConceptMembers'>, sourceId: string, members: ConceptRebuild['members']): Promise<boolean> {
  return members.length > 0 && await engine.lockLiveConceptMembers(sourceId, members) === members.length;
}

/** Who may read a page, as the read predicate decides it: compared before and after a rebuild (rebuildWidens). */
export type { RebuildAccess } from '../engine-sql/concept-rebuild.ts';

export async function readRebuildAccess(engine: Pick<BrainEngine, 'readRebuildAccess'>, pageId: number): Promise<RebuildAccess | null> {
  return engine.readRebuildAccess(pageId);
}

/** Why the fresh page would be readable by someone who could not read the tombstone, or null. Anything it cannot tell widens. */
export function rebuildWidens(before: RebuildAccess | null | undefined, after: RebuildAccess | null | undefined): string | null {
  if (!before || !after) return 'its access could not be read';
  const within = (inner: readonly string[] | null, outer: readonly string[] | null) => (inner ?? []).every(id => (outer ?? []).includes(id));
  if (!before.open && after.open) return 'it would be readable by any caller';
  if (!before.public_part && after.public_part) return 'it would no longer be private';
  if (before.readers && (!after.readers || !within(after.readers, before.readers))) return 'it would name readers the hidden concept did not';
  if (before.page_readers && (!after.page_readers || !within(after.page_readers, before.page_readers))) return 'its stored readers would widen';
  if (before.folder_rule_ids && (!after.folder_rule_ids || !within(before.folder_rule_ids, after.folder_rule_ids))) return 'a folder rule would stop covering it';
  return null;
}

/**
 * The rebuild a synthesis would run for `snapshot`, a tombstone. Null when the concept is not held (a person or a sync
 * deleted it, or an owner purge is owed); `kept` when it is held but carries something stated, or when its fresh
 * visibility (`visibility`, derived from the current members) would be wider than the tombstone's. Records each
 * member at `read`, the revision its body was read at for the narrative, so the rebuild refuses when one moved.
 */
export async function heldConceptRebuild(engine: BrainEngine, sourceId: string, snapshot: PageSnapshot, members: readonly string[],
  read: ReadonlyArray<string | undefined>, visibility: 'private' | 'world'): Promise<{ rebuild: ConceptRebuild } | { kept: RebuildKept } | null> {
  const pageId = Number(snapshot.page.id);
  const held = await engine.readHeldConcept(pageId);
  if (!held) return null;
  const slug = snapshot.page.slug;
  const kinds = await statedKinds(engine, pageId, sourceId, slug);
  if (kinds.length) return { kept: { source_id: sourceId, slug, reason: 'stated', kinds } };
  const access = await readRebuildAccess(engine, pageId);
  if (!access || (visibility === 'world' && !access.public_part)) return { kept: { source_id: sourceId, slug, reason: 'access', why: WIDER } };
  const rows = await engine.listLiveConceptMemberRevisions(sourceId, members);
  if (!rows.length || rows.length !== new Set(members).size) return null;
  const readAt = new Map(members.flatMap((m, i) => read[i] === undefined ? [] : [[m, read[i]!] as const]));
  return { rebuild: { page_id: pageId, deleted_us: held.deleted_us, revision: snapshot.revision,
    members: rows.map(row => ({ slug: row.slug, revision: readAt.get(row.slug) ?? row.revision })) } };
}

/**
 * Unmanaged, inside the rebuild's transaction and under the page lock: confirms the concept is still held at the same
 * delete, carries nothing stated and every member is live at the revision the narrative read (locking them against a
 * purge), then hard-purges the tombstone with the expiry's own statements (engine purgeDeletedPages, onlyIds). Returns
 * why it purged nothing, or the tombstone's access and the incoming links the fresh page takes over.
 */
async function purgeHeldConcept(tx: BrainEngine, sourceId: string, slug: string, rebuild: ConceptRebuild): Promise<string | { parked: string } | { access: RebuildAccess; incoming: unknown[]; oldId: number }> {
  if (!await tx.lockHeldConcept(rebuild.page_id, sourceId, slug, rebuild.deleted_us)) return 'The concept is no longer held for a rebuild (a person or sync deleted, restored or purged it), so the rebuild wrote nothing.';
  if ((await statedKinds(tx, rebuild.page_id, sourceId, slug)).length) return 'Something was stated on the concept during synthesis, so the rebuild wrote nothing and it stays held.';
  if (!await membersUnchanged(tx, sourceId, rebuild.members)) return 'A member the rebuilt narrative was built from changed or was removed during synthesis, so the rebuild wrote nothing; the next run builds it again.';
  const access = await readRebuildAccess(tx, rebuild.page_id);
  const incoming = await tx.listConceptIncomingLinks(rebuild.page_id);
  const { parkUncarriedInPurge } = await import('../repair/origin-carry.ts');
  if ((await parkUncarriedInPurge(tx, [rebuild.page_id])).length) {
    return { parked: 'A page written since depends on the concept for its privacy, so the concept is parked until the next purge labels it and the rebuild wrote nothing.' };
  }
  const purged = await tx.purgeDeletedPages(0, { onlyIds: [rebuild.page_id] });
  if (purged.count !== 1 || !access) return 'The tombstone is held by another purge rule, so the rebuild wrote nothing and it stays held.';
  await redactExpiredPageJournal(tx, sourceId, [slug]);
  return { access, incoming, oldId: rebuild.page_id };
}

/** Unmanaged, after the fresh write in the same transaction: points the incoming links at it and confirms it reads no wider. */
async function finishConceptRebuild(tx: BrainEngine, sourceId: string, slug: string, before: { access: RebuildAccess; incoming: unknown[]; oldId: number }): Promise<void> {
  const fresh = await tx.carryConceptIncomingLinks(sourceId, slug, before.incoming, before.oldId);
  if (!fresh) throw Object.assign(new Error('The rebuilt concept was not written (the import refused it), so the rebuild wrote nothing and the concept stays held.'), { code: 'revision_conflict' });
  const widened = rebuildWidens(before.access, await readRebuildAccess(tx, Number(fresh.id)));
  if (widened) {
    const error: Error & { code?: string } = new Error(`The rebuilt concept would be readable more widely than the hidden one (${widened}), so the rebuild wrote nothing and the concept stays held.`);
    error.code = 'revision_conflict';
    throw error;
  }
}

/**
 * Unmanaged: one transaction purges the held tombstone, writes the fresh page through `write` and carries the incoming
 * links over. Like the expiry of a recorded tombstone (purge-deleted.ts), it runs in one belief batch over the page and
 * its link streams, so the ledger ends the old page's lifetime as `page.expired` and the fresh page starts a new one.
 */
export async function rebuildHeldConcept(engine: BrainEngine, sourceId: string, slug: string, rebuild: ConceptRebuild, write: (tx: BrainEngine) => Promise<unknown>): Promise<void> {
  const publicationId = randomUUID(), report = { appended: 0 };
  let parked: string | undefined;
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    const slugs = [...new Set([slug, ...await linkStreamSlugs(tx, sourceId, rebuild.page_id)])].sort();
    await tx.lockPageKeys(slugs.map(key => ({ sourceId, slug: key })));
    await withBeliefBatch(tx, { sourceId, slugs, publicationId, op: 'purge_deleted_pages', hardDeleteEvent: 'page.expired', report }, async () => {
      const before = await purgeHeldConcept(tx, sourceId, slug, rebuild);
      if (typeof before === 'string') throw Object.assign(new Error(before), { code: 'revision_conflict' });
      if ('parked' in before) { parked = before.parked; return; }
      await write(tx);
      await finishConceptRebuild(tx, sourceId, slug, before);
    });
  });
  if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
  if (parked) throw Object.assign(new Error(parked), { code: 'revision_conflict' });
}

/** GST-3179: the write owner's preparer for that maintenance kind: the same retention purge a delete_page prepares. */
export async function prepareConceptPurge(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, clock?: ClaimPhaseClock): Promise<PreparedMutation> {
  const { preparePageMutation } = await import('./page-prepare.ts');
  return preparePageMutation(engine, { ...row, operation: 'delete_page' }, config, undefined, undefined, { clock });
}

/**
 * Managed: submits the retention purge of the tombstone, pinned to the revision the synthesis read and to the delete it
 * was held at (`concept_hold`, re-checked with what was stated under the purge's lock: conceptPurgeRefusal), so a
 * person's edit, restore, delete or statement in between refuses it. True only when its receipt shows the purge committed; a pending, failed or
 * refused purge returns why, and the next synthesis handles whatever it finds.
 */
export async function submitHeldConceptPurge(engine: BrainEngine, authority: MaintenanceAuthority, sourceId: string, slug: string, rebuild: ConceptRebuild): Promise<true | string> {
  if (!await membersUnchanged(engine, sourceId, rebuild.members)) return 'a member the rebuilt narrative was built from changed or was removed during synthesis';
  if (!await stillHeld(engine, rebuild.page_id, rebuild.deleted_us)) return 'the concept is no longer held for a rebuild (a person or sync deleted, restored or purged it)';
  if ((await statedKinds(engine, rebuild.page_id, sourceId, slug)).length) return 'something was stated on the concept during synthesis';
  try {
    // GST-3179: its own maintenance kind, so a write owner too old to re-check the hold refuses it instead of purging.
    const purged = await (await import('./prepared-maintenance.ts')).submitMaintenanceIntent(engine, authority, slug, { kind: 'managed_maintenance_concept_purge', expected_revision: rebuild.revision,
      deleted_page: true, purge: true, retention: true, concept_hold: { page_id: rebuild.page_id, deleted_us: rebuild.deleted_us } }, randomUUID());
    return purged.status === 'purged' ? true : `the purge of the hidden concept did not commit (${String(purged.status ?? 'no status')})`;
  } catch (error) {
    const pending = pendingRequestId(error);
    if (pending) return `the purge of the hidden concept is accepted and still pending (request_id ${pending})`;
    return `the purge of the hidden concept was refused: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Every held concept and, for those the next synthesis will not rebuild, why (the purge previews name them). `model`:
 * whether a synthesis model is configured; without one a concept built from many atoms is not rebuilt.
 */
export async function readHeldConcepts(engine: Pick<BrainEngine, 'readHeldConceptRows' | 'readConceptStatedKinds'>, model: boolean): Promise<{ held: Array<{ source_id: string; slug: string }>; kept: RebuildKept[] }> {
  // Report-only: a failed read leaves the previews without it, never the purge or the status that asked for it. A typed
  // capability refusal is rethrown instead of reporting no held concepts.
  return readHeldConceptRows(engine, model).catch((e: unknown) => {
    rethrowCapabilityRefusal(e);
    console.warn(`[purge] held-concept report skipped: ${e instanceof Error ? e.message : String(e)}`);
    return { held: [], kept: [] };
  });
}

async function readHeldConceptRows(engine: Pick<BrainEngine, 'readHeldConceptRows' | 'readConceptStatedKinds'>, model: boolean): Promise<{ held: Array<{ source_id: string; slug: string }>; kept: RebuildKept[] }> {
  const rows = await engine.readHeldConceptRows();
  const kept: RebuildKept[] = [];
  for (const row of rows) {
    const kinds = await statedKinds(engine, Number(row.id), row.source_id, row.slug);
    if (kinds.length) kept.push({ source_id: row.source_id, slug: row.slug, reason: 'stated', kinds });
    else if (row.private && !row.members_private) kept.push({ source_id: row.source_id, slug: row.slug, reason: 'access', why: WIDER });
    else if (!model) kept.push({ source_id: row.source_id, slug: row.slug, reason: 'no_model' });
  }
  return { held: rows.map(({ source_id, slug }) => ({ source_id, slug })), kept };
}

/** When a tombstone's recovery window ends: its own delete plus `hours` (UTC, to the second), and whether that has passed. */
export async function tombstoneWindow(tx: Pick<BrainEngine, 'readTombstoneWindow'>, pageId: number, hours: number): Promise<{ until: string; past: boolean } | null> {
  return tx.readTombstoneWindow(pageId, hours);
}

/** One preview line per kept concept, naming its reason. */
export function keptReason(kept: RebuildKept): string {
  if (kept.reason === 'stated') return `${kept.source_id}/${kept.slug}: stays hidden, it carries what a person or an agent stated (${kept.kinds.join(', ')})`;
  if (kept.reason === 'access') return `${kept.source_id}/${kept.slug}: stays hidden, a rebuild would be readable more widely (${kept.why})`;
  return `${kept.source_id}/${kept.slug}: stays hidden, no synthesis model is configured to rebuild it`;
}
