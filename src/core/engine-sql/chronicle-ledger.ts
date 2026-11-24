/**
 * The chronicle ledger statements that the write-time decision of src/core/chronicle/ledger.ts ran through
 * `executeRaw`, as typed members: SQL once for both SQL engines, so the Rust store serves the same members
 * (rust/docs/store/chronicle-ledger.md). Each statement keeps the text its caller ran.
 */
import type { BrainEngine } from '../engine.ts';
import type { ChronicleLedgerRow } from '../chronicle/contract.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One automatic or backfill decision of the chronicle ledger: the row `upsertChronicleRow` writes (a pending or skipped row). */
export interface ChronicleRowUpsert {
  sourceId: string;
  pageId: number;
  contentHash: string;
  extractorVersion: number;
  slug: string;
  state: string;
  reason: string | null;
  trigger: string;
  principalKind: string | null;
  principalId: string | null;
  requestId: string | null;
  noExtract: boolean;
  /** An ISO instant, or null. */
  nextAttemptAt: string | null;
}

/** The decision upsert of src/core/chronicle/ledger.ts, as it ran. */
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
} as const;

/** Records a decision; false when the guards leave the existing row as it was (see ledger.ts upsertChronicleRow). */
export async function upsertChronicleRow(tx: Raw, w: ChronicleRowUpsert): Promise<boolean> {
  const written = await tx.executeRaw(CHRONICLE_LEDGER_SQL.upsert,
    [w.sourceId, w.pageId, w.contentHash, w.extractorVersion, w.slug, w.state, w.reason, w.trigger,
      w.principalKind, w.principalId, w.requestId, w.noExtract, w.nextAttemptAt]);
  return written.length > 0;
}

/** The key of one ledger row: `chronicle_page_state`'s primary key. */
export interface ChronicleRowKey {
  sourceId: string;
  pageId: number;
  contentHash: string;
  extractorVersion: number;
}

/** The other write-time statements of src/core/chronicle/ledger.ts, as they ran. */
export const CHRONICLE_STATE_SQL = {
  readRow: 'SELECT * FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4',
  pendingAuto: `SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND state='pending'
      AND trigger='auto' AND no_extract=false AND extractor_version=$3 LIMIT 1`,
  dailyCount: "SELECT count(*) AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'",
  truthLead: 'SELECT truth_lead FROM pages WHERE id=$1',
} as const;

/**
 * The chronicle judge reservation's lock, insert and prune, kept apart from CHRONICLE_STATE_SQL's reads so the
 * owner-socket read scan (test/rust-owner-ipc-read-classes.test.ts) sees that those reads reach no write.
 */
export const CHRONICLE_RESERVATION_SQL = {
  reserveLock: "SELECT pg_advisory_xact_lock(hashtext('gbrain:chronicle:daily_reservation'))",
  reserveInsert: 'INSERT INTO chronicle_judge_reservations (source_id, page_id, content_hash) VALUES ($1, $2, $3)',
  pruneReservations: "DELETE FROM chronicle_judge_reservations WHERE reserved_at < now() - interval '48 hours'",
} as const;

/** The chronicle activation stamp's insert, apart from CHRONICLE_STATE_SQL's reads for the same reason. */
export const CHRONICLE_ACTIVATION_SQL = 'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING';

/** The ledger row at `key`, every column, or null. */
export async function readChronicleRow(tx: Raw, key: ChronicleRowKey): Promise<ChronicleLedgerRow | null> {
  const [row] = await tx.executeRaw<ChronicleLedgerRow>(CHRONICLE_STATE_SQL.readRow,
    [key.sourceId, key.pageId, key.contentHash, key.extractorVersion]);
  return row ?? null;
}

/** Whether an automatic, extractable decision of the page at `extractorVersion` is still pending (add_link carries it). */
export async function hasPendingAutoChronicleRow(tx: Raw, sourceId: string, pageId: number, extractorVersion: number): Promise<boolean> {
  const rows = await tx.executeRaw(CHRONICLE_STATE_SQL.pendingAuto, [sourceId, pageId, extractorVersion]);
  return rows.length > 0;
}

/** The automatic judge reservations taken in the last 24 hours. */
export async function countRecentChronicleReservations(tx: Raw): Promise<number> {
  const [row] = await tx.executeRaw<{ n: number | string }>(CHRONICLE_STATE_SQL.dailyCount);
  return Number(row?.n ?? 0);
}

/** The page an automatic judge reservation is taken for. */
export interface ChronicleJudgeKey {
  sourceId: string;
  pageId: number;
  contentHash: string;
}

/**
 * Takes one automatic judge slot: true when fewer than `limit` reservations were taken in the last 24 hours and one is
 * recorded now, false otherwise. One transaction serialized by a transaction-scoped advisory lock, so concurrent hosts
 * cannot both take the last slot (the statements chronicle/ledger.ts reserveChronicleSlot ran).
 */
export function reserveChronicleJudgeSlot(engine: Pick<BrainEngine, 'transaction'>, limit: number, key: ChronicleJudgeKey): Promise<boolean> {
  return engine.transaction(async (tx) => {
    await tx.executeRaw(CHRONICLE_RESERVATION_SQL.reserveLock);
    if (await countRecentChronicleReservations(tx) >= limit) return false;
    await tx.executeRaw(CHRONICLE_RESERVATION_SQL.reserveInsert, [key.sourceId, key.pageId, key.contentHash]);
    return true;
  });
}

/** Deletes the reservations older than 48 hours (the window serves 24; doctor reads two days). */
export async function pruneChronicleReservations(tx: Raw): Promise<void> {
  await tx.executeRaw(CHRONICLE_RESERVATION_SQL.pruneReservations);
}

/** Sets a config key only when it has none; an existing value stays. */
export async function insertConfigIfAbsent(tx: Raw, key: string, value: string): Promise<void> {
  await tx.executeRaw(CHRONICLE_ACTIVATION_SQL, [key, value]);
}

/** The stored `truth_lead` of page `pageId` (a segmented page's body prefix), or null. */
export async function readPageTruthLead(tx: Raw, pageId: number): Promise<string | null> {
  const [row] = await tx.executeRaw<{ truth_lead: string | null }>(CHRONICLE_STATE_SQL.truthLead, [pageId]);
  return row?.truth_lead ?? null;
}
