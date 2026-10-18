/**
 * #6696 B1: the ops-tier sections of `gbrain doctor --tier ops` — "what is
 * wrong right now", answered in seconds. Each entry is tagged `tier: 'ops'`, so
 * the default run puts them first (registry order) and `--tier ops` runs only
 * them, under one absolute deadline (./budget.ts).
 *
 * Sections owned here: managed write capacity and its forecast, terminal write
 * failures, receipt compaction freshness (`persistence_compaction`, the
 * consumer's `persistence.maintenance.last_compaction` record) and schema-pack
 * consistency, and (#6712 PR 2) the managed-sync soak counters (`sync_soak_counters`:
 * interventions and content decisions over the last seven days). The other ops sections are
 * tagged where they live: `embedding_state` (embedding coverage),
 * `managed_sync_not_moving` (sync cursor movement and age) and
 * `serve_build_drift` (serve build drift).
 *
 * On PGLite the ops tier reads only counters, config and catalog: an entry with
 * `opsPglite: 'not_applicable'` (it aggregates request or page tables) reports
 * `not_applicable` there instead of running.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkPersistenceCapacity } from './persistence-capacity.ts';
import { terminalFailuresCheck } from './persistence-requests.ts';
import { checkSchemaPackConsistency } from '../schema-pack-checks.ts';
import { checkPersistenceCompaction } from './persistence-compaction.ts';
import { readSoakCounters } from '../../../core/persistence/soak-counters.ts';

async function runPersistenceCapacity(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('persistence_capacity');
  checks.push(await checkPersistenceCapacity(connectedEngine(ctx)));
  return checks;
}

export const persistenceCapacityEntry: DoctorEntry = {
  name: 'persistence_capacity',
  emits: ['persistence_capacity'],
  tier: 'ops',
  run: runPersistenceCapacity,
};

async function runTerminalFailures(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('persistence_terminal_failures');
  const check = await terminalFailuresCheck(connectedEngine(ctx), doctorSourceIds(ctx));
  if (check) checks.push({ ...check, name: 'persistence_terminal_failures' });
  return checks;
}

export const terminalFailuresEntry: DoctorEntry = {
  name: 'persistence_terminal_failures',
  emits: ['persistence_terminal_failures'],
  tier: 'ops',
  opsPglite: 'not_applicable',
  run: runTerminalFailures,
};

async function runPersistenceCompaction(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('persistence_compaction');
  checks.push(await checkPersistenceCompaction(connectedEngine(ctx)));
  return checks;
}

export const persistenceCompactionEntry: DoctorEntry = {
  name: 'persistence_compaction',
  emits: ['persistence_compaction'],
  tier: 'ops',
  run: runPersistenceCompaction,
};

async function runSchemaPackConsistency(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('schema_pack_consistency');
  const sourceIds = doctorSourceIds(ctx);
  checks.push(await checkSchemaPackConsistency(connectedEngine(ctx), sourceIds ? { sourceIds } : {}));
  return checks;
}

export const schemaPackConsistencyEntry: DoctorEntry = {
  name: 'schema_pack_consistency',
  emits: ['schema_pack_consistency'],
  tier: 'ops',
  opsPglite: 'not_applicable',
  run: runSchemaPackConsistency,
};

/**
 * #6712 PR 2: what the seven-day soak reads. Informational (never scored): interventions are the steps a person took to
 * keep managed sync converging, content decisions the drift choices on pages outside `storage.keep_db` (Garry's d1b).
 */
async function runSoakCounters(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('sync_soak_counters');
  const counters = await readSoakCounters(connectedEngine(ctx));
  const kinds = (record: Record<string, number>) => Object.entries(record).filter(([kind, n]) => kind !== 'total' && n > 0).map(([kind, n]) => `${kind} ${n}`).join(', ');
  checks.push({ name: 'sync_soak_counters', status: 'ok', severity: 'info', details: { ...counters, docs: 'docs/guides/sync-unblock-runbook.md#soak-counters' },
    message: `Last ${counters.window_days} days: ${counters.interventions.total} managed-sync intervention(s)${counters.interventions.total ? ` (${kinds(counters.interventions)})` : ''}, `
      + `${counters.content_decisions.total} content decision(s)${counters.content_decisions.total ? ` (${kinds(counters.content_decisions)})` : ''}.` });
  return checks;
}

export const soakCountersEntry: DoctorEntry = {
  name: 'sync_soak_counters',
  emits: ['sync_soak_counters'],
  tier: 'ops',
  run: runSoakCounters,
};
