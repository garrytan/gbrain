/**
 * Cursor state of an unmanaged connector source that keeps no state file
 * (the meetings kind, whose `database` record mode has no directory and whose
 * `git` mode keeps the checkout free of gbrain bookkeeping). One
 * `op_checkpoints` row (`op='connector-db-cursor'`) per source incarnation and
 * connector identity, so a content-config change starts fresh exactly like the
 * managed checkpoint key. The row also records the last finished run (id,
 * time, counts): on a brain with no Git repo and no persistence journal it is
 * the run's durable receipt. Checkpoint GC never purges it.
 */
import type { BrainEngine } from '../engine.ts';
import { connectorCheckpointKey, type ConnectorIdentity } from '../persistence/connector-identity.ts';

export const CONNECTOR_DB_CURSOR_OP = 'connector-db-cursor';

export interface ConnectorRunReceipt { run_id: string; finished_at: string; counts: Record<string, number> }
interface CursorRow { version: 1; state: Record<string, unknown>; last_run: ConnectorRunReceipt | null }

type Exec = Pick<BrainEngine, 'executeRaw'>;

export function connectorDbCursorKey(sourceId: string, incarnation: string, identity: Pick<ConnectorIdentity, 'kind' | 'digest'>): string {
  return connectorCheckpointKey(sourceId, incarnation, identity);
}

/** The row an unmanaged source's account pin lives in: one per source incarnation, so a content-config change keeps the pin. */
export function connectorAccountPinKey(sourceId: string, incarnation: string, kind: ConnectorIdentity['kind']): string {
  return connectorCheckpointKey(sourceId, incarnation, { kind, digest: 'account-pin' });
}

export async function readConnectorDbCursor(engine: Exec | Pick<BrainEngine, 'readOpCheckpointCompletedKeys'>, key: string): Promise<{ state: Record<string, unknown> | null; lastRun: ConnectorRunReceipt | null }> {
  // A handle without the typed member (a persistence view, a test double) runs the member's own statement.
  const keys = 'readOpCheckpointCompletedKeys' in engine && typeof engine.readOpCheckpointCompletedKeys === 'function'
    ? await engine.readOpCheckpointCompletedKeys(CONNECTOR_DB_CURSOR_OP, key)
    : ((await (engine as Exec).executeRaw<{ completed_keys: CursorRow[] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [CONNECTOR_DB_CURSOR_OP, key]))[0]?.completed_keys ?? null);
  const value = (keys as CursorRow[] | null)?.[0];
  return { state: value?.state ?? null, lastRun: value?.last_run ?? null };
}

export async function writeConnectorDbCursor(engine: Exec, key: string, state: Record<string, unknown>, lastRun?: ConnectorRunReceipt): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(jsonb_build_object('version',1,'state',EXCLUDED.completed_keys->0->'state',
      'last_run',COALESCE(EXCLUDED.completed_keys->0->'last_run',op_checkpoints.completed_keys->0->'last_run'))),updated_at=now()`,
  [CONNECTOR_DB_CURSOR_OP, key, JSON.stringify([{ version: 1, state, last_run: lastRun ?? null }])]);
}
