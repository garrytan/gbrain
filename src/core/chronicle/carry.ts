/**
 * pages-03: a chronicle ledger row the one-time upgrade re-read could not move.
 *
 * The re-read moves a page's ledger row from its old content hash to the new one (carryHashKeyedPageState), except
 * while a judge holds the row's lease or the row waits out a retry delay: that judge's outcome and spend are keyed to
 * the old hash. Such a row is recorded here as carried (`op_checkpoints`, op `chronicle-carry`, one entry per old
 * hash) so the page is paid for once:
 *
 * - the new hash's row is not claimable while the carried row is leased or waits (claimChronicleRow), so no second
 *   judge runs on the same meaning;
 * - the judge holding the carried row follows it to the new hash when it finds the page moved (followChronicleCarry),
 *   publishing what it already paid for against the new revision;
 * - a carried row whose lease ended without that (a crash, a retry delay) moves on the next chronicle run
 *   (settleChronicleCarries), before rows of content that is no longer live are superseded.
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
/** SQL condition: the ledger row aliased `alias` is recorded as carried (its judge or its wait still holds it). */
export const isCarriedRowSql = (alias: string) =>
  `EXISTS (SELECT 1 FROM op_checkpoints m WHERE m.op='${CHRONICLE_CARRY_OP}' AND m.fingerprint = ${fingerprintSql(alias)})`;
/** SQL: the ledger row a carry record (aliased `m`) names, as a join condition on the row aliased `alias`. */
const carriedRowSql = (alias: string) => `${alias}.source_id = m.completed_keys->0->>'sourceId'
  AND ${alias}.page_id = (m.completed_keys->0->>'pageId')::int AND ${alias}.content_hash = m.completed_keys->0->>'fromHash'`;

/**
 * Inside the page write, after the ledger row move: records each current-extractor row still at `fromHash` because a
 * judge holds its lease or it waits out a retry delay.
 */
export async function recordChronicleCarry(tx: BrainEngine, sourceId: string, pageId: number, fromHash: string, toHash: string): Promise<void> {
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

/** SQL condition (row aliased `alias`, current extractor): a carried row of the same page still holds this row's hash. */
export const awaitsCarriedRowSql = (alias: string) => `EXISTS (SELECT 1 FROM op_checkpoints m
    JOIN chronicle_page_state o ON ${carriedRowSql('o')} AND o.extractor_version=${alias}.extractor_version
   WHERE m.op='${CHRONICLE_CARRY_OP}' AND m.completed_keys->0->>'toHash' = ${alias}.content_hash
     AND m.completed_keys->0->>'sourceId' = ${alias}.source_id AND (m.completed_keys->0->>'pageId')::int = ${alias}.page_id
     AND o.state IN ('pending','failed') AND o.next_attempt_at > now())`;

/**
 * Moves one carried row to the hash its page now has, replacing a row there that holds no paid history. `owner`: the
 * attempt of the executor holding the row's lease (it follows its own row); without it the row moves only once its
 * lease or retry delay ended. Returns the new hash, or null when the row stays (the record is kept while it still
 * waits, else dropped).
 */
async function moveCarried(engine: BrainEngine, key: CarryKey, owner: { attempts: number } | null): Promise<string | null> {
  return engine.transaction(async (tx) => {
    const fingerprint = fingerprintOf(key);
    const drop = async () => { await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [CHRONICLE_CARRY_OP, fingerprint]); return null; };
    const [carry] = await tx.executeRaw<{ to_hash: string; live_hash: string | null; attempts: number | null; waiting: boolean | null }>(
      `SELECT m.completed_keys->0->>'toHash' AS to_hash,
              (SELECT p.content_hash FROM pages p WHERE p.id=$3 AND p.source_id=$2 AND p.deleted_at IS NULL) AS live_hash,
              c.attempts, (c.state IN ('pending','failed') AND c.next_attempt_at > now()) AS waiting
         FROM op_checkpoints m
         LEFT JOIN chronicle_page_state c ON c.source_id=$2 AND c.page_id=$3 AND c.content_hash=$4 AND c.extractor_version=$5
        WHERE m.op=$1 AND m.fingerprint=$6`,
      [CHRONICLE_CARRY_OP, key.sourceId, key.pageId, key.fromHash, CHRONICLE_EXTRACTOR_VERSION, fingerprint]);
    if (!carry) return null;
    if (carry.attempts == null || carry.live_hash !== carry.to_hash) return drop();
    if (owner ? Number(carry.attempts) !== owner.attempts : carry.waiting === true) return null;
    await tx.executeRaw(
      `DELETE FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4
         AND state<>'extracted' AND attempts=0 AND cost_usd IS NULL AND cardinality(cost_attempts)=0 AND judge_input_failures=0`,
      [key.sourceId, key.pageId, carry.to_hash, CHRONICLE_EXTRACTOR_VERSION]);
    const moved = await tx.executeRaw(
      `UPDATE chronicle_page_state c SET content_hash=$5, updated_at=now()
        WHERE c.source_id=$1 AND c.page_id=$2 AND c.content_hash=$3 AND c.extractor_version=$4 AND c.attempts=$6
          AND NOT EXISTS (SELECT 1 FROM chronicle_page_state n WHERE n.source_id=c.source_id AND n.page_id=c.page_id
            AND n.content_hash=$5 AND n.extractor_version=c.extractor_version)
        RETURNING c.page_id`,
      [key.sourceId, key.pageId, key.fromHash, CHRONICLE_EXTRACTOR_VERSION, carry.to_hash, Number(carry.attempts)]);
    await drop();
    return moved.length ? carry.to_hash : null;
  });
}

/** The executor holding `row`'s lease follows it to its page's new hash; null when the row was not carried there. */
export async function followChronicleCarry(engine: BrainEngine, row: { source_id: string; page_id: number | string; content_hash: string }, attempts: number): Promise<string | null> {
  return moveCarried(engine, { sourceId: row.source_id, pageId: Number(row.page_id), fromHash: row.content_hash }, { attempts });
}

/** Moves every carried row whose lease or retry delay ended; drops records whose row or page moved on. */
export async function settleChronicleCarries(engine: BrainEngine): Promise<void> {
  // moveCarried drops a record whose row is gone (its page was deleted) or whose page changed again.
  const carries = await engine.executeRaw<{ source_id: string; page_id: number | string; from_hash: string }>(
    `SELECT m.completed_keys->0->>'sourceId' AS source_id, m.completed_keys->0->>'pageId' AS page_id, m.completed_keys->0->>'fromHash' AS from_hash
       FROM op_checkpoints m WHERE m.op=$1`, [CHRONICLE_CARRY_OP]);
  for (const c of carries) await moveCarried(engine, { sourceId: c.source_id, pageId: Number(c.page_id), fromHash: c.from_hash }, null);
}
