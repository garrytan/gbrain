/**
 * The purge receipt's store probes (src/core/facts/purge-verify.ts): the keyed, fact-reference, fingerprint, claim-text,
 * segment-text, request and effect-payload stores a receipt checks for what a purge left behind. Each probe ran through
 * executeRaw; its SQL is built here once for both engines and run by engine-sql/facts-purge-plan.ts `countPurgeProbe`
 * (bounded at `rows + 1`) and `listPurgeProbeItems` (the first 20 effect rows). The inventory and named-row probes are
 * facts/purge-plan-statements.ts `PurgeProbe`.
 *
 * The probe is typed: a caller names the store and passes values, never SQL text. Every value binds as a parameter;
 * table and column names come from the constant maps below, so nothing a caller passes is spliced. The Rust engine
 * answers each kind from its own stores (rust-engine/store-members/purge-plan.ts): `fingerprint` and `claim_text` count the
 * facts, takes, take proposals, pages, chunks, versions and journal requests, and a `claim_text` probe of `core_edit_notices`
 * finds nothing (the store keeps no edit notice).
 */
import { outcomeMarkerSql } from '../facts/audit-sources.ts';
import { stagingNeedsTextSql } from '../page-body/schema.ts';
import { holdResidueOfDeletedPageSql } from '../write-gate-binding.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

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

/**
 * One store probe of the purge receipt. `forms` lists are already folded the way the store is matched (lowercased,
 * with the JSON-escaped form beside the plain one where the column holds JSON text); a binary store matches bytes.
 */
export type PurgeStoreProbe =
  | { kind: 'slug_key'; store: PurgeSlugKeyStore; sourceId: string; slug: string; pageId?: number | null }
  | { kind: 'page_rows'; store: PurgePageRowStore; pageId: number }
  | { kind: 'fact_refs'; store: PurgeFactRefStore; sourceId: string; factIds: readonly number[] }
  | { kind: 'trust_proposals'; sourceId: string; pageId: number; factIds: readonly number[] }
  | { kind: 'query_cache'; sourceId: string }
  | { kind: 'page_requests'; sourceId: string; slug: string; requestId: string; needles: readonly string[]; reasons: readonly string[] }
  | { kind: 'page_segment_texts'; sourceId: string; shas: readonly string[]; forms: readonly string[] }
  | { kind: 'segment_texts'; sourceId: string; needles: readonly string[]; referenced: boolean }
  | EffectPayloadProbe
  | { kind: 'fingerprint'; store: PurgeFingerprintStore; sourceId: string; factHash: string; visibility: string; subject: string }
  | { kind: 'claim_text'; store: PurgeClaimTextStore; sourceId: string; claim: string; json: string; reason: string; reasonJson: string };
export type EffectPayloadProbe = { kind: 'effect_payload'; sourceId: string; forms: readonly string[]; page?: { slug: string; reasonForms: readonly string[] } };

/** The store probe kinds, for a caller that routes them apart from the inventory probes. */
export const PURGE_STORE_PROBE_KINDS: ReadonlySet<string> = new Set(['slug_key', 'page_rows', 'fact_refs', 'trust_proposals', 'query_cache',
  'page_requests', 'page_segment_texts', 'segment_texts', 'effect_payload', 'fingerprint', 'claim_text'] satisfies Array<PurgeStoreProbe['kind']>);

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

function slugKeySelect(store: PurgeSlugKeyStore, src: string, slug: string, pageId: number | null = null): SqlFragment {
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
    // The purged page's holds: those bound to its id (whatever it was called), the unbound ones at its slug and any candidate-marked
    // hold still naming it; a hold bound to another page that reused the name is not left behind (write-gate-binding.ts).
    case 'write_gate_holds': return sqlFragment`WITH d(pid, slug) AS (SELECT ${pageId}::bigint, ${slug}::text)
      SELECT 1 FROM write_gate_holds h, d WHERE h.source_id=${src} AND ${trustedSql(holdResidueOfDeletedPageSql('h', 'd.pid', 'd.slug'))}`;
  }
}

function fingerprintSelect(p: Extract<PurgeStoreProbe, { kind: 'fingerprint' }>): SqlFragment {
  switch (p.store) {
    case 'facts': return sqlFragment`SELECT 1 FROM facts WHERE source_id=${p.sourceId} AND visibility=${p.visibility} AND gbrain_fact_fingerprint(fact)=${p.factHash}
    AND (${p.subject}::text='*' OR entity_slug=${p.subject}) AND NOT ${trustedSql(outcomeMarkerSql('facts'))}`;
    case 'takes': return sqlFragment`SELECT 1 FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=${p.sourceId} AND gbrain_fact_fingerprint(k.claim)=${p.factHash}
    AND (${p.subject}::text='*' OR p.slug=${p.subject})`;
    case 'take_proposals': return sqlFragment`SELECT 1 FROM take_proposals WHERE source_id=${p.sourceId} AND gbrain_fact_fingerprint(claim_text)=${p.factHash}`;
  }
}

function claimTextSelect(p: Extract<PurgeStoreProbe, { kind: 'claim_text' }>): SqlFragment {
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

function effectPayloadSelect(p: EffectPayloadProbe): SqlFragment {
  const own = p.page ? sqlFragment` OR (e.kind = 'git' AND e.data->>'slug' = ${p.page.slug}
      AND EXISTS (SELECT 1 FROM unnest(${[...p.page.reasonForms]}::text[]) n WHERE strpos(lower(e.data::text),n)>0))` : sqlFragment``;
  return sqlFragment`SELECT 'effect:' || e.id || ' ' || e.kind || ' ' || e.state AS item FROM persistence_effects e WHERE e.source_id = ${p.sourceId}
    AND (EXISTS (SELECT 1 FROM unnest(${[...p.forms]}::text[]) n WHERE ${trustedSql(EFFECT_TEXT_MATCH)})${own})`;
}

/** The rows `probe` selects (no LIMIT). */
function probeSelect(p: PurgeStoreProbe): SqlFragment {
  switch (p.kind) {
    case 'slug_key': return slugKeySelect(p.store, p.sourceId, p.slug, p.pageId ?? null);
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
    case 'effect_payload': return effectPayloadSelect(p);
    case 'fingerprint': return fingerprintSelect(p);
    case 'claim_text': return claimTextSelect(p);
  }
}

/** The store probe's row select (no LIMIT) and its parameters, rendered. */
export function purgeStoreProbeSelect(p: PurgeStoreProbe): { sql: string; params: unknown[] } {
  const { text, params } = renderFragment(probeSelect(p));
  return { sql: text, params };
}
