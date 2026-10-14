/**
 * #5762: the managed sync checkpoint's incomplete-receipt validation and the
 * `checkpoint_validation_timeout` refusal.
 *
 * The validation is three index probes whose union is exactly the former
 * single predicate (a receipt with recovery; an open page receipt of the run;
 * a non-committed page receipt of the run with no committed sibling at the
 * same index). Each probe is served by an index: `persistence_requests_recovery`,
 * `persistence_requests_sync_run_open` and, for the sibling lookup,
 * `persistence_requests_sync_run_committed`. A statement timeout of this one
 * statement is a deterministic failure on a large request table, not
 * contention, so it becomes the terminal typed code instead of being released
 * as `database_contention` and retried ahead of every other write.
 *
 * The coordinator persists only the code and message, so the hint is rebuilt
 * by one formatter from a fresh read of the index state plus the request's
 * recorded source and processing options, for the sync summary and for
 * `gbrain write-request` / MCP `get_write_request`.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { PERSISTENCE_REQUEST_ONLINE_INDEXES, PERSISTENCE_SYNC_RUN_INDEXES } from './schema.ts';
import { docsAnchor } from './connector-errors.ts';
import type { SyncProcessingOptions } from './sync-authority.ts';
import type { SyncCursorOptions } from './sync-prepare.ts';
import { syncKnockOnSql } from './sync-knock-on.ts';

export const CHECKPOINT_VALIDATION_TIMEOUT = 'checkpoint_validation_timeout';
export const CHECKPOINT_VALIDATION_TIMEOUT_MESSAGE = 'The sync checkpoint validation timed out on a large request table; the checkpoint did not commit.';
export const REQUEST_INDEXES_REPAIR_COMMAND = 'gbrain repair request-indexes --apply';

const SYNC_PAGE_KINDS = "r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete')";
/**
 * #6643: clause 3 skips a terminal, recovery-free receipt the cursor settled another way: one the run converted in place
 * ($3, #5988), one at an index the cursor passed without a commit (waived or held: the settled ranges $4..$5), and, only
 * below $6 (the index from which the cursor recorded its settled ranges, i.e. a cursor that began before #6643), a
 * knock-on (sync-knock-on.ts), which never published and whose entry the cursor re-froze when it reached it.
 */
export const INCOMPLETE_SYNC_RECEIPT_SQL = `(SELECT r.request_id::text AS request_id FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL LIMIT 1)
  UNION ALL (SELECT r.request_id::text FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.intent->>'runId'=$2 AND r.state<>'committed' AND ${SYNC_PAGE_KINDS}
      AND r.state IN ('queued','running','recovering') LIMIT 1)
  UNION ALL (SELECT r.request_id::text FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.intent->>'runId'=$2 AND r.state<>'committed' AND ${SYNC_PAGE_KINDS}
      AND NOT EXISTS (SELECT 1 FROM persistence_requests committed WHERE committed.source_id=r.source_id
        AND committed.intent->>'runId'=$2 AND committed.intent->>'index'=r.intent->>'index'
        AND committed.state='committed' AND committed.intent ? 'runId')
      AND NOT (r.request_id::text=ANY($3::text[]))
      AND NOT (r.state IN ('failed','cancelled','conflict') AND r.recovery IS NULL
        AND EXISTS (SELECT 1 FROM unnest($4::int[], $5::int[]) AS settled(lo, hi) WHERE (r.intent->>'index')::int BETWEEN settled.lo AND settled.hi))
      AND NOT ((r.intent->>'index')::int < $6::int AND ${syncKnockOnSql('r')}) LIMIT 1)
  LIMIT 1`;

/** #6643: the index ranges a cursor passed without a commit, and the index it began recording them at. */
export interface SyncSettledIndexes { from: number; ranges: Array<[number, number]> }

/**
 * The request id of a receipt that blocks the run's checkpoint, or null.
 * `superseded` names failed content-refusal requests the run converted in
 * place (#5988): their entry was held, so they no longer block the checkpoint.
 * `settled` (#6643) is the cursor's record of the indexes it passed without a
 * commit; null for a checkpoint frozen before #6643, whose whole run predates it.
 */
export async function findIncompleteSyncReceipt(tx: Pick<BrainEngine, 'executeRaw'>, worktreeId: string, runId: string, superseded: string[] = [],
  settled: SyncSettledIndexes | null = null, total = 0): Promise<string | null> {
  try {
    const ranges = settled?.ranges ?? [];
    const [row] = await tx.executeRaw<{ request_id: string }>(INCOMPLETE_SYNC_RECEIPT_SQL,
      [worktreeId, runId, superseded, ranges.map(range => range[0]), ranges.map(range => range[1]), settled ? settled.from : total]);
    return row?.request_id ?? null;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    if (failure?.code !== '57014' || !/statement timeout/.test(String(failure.message))) throw error;
    throw opError(CHECKPOINT_VALIDATION_TIMEOUT, CHECKPOINT_VALIDATION_TIMEOUT_MESSAGE,
      `Page writes that sync run ${runId} already committed stay committed; only its checkpoint did not. This usually means the request table lacks its lookup indexes: preview that repair and apply it after the user approves, then sync again.`,
      { fix: { argv: ['gbrain', 'repair', 'request-indexes', '--json'], consent: [], actor: 'agent', why: 'Previews the missing request-table indexes without changing anything.', requires_exclusive: false } });
  }
}

/**
 * #6643: every receipt (up to 20) that would block the run's checkpoint now, with what `sync status` needs to tell a
 * knock-on from a root; read-only. The checkpoint itself names only the first (`findIncompleteSyncReceipt`).
 */
export async function listIncompleteSyncReceipts(engine: Pick<BrainEngine, 'executeRaw'>, worktreeId: string, runId: string, superseded: string[] = [],
  settled: SyncSettledIndexes | null = null, total = 0): Promise<Array<{ request_id: string; slug: string; state: string; code: string | null; index: number | null; recovery: boolean }>> {
  const ranges = settled?.ranges ?? [];
  return engine.executeRaw(`SELECT r.request_id::text AS request_id, r.slug, r.state, r.error_code AS code, (r.intent->>'index')::int AS index, r.recovery IS NOT NULL AS recovery
      FROM persistence_requests r WHERE r.request_id::text IN (SELECT request_id FROM (${INCOMPLETE_SYNC_RECEIPT_SQL.replaceAll('LIMIT 1', 'LIMIT 20')}) blockers) ORDER BY r.sequence LIMIT 20`,
    [worktreeId, runId, superseded, ranges.map(range => range[0]), ranges.map(range => range[1]), settled ? settled.from : total]);
}

/** #6643: `settled` with `[from, to]` added, merged into the last range when contiguous. */
export function addSettledRange(settled: SyncSettledIndexes, from: number, to: number): SyncSettledIndexes {
  if (to < from) return settled;
  const last = settled.ranges.at(-1);
  if (last && from <= last[1] + 1) return { ...settled, ranges: [...settled.ranges.slice(0, -1), [last[0], Math.max(last[1], to)]] };
  return { ...settled, ranges: [...settled.ranges, [from, to]] };
}

export interface RequestIndexState {
  name: string;
  state: 'valid' | 'missing' | 'invalid' | 'building';
  progress?: { phase: string; blocks_done: number; blocks_total: number };
}

/**
 * A fresh read of the online-built request indexes (#5762's checkpoint pair and #6511's slug index by default): valid,
 * missing, INVALID, or still being built by another session. The checkpoint timeout hint reads the pair it depends on.
 */
export async function readRequestIndexStates(engine: Pick<BrainEngine, 'executeRaw' | 'kind'>,
  indexes: ReadonlyArray<{ name: string }> = PERSISTENCE_REQUEST_ONLINE_INDEXES): Promise<RequestIndexState[]> {
  const names = indexes.map(index => index.name);
  if (engine.kind !== 'postgres') {
    const rows = await engine.executeRaw<{ name: string; present: boolean }>(
      'SELECT n.name, to_regclass(n.name) IS NOT NULL AS present FROM unnest($1::text[]) AS n(name)', [names]);
    return rows.map(row => ({ name: row.name, state: row.present ? 'valid' : 'missing' }));
  }
  const rows = await engine.executeRaw<{ name: string; valid: boolean | null; phase: string | null; blocks_done: string | null; blocks_total: string | null }>(
    `SELECT n.name, i.indisvalid AS valid, p.phase, p.blocks_done::text, p.blocks_total::text
       FROM unnest($1::text[]) AS n(name)
       LEFT JOIN pg_index i ON i.indexrelid = to_regclass(n.name)
       LEFT JOIN LATERAL (SELECT phase, blocks_done, blocks_total FROM pg_stat_progress_create_index p
         WHERE p.relid = i.indrelid AND p.index_relid IN (i.indexrelid, 0) LIMIT 1) p ON true`, [names]);
  return rows.map(row => row.valid === null ? { name: row.name, state: 'missing' }
    : row.valid ? { name: row.name, state: 'valid' }
      : row.phase !== null ? { name: row.name, state: 'building', progress: { phase: row.phase, blocks_done: Number(row.blocks_done ?? 0), blocks_total: Number(row.blocks_total ?? 0) } }
        : { name: row.name, state: 'invalid' });
}

const shellWord = (value: string) => /^[\w./@:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** The exact retry for the failed checkpoint: same source and cursor-selecting options, plus the recorded processing flags. */
export function checkpointRetryCommand(input: { sourceId: string; processingOptions?: Partial<SyncProcessingOptions> | null; syncOptions?: SyncCursorOptions | null; repoPath?: string | null }): string {
  const base = `gbrain sync --source ${shellWord(input.sourceId)} --no-pull --retry-failed`;
  // A compacted receipt (intent cleared) or a checkpoint admitted before the options were recorded
  // cannot name its cursor; never print assumed defaults for it.
  if (!input.syncOptions) return `${base} with the same options as the failed run (this receipt no longer records them)`;
  const options = input.processingOptions ?? {};
  const cursor = input.syncOptions;
  return [base, input.repoPath ? `--repo ${shellWord(input.repoPath)}` : '', options.noEmbed ? '--no-embed' : '', options.noExtract ? '--no-extract' : '',
    options.noSchemaPack ? '--no-schema-pack' : '', cursor?.full ? '--full' : '', cursor?.workingTree ? '--working-tree' : '',
    cursor?.srcSubpath ? `--src-subpath ${shellWord(cursor.srcSubpath)}` : '', ...(cursor?.exclude ?? []).map(pattern => `--exclude ${shellWord(pattern)}`),
    ...(cursor?.includeHidden ?? []).map(pattern => `--include-hidden ${shellWord(pattern)}`), cursor?.strategy ? `--strategy ${shellWord(cursor.strategy)}` : '']
    .filter(Boolean).join(' ');
}

export interface CheckpointTimeoutHint { reason: string; message: string; suggestion: string; detail: 'index_building' | 'index_missing' | 'indexes_valid'; docs: string }

/** The one formatter for the refusal: a three-state hint from the index state, plus the filled retry command. */
export function formatCheckpointTimeoutHint(indexes: RequestIndexState[], input: { requestId: string | null; sourceId: string;
  processingOptions?: Partial<SyncProcessingOptions> | null; syncOptions?: SyncCursorOptions | null; repoPath?: string | null }): CheckpointTimeoutHint {
  const retry = checkpointRetryCommand(input);
  const base = { reason: CHECKPOINT_VALIDATION_TIMEOUT, message: CHECKPOINT_VALIDATION_TIMEOUT_MESSAGE, docs: docsAnchor(CHECKPOINT_VALIDATION_TIMEOUT) };
  const building = indexes.filter(index => index.state === 'building');
  if (building.length) return { ...base, detail: 'index_building',
    suggestion: `This release's request-index build is still running (${building.map(index => `${index.name}: ${index.progress?.phase ?? 'building'}`
      + `${index.progress?.blocks_total ? `, ${index.progress.blocks_done}/${index.progress.blocks_total} blocks` : ''}`).join('; ')}). `
      + `Wait for it to finish (gbrain doctor shows persistence_request_indexes), then run: ${retry}` };
  const broken = indexes.filter(index => index.state === 'missing' || index.state === 'invalid');
  if (broken.length) return { ...base, detail: 'index_missing',
    suggestion: `The request index ${broken.map(index => `${index.name} is ${index.state === 'invalid' ? 'INVALID' : 'missing'}`).join(' and ')}. `
      + `Rebuild it: ${REQUEST_INDEXES_REPAIR_COMMAND} — then run: ${retry}` };
  return { ...base, detail: 'indexes_valid',
    suggestion: `The request indexes are valid, so there is nothing to wait for. Run: ${retry}. If it times out again, report request `
      + `${input.requestId ?? '<request-id>'} and attach the persistence_request_indexes and persistence_request_growth entries of gbrain doctor --json.` };
}

export async function checkpointTimeoutHint(engine: Pick<BrainEngine, 'executeRaw' | 'kind'>, input: Parameters<typeof formatCheckpointTimeoutHint>[1]): Promise<CheckpointTimeoutHint> {
  return formatCheckpointTimeoutHint(await readRequestIndexStates(engine, PERSISTENCE_SYNC_RUN_INDEXES), input);
}
