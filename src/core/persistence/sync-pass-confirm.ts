/**
 * #6712 PR 4b: the proof-carrying confirm round. A pass's next round at the same commit reuses the previous round's `I⋈P`
 * (every page of the source with an origin, joined with its import record) and re-reads only the pages the pass itself
 * wrote, when the database proves that nothing else changed since the previous round's mark (S1). A change it cannot
 * attribute to the pass, a count it cannot account for, or a statement error takes the full read. Q4 is narrowed for this
 * round only (GBRA-108, under Garry's 2026-10-17 standing approval).
 *
 * Every relation the level read or the classifier consumes, and why a reused `I⋈P` stays exact:
 * - `pages` (`I⋈P`): every row of the source whose `xmin` S1 does not prove committed must carry a revision a committed
 *   request of this pass produced (`revision_write_request_id` names the request, its intent names the pass and its outcome
 *   names the row's revision); the delta re-reads exactly those rows. `pages` carries no `last_write_request_id` (only
 *   facts, takes and timeline entries do), and the revision's writer survives a write that keeps the revision: such a write
 *   to a page the pass wrote is re-read with it, so the reused rows still equal a whole read. A deletion leaves no `xmin`,
 *   so the source's count of pages with an origin must equal the reused rows plus the new ones the delta read.
 * - `op_checkpoints`, every op the level reads for the incarnation (`CONFIRM_OPS`): import records (`I⋈P`), holds, the hold
 *   summary and retry rows, origin and legacy deletion markers, the withheld-deletes record and the pass row with its
 *   episode. A changed row is allowed only as the pass row, as the import record of a page the pass wrote at that page's
 *   revision or of a page whose record the pass's round wrote (`recorded`: the record writes of sync-pass-apply.ts, the
 *   page then re-read too), or as a hold the pass wrote (its `run_id`, with the summary row that moves with it); every other op's count
 *   must equal S1's plus the records the pass inserted (and the pass row, when S1 had none), and the holds must keep every
 *   S1 fingerprint (a release is not attributed) and add only the pass's. Holds, markers, the withheld record and the pass
 *   row are re-read by every round as well; the proof keeps a foreign change of them on the full read all the same.
 * - `persistence_requests` and `persistence_effects`: open work (`U_db`), the attestations (`A`) and the legacy deletions
 *   are re-read by every round.
 * - `sources` and `config`: the pass's context is fixed for the pass, and the level's settings are re-read by every round.
 * - Git: HEAD must equal the previous round's and the mode be committed (both are in the reuse key); `T` is cached by commit
 *   and the index (`X`) is re-read by every round. Working mode always takes the full read.
 *
 * Visibility: a row is unchanged when S1 saw its writer commit. Its `xmin` is older than S1's `xmin` (`age(xmin) >
 * age(S1.xmin)`, both counted back from S2's transaction counter in the 32-bit xid space; `age` of a frozen id is the
 * largest), or (GBRA-108) S1's snapshot, recorded with its mark, shows it ended: below S1's `xmax` and not in its
 * in-progress list. S1's list names top-level transactions only, and a row written inside a savepoint carries a
 * subtransaction id it does not list (publication's nested transactions, the fold's savepoint and the statistics refresh
 * write inside savepoints), which reads as ended though its transaction was in flight at S1. Such an id is larger than its
 * transaction's own, and its row is visible to S2 only when that transaction committed before S2: so an id at or above the
 * smallest listed transaction S2 sees committed counts as changed, and so does S1's own transaction's id. A transaction
 * that held no id at S1 takes one at or above S1's `xmax`. Each row is judged in the 32-bit xid space: S1's 64-bit
 * `cut`, list and own id become xids, `age(xmin) > age(cut)` (both counted back from S2's counter) is `xmin < cut`, and
 * xid equality is id equality, exact while every id is within 2^31 of S2 (unfrozen rows always are; a frozen `xmin` is
 * unchanged by its `age`; test/sync-pass-xid-arms-gbra108.test.ts checks the verdicts against the 64-bit ids). A round
 * without S1's snapshot (a stamp frozen before it was recorded) judges by `xmin` alone. `age` and
 * the `txid_*` snapshot functions exist on every supported Postgres and on PGLite, where one connection leaves S1's list
 * empty. More than 2^31 xids between S1's `xmin` and S2's `xmax` takes the full read (`age` would wrap).
 *
 * Across passes (GBRA-133 wave 4, `across`; GBRA-108 widened Q4 under the same standing approval): the next pass's first round
 * reuses the `I⋈P` of the last round of a pass that ended synced in the same process (sync-tree-reuse.ts), with S1 that round's
 * mark. Nothing is attributed: every `pages` row S1 does not prove unchanged, from any writer, and the page of every import
 * record S1 does not prove unchanged are re-read, and the count of pages with an origin and the count of import records
 * must equal what the patched table accounts for (a deletion leaves no `xmin`). Only `I⋈P` is reused: holds, markers, open
 * work, the pass row, `A` and the Git level are read as every round reads them, and the round keeps no classification or
 * domain from the last pass. The visibility arms, the xid span bound and the full read on any failed statement are the same.
 */
import { GIT_HOLD_OP, GIT_HOLD_RETRY_OP, GIT_HOLD_SUMMARY_OP, SYNC_IMPORT_PROVENANCE_OP } from './sync-holds.ts';
import { MANAGED_SYNC_PASS_OP, SYNC_DELETES_WITHHELD_OP, SYNC_ORIGIN_DELETED_OP } from './sync-pass-row.ts';
import type { BrainEngine } from '../engine.ts';
import { faultPoint } from './fault-points.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export const CONFIRM_OPS = [SYNC_IMPORT_PROVENANCE_OP, GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP, GIT_HOLD_RETRY_OP, SYNC_ORIGIN_DELETED_OP, SYNC_DELETES_WITHHELD_OP, MANAGED_SYNC_PASS_OP];

/**
 * A round's mark: its snapshot's `xmin` (64-bit), each `CONFIRM_OPS` op's row count for the incarnation and its holds'
 * fingerprints; `snapshot` (`txid_current_snapshot()`) and `own` (its transaction's id, if it had one) judge rows exactly.
 */
export interface LevelMark { xmin: string; ops: Record<string, number>; holds: string[]; snapshot?: string; own?: string | null }

/** The incarnation's `CONFIRM_OPS` rows (`o`: the table alias's prefix; `ops` and `scope`: their placeholders). */
const opScope = (o: string, ops: string, scope: string) => `${o}op = ANY(${ops}::text[]) AND (${o}fingerprint = ${scope} OR starts_with(${o}fingerprint, ${scope} || ':'))`;
const opCounts = (ops: string, scope: string) => `(SELECT COALESCE(jsonb_object_agg(op, n), '{}'::jsonb) FROM (SELECT op, count(*)::int AS n FROM op_checkpoints WHERE ${opScope('', ops, scope)} GROUP BY op) c) AS ops,
    (SELECT COALESCE(jsonb_agg(fingerprint), '[]'::jsonb) FROM op_checkpoints WHERE op='${GIT_HOLD_OP}' AND starts_with(fingerprint, ${scope} || ':')) AS holds`;

/** The round's mark, read inside its snapshot (on PGLite, before the round's other reads, so whatever lands later reads as changed). */
export async function readLevelMark(exec: Exec, sourceId: string, incarnation: string): Promise<LevelMark> {
  const [row] = await exec.executeRaw<{ xmin: string; snapshot: string; own: string | null; ops: Record<string, number> | null; holds: string[] }>(
    `SELECT txid_snapshot_xmin(txid_current_snapshot())::text AS xmin, txid_current_snapshot()::text AS snapshot, txid_current_if_assigned()::text AS own,
    ${opCounts('$1', '$2')}`, [CONFIRM_OPS, `${sourceId}:${incarnation}`]);
  return { xmin: row!.xmin, ops: row!.ops ?? {}, holds: row!.holds, snapshot: row!.snapshot, own: row!.own };
}

/** A 64-bit id's 32-bit xid (the same id within 2^31 of S2; a txid never has the special low words 0-2). */
const xid32 = (id: string) => `((${id}) % 4294967296)::text::xid`;
/** `age` of S1's 64-bit `xmin`: rows older than it are unchanged. */
export const loAge = (lo: string) => `age(${xid32(lo)})`;
/**
 * S1's arms in the 32-bit xid space, from its 64-bit `cut`, in-progress list and own id: `age` counts back from S2's
 * transaction counter, so `age(xmin) > cut_age` is `xmin < cut` and xid equality is 64-bit equality, both exact within 2^31.
 */
export const s1XidArms = (cut: string, xip: string, own: string) =>
  `age(${xid32(cut)}) AS cut_age, ARRAY(SELECT ${xid32('t')} FROM unnest(${xip}) t) AS xip, ${xid32(own)} AS own`;
/** Whether `col` (an xid) was committed before S1 (see the header). */
export const unchanged = (col: string) => `(age(${col}) > x.lo_age OR COALESCE(age(${col}) > s1.cut_age AND ${col} <> ALL(s1.xip) AND ${col} IS DISTINCT FROM s1.own, false))`;

/**
 * One scan of the source's pages and one of the incarnation's op rows: the counts, and the rows S1 does not prove unchanged.
 * `$6`: the request publishing in this transaction (a folded checkpoint, sync-pass-fold.ts), whose page is not committed yet.
 */
const PROOF = `WITH x AS MATERIALIZED (SELECT txid_snapshot_xmin(txid_current_snapshot()) AS now_lo, txid_snapshot_xmax(txid_current_snapshot()) AS hi,
    ${loAge('$4::bigint')} AS lo_age, txid_current_snapshot()::text AS now_snapshot, txid_current_if_assigned()::text AS now_own),
  s1 AS MATERIALIZED (SELECT ${s1XidArms('c.cut', 'c.xip', 'c.own')} FROM (SELECT ARRAY(SELECT txid_snapshot_xip($7::txid_snapshot)) AS xip, $8::bigint AS own,
    LEAST(txid_snapshot_xmax($7::txid_snapshot), (SELECT min(t) FROM txid_snapshot_xip($7::txid_snapshot) t WHERE txid_visible_in_snapshot(t, txid_current_snapshot()))) AS cut) c),
  pg AS (SELECT count(*) FILTER (WHERE p.source_path IS NOT NULL)::int AS n,
      COALESCE(jsonb_agg(jsonb_build_array(p.id::text, EXISTS (SELECT 1 FROM persistence_requests r WHERE r.id=p.revision_write_request_id AND r.source_id=$1
        AND (r.id=$6::uuid OR r.state='committed' AND r.intent->>'passId'=$5 AND r.outcome->>'revision'=p.knowledge_revision::text)), p.knowledge_revision::text))
        FILTER (WHERE NOT ${unchanged('p.xmin')}), '[]'::jsonb) AS changed
    FROM pages p, x, s1 WHERE p.source_id=$1),
  oc AS (SELECT o.op, count(*)::int AS n, jsonb_agg(jsonb_build_array(o.op, o.fingerprint, o.completed_keys->0->>'revision', o.completed_keys->0->>'run_id'))
        FILTER (WHERE NOT ${unchanged('o.xmin')}) AS changed
    FROM op_checkpoints o, x, s1 WHERE ${opScope('o.', '$2', '$3')} GROUP BY o.op)
  SELECT x.now_lo::text AS xmin, x.now_snapshot AS snapshot, x.now_own AS own, (x.hi - $4::bigint)::float8 AS span, pg.n AS pages, pg.changed AS pages_changed,
    (SELECT COALESCE(jsonb_object_agg(op, n), '{}'::jsonb) FROM oc) AS ops,
    (SELECT COALESCE(jsonb_agg(c), '[]'::jsonb) FROM oc, jsonb_array_elements(COALESCE(oc.changed, '[]'::jsonb)) c) AS ops_changed,
    (SELECT COALESCE(jsonb_agg(fingerprint), '[]'::jsonb) FROM op_checkpoints WHERE op='${GIT_HOLD_OP}' AND starts_with(fingerprint, $3 || ':')) AS holds
  FROM x, pg`;

type ProofRow = { xmin: string; snapshot: string; own: string | null; span: number; ops: Record<string, number> | null; holds: string[]; pages: number;
  pages_changed: Array<[string, boolean, string]>; ops_changed: Array<[string, string, string | null, string | null]> };

/**
 * Parallel workers for the proof's two scans (about 420 ms against 820 ms at 600k). A server that refuses a setting (a
 * restricted role, a managed host) raises inside the block, whose handler drops the settings and keeps the transaction.
 */
const parallelSettings = (cost: string) => `DO $$ BEGIN PERFORM set_config('parallel_setup_cost', '${cost}', true), set_config('parallel_tuple_cost', '0', true),
  set_config('min_parallel_table_scan_size', '0', true); EXCEPTION WHEN OTHERS THEN NULL; END $$`;

/**
 * The proof with parallel scans, for the proof alone: the settings are made inside a savepoint the proof then rolls back
 * to, so the statements after it (the round's other reads) run with the transaction's own settings; refused, the proof
 * runs without them. Its statements are issued together, so nothing the caller pipelines lands inside the savepoint. The
 * `sync:confirm_parallel` seam (a hook that throws) sends a value the server refuses.
 */
async function parallelProof(exec: Exec, sourceId: string, params: unknown[]): Promise<ProofRow[]> {
  const refused = await faultPoint('sync:confirm_parallel', { sourceId }).then(() => false, () => true);
  const steps = [exec.executeRaw('SAVEPOINT gbrain_confirm_proof'), exec.executeRaw(parallelSettings(refused ? 'refused' : '0')), exec.executeRaw<ProofRow>(PROOF, params),
    exec.executeRaw('ROLLBACK TO SAVEPOINT gbrain_confirm_proof'), exec.executeRaw('RELEASE SAVEPOINT gbrain_confirm_proof')];
  for (const step of steps) step.catch(() => undefined);
  const [, , proof] = await Promise.all(steps);
  return proof as ProofRow[];
}

/**
 * What the pass may reuse: the pages it wrote since S1 (`pages`, by id), which of them changed their import record
 * (`records`), the source's count of pages with an origin, and S2's mark for the next round; or why the full read.
 */
export type ConfirmProof = { ok: true; mark: LevelMark; pages: string[]; records: Set<string>; pageCount: number; summary: boolean; across?: true } | { ok: false; reason: string; mark: LevelMark | null };

/**
 * Proves, in S2 (the round's snapshot), that every change since `base` (S1) to what the level read consumes is the pass's
 * own write (see the header). The counts still need the reused rows: `countsMatch` checks them after the delta read.
 */
export async function proveConfirm(exec: Exec, input: { sourceId: string; incarnation: string; passId: string; base: LevelMark; recorded?: ReadonlySet<number>; postgres: boolean;
  parallel?: boolean; self?: string; across?: boolean }): Promise<ConfirmProof> {
  const scope = `${input.sourceId}:${input.incarnation}`;
  const params = [input.sourceId, CONFIRM_OPS, scope, input.base.xmin, input.passId, input.self ?? null, input.base.snapshot ?? null, input.base.own ?? null];
  // Two plain scans: compiling them (JIT, which the planner's cost picks at 600k) cost more than running them (about 200 ms).
  const jit = input.postgres ? exec.executeRaw('SET LOCAL jit = off') : Promise.resolve([]);
  jit.catch(() => undefined);
  const [row] = input.postgres && input.parallel ? await parallelProof(exec, input.sourceId, params) : await exec.executeRaw<ProofRow>(PROOF, params);
  await jit;
  const mark: LevelMark = { xmin: row!.xmin, ops: row!.ops ?? {}, holds: row!.holds, snapshot: row!.snapshot, own: row!.own };
  if (!(Number(row!.span) >= 0 && Number(row!.span) < 2 ** 31)) return { ok: false, reason: 'xid_span', mark };
  if (input.across) {
    // Across passes nothing is attributed: every changed page, and the page of every changed import record, is re-read.
    const records = new Set(row!.ops_changed.filter(([op, fingerprint]) => op === SYNC_IMPORT_PROVENANCE_OP && fingerprint.startsWith(`${scope}:`))
      .map(([, fingerprint]) => fingerprint.slice(scope.length + 1)));
    return { ok: true, mark, pages: [...new Set([...row!.pages_changed.map(([id]) => id), ...records])], records, pageCount: Number(row!.pages), summary: false, across: true };
  }
  const revisions = new Map<string, string>();
  for (const [id, ours, revision] of row!.pages_changed) {
    if (!ours) return { ok: false, reason: 'foreign_page_write', mark };
    revisions.set(id, revision);
  }
  const records = new Set<string>(), held = new Set<string>(), reread = new Set<string>();
  let summary = false;
  for (const [op, fingerprint, revision, runId] of row!.ops_changed) {
    if (op === MANAGED_SYNC_PASS_OP && fingerprint === scope) continue;
    // A hold the pass wrote names it (`run_id`); the summary row moves with it.
    if (op === GIT_HOLD_OP && runId === input.passId) { held.add(fingerprint); continue; }
    if (op === GIT_HOLD_SUMMARY_OP && fingerprint === scope) { summary = true; continue; }
    const pageId = op === SYNC_IMPORT_PROVENANCE_OP && fingerprint.startsWith(`${scope}:`) ? fingerprint.slice(scope.length + 1) : null;
    // A record the pass's round wrote outside its imports (a page it did not rewrite): its page is re-read with the others.
    if (pageId !== null && !revisions.has(pageId) && input.recorded?.has(Number(pageId))) { reread.add(pageId); records.add(pageId); continue; }
    if (pageId === null || revisions.get(pageId) !== revision) return { ok: false, reason: 'foreign_checkpoint_write', mark };
    records.add(pageId);
  }
  if (summary && !held.size) return { ok: false, reason: 'foreign_checkpoint_write', mark };
  // Holds: none of S1's is gone (a release is not attributed), and every new one is the pass's.
  const before = new Set(input.base.holds), now = new Set(mark.holds);
  if ([...before].some(print => !now.has(print)) || [...now].some(print => !before.has(print) && !held.has(print))) return { ok: false, reason: 'holds', mark };
  return { ok: true, mark, pages: [...revisions.keys(), ...reread], records, pageCount: Number(row!.pages), summary };
}

/**
 * The counts S2 must show: the reused rows plus the new pages the delta read (`pages`), and S1's op counts plus the import
 * records the pass inserted (`newRecords`), its pass row if S1 had none and the hold summary its holds created. Anything else
 * (a deletion) is a mismatch. Across passes only the pages and the import records count: nothing else is reused.
 */
export function countsMatch(base: LevelMark, proof: Extract<ConfirmProof, { ok: true }>, added: { pages: number; newRecords: number }): boolean {
  if (proof.pageCount !== added.pages) return false;
  for (const op of CONFIRM_OPS) {
    const before = base.ops[op] ?? 0, after = proof.mark.ops[op] ?? 0;
    if (op === GIT_HOLD_OP || proof.across && op !== SYNC_IMPORT_PROVENANCE_OP) continue;
    // The pass row, and the hold summary a hold of the pass created, may be new.
    const created = before === 0 && after === 1 && (op === MANAGED_SYNC_PASS_OP || op === GIT_HOLD_SUMMARY_OP && proof.summary);
    if (op === SYNC_IMPORT_PROVENANCE_OP ? after !== before + added.newRecords : after !== before && !created) return false;
  }
  return true;
}
