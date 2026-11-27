/**
 * The reads withdrawal discovery makes (discoverWithdrawalTargets, src/core/facts/withdrawal-discovery.ts) to find
 * every page that carries a withdrawn claim. They ran through `executeRaw` before they had one typed member,
 * `readWithdrawalDiscovery`; each kind keeps the statement text and parameter order its call site ran, so PGLite and
 * Postgres answer exactly as before (test/withdrawal-discovery-reads-sql-pin.test.ts pins the text). A Rust brain
 * answers from its store (rust/crates/gbrain-store/src/facts/withdrawal_discovery.rs).
 *
 * - `claim_keys`: each claim's ledger subject and normalized text (its own text, else a source fact's with its fingerprint).
 * - `provenance_pages`: the pages that carry a fact with a key's claim as its provenance or entity page.
 * - `claim_matches`: the fence and chunk rows whose claim fingerprints equal a key's, with whether the row was ambiguous.
 * - `inline_fence_pages`: inline pages with a facts fence whose body holds every token of a key, by id after a cursor.
 * - `segment_fence_rows`: live manifest rows of segmented pages whose whole facts slots hold every token of a key.
 * - `split_fence_slots`: the facts fences of segmented pages a forced cut split, with the bytes their slots hold.
 * - `target_pages`: slug, id and knowledge revision of the matched pages.
 * - `sample_slugs`: up to 20 slugs of the matched pages, for the capacity refusal.
 *
 * The statements reuse a parameter and number them out of order, which sqlFragment cannot render, so each runs as
 * constant text. PROVENANCE_PAGES_SQL holds onOwnedMemoryPageSql('f') inline; the pin test builds the old text with
 * the builder and fails when the two drift.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One claim keyed for discovery: `norm` is its normalized text (null when no fact carries it), `patterns` its LIKE tokens. */
export interface WithdrawalDiscoveryKey { visibility: string; fact_hash: string; subject: string; norm: string | null; patterns: string[] }
/** One fence or chunk row discovery checks against the keys. */
export interface WithdrawalDiscoveryCandidate { id: number; slug: string; claim: string; visibility: string | null; ambiguous: boolean }

export type WithdrawalDiscoveryRead =
  | { kind: 'claim_keys'; sourceId: string; claims: Array<{ visibility: string; fact_hash: string; subject: string; claim: string | null }> }
  | { kind: 'provenance_pages'; sourceId: string; keys: WithdrawalDiscoveryKey[] }
  | { kind: 'claim_matches'; incoming: WithdrawalDiscoveryCandidate[]; keys: WithdrawalDiscoveryKey[] }
  | { kind: 'inline_fence_pages'; sourceId: string; keys: WithdrawalDiscoveryKey[]; after: number; limit: number; subjects: string[] | null }
  | { kind: 'segment_fence_rows'; sourceId: string; keys: WithdrawalDiscoveryKey[]; after: [page: number, occurrence: number]; limit: number; subjects: string[] | null }
  | { kind: 'split_fence_slots'; sourceId: string; subjects: string[] | null; after: [page: number, region: string, openStart: number]; limit: number }
  | { kind: 'target_pages'; sourceId: string; ids: number[] }
  | { kind: 'sample_slugs'; sourceId: string; ids: number[] };

export interface WithdrawalDiscoveryRows {
  claim_keys: Array<{ visibility: string; fact_hash: string; subject: string; norm: string | null }>;
  provenance_pages: Array<{ id: number }>;
  claim_matches: Array<{ id: number; ambiguous: boolean }>;
  inline_fence_pages: Array<{ id: number; slug: string; compiled_truth: string; timeline: string }>;
  segment_fence_rows: Array<{ id: number; occurrence_id: string; slug: string; fences: string[] }>;
  split_fence_slots: Array<{ page_id: number; slug: string; region: string; open_start: string; bytes: string }>;
  target_pages: Array<{ slug: string; page_id: number; revision: string }>;
  sample_slugs: Array<{ slug: string }>;
}

export type WithdrawalDiscoveryKind = WithdrawalDiscoveryRead['kind'];

const SAMPLE_SLUGS_SQL = `SELECT slug FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug COLLATE "C" LIMIT 20`;

const SPLIT_FENCE_SLOTS_SQL = `SELECT m.page_id,p.slug,m.region,
        (s->>'open_start')::bigint::text AS open_start,sum((s->>'end')::bigint-(s->>'start')::bigint)::text AS bytes
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id CROSS JOIN LATERAL jsonb_array_elements(m.facts_slots) s
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb AND s ? 'open_start'
        AND ($2::text[] IS NULL OR p.slug=ANY($2::text[])) AND (m.page_id,m.region COLLATE "C",(s->>'open_start')::bigint)>($3::int,$4::text,$5::bigint)
      GROUP BY m.page_id,p.slug,m.region,(s->>'open_start')::bigint ORDER BY m.page_id,m.region COLLATE "C",(s->>'open_start')::bigint LIMIT $6`;

const CLAIM_KEYS_SQL = `WITH w AS (
      SELECT w.visibility,w.fact_hash,COALESCE(w.subject,'*') AS subject,gbrain_fact_normalize(COALESCE(w.claim,
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint(f.fact)=w.fact_hash LIMIT 1),
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint_v2(f.fact)=w.fact_hash LIMIT 1),
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint_v1(f.fact)=w.fact_hash LIMIT 1))) AS norm
      FROM jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text,claim text)
    ) SELECT * FROM w`;

const PROVENANCE_PAGES_SQL = `SELECT DISTINCT p.id
    FROM jsonb_to_recordset($2::text::jsonb) k(visibility text,fact_hash text,subject text,norm text)
    JOIN facts f ON f.source_id=$1 AND f.visibility=k.visibility
      AND gbrain_fact_fingerprint(f.fact)=COALESCE(encode(sha256(convert_to(k.norm,'UTF8')),'hex'),k.fact_hash)
      AND (k.subject='*' OR f.entity_slug=k.subject OR ((starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') OR COALESCE(f.source_markdown_slug, '') = 'memory/scope') AND f.source_markdown_slug=k.subject))
    JOIN pages p ON p.source_id=f.source_id AND p.slug=COALESCE(f.source_markdown_slug,f.entity_slug)`;

const CLAIM_MATCHES_SQL = `SELECT DISTINCT i.id,i.ambiguous
      FROM jsonb_to_recordset($1::text::jsonb) i(id integer,slug text,claim text,visibility text,ambiguous boolean)
      JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text)
        ON (i.visibility IS NULL OR i.visibility=w.visibility) AND (w.subject='*' OR w.subject=i.slug)
          AND w.fact_hash IN (gbrain_fact_fingerprint(i.claim),gbrain_fact_fingerprint_v2(i.claim),gbrain_fact_fingerprint_v1(i.claim))`;

const INLINE_FENCE_PAGES_SQL = `SELECT p.id,p.slug,p.compiled_truth,p.timeline FROM pages p
      WHERE p.source_id=$1 AND p.id>$3 AND ($5::text[] IS NULL OR p.slug=ANY($5::text[]))
        AND (strpos(p.compiled_truth,'gbrain:facts:')>0 OR strpos(p.timeline,'gbrain:facts:')>0)
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) k(subject text,patterns text[])
          WHERE (k.subject='*' OR k.subject=p.slug) AND ((lower(p.compiled_truth) LIKE ALL(k.patterns)) OR (lower(p.timeline) LIKE ALL(k.patterns))))
      ORDER BY p.id LIMIT $4`;

const SEGMENT_FENCE_ROWS_SQL = `SELECT p.id,m.occurrence_id::text AS occurrence_id,p.slug,
        ARRAY(SELECT convert_from(substring(t.body from (s->>'start')::int + 1 for (s->>'end')::int - (s->>'start')::int),'UTF8') FROM jsonb_array_elements(m.facts_slots) s WHERE NOT s ? 'open_start') AS fences
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb
        AND (m.page_id,m.occurrence_id)>($3::int,$6::bigint) AND ($5::text[] IS NULL OR p.slug=ANY($5::text[]))
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) k(subject text,patterns text[]), jsonb_array_elements(m.facts_slots) s
          WHERE (k.subject='*' OR k.subject=p.slug) AND NOT s ? 'open_start' AND lower(convert_from(substring(t.body from (s->>'start')::int + 1 for (s->>'end')::int - (s->>'start')::int),'UTF8')) LIKE ALL(k.patterns))
      ORDER BY m.page_id,m.occurrence_id LIMIT $4`;

const TARGET_PAGES_SQL = `SELECT slug,id AS page_id,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])`;

function statement(read: WithdrawalDiscoveryRead): { text: string; params: unknown[] } {
  switch (read.kind) {
    case 'claim_keys': return { text: CLAIM_KEYS_SQL, params: [read.sourceId, JSON.stringify(read.claims)] };
    case 'provenance_pages': return { text: PROVENANCE_PAGES_SQL, params: [read.sourceId, JSON.stringify(read.keys)] };
    case 'claim_matches': return { text: CLAIM_MATCHES_SQL, params: [JSON.stringify(read.incoming), JSON.stringify(read.keys)] };
    case 'inline_fence_pages': return { text: INLINE_FENCE_PAGES_SQL, params: [read.sourceId, JSON.stringify(read.keys), read.after, read.limit, read.subjects] };
    case 'segment_fence_rows':
      return { text: SEGMENT_FENCE_ROWS_SQL, params: [read.sourceId, JSON.stringify(read.keys), read.after[0], read.limit, read.subjects, read.after[1]] };
    case 'split_fence_slots':
      return { text: SPLIT_FENCE_SLOTS_SQL, params: [read.sourceId, read.subjects, read.after[0], read.after[1], read.after[2], read.limit] };
    case 'target_pages': return { text: TARGET_PAGES_SQL, params: [read.sourceId, read.ids] };
    case 'sample_slugs': return { text: SAMPLE_SLUGS_SQL, params: [read.sourceId, read.ids] };
  }
}

/** One withdrawal discovery read (WithdrawalDiscoveryRead), as its call site ran it. */
export async function readWithdrawalDiscovery<K extends WithdrawalDiscoveryKind>(
  exec: Raw, read: Extract<WithdrawalDiscoveryRead, { kind: K }>,
): Promise<WithdrawalDiscoveryRows[K]> {
  const { text, params } = statement(read);
  return exec.executeRaw(text, params) as Promise<WithdrawalDiscoveryRows[K]>;
}
