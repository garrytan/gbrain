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
import { PERSISTENCE_SYNC_RUN_INDEXES } from './schema.ts';
import { docsAnchor } from './connector-errors.ts';
import type { SyncProcessingOptions } from './sync-authority.ts';
import type { SyncCursorOptions } from './sync-prepare.ts';

export const CHECKPOINT_VALIDATION_TIMEOUT = 'checkpoint_validation_timeout';
export const CHECKPOINT_VALIDATION_TIMEOUT_MESSAGE = 'The sync checkpoint validation timed out on a large request table; the checkpoint did not commit.';
export const REQUEST_INDEXES_REPAIR_COMMAND = 'gbrain repair request-indexes --apply';

const SYNC_PAGE_KINDS = "r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete')";
export const INCOMPLETE_SYNC_RECEIPT_SQL = `(SELECT r.request_id::text AS request_id FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL LIMIT 1)
  UNION ALL (SELECT r.request_id::text FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.intent->>'runId'=$2 AND r.state<>'committed' AND ${SYNC_PAGE_KINDS}
      AND r.state IN ('queued','running','recovering') LIMIT 1)
  UNION ALL (SELECT r.request_id::text FROM persistence_requests r
    WHERE r.worktree_id=$1::uuid AND r.intent->>'runId'=$2 AND r.state<>'committed' AND ${SYNC_PAGE_KINDS}
      AND NOT EXISTS (SELECT 1 FROM persistence_requests committed WHERE committed.source_id=r.source_id
        AND committed.intent->>'runId'=$2 AND committed.intent->>'index'=r.intent->>'index'
        AND committed.state='committed' AND committed.intent ? 'runId') LIMIT 1)
  LIMIT 1`;

/** The request id of a receipt that blocks the run's checkpoint, or null. */
export async function findIncompleteSyncReceipt(tx: Pick<BrainEngine, 'executeRaw'>, worktreeId: string, runId: string): Promise<string | null> {
  try {
    const [row] = await tx.executeRaw<{ request_id: string }>(INCOMPLETE_SYNC_RECEIPT_SQL, [worktreeId, runId]);
    return row?.request_id ?? null;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    if (failure?.code !== '57014' || !/statement timeout/.test(String(failure.message))) throw error;
    throw opError(CHECKPOINT_VALIDATION_TIMEOUT, CHECKPOINT_VALIDATION_TIMEOUT_MESSAGE,
      `Page writes that sync run ${runId} already committed stay committed; only its checkpoint did not. This usually means the request table lacks its lookup indexes: preview that repair and apply it after the user approves, then sync again.`,
      { fix: { argv: ['gbrain', 'repair', 'request-indexes', '--json'], consent: [], actor: 'agent', why: 'Previews the missing request-table indexes without changing anything.', requires_exclusive: false } });
  }
}

export interface RequestIndexState {
  name: string;
  state: 'valid' | 'missing' | 'invalid' | 'building';
  progress?: { phase: string; blocks_done: number; blocks_total: number };
}

/** A fresh read of the #5762 indexes: valid, missing, INVALID, or still being built by another session. */
export async function readRequestIndexStates(engine: Pick<BrainEngine, 'executeRaw' | 'kind'>): Promise<RequestIndexState[]> {
  const names = PERSISTENCE_SYNC_RUN_INDEXES.map(index => index.name);
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
  return formatCheckpointTimeoutHint(await readRequestIndexStates(engine), input);
}
