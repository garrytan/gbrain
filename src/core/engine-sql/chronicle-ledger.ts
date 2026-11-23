/**
 * The chronicle ledger writes chronicle/ledger.ts ran through executeRaw (the decision upsert and the automatic judge
 * slot), as typed members: PGLite and Postgres send the same statements as before, and a Rust brain answers from its
 * store (rust/docs/store/chronicle-ledger.md). The ledger rollup is readChronicleLedgerStats (engine-sql/doctor-acc.ts).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One automatic or backfill decision: the row `upsertChronicleRow` writes. `nextAttemptAt` is an ISO instant or null. */
export interface ChronicleRowUpsert {
  sourceId: string;
  pageId: number;
  contentHash: string;
  extractorVersion: number;
  slug: string;
  state: 'pending' | 'skipped';
  reason: string | null;
  trigger: string;
  principalKind: string | null;
  principalId: string | null;
  requestId: string | null;
  noExtract: boolean;
  nextAttemptAt: string | null;
}

/** The page an automatic judge call is reserved for. */
export interface ChronicleJudgeKey { sourceId: string; pageId: number; contentHash: string }

/** The statements chronicle/ledger.ts upsertChronicleRow and reserveChronicleSlot ran. */
export const CHRONICLE_LEDGER_SQL = {
  upsert: `INSERT INTO chronicle_page_state AS c (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger,
       principal_kind, principal_id, request_id, no_extract, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13::timestamptz)
     ON CONFLICT (source_id, page_id, content_hash, extractor_version) DO UPDATE SET
       slug=EXCLUDED.slug, state=EXCLUDED.state, reason=EXCLUDED.reason, trigger=EXCLUDED.trigger,
       principal_kind=EXCLUDED.principal_kind, principal_id=EXCLUDED.principal_id, request_id=EXCLUDED.request_id,
       no_extract=EXCLUDED.no_extract, next_attempt_at=EXCLUDED.next_attempt_at, decided_at=now(), updated_at=now(),
       campaign_id=NULL, attempt_cap_usd=NULL, max_attempts=NULL, pricing_policy=NULL, campaign_max_usd=NULL
     WHERE NOT (EXCLUDED.trigger='auto' AND c.trigger='backfill' AND c.state IN ('pending','failed'))
       AND (c.state <> 'extracted' OR EXISTS (SELECT 1 FROM chronicle_page_state newer
         WHERE newer.source_id=c.source_id AND newer.page_id=c.page_id AND newer.content_hash<>c.content_hash
           AND newer.state='extracted' AND newer.updated_at > c.updated_at))
     RETURNING page_id`,
  lock: "SELECT pg_advisory_xact_lock(hashtext('gbrain:chronicle:daily_reservation'))",
  count: "SELECT count(*) AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'",
  reserve: 'INSERT INTO chronicle_judge_reservations (source_id, page_id, content_hash) VALUES ($1, $2, $3)',
} as const;

/** Records a decision; false when the guards leave the existing row as it was (see chronicle/ledger.ts). */
export async function upsertChronicleRow(tx: Raw, w: ChronicleRowUpsert): Promise<boolean> {
  const written = await tx.executeRaw(CHRONICLE_LEDGER_SQL.upsert,
    [w.sourceId, w.pageId, w.contentHash, w.extractorVersion, w.slug, w.state, w.reason, w.trigger,
      w.principalKind, w.principalId, w.requestId, w.noExtract, w.nextAttemptAt]);
  return written.length > 0;
}

/** Takes one automatic judge slot under the daily limit, serialized by a transaction-scoped advisory lock; false when used up. */
export function reserveChronicleJudgeSlot(engine: Pick<BrainEngine, 'transaction'>, limit: number, key: ChronicleJudgeKey): Promise<boolean> {
  return engine.transaction(async (tx) => {
    await tx.executeRaw(CHRONICLE_LEDGER_SQL.lock);
    const [row] = await tx.executeRaw<{ n: number | string }>(CHRONICLE_LEDGER_SQL.count);
    if (Number(row?.n ?? 0) >= limit) return false;
    await tx.executeRaw(CHRONICLE_LEDGER_SQL.reserve, [key.sourceId, key.pageId, key.contentHash]);
    return true;
  });
}
