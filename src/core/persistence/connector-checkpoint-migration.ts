/**
 * #5686 upgrade: re-key connector checkpoints through retained receipts, and
 * clean up checkpoint rows no source can load.
 *
 * Old checkpoint keys hashed the raw `sources.config`, which the cycle stamp
 * rewrote after every run, so they cannot be recomputed. The newest committed
 * checkpoint receipt per source incarnation still names the key it saved, so
 * its row is copied to the stable key (`INSERT … ON CONFLICT DO NOTHING`,
 * never overwriting a newer row). A source whose newest receipt was compacted
 * or is missing re-walks its window once; it never falls back to an older
 * receipt. Every statement runs on its own (transaction-mode PgBouncer), ages
 * use the database clock, and a rerun changes nothing.
 *
 * Orphans: `managed-connector` rows no source can load, and retry pointers
 * whose checkpoint no source loads, are excluded from the 7-day checkpoint
 * purge, so every cycle since the stamp was added left one behind. Cleanup
 * keeps rows touched after it started and rows referenced by a non-terminal
 * request or a recorded pending set. `gbrain repair connector-checkpoints` and
 * the doctor count reuse the same predicate with a 7-day age floor, because an
 * older binary may still be using an old key during a mixed-version window.
 */
import type { BrainEngine } from '../engine.ts';
import { connectorCheckpointKey, connectorIdentity, type ConnectorKind } from './connector-identity.ts';
import { CONNECTOR_STATE_OP, connectorStateKey, emptyConnectorState, type ConnectorState } from './connector-state.ts';

type Sql = Pick<BrainEngine, 'executeRaw' | 'transaction' | 'kind'>;
/** The database time migration 176 first ran; classifies retired-format connector intents. */
export const CONNECTOR_MIGRATION_OP = 'managed-connector-migration';
export async function readConnectorV2Cutoff(engine: Pick<BrainEngine, 'executeRaw'>): Promise<string | null> {
  const [row] = await engine.executeRaw<{ cutoff: string | null }>("SELECT completed_keys->0->>'cutoff' AS cutoff FROM op_checkpoints WHERE op=$1 AND fingerprint='v2-cutoff'", [CONNECTOR_MIGRATION_OP]);
  return row?.cutoff ?? null;
}

interface SourceRow { id: string; incarnation: string; local_path: string | null; config: Record<string, unknown> | string | null; archived: boolean }

/** Stable checkpoint keys of every registered connector source (archived ones included: a restore must still find its cursor). */
export async function loadableConnectorKeys(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Map<string, { id: string; incarnation: string; archived: boolean }>> {
  const rows = await engine.executeRaw<SourceRow>("SELECT id,incarnation::text,local_path,config,archived FROM sources WHERE config->>'kind' IN ('google','github')");
  const keys = new Map<string, { id: string; incarnation: string; archived: boolean }>();
  for (const row of rows) {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) as Record<string, unknown> : row.config ?? {};
    keys.set(connectorCheckpointKey(row.id, row.incarnation, connectorIdentity(config.kind as ConnectorKind, config, row.local_path)),
      { id: row.id, incarnation: row.incarnation, archived: row.archived === true });
  }
  return keys;
}

export interface OrphanCheckpointRow { op: 'managed-connector' | 'managed-connector-retry'; fingerprint: string; updated_at: string }

/** The orphan test for op_checkpoints row `c`; binds loadable keys, before, min age days and the state op from parameter `$first` on. */
const orphanPredicate = (first: number) => {
  const [k, b, d, o] = [first, first + 1, first + 2, first + 3].map(n => `$${n}`);
  return `(
      ((c.op='managed-connector' AND NOT (c.fingerprint = ANY(${k}::text[])))
        OR (c.op='managed-connector-retry' AND NOT (COALESCE(c.completed_keys->0->>'checkpointKey','') = ANY(${k}::text[]))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests r
        WHERE (r.state IN ('queued','running','recovering') OR r.recovery IS NOT NULL)
          AND (r.intent->>'kind' LIKE 'connector\\_v2\\_%' OR r.intent->>'kind' LIKE 'managed\\_connector\\_%')
          AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey'
            OR r.request_id::text = c.completed_keys->0->>'requestId'))
      AND NOT EXISTS (SELECT 1 FROM op_checkpoints s
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.completed_keys->0->'pending','[]'::jsonb)) p
        JOIN persistence_requests r ON r.request_id::text = p->>'requestId'
        WHERE s.op=${o} AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey'
          OR r.request_id::text = c.completed_keys->0->>'requestId'))
      AND (${b}::text IS NULL OR c.updated_at <= ${b}::text::timestamptz)
      AND (${d}::integer IS NULL OR c.updated_at < now() - make_interval(days => ${d}::integer)))`;
};

/**
 * Checkpoint and retry rows no source can load. `before` bounds `updated_at`
 * (the migration start); `minAgeDays` adds the doctor/repair age floor.
 */
export async function orphanConnectorCheckpoints(engine: Pick<BrainEngine, 'executeRaw'>, opts: { before?: string; minAgeDays?: number; limit?: number } = {}): Promise<OrphanCheckpointRow[]> {
  const loadable = [...(await loadableConnectorKeys(engine)).keys()];
  return engine.executeRaw<OrphanCheckpointRow>(`SELECT c.op, c.fingerprint, c.updated_at::text AS updated_at FROM op_checkpoints c
    WHERE c.op IN ('managed-connector','managed-connector-retry') AND ${orphanPredicate(2)}
    ORDER BY c.op, c.fingerprint LIMIT $1`, [opts.limit ?? 100_000, loadable, opts.before ?? null, opts.minAgeDays ?? null, CONNECTOR_STATE_OP]);
}

/**
 * Deletes the given orphans. Each DELETE re-applies the whole orphan predicate
 * in the same statement, so a row loaded, touched or newly referenced since
 * planning survives.
 */
export async function deleteOrphanConnectorCheckpoints(engine: Pick<BrainEngine, 'executeRaw' | 'transaction'>, rows: OrphanCheckpointRow[], opts: { before?: string; minAgeDays?: number } = {}): Promise<{ checkpoints: number; retries: number }> {
  const removed = { checkpoints: 0, retries: 0 };
  if (!rows.length) return removed;
  // Connector source rows stay share-locked while loadability is recomputed and rows are deleted, so a config change cannot make a deleted key current.
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT id FROM sources WHERE config->>'kind' IN ('google','github') ORDER BY id FOR SHARE");
    const loadable = [...(await loadableConnectorKeys(tx)).keys()];
    for (const row of rows) {
      const deleted = await tx.executeRaw<{ op: string }>(`DELETE FROM op_checkpoints c WHERE c.op=$1 AND c.fingerprint=$2 AND c.updated_at=$3::text::timestamptz
        AND ${orphanPredicate(4)} RETURNING c.op`, [row.op, row.fingerprint, row.updated_at, loadable, opts.before ?? null, opts.minAgeDays ?? null, CONNECTOR_STATE_OP]);
      if (!deleted.length) continue;
      if (row.op === 'managed-connector') removed.checkpoints++; else removed.retries++;
    }
  });
  return removed;
}

export interface ConnectorMigrationReport {
  rekeyed: Array<{ source_id: string; resumed_from: string }>;
  rewalking: string[];
  removed: { checkpoints: number; retries: number };
}

export async function migrateConnectorCheckpoints(engine: Sql, log: (line: string) => void = line => process.stderr.write(`${line}\n`)): Promise<ConnectorMigrationReport> {
  const [clock] = await engine.executeRaw<{ now: string }>('SELECT now()::text AS now');
  const start = clock.now;
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,'v2-cutoff',$2::text::jsonb) ON CONFLICT (op,fingerprint) DO NOTHING",
    [CONNECTOR_MIGRATION_OP, JSON.stringify([{ cutoff: start }])]);
  // One statement, bounded by its own timeout; no long transaction around the scan.
  const receipts = await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('statement_timeout','120s',true)");
    return tx.executeRaw<{ source_id: string; source_incarnation: string; kind: string | null; checkpoint_key: string | null; compacted: boolean; committed_at: string }>(`
      SELECT DISTINCT ON (source_id, source_incarnation) source_id, source_incarnation::text, intent->>'kind' AS kind, intent->>'checkpointKey' AS checkpoint_key,
             COALESCE(compacted,false) AS compacted, COALESCE(completed_at,updated_at)::text AS committed_at
        FROM persistence_requests
       -- Compaction nulls the intent but keeps the slug, so a compacted newest receipt is still found (and re-walks).
       WHERE state='committed' AND slug='__managed_connector_checkpoint__' AND operation='submit_job'
       ORDER BY source_id, source_incarnation, sequence DESC`);
  });
  const newest = new Map(receipts.map(row => [`${row.source_id}\u0000${row.source_incarnation}`, row]));
  const report: ConnectorMigrationReport = { rekeyed: [], rewalking: [], removed: { checkpoints: 0, retries: 0 } };
  // Archived sources are migrated too: archive and restore keep the incarnation, so a restore resumes its cursor.
  for (const [key, source] of await loadableConnectorKeys(engine)) {
    const receipt = newest.get(`${source.id}\u0000${source.incarnation}`);
    // No managed checkpoint yet, or already saved by this release under its stable key.
    if (!receipt || receipt.kind === 'connector_v2_checkpoint') continue;
    let recovery: Pick<ConnectorState, 'upgrade_recovery' | 'resumed_from'> = { upgrade_recovery: 'rewalking_once', resumed_from: null };
    if (!receipt.compacted && receipt.checkpoint_key) {
      await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
        SELECT 'managed-connector',$1,completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$2
        ON CONFLICT (op,fingerprint) DO NOTHING`, [key, receipt.checkpoint_key]);
      const [copied] = await engine.executeRaw<{ fingerprint: string }>("SELECT fingerprint FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [key]);
      if (copied) recovery = { upgrade_recovery: 'resumed', resumed_from: receipt.committed_at };
    }
    const seeded: ConnectorState = { ...emptyConnectorState(), ...recovery };
    const inserted = await engine.executeRaw<{ op: string }>(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
      ON CONFLICT (op,fingerprint) DO NOTHING RETURNING op`, [CONNECTOR_STATE_OP, connectorStateKey(source.id, source.incarnation), JSON.stringify([seeded])]);
    if (!inserted.length) continue;
    if (recovery.upgrade_recovery === 'resumed') {
      report.rekeyed.push({ source_id: source.id, resumed_from: recovery.resumed_from! });
      log(`  ${source.id}: resumed from pre-upgrade checkpoint of ${recovery.resumed_from}`);
      log(`    content selection since then is unverified; to re-walk: gbrain sync --source ${source.id} --reset-checkpoint`);
    } else report.rewalking.push(source.id);
  }
  report.removed = await deleteOrphanConnectorCheckpoints(engine, await orphanConnectorCheckpoints(engine, { before: start }), { before: start });
  if (report.rekeyed.length || report.rewalking.length || report.removed.checkpoints || report.removed.retries) {
    log(`  connector checkpoints: ${report.rekeyed.length} source(s) re-keyed, ${report.rewalking.length} will re-walk once `
      + `(the first post-upgrade admission spike is expected and is not #5470 churn); removed ${report.removed.checkpoints} orphan checkpoint row(s) `
      + `and ${report.removed.retries} orphan retry pointer(s).`);
  }
  return report;
}
