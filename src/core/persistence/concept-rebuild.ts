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
import type { BrainEngine, LinkBatchInput, PageSnapshot } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { loadConfig } from '../config.ts';
import { submitPageMutation } from './page-mutations.ts';
import { maintenancePublishWaitMs } from './maintenance-wait.ts';
import { pendingRequestId } from '../cycle/dream-write-deferral.ts';
import { OWED_PURGE_OP } from './derived-origin-hold.ts';
import { extractedFromPageSql } from '../facts/gone-page-facts.ts';
import { PRIVACY_ALIASES, privacyPartSql, privatePagesFilterFragment } from '../search/private-visibility.ts';

type Sql = Pick<BrainEngine, 'executeRaw'>;

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
  files: 'stated', core_edit_notices: 'stated', write_gate_holds: 'stated', write_gate_receipts: 'stated', links: 'stated', labels: 'stated',
  pages: 'derived', page_versions: 'derived', content_chunks: 'derived', query_cache: 'derived', take_proposals: 'derived', open_loops: 'derived',
  slug_rename_history: 'derived', trust_proposals: 'derived', decide_proposals: 'derived', decide_review_queue: 'derived',
  decide_review_proposals: 'derived', persistence_requests: 'derived', persistence_effects: 'derived', derived_generations: 'derived',
  derived_generation_items: 'derived', retrieval_event_pages: 'derived', retrieval_event_links: 'derived', retrieval_feedback: 'derived',
  retrieval_weights: 'derived', 'eval_candidates.retrieved_slugs': 'derived', mention_gazetteer_entries: 'derived',
  context_volunteer_events: 'derived', op_checkpoints: 'derived', belief_events: 'derived', raw_data: 'derived',
  page_body_manifest: 'derived', page_body_stagings: 'derived', page_segment_texts: 'derived',
};

const WIDER = 'its current members are all world-readable and the hidden concept was not';

const HELD_SQL = `p.deleted_at IS NOT NULL AND p.type = 'concept' AND coalesce(p.frontmatter->>'synthesized_by', '') LIKE 'synthesize_concepts%'
  AND EXISTS (SELECT 1 FROM needs_rederive n WHERE n.derived_table = 'pages' AND n.derived_id = p.id::text AND n.marked_at = p.deleted_at)
  AND NOT EXISTS (SELECT 1 FROM op_checkpoints o WHERE o.op = '${OWED_PURGE_OP}' AND o.fingerprint = p.id::text)`;
const DELETED_US = `floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text`;

/** What a person or an agent stated on or about the concept row `$1` (source `$2`, slug `$3`), as REBUILD_STORES kinds. */
const STATED_SQL = `SELECT array_remove(ARRAY[
  CASE WHEN EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $2 AND (f.entity_slug = $3 OR f.source_markdown_slug = $3) AND NOT ${extractedFromPageSql('f', '$3')}) THEN 'facts' END,
  CASE WHEN EXISTS (SELECT 1 FROM takes t WHERE t.page_id = $1) THEN 'takes' END,
  CASE WHEN EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = $1) THEN 'timeline_entries' END,
  CASE WHEN EXISTS (SELECT 1 FROM links l WHERE (l.to_page_id = $1 OR l.from_page_id = $1) AND l.link_source IS NOT NULL
    AND l.link_source <> ALL($4::text[])) THEN 'links' END,
  CASE WHEN EXISTS (SELECT 1 FROM tags t WHERE t.page_id = $1) THEN 'tags' END,
  CASE WHEN EXISTS (SELECT 1 FROM files x WHERE x.page_id = $1) THEN 'files' END,
  CASE WHEN EXISTS (SELECT 1 FROM page_aliases a WHERE a.source_id = $2 AND a.slug = $3) THEN 'page_aliases' END,
  CASE WHEN EXISTS (SELECT 1 FROM slug_aliases a WHERE a.source_id = $2 AND a.canonical_slug = $3) THEN 'slug_aliases' END,
  CASE WHEN EXISTS (SELECT 1 FROM core_edit_notices c WHERE c.source_id = $2 AND c.slug = $3) THEN 'core_edit_notices' END,
  CASE WHEN EXISTS (SELECT 1 FROM write_gate_holds h WHERE h.source_id = $2 AND h.slug = $3) THEN 'write_gate_holds' END,
  CASE WHEN EXISTS (SELECT 1 FROM page_label_guards g WHERE g.page_id = $1) OR EXISTS (SELECT 1 FROM pages p WHERE p.id = $1
    AND p.frontmatter ?| $5::text[]) THEN 'labels' END
], NULL) AS kinds`;

/** The kinds of stated rows the concept carries; empty when it carries none. */
export async function statedKinds(engine: Sql, pageId: number, sourceId: string, slug: string): Promise<string[]> {
  const [row] = await engine.executeRaw<{ kinds: string[] | null }>(STATED_SQL, [pageId, sourceId, slug, DERIVED_LINK_SOURCES, STATED_LABEL_KEYS]);
  return row?.kinds ?? [];
}

/** Who may read a page, as the read predicate decides it: compared before and after a rebuild (rebuildWidens). */
export interface RebuildAccess { open: boolean; public_part: boolean; readers: string[] | null; page_readers: string[] | null; folder_rule_ids: string[] | null }
const ACCESS_SQL = `SELECT ${privatePagesFilterFragment('p')} AS open, ${privacyPartSql('p')} AS public_part, gbrain_access_readers(p.frontmatter) AS readers,
  p.page_readers, p.folder_rule_ids FROM pages p WHERE p.id = $1`;

export async function readRebuildAccess(engine: Sql, pageId: number): Promise<RebuildAccess | null> {
  return (await engine.executeRaw<RebuildAccess>(ACCESS_SQL, [pageId]))[0] ?? null;
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
export async function heldConceptRebuild(engine: Sql, sourceId: string, snapshot: PageSnapshot, members: readonly string[],
  read: ReadonlyArray<string | undefined>, visibility: 'private' | 'world'): Promise<{ rebuild: ConceptRebuild } | { kept: RebuildKept } | null> {
  const pageId = Number(snapshot.page.id);
  const [held] = await engine.executeRaw<{ deleted_us: string }>(`SELECT ${DELETED_US} AS deleted_us FROM pages p WHERE p.id = $1 AND ${HELD_SQL}`, [pageId]);
  if (!held) return null;
  const slug = snapshot.page.slug;
  const kinds = await statedKinds(engine, pageId, sourceId, slug);
  if (kinds.length) return { kept: { source_id: sourceId, slug, reason: 'stated', kinds } };
  const access = await readRebuildAccess(engine, pageId);
  if (!access || (visibility === 'world' && !access.public_part)) return { kept: { source_id: sourceId, slug, reason: 'access', why: WIDER } };
  const rows = await engine.executeRaw<{ slug: string; revision: string }>(`SELECT slug, knowledge_revision::text AS revision FROM pages
    WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`, [sourceId, [...new Set(members)]]);
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
export async function purgeHeldConcept(tx: BrainEngine, sourceId: string, slug: string, rebuild: ConceptRebuild): Promise<string | { access: RebuildAccess; incoming: LinkBatchInput[] }> {
  const [held] = await tx.executeRaw<{ id: number }>(`SELECT p.id FROM pages p WHERE p.id = $1 AND p.source_id = $2 AND p.slug = $3
    AND ${DELETED_US} = $4 AND ${HELD_SQL} FOR UPDATE OF p`, [rebuild.page_id, sourceId, slug, rebuild.deleted_us]);
  if (!held) return 'The concept is no longer held for a rebuild (a person or sync deleted, restored or purged it), so the rebuild wrote nothing.';
  if ((await statedKinds(tx, rebuild.page_id, sourceId, slug)).length) return 'Something was stated on the concept during synthesis, so the rebuild wrote nothing and it stays held.';
  const live = await tx.executeRaw(`SELECT m.slug FROM pages m JOIN jsonb_to_recordset($2::text::jsonb) AS r(slug text, revision text)
    ON m.slug = r.slug AND m.knowledge_revision::text = r.revision WHERE m.source_id = $1 AND m.deleted_at IS NULL FOR SHARE OF m`, [sourceId, JSON.stringify(rebuild.members)]);
  if (!rebuild.members.length || live.length !== rebuild.members.length) return 'A member the rebuilt narrative was built from changed or was removed during synthesis, so the rebuild wrote nothing; the next run builds it again.';
  const access = await readRebuildAccess(tx, rebuild.page_id);
  const incoming = await tx.executeRaw<LinkBatchInput>(`SELECT f.slug AS from_slug, $2::text AS to_slug, l.link_type, l.context, l.link_source,
    o.slug AS origin_slug, l.origin_field, f.source_id AS from_source_id, $3::text AS to_source_id, o.source_id AS origin_source_id
    FROM links l JOIN pages f ON f.id = l.from_page_id LEFT JOIN pages o ON o.id = l.origin_page_id
    WHERE l.to_page_id = $1 AND l.from_page_id <> $1 AND f.deleted_at IS NULL`, [rebuild.page_id, slug, sourceId]);
  const purged = await tx.purgeDeletedPages(0, { onlyIds: [rebuild.page_id] });
  if (purged.count !== 1 || !access) return 'The tombstone is held by another purge rule, so the rebuild wrote nothing and it stays held.';
  return { access, incoming };
}

/** Unmanaged, after the fresh write in the same transaction: points the incoming links at it and confirms it reads no wider. */
export async function finishConceptRebuild(tx: BrainEngine, sourceId: string, slug: string, before: { access: RebuildAccess; incoming: LinkBatchInput[] }): Promise<void> {
  const [fresh] = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
  if (!fresh) throw Object.assign(new Error('The rebuilt concept was not written (the import refused it), so the rebuild wrote nothing and the concept stays held.'), { code: 'revision_conflict' });
  if (before.incoming.length) await tx.addLinksBatch(before.incoming);
  const widened = rebuildWidens(before.access, await readRebuildAccess(tx, Number(fresh.id)));
  if (widened) {
    const error: Error & { code?: string } = new Error(`The rebuilt concept would be readable more widely than the hidden one (${widened}), so the rebuild wrote nothing and the concept stays held.`);
    error.code = 'revision_conflict';
    throw error;
  }
}

/**
 * Managed: submits the retention purge of the tombstone, pinned to the revision the synthesis read, so a person's edit,
 * restore or delete in between refuses it. True only when its receipt shows the purge committed; a pending, failed or
 * refused purge returns why, and the next synthesis handles whatever it finds.
 */
export async function submitHeldConceptPurge(engine: BrainEngine, sourceId: string, slug: string, rebuild: ConceptRebuild): Promise<true | string> {
  const live = await engine.executeRaw(`SELECT m.slug FROM pages m JOIN jsonb_to_recordset($2::text::jsonb) AS r(slug text, revision text)
    ON m.slug = r.slug AND m.knowledge_revision::text = r.revision WHERE m.source_id = $1 AND m.deleted_at IS NULL`, [sourceId, JSON.stringify(rebuild.members)]);
  if (live.length !== rebuild.members.length) return 'a member the rebuilt narrative was built from changed or was removed during synthesis';
  const [held] = await engine.executeRaw(`SELECT 1 FROM pages p WHERE p.id = $1 AND ${DELETED_US} = $2 AND ${HELD_SQL}`, [rebuild.page_id, rebuild.deleted_us]);
  if (!held) return 'the concept is no longer held for a rebuild (a person or sync deleted, restored or purged it)';
  if ((await statedKinds(engine, rebuild.page_id, sourceId, slug)).length) return 'something was stated on the concept during synthesis';
  const ctx: OperationContext = { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, sourceId, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
  try {
    const purged = await submitPageMutation(ctx, { operation: 'delete_page', waitMs: maintenancePublishWaitMs(), params: { slug, source_id: sourceId,
      purge: true, retention: true, expected_revision: rebuild.revision, request_id: randomUUID() } });
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
export async function readHeldConcepts(engine: Sql, model: boolean): Promise<{ held: Array<{ source_id: string; slug: string }>; kept: RebuildKept[] }> {
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; private: boolean; members_private: boolean }>(`SELECT p.id, p.source_id, p.slug,
    NOT ${privacyPartSql('p')} AS private,
    EXISTS (SELECT 1 FROM derivation_inputs d JOIN pages m ON m.id::text = d.input_id AND d.input_table = 'pages'
      WHERE d.derived_table = 'pages' AND d.derived_id = p.id::text AND m.deleted_at IS NULL AND NOT (${privatePagesFilterFragment('m')})) AS members_private
    FROM pages p WHERE ${HELD_SQL} ORDER BY p.source_id, p.slug`);
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
export async function tombstoneWindow(tx: Sql, pageId: number, hours: number): Promise<{ until: string; past: boolean } | null> {
  const [window] = await tx.executeRaw<{ until: string; past: boolean }>(`SELECT to_char((deleted_at + ($2 || ' hours')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS until,
    deleted_at + ($2 || ' hours')::interval <= now() AS past FROM pages WHERE id = $1 AND deleted_at IS NOT NULL`, [pageId, String(hours)]);
  return window ?? null;
}

/** One preview line per kept concept, naming its reason. */
export function keptReason(kept: RebuildKept): string {
  if (kept.reason === 'stated') return `${kept.source_id}/${kept.slug}: stays hidden, it carries what a person or an agent stated (${kept.kinds.join(', ')})`;
  if (kept.reason === 'access') return `${kept.source_id}/${kept.slug}: stays hidden, a rebuild would be readable more widely (${kept.why})`;
  return `${kept.source_id}/${kept.slug}: stays hidden, no synthesis model is configured to rebuild it`;
}
