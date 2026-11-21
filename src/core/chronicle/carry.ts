/**
 * pages-03: a chronicle ledger row the one-time upgrade re-read could not move.
 *
 * The re-read moves a page's ledger row from its old content hash to the new one (carryHashKeyedPageState), except
 * while a judge holds the row's lease or the row waits out a retry delay: that judge's outcome and spend are keyed to
 * the old hash. Such a row is recorded here as carried (`op_checkpoints`, op `chronicle-carry`, one entry per old
 * hash) so the page is paid for once:
 *
 * - the new hash's row is not claimable while the record is unsettled and the carried row is still pending or failed,
 *   whatever its lease or retry delay says (claimChronicleRow), so no second judge runs on the same meaning; a claim
 *   that finds it blocked by a record whose lease or delay ended settles it there and claims the moved row, so a run
 *   that skipped the settlement pass (a job, a deadline crossed after the pass) still judges the page once;
 * - the judge holding the carried row follows it to the new hash when it finds the page moved (followChronicleCarry),
 *   publishing what it already paid for against the new revision;
 * - a carried row whose lease ended without that (a crash, a retry delay) moves on the next chronicle run
 *   (settleChronicleCarries), before rows of content that is no longer live are superseded.
 *
 * A moved row's record stays, marked settled, as a forwarding entry from the old hash to the new one: a judge whose
 * lease ended while the row moved still reports to the row (finish follows it), so its spend is recorded once (keyed to
 * its attempt) and its outcome applies only while its attempt is still the row's latest. A settled entry is dropped once
 * the row it forwards to is gone; entries exist only for rows leased or waiting at the upgrade re-read, and for rows a
 * judge's ended lease or an ended retry delay left pending or failed, which the re-read moved at once.
 *
 * The carried row replaces the new hash's row only when that row holds no paid history (a fresh write decision), so its
 * campaign stamp, attempts and recorded spend stay on the page's live row and count once. A page whose content changed
 * again since the re-read keeps the ordinary path: the record is dropped and the old row is superseded.
 */
import type { BrainEngine } from '../engine.ts';
import { CHRONICLE_EXTRACTOR_VERSION } from './contract.ts';

export const CHRONICLE_CARRY_OP = 'chronicle-carry';

type CarryKey = { sourceId: string; pageId: number; fromHash: string };

const fingerprintOf = (key: CarryKey) => `${key.sourceId}:${key.pageId}:${key.fromHash}`;
const fingerprintSql = (alias: string) => `${alias}.source_id || ':' || ${alias}.page_id::text || ':' || ${alias}.content_hash`;
/** SQL condition on a carry record aliased `m`: not yet moved (a settled record only forwards the old hash). */
const unsettledSql = `m.completed_keys->0->>'settled' IS NULL`;
/** SQL condition: the ledger row aliased `alias` is recorded as carried (its judge or its wait still holds it). */
export const isCarriedRowSql = (alias: string) =>
  `EXISTS (SELECT 1 FROM op_checkpoints m WHERE m.op='${CHRONICLE_CARRY_OP}' AND m.fingerprint = ${fingerprintSql(alias)} AND ${unsettledSql})`;
/** SQL: the ledger row a carry record (aliased `m`) names, as a join condition on the row aliased `alias`. */
const carriedRowSql = (alias: string) => `${alias}.source_id = m.completed_keys->0->>'sourceId'
  AND ${alias}.page_id = (m.completed_keys->0->>'pageId')::int AND ${alias}.content_hash = m.completed_keys->0->>'fromHash'`;

/**
 * Inside the page write, after the ledger row move: records each current-extractor row still at `fromHash` because a
 * judge holds its lease or it waits out a retry delay.
 */
async function recordChronicleCarry(tx: BrainEngine, sourceId: string, pageId: number, fromHash: string, toHash: string): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO op_checkpoints (op, fingerprint, completed_keys)
     SELECT $1, ${fingerprintSql('c')},
            jsonb_build_array(jsonb_build_object('sourceId', c.source_id, 'pageId', c.page_id, 'fromHash', c.content_hash, 'toHash', $5::text))
       FROM chronicle_page_state c
      WHERE c.source_id=$2 AND c.page_id=$3 AND c.content_hash=$4 AND c.extractor_version=$6
        AND c.state IN ('pending','failed') AND c.next_attempt_at > now()
     ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
    [CHRONICLE_CARRY_OP, sourceId, pageId, fromHash, toHash, CHRONICLE_EXTRACTOR_VERSION]);
}

/**
 * Inside the page write: moves the page's ledger rows from `fromHash` to `toHash` (they carry recorded spend and failed
 * attempts, which a copy would count twice), naming the page's slug now, as a rename in the same sync left it. A row
 * whose lease or retry delay already ended moves at once; a current-extractor row of those that a judge may still
 * report to (its lease ended while it called the model) gets a settled forwarding record, so that judge's spend and
 * outcome follow the row. A row that stays (leased or waiting) is recorded as carried: the new hash's row waits for
 * it, and it follows later.
 */
export async function moveChronicleRows(tx: BrainEngine, sourceId: string, pageId: number, fromHash: string, toHash: string): Promise<void> {
  await tx.executeRaw(
    `WITH moved AS (
       UPDATE chronicle_page_state c SET content_hash=$3,
              slug=COALESCE((SELECT p.slug FROM pages p WHERE p.id=c.page_id AND p.source_id=c.source_id AND p.deleted_at IS NULL), c.slug)
        WHERE c.source_id=$4 AND c.page_id=$1 AND c.content_hash=$2
          AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
          AND NOT EXISTS (SELECT 1 FROM chronicle_page_state n WHERE n.source_id=c.source_id AND n.page_id=c.page_id
            AND n.content_hash=$3 AND n.extractor_version=c.extractor_version)
        RETURNING c.source_id, c.page_id, c.state, c.next_attempt_at, c.extractor_version)
     INSERT INTO op_checkpoints (op, fingerprint, completed_keys)
     SELECT $5, m.source_id || ':' || m.page_id::text || ':' || $2::text,
            jsonb_build_array(jsonb_build_object('sourceId', m.source_id, 'pageId', m.page_id, 'fromHash', $2::text, 'toHash', $3::text, 'settled', true))
       FROM moved m WHERE m.extractor_version=$6 AND m.state IN ('pending','failed') AND m.next_attempt_at IS NOT NULL
     ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
    [pageId, fromHash, toHash, sourceId, CHRONICLE_CARRY_OP, CHRONICLE_EXTRACTOR_VERSION]);
  await recordChronicleCarry(tx, sourceId, pageId, fromHash, toHash);
}

/**
 * SQL condition (row aliased `alias`, current extractor): an unsettled carried row of the same page, still pending or
 * failed, is owed this row's hash. Its lease or retry delay is not consulted: the row stays blocked until the carried
 * row moves (or the record is dropped), so a deadline crossed between settlement and claim never frees it.
 */
export const awaitsCarriedRowSql = (alias: string) => `EXISTS (SELECT 1 FROM op_checkpoints m
    JOIN chronicle_page_state o ON ${carriedRowSql('o')} AND o.extractor_version=${alias}.extractor_version
   WHERE m.op='${CHRONICLE_CARRY_OP}' AND m.completed_keys->0->>'toHash' = ${alias}.content_hash
     AND m.completed_keys->0->>'sourceId' = ${alias}.source_id AND (m.completed_keys->0->>'pageId')::int = ${alias}.page_id
     AND ${unsettledSql} AND o.state IN ('pending','failed'))`;

/**
 * Moves one carried row to the hash its page now has, replacing a row there that holds no paid history, and marks the
 * record settled. `owner`: the attempt of the executor holding the row's lease (it follows its own row); without it
 * the row moves only once its lease or retry delay ended. Returns the new hash, or null when the row stays (the record
 * is kept while it still waits, else dropped). On a settled record, an owner whose attempt is still the moved row's
 * latest gets the new hash while the page still has it (its row moved while it judged); a settled record whose row is
 * gone is dropped.
 */
async function moveCarried(engine: BrainEngine, key: CarryKey, owner: { attempts: number; requestId: string | null } | null): Promise<string | null> {
  return engine.transaction(async (tx) => {
    const fingerprint = fingerprintOf(key);
    const drop = async () => { await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [CHRONICLE_CARRY_OP, fingerprint]); return null; };
    // Movers of one carry take turns on its record, so the second reads what the first left: a settled forwarding
    // record it keeps, never the unsettled one it read before the first moved the row (it would drop it, and a late
    // judge's spend with it). The read below is a new statement, so it sees the first mover's commit.
    const [held] = await tx.executeRaw<{ held: number }>('SELECT 1 AS held FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR UPDATE',
      [CHRONICLE_CARRY_OP, fingerprint]);
    if (!held) return null;
    const [carry] = await tx.executeRaw<{ to_hash: string; live_hash: string | null; attempts: number | null; waiting: boolean | null; settled: boolean; moved_attempts: number | null; moved_request: string | null }>(
      `SELECT m.completed_keys->0->>'toHash' AS to_hash,
              (SELECT p.content_hash FROM pages p WHERE p.id=$3 AND p.source_id=$2 AND p.deleted_at IS NULL) AS live_hash,
              c.attempts, (c.state IN ('pending','failed') AND c.next_attempt_at > now()) AS waiting,
              m.completed_keys->0->>'settled' IS NOT NULL AS settled,
              (SELECT n.attempts FROM chronicle_page_state n WHERE n.source_id=$2 AND n.page_id=$3
                  AND n.content_hash=m.completed_keys->0->>'toHash' AND n.extractor_version=$5) AS moved_attempts,
              (SELECT n.request_id::text FROM chronicle_page_state n WHERE n.source_id=$2 AND n.page_id=$3
                  AND n.content_hash=m.completed_keys->0->>'toHash' AND n.extractor_version=$5) AS moved_request
         FROM op_checkpoints m
         LEFT JOIN chronicle_page_state c ON c.source_id=$2 AND c.page_id=$3 AND c.content_hash=$4 AND c.extractor_version=$5
        WHERE m.op=$1 AND m.fingerprint=$6`,
      [CHRONICLE_CARRY_OP, key.sourceId, key.pageId, key.fromHash, CHRONICLE_EXTRACTOR_VERSION, fingerprint]);
    if (!carry) return null;
    if (carry.settled) {
      if (carry.moved_attempts == null) return drop();
      // The moved row's judge follows only while the page still has the hash it moved to: after a later edit its answer
      // is about content the page no longer holds, so it is not published (its spend still lands, via finish). Nor after
      // a newer decision on the moved row (a write that kept the content, e.g. with extraction turned off).
      return owner && Number(carry.moved_attempts) === owner.attempts && carry.moved_request === owner.requestId
        && carry.attempts == null && carry.live_hash === carry.to_hash ? carry.to_hash : null;
    }
    if (carry.attempts == null || carry.live_hash !== carry.to_hash) return drop();
    if (owner ? Number(carry.attempts) !== owner.attempts : carry.waiting === true) return null;
    // Only a fresh pending decision gives way. A skip decision (`--no-extract`, a page the writer may not have judged)
    // is the live revision's own choice: the carried row then stays behind and the record is dropped.
    await tx.executeRaw(
      `DELETE FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4
         AND state='pending' AND no_extract=false AND attempts=0 AND cost_usd IS NULL AND cardinality(cost_attempts)=0 AND judge_input_failures=0`,
      [key.sourceId, key.pageId, carry.to_hash, CHRONICLE_EXTRACTOR_VERSION]);
    // The moved row names the page's slug now: the re-read may also have renamed it.
    const moved = await tx.executeRaw(
      `UPDATE chronicle_page_state c SET content_hash=$5, updated_at=now(),
              slug=COALESCE((SELECT p.slug FROM pages p WHERE p.id=c.page_id AND p.source_id=c.source_id AND p.deleted_at IS NULL), c.slug)
        WHERE c.source_id=$1 AND c.page_id=$2 AND c.content_hash=$3 AND c.extractor_version=$4 AND c.attempts=$6
          AND NOT EXISTS (SELECT 1 FROM chronicle_page_state n WHERE n.source_id=c.source_id AND n.page_id=c.page_id
            AND n.content_hash=$5 AND n.extractor_version=c.extractor_version)
        RETURNING c.page_id`,
      [key.sourceId, key.pageId, key.fromHash, CHRONICLE_EXTRACTOR_VERSION, carry.to_hash, Number(carry.attempts)]);
    if (!moved.length) return drop();
    await tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,settled}', 'true'::jsonb), updated_at=now()
      WHERE op=$1 AND fingerprint=$2`, [CHRONICLE_CARRY_OP, fingerprint]);
    return carry.to_hash;
  });
}

/**
 * The hash `row` is recorded under now: its own, or, when it is gone and a settled carry forwards its hash, the hash
 * the row moved to. An outcome or spend of a judge whose row moved while it ran lands on the moved row.
 */
export async function carriedRowHash(engine: BrainEngine, row: { source_id: string; page_id: number | string; content_hash: string }): Promise<string> {
  const [forward] = await engine.executeRaw<{ to_hash: string }>(
    `SELECT m.completed_keys->0->>'toHash' AS to_hash FROM op_checkpoints m
      WHERE m.op=$1 AND m.fingerprint=$2 AND m.completed_keys->0->>'settled' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.source_id=$3 AND c.page_id=$4 AND c.content_hash=$5 AND c.extractor_version=$6)`,
    [CHRONICLE_CARRY_OP, fingerprintOf({ sourceId: row.source_id, pageId: Number(row.page_id), fromHash: row.content_hash }),
      row.source_id, Number(row.page_id), row.content_hash, CHRONICLE_EXTRACTOR_VERSION]);
  return forward?.to_hash ?? row.content_hash;
}

/**
 * pages-03: a claim of `row` that found it blocked by an unsettled carry whose lease or retry delay ended settles that
 * carry here, moving the carried row (its state, campaign stamp and attempts) onto `row`'s hash for the caller to
 * claim. False when no such carry names the row or none moved.
 */
export async function settleCarryInto(engine: BrainEngine, row: { source_id: string; page_id: number | string; content_hash: string }): Promise<boolean> {
  const carries = await engine.executeRaw<{ from_hash: string }>(
    `SELECT m.completed_keys->0->>'fromHash' AS from_hash FROM op_checkpoints m
      WHERE m.op=$1 AND m.completed_keys->0->>'toHash'=$2 AND m.completed_keys->0->>'sourceId'=$3
        AND (m.completed_keys->0->>'pageId')::int=$4 AND ${unsettledSql}`,
    [CHRONICLE_CARRY_OP, row.content_hash, row.source_id, Number(row.page_id)]);
  let moved = false;
  for (const c of carries) if (await moveCarried(engine, { sourceId: row.source_id, pageId: Number(row.page_id), fromHash: c.from_hash }, null)) moved = true;
  return moved;
}

/** The executor holding `row`'s lease follows it to its page's new hash; null when the row was not carried there. */
export async function followChronicleCarry(engine: BrainEngine, row: { source_id: string; page_id: number | string; content_hash: string; request_id: string | null }, attempts: number): Promise<string | null> {
  return moveCarried(engine, { sourceId: row.source_id, pageId: Number(row.page_id), fromHash: row.content_hash }, { attempts, requestId: row.request_id ?? null });
}

/** Moves every carried row whose lease or retry delay ended; drops records whose row or page moved on, and settled records whose moved row is gone. */
export async function settleChronicleCarries(engine: BrainEngine): Promise<void> {
  // moveCarried drops a record whose row is gone (its page was deleted) or whose page changed again. A settled record
  // is read only once the row it forwards to is gone, to drop it.
  const carries = await engine.executeRaw<{ source_id: string; page_id: number | string; from_hash: string }>(
    `SELECT m.completed_keys->0->>'sourceId' AS source_id, m.completed_keys->0->>'pageId' AS page_id, m.completed_keys->0->>'fromHash' AS from_hash
       FROM op_checkpoints m WHERE m.op=$1 AND (${unsettledSql} OR NOT EXISTS (SELECT 1 FROM chronicle_page_state n
         WHERE n.source_id = m.completed_keys->0->>'sourceId' AND n.page_id = (m.completed_keys->0->>'pageId')::int
           AND n.content_hash = m.completed_keys->0->>'toHash'))`, [CHRONICLE_CARRY_OP]);
  for (const c of carries) await moveCarried(engine, { sourceId: c.source_id, pageId: Number(c.page_id), fromHash: c.from_hash }, null);
}
