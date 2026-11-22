/**
 * The journal statements of a page purge's sweep and intent redaction (persistence/intent-redaction.ts): the requests of a
 * slug, the source's sequence ceiling, one keyset chunk of the carrying predicate, the request lock, the effect byte sum, the
 * redaction of one request row and the release of its counters. Each ran through `executeRaw`; SQL once for both engines, so
 * the Rust store serves the same members from its request records (src/core/rust-engine/store-members/page-purge-journal.ts).
 *
 * Every function takes the engine (or transaction) it runs on. A chunk's rows come back in sequence order, ids as text.
 */
import type { BrainEngine } from '../engine.ts';
import type { IntentRedactionTarget } from '../persistence/intent-redaction.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { EFFECT_BYTES_SQL } from '../persistence/receipt-bytes.ts';
import type { WriteRequest } from '../persistence/model.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** A request of a slug that still holds its intent; its sequence is text (a bigint). */
export type SlugRequestRow = IntentRedactionTarget & { sequence: string };

/** One request of a chunk that matched a needle or was still pending, with the 0-based indexes of the needles it carries. */
export type JournalChunkRow = IntentRedactionTarget & { sequence: string; pending: boolean; matched: boolean; hits: number[] };

/**
 * One chunk of the carrying predicate: the rows of `sourceId` with `after < sequence <= ceiling` (`ceiling` null: no upper
 * bound), among `ids` when given and but for `exclude`, in sequence order, at most `limit`. Sequences are text (bigint).
 */
export interface JournalChunkQuery {
  sourceId: string;
  needles: readonly string[];
  after: string;
  ceiling: string | null;
  limit: number;
  ids: readonly string[] | null;
  exclude: string | null;
}

/** The chunk's matching or pending rows, the chunk's row count and its last scanned sequence (null for an empty chunk), so a caller continues past a chunk that matched nothing. */
export interface JournalSweepChunk { rows: JournalChunkRow[]; scanned: number; last: string | null }

/** What `redactWriteRequestRow` stores: the request, its new terminal reservation, and its outcome and error detail (null: none). */
export interface RequestRedaction { id: string; terminalReservation: number; outcome: unknown; errorDetail: unknown }

/** Numeric order of bigint texts. */
const bySequence = (a: { sequence: string }, b: { sequence: string }): number => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0);

/**
 * The source's requests under one of `slugs` that are not compacted and still hold an intent, with a sequence past `after`,
 * in sequence order, at most `limit`. The order is the numeric one: `ORDER BY` names the column, not the text alias of it.
 */
export async function listRequestsForSlugs(engine: Raw, sourceId: string, slugs: readonly string[], limit: number, after: string): Promise<SlugRequestRow[]> {
  return engine.executeRaw<SlugRequestRow>(`SELECT id::text AS id,principal_kind,principal_id,sequence::text AS sequence FROM persistence_requests
    WHERE source_id=$1 AND slug=ANY($2::text[]) AND NOT compacted AND intent IS NOT NULL AND sequence > $4::bigint ORDER BY persistence_requests.sequence LIMIT $3`, [sourceId, [...slugs], limit, after]);
}

/** The source's highest request sequence as text; null when it has no request. */
export async function readJournalCeiling(engine: Raw, sourceId: string): Promise<string | null> {
  const [top] = await engine.executeRaw<{ ceiling: string | null }>('SELECT max(sequence)::text AS ceiling FROM persistence_requests WHERE source_id=$1', [sourceId]);
  return top?.ceiling ?? null;
}

interface SweepRow extends IntentRedactionTarget { sequence: string; pending: boolean; hits: number[] | null; chunk_rows: string; chunk_last: string | null }

/**
 * One chunk of the carrying predicate. The chunk is materialised once and each text column lowered once per row; only the
 * rows that match a needle (`strpos` over the lowercased intent, outcome, error detail and error message) or are still
 * pending (queued, deferred, running, recovering, or holding a recovery record) come back, with the 0-based indexes of the
 * needles each carries (`hits`), plus the chunk's row count and last scanned sequence (as text: bigint) so the caller continues
 * past a chunk that matched nothing. Needles are matched as given: the caller lowercases them.
 */
export async function sweepJournalChunk(engine: Raw, q: JournalChunkQuery): Promise<JournalSweepChunk> {
  const rows = await engine.executeRaw<SweepRow>(`WITH chunk AS MATERIALIZED (
      SELECT id,principal_kind,principal_id,sequence,
        (state IN ('queued','deferred','running','recovering') OR recovery IS NOT NULL) AS pending,
        lower(COALESCE(intent::text,'')) AS i,lower(COALESCE(outcome::text,'')) AS o,lower(COALESCE(error_detail::text,'')) AS d,lower(COALESCE(error_message,'')) AS m
      FROM persistence_requests WHERE source_id=$1 AND sequence>$2::bigint AND ($3::bigint IS NULL OR sequence<=$3::bigint)
        AND ($6::uuid[] IS NULL OR id=ANY($6::uuid[])) AND ($7::uuid IS NULL OR id<>$7::uuid)
      ORDER BY sequence LIMIT $5),
    stats AS (SELECT count(*)::text AS chunk_rows,max(sequence)::text AS chunk_last FROM chunk),
    tested AS (SELECT id,principal_kind,principal_id,sequence,pending,
        ARRAY(SELECT (n.ord-1)::int FROM unnest($4::text[]) WITH ORDINALITY AS n(v,ord)
          WHERE strpos(i,n.v)>0 OR strpos(o,n.v)>0 OR strpos(d,n.v)>0 OR strpos(m,n.v)>0 ORDER BY n.ord) AS hits FROM chunk)
    SELECT t.id::text AS id,t.principal_kind,t.principal_id,t.sequence::text AS sequence,t.pending,t.hits,s.chunk_rows,s.chunk_last
      FROM tested t CROSS JOIN stats s WHERE cardinality(t.hits)>0 OR t.pending
    UNION ALL SELECT NULL,NULL,NULL,NULL,false,NULL::int[],s.chunk_rows,s.chunk_last FROM stats s`,
  [q.sourceId, q.after, q.ceiling, [...q.needles], q.limit, q.ids ? [...q.ids] : null, q.exclude]);
  // Every row carries the chunk statistics; the sentinel row guarantees at least one.
  const stats = rows[0]!;
  return { rows: rows.filter(row => row.id !== null).map(({ id, principal_kind, principal_id, sequence, pending, hits }) => ({ id, principal_kind, principal_id, sequence, pending,
    matched: (hits?.length ?? 0) > 0, hits: (hits ?? []).map(Number) })).sort(bySequence), scanned: Number(stats.chunk_rows), last: stats.chunk_last };
}

/** The bytes the request's effect rows hold on its receipt (`EFFECT_BYTES_SQL` each); 0 when it has none. */
export async function readEffectBytes(engine: Raw, requestId: string): Promise<number> {
  const sql = renderFragment(sqlFragment`SELECT COALESCE(SUM(${trustedSql(EFFECT_BYTES_SQL)}),0)::text AS bytes
      FROM persistence_effects WHERE request_id=${requestId}::uuid`);
  const [effects] = await engine.executeRaw<{ bytes: string }>(sql.text, sql.params);
  return Number(effects!.bytes);
}

/**
 * Redacts one request row: its intent and error message removed, marked compacted, its terminal reservation, outcome and error
 * detail replaced (a null outcome or error detail stores SQL NULL). Writes persistence_requests; run it in the purge transaction.
 */
export async function redactWriteRequestRow(engine: Raw, redaction: RequestRedaction): Promise<void> {
  const text = (value: unknown) => value == null ? null : JSON.stringify(value);
  await engine.executeRaw(`UPDATE persistence_requests SET intent=NULL,compacted=true,error_message=NULL,terminal_reservation=$2,
      outcome=$3::text::jsonb,error_detail=$4::text::jsonb WHERE id=$1::uuid`,
  [redaction.id, redaction.terminalReservation, text(redaction.outcome), text(redaction.errorDetail)]);
}

/** Lowers the counter's `terminal_bytes` by `bytes`, never below zero. Writes persistence_counters; run it in the purge transaction. */
export async function releaseTerminalBytes(engine: Raw, key: string, bytes: number): Promise<void> {
  await engine.executeRaw('UPDATE persistence_counters SET terminal_bytes=terminal_bytes-LEAST($2::bigint,terminal_bytes) WHERE key=$1', [key, bytes]);
}
