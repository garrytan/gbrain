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

import { CONNECTOR_DB_CURSOR_OP, readConnectorDbCursorRow, writeConnectorDbCursor as writeCursorRow } from '../engine-sql/connector-db-cursor.ts';

export { CONNECTOR_DB_CURSOR_OP };

export interface ConnectorRunReceipt { run_id: string; finished_at: string; counts: Record<string, number> }
interface CursorRow { version: 1; state: Record<string, unknown>; last_run: ConnectorRunReceipt | null }

/** An engine (the typed members) or a bare executor (the same statements through `executeRaw`). */
type Exec = Pick<BrainEngine, 'executeRaw'> & Partial<Pick<BrainEngine, 'readOpCheckpointRecord' | 'writeConnectorDbCursor'>>;

export function connectorDbCursorKey(sourceId: string, incarnation: string, identity: Pick<ConnectorIdentity, 'kind' | 'digest'>): string {
  return connectorCheckpointKey(sourceId, incarnation, identity);
}

/** The row an unmanaged source's account pin lives in: one per source incarnation, so a content-config change keeps the pin. */
export function connectorAccountPinKey(sourceId: string, incarnation: string, kind: ConnectorIdentity['kind']): string {
  return connectorCheckpointKey(sourceId, incarnation, { kind, digest: 'account-pin' });
}

export async function readConnectorDbCursor(engine: Exec, key: string): Promise<{ state: Record<string, unknown> | null; lastRun: ConnectorRunReceipt | null }> {
  const keys = engine.readOpCheckpointRecord ? (await engine.readOpCheckpointRecord(CONNECTOR_DB_CURSOR_OP, key))?.completed_keys
    : await readConnectorDbCursorRow(engine, key);
  const value = (keys as CursorRow[] | null | undefined)?.[0];
  return { state: value?.state ?? null, lastRun: value?.last_run ?? null };
}

export async function writeConnectorDbCursor(engine: Exec, key: string, state: Record<string, unknown>, lastRun?: ConnectorRunReceipt): Promise<void> {
  const record = [{ version: 1, state, last_run: lastRun ?? null }];
  if (engine.writeConnectorDbCursor) await engine.writeConnectorDbCursor(key, record);
  else await writeCursorRow(engine, key, record);
}
