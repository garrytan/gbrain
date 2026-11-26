/**
 * The reads withdrawal discovery makes (discoverWithdrawalTargets, src/core/facts/withdrawal-discovery.ts) to find
 * every page that carries a withdrawn claim. They ran through `executeRaw` before they had one typed member,
 * `readWithdrawalDiscovery`; each kind keeps the statement text and parameter order its call site ran, so PGLite and
 * Postgres answer exactly as before (test/withdrawal-discovery-reads-sql-pin.test.ts pins the text). A Rust brain
 * does not serve the member yet: it is held as raw_sql there.
 *
 * - `claim_keys`: each claim's ledger subject and normalized text (its own text, else a source fact's with its fingerprint).
 * - `claim_matches`: the fence and chunk rows whose claim fingerprints equal a key's, with whether the row was ambiguous.
 * - `split_fence_slots`: the facts fences of segmented pages a forced cut split, with the bytes their slots hold.
 * - `target_pages`: slug, id and knowledge revision of the matched pages.
 * - `sample_slugs`: up to 20 slugs of the matched pages, for the capacity refusal.
 *
 * Each statement is the call site's text byte for byte, so the PGLite and Postgres answers do not move. The reads that
 * splice text into their statement (provenance pages, inline fence pages, segment fence rows, with the owned-memory-page
 * rule and the LIKE shortlist) stay at the call site: engine-sql binds every value and splices no text.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One claim keyed for discovery: `norm` is its normalized text (null when no fact carries it), `patterns` its LIKE tokens. */
export interface WithdrawalDiscoveryKey { visibility: string; fact_hash: string; subject: string; norm: string | null; patterns: string[] }
/** One fence or chunk row discovery checks against the keys. */
export interface WithdrawalDiscoveryCandidate { id: number; slug: string; claim: string; visibility: string | null; ambiguous: boolean }

export type WithdrawalDiscoveryRead =
  | { kind: 'claim_keys'; sourceId: string; claims: Array<{ visibility: string; fact_hash: string; subject: string; claim: string | null }> }
  | { kind: 'claim_matches'; incoming: WithdrawalDiscoveryCandidate[]; keys: WithdrawalDiscoveryKey[] }
  | { kind: 'split_fence_slots'; sourceId: string; subjects: string[] | null; after: [page: number, region: string, openStart: number]; limit: number }
  | { kind: 'target_pages'; sourceId: string; ids: number[] }
  | { kind: 'sample_slugs'; sourceId: string; ids: number[] };

export interface WithdrawalDiscoveryRows {
  claim_keys: Array<{ visibility: string; fact_hash: string; subject: string; norm: string | null }>;
  claim_matches: Array<{ id: number; ambiguous: boolean }>;
  split_fence_slots: Array<{ page_id: number; slug: string; region: string; open_start: string; bytes: string }>;
  target_pages: Array<{ slug: string; page_id: number; revision: string }>;
  sample_slugs: Array<{ slug: string }>;
}

export type WithdrawalDiscoveryKind = WithdrawalDiscoveryRead['kind'];

const SAMPLE_SLUGS_SQL = `SELECT slug FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug LIMIT 20`;

const SPLIT_FENCE_SLOTS_SQL = `SELECT m.page_id,p.slug,m.region,
        (s->>'open_start')::bigint::text AS open_start,sum((s->>'end')::bigint-(s->>'start')::bigint)::text AS bytes
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id CROSS JOIN LATERAL jsonb_array_elements(m.facts_slots) s
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb AND s ? 'open_start'
        AND ($2::text[] IS NULL OR p.slug=ANY($2::text[])) AND (m.page_id,m.region,(s->>'open_start')::bigint)>($3::int,$4::text,$5::bigint)
      GROUP BY m.page_id,p.slug,m.region,(s->>'open_start')::bigint ORDER BY m.page_id,m.region,(s->>'open_start')::bigint LIMIT $6`;

const CLAIM_KEYS_SQL = `WITH w AS (
      SELECT w.visibility,w.fact_hash,COALESCE(w.subject,'*') AS subject,gbrain_fact_normalize(COALESCE(w.claim,
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint(f.fact)=w.fact_hash LIMIT 1),
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint_v1(f.fact)=w.fact_hash LIMIT 1))) AS norm
      FROM jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text,claim text)
    ) SELECT * FROM w`;

const CLAIM_MATCHES_SQL = `SELECT DISTINCT i.id,i.ambiguous
      FROM jsonb_to_recordset($1::text::jsonb) i(id integer,slug text,claim text,visibility text,ambiguous boolean)
      JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text)
        ON (i.visibility IS NULL OR i.visibility=w.visibility) AND (w.subject='*' OR w.subject=i.slug)
          AND w.fact_hash IN (gbrain_fact_fingerprint(i.claim),gbrain_fact_fingerprint_v1(i.claim))`;

const TARGET_PAGES_SQL = `SELECT slug,id AS page_id,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])`;

function statement(read: WithdrawalDiscoveryRead): { text: string; params: unknown[] } {
  switch (read.kind) {
    case 'claim_keys': return { text: CLAIM_KEYS_SQL, params: [read.sourceId, JSON.stringify(read.claims)] };
    case 'claim_matches': return { text: CLAIM_MATCHES_SQL, params: [JSON.stringify(read.incoming), JSON.stringify(read.keys)] };
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
