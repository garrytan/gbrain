/**
 * Reads and retry requests for connector item holds (fix wave 4 lane B).
 *
 * Holds live in each connector's cursor state (`item_holds`): the managed
 * connector checkpoint (`op_checkpoints` op `managed-connector`) on a managed
 * brain, the `.google-source.json` / `.github-source.json` state file
 * otherwise. `gbrain sources status`, the doctor check `connector_held_items`
 * and `gbrain waiting` read them here.
 *
 * `gbrain sources retry-held <id>` records a retry request row (op
 * `connector-hold-retry`, one per source incarnation) naming the held keys;
 * the connector re-attempts those items on its next run and removes each key
 * it attempted. On a managed brain it also writes, for each held item that
 * kept a failed receipt, the durable retry-pointer row that `--retry-failed`
 * writes (op `managed-connector-retry`), so the re-attempt is admitted under a
 * new request identity.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { connectorCheckpointKey, connectorIdentity, isConnectorSourceKind, type ConnectorKind } from '../persistence/connector-identity.ts';
import { connectorStateKey } from '../persistence/connector-state.ts';
import { heldItems, type ItemHoldRecord } from './item-holds.ts';

export const HOLD_RETRY_OP = 'connector-hold-retry';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export interface ConnectorSourceRow { id: string; incarnation: string; local_path: string | null; config: Record<string, unknown> }

export async function managedBrain(engine: Exec): Promise<boolean> {
  // A failed mode query propagates: guessing "unmanaged" would read a stale state file and report no holds.
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  return brain?.enabled === true;
}

/** The connector's cursor state, wherever this brain keeps it. */
export async function readConnectorCursorState(engine: Exec, source: ConnectorSourceRow, managed?: boolean): Promise<Record<string, unknown> | null> {
  const kind = source.config.kind;
  if (!isConnectorSourceKind(kind)) return null;
  const identity = connectorIdentity(kind, source.config, source.local_path);
  if (managed ?? await managedBrain(engine)) {
    const [row] = await engine.executeRaw<{ completed_keys: Array<{ state?: Record<string, unknown> | null }> }>(
      "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1",
      [connectorCheckpointKey(source.id, source.incarnation, identity)]);
    return row?.completed_keys?.[0]?.state ?? null;
  }
  const dir = (identity.config as { dir?: string }).dir;
  if (!dir) return null;
  const file = join(dir, kind === 'google' ? '.google-source.json' : '.github-source.json');
  if (!existsSync(file)) return null;
  // A corrupt state file is unknown hold state, not "no holds": the caller reports it.
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

export interface SourceHolds { sourceId: string; kind: ConnectorKind; held: ItemHoldRecord[] }

/** Held items per connector source (sources with none are omitted). */
export async function readAllSourceHolds(engine: Exec, opts: { sourceIds?: string[] } = {}): Promise<SourceHolds[]> {
  const sources = await engine.executeRaw<ConnectorSourceRow>(
    "SELECT id,incarnation::text AS incarnation,local_path,config FROM sources WHERE archived IS NOT TRUE AND config->>'kind' IN ('google','github') ORDER BY id");
  const managed = await managedBrain(engine);
  const out: SourceHolds[] = [];
  for (const source of sources) {
    if (opts.sourceIds && !opts.sourceIds.includes(source.id)) continue;
    // A read failure propagates: callers must report unknown coverage, never an empty hold list.
    const state = await readConnectorCursorState(engine, source, managed);
    const held = heldItems(state?.item_holds);
    if (held.length) out.push({ sourceId: source.id, kind: source.config.kind as ConnectorKind, held });
  }
  return out;
}

export async function readHoldRetryKeys(engine: Exec, sourceId: string, incarnation: string): Promise<string[]> {
  const [row] = await engine.executeRaw<{ completed_keys: Array<{ keys?: unknown }> }>(
    'SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [HOLD_RETRY_OP, connectorStateKey(sourceId, incarnation)]);
  const keys = row?.completed_keys?.[0]?.keys;
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
}

/** Adds keys to the source's retry request (idempotent; a repeated request schedules nothing new). */
export async function requestHoldRetry(engine: Exec, sourceId: string, incarnation: string, keys: string[]): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'keys',$4::text::jsonb,'requested_at',now())))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,
      'keys',(SELECT COALESCE(jsonb_agg(DISTINCT k),'[]'::jsonb) FROM (
        SELECT jsonb_array_elements_text(COALESCE(op_checkpoints.completed_keys->0->'keys','[]'::jsonb)) AS k
        UNION SELECT jsonb_array_elements_text($4::text::jsonb)) keys),
      'requested_at',now())),updated_at=now()`,
  [HOLD_RETRY_OP, connectorStateKey(sourceId, incarnation), sourceId, JSON.stringify(keys)]);
}

/** Removes the keys a run attempted; keys requested meanwhile stay. */
export async function clearHoldRetryKeys(engine: Exec, sourceId: string, incarnation: string, attempted: string[]): Promise<void> {
  if (!attempted.length) return;
  const fingerprint = connectorStateKey(sourceId, incarnation);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,keys}',
      (SELECT COALESCE(jsonb_agg(k),'[]'::jsonb) FROM jsonb_array_elements_text(completed_keys->0->'keys') k WHERE NOT (k = ANY($3::text[])))),
      updated_at=now() WHERE op=$1 AND fingerprint=$2`, [HOLD_RETRY_OP, fingerprint, attempted]);
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND jsonb_array_length(completed_keys->0->'keys')=0`,
    [HOLD_RETRY_OP, fingerprint]);
}

interface HeldReceipt { request_id: string; source_id: string; principal_id: string; principal_kind: string; intent: Record<string, unknown> | null }

function stableId(value: unknown): string {
  const hash = digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * The retry-pointer row `--retry-failed` writes, for a held item's failed
 * receipt, marked `pending` because nothing has been admitted under it yet.
 * The next run's admission of that item uses the pointer's new request id.
 * Returns false when the receipt is gone, not failed, or has recovery.
 */
export async function writeHeldRetryPointer(engine: Exec, sourceId: string, requestId: string): Promise<boolean> {
  const [row] = await engine.executeRaw<HeldReceipt>(`SELECT request_id::text AS request_id,source_id,principal_id,principal_kind,intent
      FROM persistence_requests WHERE request_id=$1::uuid AND source_id=$2 AND state IN ('failed','conflict') AND recovery IS NULL`, [requestId, sourceId]);
  if (!row?.intent || typeof row.intent.checkpointKey !== 'string') return false;
  const baseRequestId = typeof row.intent.retryBase === 'string' ? row.intent.retryBase : row.request_id;
  const [existing] = await engine.executeRaw<{ completed_keys: Array<{ attempt?: number; requestId?: string; pending?: boolean }> }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector-retry' AND fingerprint=$1", [baseRequestId]);
  const current = existing?.completed_keys?.[0];
  if (current?.pending) return true;
  const attempt = Number(current?.attempt ?? row.intent.retryAttempt ?? 0) + 1;
  const pointer = { checkpointKey: row.intent.checkpointKey, principalId: row.principal_id, principalKind: row.principal_kind, baseRequestId,
    retryOf: row.request_id, attempt, requestId: stableId({ baseRequestId, retryOf: row.request_id, attempt }), pending: true };
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector-retry',$1,$2::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [baseRequestId, JSON.stringify([pointer])]);
  return true;
}
