/**
 * #9653 (PR 2): a concept the input purge hid comes back. purge's hideDerivedRows soft-deletes a concept derived from a
 * purged input and marks it needs_rederive with marked_at equal to the deleted_at it set; while that mark is open the
 * automatic purge keeps the tombstone (purge-deleted.ts readRederiveHeldConcepts). The next synthesis builds the concept
 * again from its current members and publishes it over the same row (same id, slug and incoming links) as a first
 * publication: in that transaction, under the page's lock, it confirms the hold and the members again, clears every
 * store that holds text of the old body, writes the page, drops every version archived before the revive and closes the
 * mark. A concept a person or a sync deleted has no such mark and is never revived. Input edges (derivation_inputs) are
 * never dropped; the publication adds the current members' edges. Everything lives in the database, so a repo-less brain
 * gets it unchanged.
 */
import type { BrainEngine, PageSnapshot } from '../engine.ts';
import { scrubPurgedSlugs } from '../feedback/store.ts';
import { expireGonePageFacts } from '../facts/gone-page-facts.ts';
import { scrubPurgedNameStores } from './purge-name-stores.ts';
import { scrubPurgedSlugHolds, scrubPurgedSlugStores } from './purge-slug-stores.ts';
import { OWED_PURGE_OP } from './derived-origin-hold.ts';
import { clearRebuildableCache } from './rebuildable-cache.ts';
import { findRequestsForSlugs, redactRequestIntents } from './intent-redaction.ts';
import { stripPageGitNotes } from '../facts/purge-reasons.ts';
import { scrubGenerationLedger } from '../generations/ledger-scrub.ts';

/** The tombstone a synthesis rebuilds, and the members (with the revisions it read) its narrative was built from. */
export interface ConceptRevive { page_id: number; deleted_us: string; members: Array<{ slug: string; revision: string }> }

type Sql = Pick<BrainEngine, 'executeRaw'>;

/** The revive a stored maintenance intent carries (`concept_revive`), or null when absent or malformed. */
export function readConceptRevive(value: unknown): ConceptRevive | null {
  const v = value as Partial<ConceptRevive> | null | undefined;
  if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.page_id) || typeof v.deleted_us !== 'string' || !Array.isArray(v.members)) return null;
  if (v.members.some(m => !m || typeof m.slug !== 'string' || typeof m.revision !== 'string')) return null;
  return v as ConceptRevive;
}

/**
 * Every column holding a foreign key to pages (test/concept-revive-stores-9653.test.ts reads them from the schema and
 * fails on one missing here): `cleared` rows hold text of the old body (or state built from it) and are deleted before
 * the page is written (page_versions after it, since the write archives the tombstone); `kept` rows hold none, with the
 * reason; `refused` rows exist only for a segmented body, and a page with any is never revived.
 */
export const REVIVE_PAGE_REFERENCES: Readonly<Record<string, readonly ['cleared' | 'kept' | 'refused', string]>> = {
  'chronicle_page_state.page_id': ['kept', 'processing state: content hashes and event slugs, no page text'],
  'content_chunks.page_id': ['cleared', 'chunks of the old body'],
  'entity_identities.page_id': ['kept', 'identity ids, no page text'],
  'extract_atoms_page_state.page_id': ['kept', 'a content hash; the new body hashes differently'],
  'files.page_id': ['kept', 'files a writer attached to the page, never derived from its body'],
  'guest_marks.page_id': ['kept', 'who wrote the page, no page text'],
  'guest_promotions.guest_page_id': ['kept', 'who promoted the page, no page text'],
  'link_edge_proposals.a_to_page_id': ['kept', 'proposals written from another page\'s text'],
  'link_edge_proposals.b_to_page_id': ['kept', 'proposals written from another page\'s text'],
  'link_edge_proposals.ending_to_page_id': ['kept', 'proposals written from another page\'s text'],
  'link_edge_proposals.from_page_id': ['cleared', 'proposals generated from the old body'],
  'link_relationships.from_page_id': ['kept', 'relationship state: link types and evidence hashes, no page text'],
  'link_relationships.to_page_id': ['kept', 'relationship state: link types and evidence hashes, no page text'],
  'link_transitions.from_page_id': ['kept', 'transition ledger: line hashes, no page text'],
  'link_transitions.origin_page_id': ['kept', 'transition ledger: line hashes, no page text'],
  'link_transitions.to_page_id': ['kept', 'transition ledger: line hashes, no page text'],
  'links.from_page_id': ['cleared', 'links the old body wrote (concept-provenance edges stay; the publication reconciles them to the current members)'],
  'links.origin_page_id': ['cleared', 'links the old body wrote between other pages'],
  'links.to_page_id': ['kept', 'incoming links: other pages\' text, kept with the row'],
  'page_body_manifest.page_id': ['refused', 'a segmented body'],
  'page_body_stagings.page_id': ['refused', 'a staged segmented body'],
  'page_derivation_spend.page_id': ['kept', 'spend counters, no page text'],
  'page_embedding_budget.page_id': ['kept', 'embedding budget state, no page text'],
  'page_extraction_state.page_id': ['kept', 'extraction watermarks (hashes), no page text'],
  'page_facts_reconcile.page_id': ['kept', 'a reconcile outcome, no page text'],
  'page_label_guards.page_id': ['kept', 'the page\'s held privacy labels, never widened by a rebuild'],
  'page_mention_state.page_id': ['cleared', 'the mention index state of the old title, so the new one is indexed'],
  'page_segment_derivations.page_id': ['refused', 'derivations of a segmented body'],
  'page_versions.page_id': ['cleared', 'every version archived before the revive, the tombstone\'s own included'],
  'page_view_digests.page_id': ['kept', 'revision-keyed hashes, no page text'],
  'raw_data.page_id': ['cleared', 'source data stored with the old page'],
  'secret_store_occurrence.page_id': ['kept', 'pointers into the secret store, no page text'],
  'synthesis_evidence.synthesis_page_id': ['cleared', 'evidence rows of the old synthesis'],
  'tags.page_id': ['cleared', 'the old page\'s tags; the publication writes the new frontmatter\'s'],
  'takes.page_id': ['cleared', 'takes of the old body'],
  'timeline_entries.event_page_id': ['kept', 'other pages\' timeline rows that name this page'],
  'timeline_entries.page_id': ['cleared', 'timeline rows of the old body'],
  'wanted_links.origin_page_id': ['cleared', 'wanted links found in the old body'],
};

/**
 * Every store a hard purge scrubs outside the foreign keys, keyed as its receipts name them: the slug and name stores
 * the retention purge calls (purge-deleted.ts: scrubPurgedSlugs, scrubPurgedNameStores, scrubPurgedSlugStores,
 * scrubPurgedSlugHolds, expireGonePageFacts) and the managed purge's sweep (page-purge.ts PURGE_SWEEP_STORES, the query
 * cache). `cleared` on revive, `kept` with the reason it never holds text derived from the page body, or `refused`: a
 * page with such a row is never revived.
 */
export const REVIVE_SLUG_STORES: Readonly<Record<string, readonly ['cleared' | 'kept' | 'refused', string]>> = {
  retrieval_event_pages: ['cleared', 'retrieval telemetry of the old page'],
  retrieval_event_links: ['cleared', 'retrieval telemetry of the old page\'s links'],
  retrieval_feedback: ['cleared', 'feedback on the old page'],
  retrieval_weights: ['cleared', 'weights learned on the old page'],
  'eval_candidates.retrieved_slugs': ['cleared', 'captured queries that retrieved the old page'],
  context_volunteer_events: ['cleared', 'rationales quoting the old page\'s names'],
  mention_gazetteer_entries: ['cleared', 'the old title and aliases; the mention pass indexes the new ones'],
  take_proposals: ['cleared', 'takes proposed from the old body'],
  open_loops: ['cleared', 'loops detected in the old body'],
  core_edit_notices: ['cleared', 'notices keeping a copy of the old body'],
  page_aliases: ['cleared', 'the old frontmatter\'s aliases; the publication writes the new ones'],
  slug_aliases: ['kept', 'redirects to this slug name slugs only'],
  slug_rename_history: ['kept', 'rename rows name slugs only'],
  write_gate_holds: ['cleared', 'held writes up to the delete (a later write stays for review)'],
  write_gate_receipts: ['cleared', 'receipts of the cleared holds'],
  facts: ['cleared', 'facts filed on, extracted from or about the old page (expired, as a purge expires them)'],
  decide_review_queue: ['cleared', 'review rows about the old page\'s facts'],
  decide_review_proposals: ['cleared', 'review proposals about the old page\'s facts'],
  decide_proposals: ['cleared', 'proposals about the old page\'s facts'],
  trust_proposals: ['cleared', 'tier proposals about the old page, its facts or takes'],
  persistence_requests: ['cleared', 'the page\'s finished requests, whose intents hold the old body (redacted as a purge redacts them; on a managed brain, whose purge redacts them too)'],
  persistence_effects: ['cleared', 'commit lines and trailers of the page\'s Git effects (on a managed brain, as persistence_requests)'],
  files: ['kept', 'files a writer attached to the page, never derived from its body'],
  derived_generations: ['cleared', 'the generation ledger of the slug'],
  derived_generation_items: ['cleared', 'the generation ledger items of the slug, preimages included'],
  op_checkpoints: ['refused', 'an owner purge is owed for the page: it is purged, never revived'],
  query_cache: ['cleared', 'cached answers that may quote the old body'],
};

const HELD_SQL = `p.deleted_at IS NOT NULL AND p.type = 'concept' AND coalesce(p.frontmatter->>'synthesized_by', '') LIKE 'synthesize_concepts%'
  AND coalesce(p.body_storage, 'inline') <> 'segmented'
  AND EXISTS (SELECT 1 FROM needs_rederive n WHERE n.derived_table = 'pages' AND n.derived_id = p.id::text AND n.marked_at = p.deleted_at)
  AND NOT EXISTS (SELECT 1 FROM page_body_manifest r WHERE r.page_id = p.id) AND NOT EXISTS (SELECT 1 FROM page_body_stagings r WHERE r.page_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM page_segment_derivations r WHERE r.page_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM op_checkpoints o WHERE o.op = '${OWED_PURGE_OP}' AND o.fingerprint = p.id::text)`;
const DELETED_US = `floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text`;

/**
 * The revive a synthesis would publish for `snapshot`, a tombstone: null unless the concept is held (hidden only by an
 * input purge, still written by synthesis, with an inline body). Records each member at `read`, the revision its body was
 * read at for the narrative (else its current one), so the publication refuses when a member changed after that read.
 */
export async function heldConceptRevive(engine: Sql, sourceId: string, snapshot: PageSnapshot, members: readonly string[],
  read: ReadonlyArray<string | undefined> = []): Promise<ConceptRevive | null> {
  const [held] = await engine.executeRaw<{ deleted_us: string }>(`SELECT ${DELETED_US} AS deleted_us FROM pages p WHERE p.id = $1 AND ${HELD_SQL}`, [snapshot.page.id]);
  if (!held) return null;
  const rows = await engine.executeRaw<{ slug: string; revision: string }>(`SELECT slug, knowledge_revision::text AS revision FROM pages
    WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`, [sourceId, [...new Set(members)]]);
  if (!rows.length || rows.length !== new Set(members).size) return null;
  const readAt = new Map(members.flatMap((slug, i) => read[i] === undefined ? [] : [[slug, read[i]!] as const]));
  return { page_id: Number(snapshot.page.id), deleted_us: held.deleted_us, members: rows.map(({ slug, revision }) => ({ slug, revision: readAt.get(slug) ?? revision })) };
}

/** Whether `revive` still names a held tombstone at the same delete (admission's check; the publication confirms it again under the lock). */
export async function conceptReviveHeld(engine: Sql, revive: ConceptRevive): Promise<boolean> {
  return (await engine.executeRaw(`SELECT 1 FROM pages p WHERE p.id = $1 AND ${DELETED_US} = $2 AND ${HELD_SQL}`, [revive.page_id, revive.deleted_us])).length > 0;
}

/**
 * Inside the publication's transaction, before the page write: confirms the concept is still held at the same delete
 * and every member is live at the revision the narrative read (locking them against a purge), then clears the stores
 * REVIVE_PAGE_REFERENCES and REVIVE_SLUG_STORES name. Returns why it published nothing, or null.
 */
export async function beginConceptRevive(tx: BrainEngine, sourceId: string, slug: string, revive: ConceptRevive, opts: { journal: boolean }): Promise<string | null> {
  const [held] = await tx.executeRaw<{ id: number }>(`SELECT p.id FROM pages p WHERE p.id = $1 AND p.source_id = $2 AND p.slug = $3
    AND ${DELETED_US} = $4 AND ${HELD_SQL} FOR UPDATE`, [revive.page_id, sourceId, slug, revive.deleted_us]);
  if (!held) return 'The concept is no longer held for a rebuild (a person or sync deleted it, a purge removed it, or it was published), so the rebuild published nothing.';
  const members = revive.members.map(member => member.slug);
  const live = await tx.executeRaw<{ slug: string }>(`SELECT m.slug FROM pages m JOIN jsonb_to_recordset($2::text::jsonb) AS r(slug text, revision text)
    ON m.slug = r.slug AND m.knowledge_revision::text = r.revision WHERE m.source_id = $1 AND m.deleted_at IS NULL FOR SHARE OF m`,
  [sourceId, JSON.stringify(revive.members)]);
  if (!members.length || live.length !== members.length) return 'A member the rebuilt narrative was built from changed or was removed during synthesis, so the rebuild published nothing; the next run builds it again.';
  const facts = (await tx.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND (source_markdown_slug = $2 OR entity_slug = $2)`, [sourceId, slug])).map(row => Number(row.id));
  const takes = (await tx.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id = $1', [revive.page_id])).map(row => Number(row.id));
  const refs = facts.map(String);
  await tx.executeRaw('DELETE FROM decide_review_queue WHERE source_id = $1 AND (a_ref = ANY($2::text[]) OR b_ref = ANY($2::text[]))', [sourceId, refs]);
  await tx.executeRaw('DELETE FROM decide_review_proposals WHERE source_id = $1 AND (a_ref = ANY($2::text[]) OR b_ref = ANY($2::text[]))', [sourceId, refs]);
  await tx.executeRaw('DELETE FROM decide_proposals WHERE source_id = $1 AND (new_fact_id = ANY($2::bigint[]) OR old_fact_id = ANY($2::bigint[]))', [sourceId, facts]);
  await tx.executeRaw(`DELETE FROM trust_proposals WHERE source_id = $1 AND ((target_table = 'pages' AND target_id = $2) OR (related_table = 'pages' AND related_id = $2)
    OR (target_table = 'facts' AND target_id = ANY($3::bigint[])) OR (related_table = 'facts' AND related_id = ANY($3::bigint[]))
    OR (target_table = 'takes' AND target_id = ANY($4::bigint[])) OR (related_table = 'takes' AND related_id = ANY($4::bigint[])))`, [sourceId, revive.page_id, facts, takes]);
  await tx.executeRaw(`DELETE FROM write_gate_receipts WHERE (target_table = 'pages' AND target_id = $1) OR (target_table = 'facts' AND target_id = ANY($2::text[]))
    OR (target_table = 'takes' AND target_id = ANY($3::text[]))`, [String(revive.page_id), refs, takes.map(String)]);
  for (const [key, [action]] of Object.entries(REVIVE_PAGE_REFERENCES)) {
    if (action !== 'cleared' || key === 'page_versions.page_id') continue;
    const [table, column] = key.split('.');
    const keep = key === 'links.from_page_id' ? " AND link_source IS DISTINCT FROM 'concept-provenance'" : '';
    await tx.executeRaw(`DELETE FROM ${table} WHERE ${column} = $1${keep}`, [revive.page_id]);
  }
  const [{ deleted_at }] = await tx.executeRaw<{ deleted_at: string }>('SELECT deleted_at::text AS deleted_at FROM pages WHERE id = $1', [revive.page_id]);
  await expireGonePageFacts(tx, [{ source_id: sourceId, slug }]);
  await scrubPurgedSlugs(tx, sourceId, [slug]);
  await scrubPurgedNameStores(tx, sourceId, [slug]);
  await scrubPurgedSlugStores(tx, sourceId, [slug], { keep: Object.keys(REVIVE_SLUG_STORES).filter(store => REVIVE_SLUG_STORES[store]![0] === 'kept') });
  await scrubPurgedSlugHolds(tx, sourceId, [{ slug, deletedAt: deleted_at }]);
  await clearRebuildableCache(tx, 'query_cache');
  if (opts.journal) {
    await redactRequestIntents(tx, await findRequestsForSlugs(tx, sourceId, [slug]), undefined, { skipPending: true });
    await stripPageGitNotes(tx, sourceId, slug);
  }
  await scrubGenerationLedger(tx, sourceId, { slug });
  return null;
}

/** When a tombstone's recovery window ends: its own delete plus `hours` (UTC, to the second), and whether that has passed. */
export async function tombstoneWindow(tx: Sql, pageId: number, hours: number): Promise<{ until: string; past: boolean } | null> {
  const [window] = await tx.executeRaw<{ until: string; past: boolean }>(`SELECT to_char((deleted_at + ($2 || ' hours')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS until,
    deleted_at + ($2 || ' hours')::interval <= now() AS past FROM pages WHERE id = $1 AND deleted_at IS NOT NULL`, [pageId, String(hours)]);
  return window ?? null;
}

/** After the page write, in the same transaction: drops every version archived before the revive and closes the mark. */
export async function finishConceptRevive(tx: Sql, revive: ConceptRevive): Promise<void> {
  await tx.executeRaw('DELETE FROM page_versions WHERE page_id = $1', [revive.page_id]);
  const closed = await tx.executeRaw(`DELETE FROM needs_rederive WHERE derived_table = 'pages' AND derived_id = $1
    AND EXISTS (SELECT 1 FROM pages WHERE id = $2 AND deleted_at IS NULL) RETURNING 1`, [String(revive.page_id), revive.page_id]);
  if (!closed.length) {
    throw Object.assign(new Error('The rebuilt concept was not written (the import refused it), so the rebuild published nothing and the concept stays held.'), { code: 'revision_conflict' });
  }
}
