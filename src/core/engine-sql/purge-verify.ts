/**
 * The purge receipt's reads (src/core/facts/purge-verify.ts): the bounded probe every store adapter runs, the rows a
 * probed store names, the belief-ledger and fact-context batches, the segmented bodies a prose scan walks, the slugs of
 * other pages whose prose still states a purged claim, the page tombstone count, the page purge's request row, and the
 * effect states and fingerprint probe completion reads. Each ran through executeRaw; SQL once for both engines.
 *
 * The probe is typed: a caller names the store and passes values, never SQL text. Every value binds as a parameter;
 * table and column names come from the constant maps below or from the deletion inventory (purgeProbeTableSql,
 * purgeProbeColumnSql), so nothing a caller passes is spliced. The Rust engine does not serve these members yet, so a
 * page purge receipt and the probe refuse there with `engine_capability_missing` naming the member.
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { DELETION_INVENTORY_BY_TABLE } from '../deletion-inventory.ts';
import { outcomeMarkerSql } from '../facts/audit-sources.ts';
import { stagingNeedsTextSql } from '../page-body/schema.ts';
import { getCode } from '../retry-matcher.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;
type Tx = Pick<BrainEngine, 'transaction'>;

/** Stores keyed by the purged page's source and slug. */
export type PurgeSlugKeyStore = 'pages' | 'facts' | 'take_proposals' | 'open_loops' | 'core_edit_notices' | 'page_aliases' | 'slug_aliases'
  | 'retrieval_event_pages' | 'retrieval_event_links' | 'retrieval_feedback' | 'retrieval_weights' | 'eval_candidates.retrieved_slugs'
  | 'context_volunteer_events' | 'mention_gazetteer_entries' | 'files' | 'write_gate_holds';
/** Stores keyed by the purged page's id. */
export type PurgePageRowStore = 'content_chunks' | 'page_versions' | 'takes' | 'timeline_entries';
/** Review stores that reference the purged facts by id. */
export type PurgeFactRefStore = 'decide_review_queue' | 'decide_review_proposals' | 'decide_proposals';
/** Stores a fact purge checks by the claim's fingerprint. */
export type PurgeFingerprintStore = 'facts' | 'takes' | 'take_proposals';
/** Stores a fact purge checks for the claim's text. */
export type PurgeClaimTextStore = 'pages' | 'content_chunks' | 'page_versions' | 'persistence_requests' | 'core_edit_notices';
/** Stores whose probe names the rows still carrying the text. */
export type PurgeNamedRowStore = 'links' | 'timeline_entries' | 'raw_data';

/**
 * One bounded probe of the purge receipt. `forms` lists are already folded the way the store is matched (lowercased,
 * with the JSON-escaped form beside the plain one where the column holds JSON text); a binary store matches bytes.
 */
export type PurgeProbe =
  | { kind: 'slug_key'; store: PurgeSlugKeyStore; sourceId: string; slug: string }
  | { kind: 'page_rows'; store: PurgePageRowStore; pageId: number }
  | { kind: 'fact_refs'; store: PurgeFactRefStore; sourceId: string; factIds: readonly number[] }
  | { kind: 'trust_proposals'; sourceId: string; pageId: number; factIds: readonly number[] }
  | { kind: 'query_cache'; sourceId: string }
  | { kind: 'page_requests'; sourceId: string; slug: string; requestId: string; needles: readonly string[]; reasons: readonly string[] }
  | { kind: 'page_segment_texts'; sourceId: string; shas: readonly string[]; forms: readonly string[] }
  | { kind: 'segment_texts'; sourceId: string; needles: readonly string[]; referenced: boolean }
  | { kind: 'inventory_text'; table: string; columns: readonly string[]; sourceId: string; forms: readonly string[] }
  | NamedRowsProbe
  | EffectPayloadProbe
  | { kind: 'fingerprint'; store: PurgeFingerprintStore; sourceId: string; factHash: string; visibility: string; subject: string }
  | { kind: 'claim_text'; store: PurgeClaimTextStore; sourceId: string; claim: string; json: string; reason: string; reasonJson: string };
export type NamedRowsProbe = { kind: 'named_rows'; table: PurgeNamedRowStore; sourceId: string; forms: readonly string[] };
export type EffectPayloadProbe = { kind: 'effect_payload'; sourceId: string; forms: readonly string[]; page?: { slug: string; reasonForms: readonly string[] } };

export interface PurgeProbeBounds { rows: number; statementMs: number }
export type PurgeProbeCount = { count: number } | { unverified: 'row_bound' | 'statement_deadline' };

/** Stores whose probe columns are bytea; their bytes are matched exactly (case-sensitive) against the UTF-8 needle. */
const BINARY_PROBE_TABLES: ReadonlySet<string> = new Set(['minion_attachments', 'page_segment_texts', 'page_body_staging_parts']);
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** An inventory table name, refused unless the deletion inventory lists it. */
export function purgeProbeTableSql(table: string): string {
  if (!IDENT.test(table) || !DELETION_INVENTORY_BY_TABLE.has(table)) throw new Error(`purge probe: ${table} is not an inventory table`);
  return table;
}

/** An inventory column name, refused unless the deletion inventory lists it for `table`. */
export function purgeProbeColumnSql(table: string, column: string): string {
  const entry = DELETION_INVENTORY_BY_TABLE.get(purgeProbeTableSql(table))!;
  if (!IDENT.test(column) || !(entry.columns.includes(column) || entry.probe?.includes(column))) throw new Error(`purge probe: ${table}.${column} is not an inventory column`);
  return column;
}

const PAGE_ROW_TABLES = { content_chunks: 'content_chunks', page_versions: 'page_versions', takes: 'takes', timeline_entries: 'timeline_entries' } as const;
const PAGE_SLUG_TABLES = { take_proposals: 'take_proposals', open_loops: 'open_loops' } as const;
const FEEDBACK_TABLES = { retrieval_feedback: 'retrieval_feedback', retrieval_weights: 'retrieval_weights' } as const;
const REVIEW_TABLES = { decide_review_queue: 'decide_review_queue', decide_review_proposals: 'decide_review_proposals' } as const;
const EDGE_KEYS = { edge_key: 'edge_key', element_key: 'element_key' } as const;
const CLAIM_ALIASES = { p: 'p', v: 'v' } as const;
const REQUEST_TEXT_MATCH = `strpos(lower(COALESCE(intent::text,'')),n)>0 OR strpos(lower(COALESCE(outcome::text,'')),n)>0
  OR strpos(lower(COALESCE(error_detail::text,'')),n)>0 OR strpos(lower(COALESCE(error_message::text,'')),n)>0`;
const EFFECT_TEXT_MATCH = `strpos(lower(COALESCE(e.data::text,'')),n)>0 OR strpos(lower(COALESCE(e.outcome::text,'')),n)>0
  OR strpos(lower(COALESCE(e.recovery::text,'')),n)>0`;

/** A link-shaped key (`from|to`) names the slug at either end. */
const edgeNames = (key: keyof typeof EDGE_KEYS, slug: string) =>
  sqlFragment`(starts_with(${trustedSql(EDGE_KEYS[key])}, ${slug}::text || '|') OR right(${trustedSql(EDGE_KEYS[key])}, length(${slug}::text) + 1) = '|' || ${slug}::text)`;

/** A page or page-version row (alias `a`) still states the claim: in its body, timeline, title or frontmatter (matched as JSON text). */
const carriesClaim = (a: keyof typeof CLAIM_ALIASES, claim: string, json: string) => {
  const t = trustedSql(CLAIM_ALIASES[a]);
  return sqlFragment`(strpos(lower(${t}.compiled_truth),${claim})>0 OR strpos(lower(COALESCE(${t}.timeline,'')),${claim})>0
  OR strpos(lower(COALESCE(${t}.title,'')),${claim})>0 OR strpos(lower(COALESCE(${t}.frontmatter::text,'')),${json})>0)`;
};

function slugKeySelect(store: PurgeSlugKeyStore, src: string, slug: string): SqlFragment {
  switch (store) {
    case 'pages': return sqlFragment`SELECT 1 FROM pages WHERE source_id=${src} AND slug=${slug}`;
    case 'facts': return sqlFragment`SELECT 1 FROM facts WHERE source_id=${src} AND source_markdown_slug=${slug}`;
    case 'take_proposals': case 'open_loops':
      return sqlFragment`SELECT 1 FROM ${trustedSql(PAGE_SLUG_TABLES[store])} WHERE source_id=${src} AND page_slug=${slug}`;
    case 'core_edit_notices': return sqlFragment`SELECT 1 FROM core_edit_notices WHERE source_id=${src} AND slug=${slug}`;
    case 'page_aliases': return sqlFragment`SELECT 1 FROM page_aliases WHERE source_id=${src} AND slug=${slug}`;
    case 'slug_aliases': return sqlFragment`SELECT 1 FROM slug_aliases WHERE source_id=${src} AND canonical_slug=${slug}`;
    case 'retrieval_event_pages': return sqlFragment`SELECT 1 FROM retrieval_event_pages WHERE source_id=${src} AND slug=${slug}`;
    case 'retrieval_event_links':
      return sqlFragment`SELECT 1 FROM retrieval_event_links WHERE source_id=${src} AND (to_slug=${slug} OR ${edgeNames('edge_key', slug)})`;
    case 'retrieval_feedback': case 'retrieval_weights':
      return sqlFragment`SELECT 1 FROM ${trustedSql(FEEDBACK_TABLES[store])} WHERE source_id=${src}
    AND ((element_kind='page' AND element_key=${slug}) OR (element_kind='link' AND ${edgeNames('element_key', slug)}))`;
    case 'eval_candidates.retrieved_slugs':
      return sqlFragment`SELECT 1 FROM eval_candidates WHERE ${src}::text = ANY(source_ids) AND ${slug}::text = ANY(retrieved_slugs)
    AND NOT EXISTS (SELECT 1 FROM pages po WHERE po.slug = ${slug} AND po.source_id = ANY(eval_candidates.source_ids) AND po.source_id <> ${src})`;
    case 'context_volunteer_events': return sqlFragment`SELECT 1 FROM context_volunteer_events WHERE source_id=${src} AND slug=${slug}`;
    case 'mention_gazetteer_entries': return sqlFragment`SELECT 1 FROM mention_gazetteer_entries WHERE source_id=${src} AND target_slug=${slug}`;
    case 'files': return sqlFragment`SELECT 1 FROM files WHERE page_id IS NULL AND page_slug=${slug} AND (source_id=${src} OR source_id IS NULL)`;
    case 'write_gate_holds': return sqlFragment`SELECT 1 FROM write_gate_holds WHERE source_id=${src} AND slug=${slug}`;
  }
}

function fingerprintSelect(p: Extract<PurgeProbe, { kind: 'fingerprint' }>): SqlFragment {
  switch (p.store) {
    case 'facts': return sqlFragment`SELECT 1 FROM facts WHERE source_id=${p.sourceId} AND visibility=${p.visibility} AND gbrain_fact_fingerprint(fact)=${p.factHash}
    AND (${p.subject}::text='*' OR entity_slug=${p.subject}) AND NOT ${trustedSql(outcomeMarkerSql('facts'))}`;
    case 'takes': return sqlFragment`SELECT 1 FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=${p.sourceId} AND gbrain_fact_fingerprint(k.claim)=${p.factHash}
    AND (${p.subject}::text='*' OR p.slug=${p.subject})`;
    case 'take_proposals': return sqlFragment`SELECT 1 FROM take_proposals WHERE source_id=${p.sourceId} AND gbrain_fact_fingerprint(claim_text)=${p.factHash}`;
  }
}

function claimTextSelect(p: Extract<PurgeProbe, { kind: 'claim_text' }>): SqlFragment {
  const src = p.sourceId;
  switch (p.store) {
    case 'pages': return sqlFragment`SELECT 1 FROM pages p WHERE p.source_id=${src} AND p.deleted_at IS NULL AND ${carriesClaim('p', p.claim, p.json)}`;
    // chunk-visibility-ok: a purge proof must find the claim in chunk rows of every generation, staged or retired included
    case 'content_chunks': return sqlFragment`SELECT 1 FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=${src} AND strpos(lower(c.chunk_text),${p.claim})>0`;
    case 'page_versions': return sqlFragment`SELECT 1 FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=${src}
    AND (${carriesClaim('v', p.claim, p.json)} OR strpos(lower(v.change_reason),${p.claim})>0 OR strpos(lower(v.change_reason),${p.reason})>0)`;
    case 'persistence_requests': return sqlFragment`SELECT 1 FROM persistence_requests WHERE source_id=${src}
    AND EXISTS (SELECT 1 FROM unnest(${[p.claim, p.json, p.reasonJson]}::text[]) n WHERE ${trustedSql(REQUEST_TEXT_MATCH)})`;
    case 'core_edit_notices': return sqlFragment`SELECT 1 FROM core_edit_notices WHERE source_id=${src} AND strpos(lower(base_text),${p.claim})>0`;
  }
}

function namedRowsSelect(p: NamedRowsProbe): SqlFragment {
  const src = p.sourceId, forms = [...p.forms];
  switch (p.table) {
    case 'links': return sqlFragment`SELECT 'link:' || l.id || ' ' || f.slug || ' -> ' || t.slug AS item FROM links l JOIN pages f ON f.id = l.from_page_id
    JOIN pages t ON t.id = l.to_page_id WHERE (f.source_id = ${src} OR t.source_id = ${src})
    AND EXISTS (SELECT 1 FROM unnest(${forms}::text[]) n WHERE strpos(lower(l.context::text),n)>0)`;
    case 'timeline_entries': return sqlFragment`SELECT 'timeline:' || x.id || ' ' || p.slug || ' ' || x.date::text AS item FROM timeline_entries x
    JOIN pages p ON p.id = x.page_id WHERE p.source_id = ${src}
    AND EXISTS (SELECT 1 FROM unnest(${forms}::text[]) n WHERE strpos(lower(x.summary::text),n)>0 OR strpos(lower(x.detail::text),n)>0)`;
    case 'raw_data': return sqlFragment`SELECT 'raw_data:' || r.id || ' ' || p.slug || ' ' || r.source AS item FROM raw_data r JOIN pages p ON p.id = r.page_id
    WHERE p.source_id = ${src} AND EXISTS (SELECT 1 FROM unnest(${forms}::text[]) n WHERE strpos(lower(r.data::text),n)>0)`;
  }
}

function effectPayloadSelect(p: EffectPayloadProbe): SqlFragment {
  const own = p.page ? sqlFragment` OR (e.kind = 'git' AND e.data->>'slug' = ${p.page.slug}
      AND EXISTS (SELECT 1 FROM unnest(${[...p.page.reasonForms]}::text[]) n WHERE strpos(lower(e.data::text),n)>0))` : sqlFragment``;
  return sqlFragment`SELECT 'effect:' || e.id || ' ' || e.kind || ' ' || e.state AS item FROM persistence_effects e WHERE e.source_id = ${p.sourceId}
    AND (EXISTS (SELECT 1 FROM unnest(${[...p.forms]}::text[]) n WHERE ${trustedSql(EFFECT_TEXT_MATCH)})${own})`;
}

function inventoryTextSelect(p: Extract<PurgeProbe, { kind: 'inventory_text' }>): SqlFragment {
  const entry = DELETION_INVENTORY_BY_TABLE.get(purgeProbeTableSql(p.table))!;
  const binary = BINARY_PROBE_TABLES.has(p.table);
  const matches = p.columns.map(col => binary
    ? sqlFragment`position(convert_to(n,'UTF8') in ${trustedSql(purgeProbeColumnSql(p.table, col))})>0`
    : sqlFragment`strpos(lower(${trustedSql(purgeProbeColumnSql(p.table, col))}::text),n)>0`);
  const scope = entry.columns.includes('source_id') ? sqlFragment`source_id=${p.sourceId}` : sqlFragment`${p.sourceId}::text IS NOT NULL`;
  return sqlFragment`SELECT 1 FROM ${trustedSql(purgeProbeTableSql(p.table))} WHERE ${scope}
    AND EXISTS (SELECT 1 FROM unnest(${[...p.forms]}::text[]) n WHERE ${joinFragments(matches, ' OR ')})`;
}

/** The rows `probe` selects (no LIMIT). */
function probeSelect(p: PurgeProbe): SqlFragment {
  switch (p.kind) {
    case 'slug_key': return slugKeySelect(p.store, p.sourceId, p.slug);
    case 'page_rows': return sqlFragment`SELECT 1 FROM ${trustedSql(PAGE_ROW_TABLES[p.store])} WHERE page_id=${p.pageId}`;
    case 'fact_refs': return p.store === 'decide_proposals'
      ? sqlFragment`SELECT 1 FROM decide_proposals WHERE source_id=${p.sourceId} AND (new_fact_id=ANY(${[...p.factIds]}::bigint[]) OR old_fact_id=ANY(${[...p.factIds]}::bigint[]))`
      : sqlFragment`SELECT 1 FROM ${trustedSql(REVIEW_TABLES[p.store])} WHERE source_id=${p.sourceId}
    AND (a_ref=ANY(${p.factIds.map(String)}::text[]) OR b_ref=ANY(${p.factIds.map(String)}::text[]))`;
    case 'trust_proposals': return sqlFragment`SELECT 1 FROM trust_proposals WHERE source_id=${p.sourceId}
    AND ((target_table='pages' AND target_id=${p.pageId}) OR (related_table='pages' AND related_id=${p.pageId})
      OR (target_table='facts' AND target_id=ANY(${[...p.factIds]}::bigint[])) OR (related_table='facts' AND related_id=ANY(${[...p.factIds]}::bigint[])))`;
    case 'query_cache': return sqlFragment`SELECT 1 FROM query_cache WHERE ${p.sourceId}::text IS NOT NULL`;
    case 'page_requests': return sqlFragment`SELECT 1 FROM persistence_requests WHERE source_id=${p.sourceId} AND request_id<>${p.requestId}::uuid AND (
      (slug=${p.slug} AND intent IS NOT NULL AND state IN ('committed','conflict','failed','cancelled'))
      OR EXISTS (SELECT 1 FROM unnest(${p.needles.map(n => n.toLowerCase())}::text[]) n WHERE ${trustedSql(REQUEST_TEXT_MATCH)})
      OR (slug=${p.slug} AND EXISTS (SELECT 1 FROM unnest(${p.reasons.map(n => n.toLowerCase())}::text[]) n WHERE ${trustedSql(REQUEST_TEXT_MATCH)})))`;
    case 'page_segment_texts': return sqlFragment`SELECT 1 FROM page_segment_texts t WHERE t.source_id=${p.sourceId}
      AND (t.sha256=ANY(SELECT decode(h,'hex') FROM unnest(${[...p.shas]}::text[]) AS h)
        OR EXISTS (SELECT 1 FROM unnest(${[...p.forms]}::text[]) AS n WHERE strpos(lower(convert_from(t.body,'UTF8')),n)>0))
      AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) AND NOT ${trustedSql(stagingNeedsTextSql('t'))}`;
    case 'segment_texts': return sqlFragment`SELECT 1 FROM page_segment_texts t WHERE t.source_id=${p.sourceId}
      AND EXISTS (SELECT 1 FROM unnest(${[...p.needles]}::text[]) n WHERE position(convert_to(n,'UTF8') in t.body)>0)
      AND ${trustedSql(p.referenced ? '' : 'NOT ')}EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256)`;
    case 'inventory_text': return inventoryTextSelect(p);
    case 'named_rows': return namedRowsSelect(p);
    case 'effect_payload': return effectPayloadSelect(p);
    case 'fingerprint': return fingerprintSelect(p);
    case 'claim_text': return claimTextSelect(p);
  }
}

const STATEMENT_TIMEOUT_SQL = "SELECT set_config('statement_timeout',$1,true)";

/**
 * One bounded probe: its own transaction under a statement timeout (`statement_timeout` through set_config, local to
 * the transaction), counting at most `rows + 1` matching rows. More than `rows` is `row_bound`; a statement the
 * timeout cancels (57014) is `statement_deadline`.
 */
export async function countPurgeProbe(db: Tx, probe: PurgeProbe, bounds: PurgeProbeBounds): Promise<PurgeProbeCount> {
  const rows = Math.floor(bounds.rows), ms = Math.floor(bounds.statementMs);
  if (!Number.isFinite(rows) || rows < 0 || !Number.isFinite(ms) || ms < 1) throw new Error(`purge probe: bad bounds ${JSON.stringify(bounds)}`);
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM (${probeSelect(probe)} LIMIT ${rows + 1}) bounded`);
  try {
    return await db.transaction(async tx => {
      await tx.executeRaw(STATEMENT_TIMEOUT_SQL, [`${ms}ms`]);
      const [row] = await tx.executeRaw<{ n: number }>(text, params);
      const count = Number(row?.n ?? 0);
      return count > rows ? { unverified: 'row_bound' as const } : { count };
    });
  } catch (error) {
    if (getCode(error) === '57014') return { unverified: 'statement_deadline' };
    throw error;
  }
}

/** The first `limit` rows a named-row or effect-payload probe matches, as `kind:id ...` items in sort order. */
export async function listPurgeProbeItems(db: Raw, probe: NamedRowsProbe | EffectPayloadProbe, limit: number): Promise<string[]> {
  const select = probe.kind === 'named_rows' ? namedRowsSelect(probe) : effectPayloadSelect(probe);
  const { text, params } = renderFragment(sqlFragment`${select} ORDER BY 1 LIMIT ${Math.max(0, Math.floor(limit))}`);
  return (await db.executeRaw<{ item: string }>(text, params)).map(r => r.item);
}

/** One keyset batch of the source's recorded belief values (`id > after`). */
export async function listBeliefEventValuesAfter(db: Raw, sourceId: string, after: number, limit: number):
  Promise<Array<{ id: number; subject_kind: string; subject_key: string; value: unknown }>> {
  const rows = await db.executeRaw<{ id: number; subject_kind: string; subject_key: string; value: unknown }>(`SELECT id, subject_kind, subject_key, value
      FROM belief_events WHERE source_id = $1 AND id > $2 AND value IS NOT NULL ORDER BY id LIMIT $3`, [sourceId, after, limit]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** One keyset batch of the source's live facts with a context (`id > after`). */
export async function listLiveFactContextsAfter(db: Raw, sourceId: string, after: number, limit: number): Promise<Array<{ id: number; context: string }>> {
  const rows = await db.executeRaw<{ id: number; context: string }>(`SELECT id, context FROM facts WHERE source_id = $1 AND id > $2 AND expired_at IS NULL
      AND COALESCE(context, '') <> '' ORDER BY id LIMIT $3`, [sourceId, after, limit]);
  return rows.map(r => ({ id: Number(r.id), context: r.context }));
}

export interface SegmentedProseBody { page_id: number; slug: string; generation: number | null; version_id: number | null }

/** Up to `limit` segmented bodies of the source: live pages (`pages`) or retained versions (`page_versions`), by id. */
export async function listSegmentedProseBodies(db: Raw, sourceId: string, store: 'pages' | 'page_versions', limit: number): Promise<SegmentedProseBody[]> {
  const rows = store === 'pages'
    ? await db.executeRaw<SegmentedProseBody>(`SELECT id AS page_id,slug,NULL AS generation,NULL AS version_id FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND body_storage='segmented' ORDER BY id LIMIT $2`, [sourceId, limit])
    : await db.executeRaw<SegmentedProseBody>(`SELECT v.page_id,p.slug,v.body_generation AS generation,v.id AS version_id
      FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND v.body_storage='segmented' ORDER BY v.id LIMIT $2`, [sourceId, limit]);
  return rows.map(r => ({ page_id: Number(r.page_id), slug: r.slug, generation: r.generation === null ? null : Number(r.generation),
    version_id: r.version_id === null ? null : Number(r.version_id) }));
}

const PROSE_SLUGS = {
  pages: `SELECT DISTINCT p.slug FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(p.compiled_truth),n)>0 OR strpos(lower(COALESCE(p.timeline,'')),n)>0) ORDER BY 1 LIMIT $3`,
  // chunk-visibility-ok: a purge proof must find the claim in chunk rows of every generation, staged or retired included
  content_chunks: `SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(c.chunk_text),n)>0) ORDER BY 1 LIMIT $3`,
  page_versions: `SELECT DISTINCT p.slug FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(v.compiled_truth),n)>0 OR strpos(lower(COALESCE(v.timeline,'')),n)>0) ORDER BY 1 LIMIT $3`,
  timeline_entries: `SELECT DISTINCT p.slug FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(t.summary),n)>0 OR strpos(lower(COALESCE(t.detail,'')),n)>0) ORDER BY 1 LIMIT $3`,
} as const;
export type PurgeProseStore = keyof typeof PROSE_SLUGS;

/** Up to `limit` slugs of the source's pages whose `store` text still states one of `needles` (already lowercased), sorted. */
export async function listPurgeProseSlugs(db: Raw, store: PurgeProseStore, sourceId: string, needles: readonly string[], limit: number): Promise<string[]> {
  return (await db.executeRaw<{ slug: string }>(PROSE_SLUGS[store], [sourceId, [...needles], limit])).map(r => r.slug);
}

/** How many page tombstones the source holds for `slug`. */
export async function countPagePurgeTombstones(db: Raw, sourceId: string, slug: string): Promise<number> {
  const [row] = await db.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_purges WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return Number(row?.n ?? 0);
}

export type PurgeRequestRow = Pick<WriteRequest, 'id' | 'request_id' | 'state' | 'source_id' | 'outcome'>;

/** The newest `delete_page` journal row of the source with this request id, or null. A request id that is not a uuid refuses, as `::uuid` does. */
export async function readPagePurgeRequest(db: Raw, sourceId: string, requestId: string): Promise<PurgeRequestRow | null> {
  const [row] = await db.executeRaw<PurgeRequestRow>(`SELECT id,request_id,state,source_id,outcome FROM persistence_requests
    WHERE source_id=$1 AND request_id=$2::uuid AND operation='delete_page' ORDER BY created_at DESC LIMIT 1`, [sourceId, requestId]);
  return row ?? null;
}

export interface PurgeEffectState { kind: string; state: string; error_code: string | null; parked: boolean }

/** The effects of journal row `requestRowId`, in kind order; `parked` when the effect parked any work. */
export async function listPurgeEffectStates(db: Raw, requestRowId: string): Promise<PurgeEffectState[]> {
  const rows = await db.executeRaw<PurgeEffectState>(`SELECT kind,state,error_code,
    jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 AS parked FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind`, [requestRowId]);
  return rows.map(r => ({ kind: r.kind, state: r.state, error_code: r.error_code ?? null, parked: r.parked === true }));
}

/** Live facts and takes of the source whose claim has fingerprint `factHash` (`subject` `*` for every entity). */
export async function countPurgeFingerprintRows(db: Raw, sourceId: string, factHash: string, subject: string): Promise<{ facts: number; takes: number }> {
  const { text, params } = renderFragment(sqlFragment`SELECT
      (SELECT count(*)::int FROM facts WHERE source_id=${sourceId} AND gbrain_fact_fingerprint(fact)=${factHash} AND (${subject}::text='*' OR entity_slug=${subject})
        AND NOT ${trustedSql(outcomeMarkerSql('facts'))}) AS facts,
      (SELECT count(*)::int FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=${sourceId} AND gbrain_fact_fingerprint(k.claim)=${factHash}
        AND (${subject}::text='*' OR p.slug=${subject})) AS takes`);
  const [row] = await db.executeRaw<{ facts: number; takes: number }>(text, params);
  return { facts: Number(row?.facts ?? 0), takes: Number(row?.takes ?? 0) };
}
