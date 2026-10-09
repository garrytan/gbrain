/**
 * #6317: the persistence consumers of this host and the identity they run
 * under. Three checks, all read-only:
 *
 * - `two_consumers_on_host` (B3): two resident-kind full consumers (`serve`,
 *   `sync`, `jobs`, `autopilot`, `mcp`) both alive for longer than 30 s on
 *   this host. Every wedge in #6317 had two consumers on the host; one
 *   consumer per host is a preference the election keeps, so a persistent
 *   overlap is reported, not bounded. Short-lived rows (`put`, `cli`) and
 *   rows younger than 30 s are listed only.
 * - `consumers_without_heartbeat` (T1c): owners stamped on this host's live
 *   running claims that have no heartbeat row: an older gbrain build, which
 *   never writes one, or a consumer whose renewals fail.
 * - `host_identity_mismatch` (I1): a worktree this filesystem holds whose
 *   binding belongs to another `host.json` identity (same machine id, or the
 *   managed worktree at the binding's path plus a `host.json` minted later
 *   under a different `HOME`/`GBRAIN_HOME`). Names both files and the one-line
 *   `GBRAIN_HOME` fix; never re-identifies anything.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { listHostConsumers } from '../../../core/persistence/consumer-heartbeat.ts';
import { consumerOverlap, hostIdentityMismatches, ownersWithoutHeartbeat, OVERLAP_MIN_AGE_MS } from '../../../core/persistence/consumer-diagnostics.ts';
import { localHostIdentity } from '../../../core/persistence/identity.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/troubleshooting.md#two-consumers-on-host';
const IDENTITY_DOCS = 'docs/guides/troubleshooting.md#host-identity-mismatch';
const STATUS_ARGV = ['gbrain', 'sources', 'writer', 'status', '--json'];

export async function twoConsumersOnHostCheck(engine: BrainEngine, hostId: string): Promise<Check> {
  if (engine.kind === 'pglite') return { name: 'two_consumers_on_host', status: 'ok', message: 'PGLite admits one process; no consumer heartbeat rows are kept.', details: { count: 0, consumers: [], docs: DOCS } };
  try {
    const consumers = await listHostConsumers(engine, hostId);
    const overlap = consumerOverlap(consumers);
    const listed = consumers.map(row => ({ kind: row.kind, pid: row.pid, nonce: row.nonce, pid_ns: row.pid_ns, mode: row.mode, version: row.version, started_at: row.started_at,
      age_ms: row.age_ms, renewed_age_ms: row.renewed_age_ms, liveness: row.liveness, restart_required: row.restart_required, root_barrier_age_ms: row.root_barrier_age_ms, pool: row.pool, self: row.self }));
    const details = { count: overlap.length, min_age_ms: OVERLAP_MIN_AGE_MS, consumers: listed, docs: DOCS };
    if (!overlap.length) return { name: 'two_consumers_on_host', status: 'ok', details,
      message: consumers.length ? `${consumers.length} consumer process(es) on this host (${listed.map(row => `${row.kind} pid ${row.pid}, ${row.liveness}`).join('; ')}); at most one resident full consumer is alive.`
        : 'No persistence consumer is running on this host.' };
    return { name: 'two_consumers_on_host', status: 'warn', details,
      message: `two_consumers_on_host: ${overlap.length} resident processes have each run a full persistence consumer on this host for over ${OVERLAP_MIN_AGE_MS / 1000} s `
        + `(${overlap.map(row => `${row.kind} pid ${row.pid}, started ${row.started_at}`).join('; ')}). Two consumers on one host preceded every #6317 wedge. `
        + 'With persistence.single_consumer on, the later resident process defers to the first; a process started with --no-delegate or before the owner keeps its own consumer until it exits. '
        + 'Stop one of them (the sync CLI or jobs worker, not the serve), or leave both and watch writer status until one exits.',
      fix: agentFix(STATUS_ARGV, 'Read-only: lists host.consumers with each process\'s mode, age and wedge report, and every running claim\'s owner.', 'two_consumers_on_host', { docs: DOCS }) };
  } catch (error) {
    return checkError('two_consumers_on_host', 'read the consumer heartbeat rows', error, { details: { count: 'unknown', health: 'unknown', docs: DOCS } });
  }
}

export async function consumersWithoutHeartbeatCheck(engine: BrainEngine, hostId: string): Promise<Check> {
  if (engine.kind === 'pglite') return { name: 'consumers_without_heartbeat', status: 'ok', message: 'PGLite admits one process; no consumer heartbeat rows are kept.', details: { count: 0, owners: [], docs: DOCS } };
  try {
    const owners = await ownersWithoutHeartbeat(engine, hostId);
    const details = { count: owners.length, owners, docs: DOCS };
    if (!owners.length) return { name: 'consumers_without_heartbeat', status: 'ok', details, message: 'Every owner of a live running claim on this host has a consumer heartbeat row.' };
    return { name: 'consumers_without_heartbeat', status: 'warn', details,
      message: `consumers_without_heartbeat: ${owners.length} process(es) hold live claims on this host without a consumer heartbeat row `
        + `(${owners.map(owner => `${owner.kind ?? 'unknown'} pid ${owner.pid}${owner.version ? ` v${owner.version}` : ''}: ${owner.requests} claim(s) on ${owner.sources.join(', ')}`).join('; ')}). `
        + 'A gbrain older than this release writes no heartbeat, so the consumer election cannot see it and a new process beside it starts a second full consumer. '
        + 'Restart that process on this gbrain version.',
      fix: agentFix(STATUS_ARGV, 'Read-only: shows each running claim\'s owner (kind, pid, build) next to host.consumers.', 'consumers_without_heartbeat', { docs: DOCS }) };
  } catch (error) {
    return checkError('consumers_without_heartbeat', 'compare running claims with the consumer heartbeat rows', error, { details: { count: 'unknown', health: 'unknown', docs: DOCS } });
  }
}

export async function hostIdentityMismatchCheck(engine: BrainEngine): Promise<Check> {
  try {
    const me = localHostIdentity();
    const mismatches = await hostIdentityMismatches(engine, me);
    // The ok details carry no `minted_under`: the machine id and hostname differ per machine, and the doctor goldens pin this shape.
    const details = { count: mismatches.length, host_id: me.id, host_json_path: me.path, mismatches, docs: IDENTITY_DOCS };
    if (!mismatches.length) return { name: 'host_identity_mismatch', status: 'ok', details, message: `This process's host identity (${me.path}) owns every binding this filesystem holds.` };
    // The owners whose identity file is known (a heartbeat row) come first: they carry the one-line fix.
    const ordered = [...mismatches].sort((a, b) => Number(b.fix_env !== null) - Number(a.fix_env !== null) || Number(b.reason === 'same_machine_id') - Number(a.reason === 'same_machine_id'));
    const minted = (value: Record<string, unknown> | 'unknown' | null) => value && value !== 'unknown'
      ? `HOME=${String(value.home ?? '')} GBRAIN_HOME=${value.gbrain_home == null ? '(unset)' : String(value.gbrain_home)}` : 'minted_under: unknown';
    const fix = ordered.find(m => m.fix_env)?.fix_env;
    return { name: 'host_identity_mismatch', status: 'warn', details: { ...details, minted_under: me.minted_under ?? 'unknown' },
      message: `host_identity_mismatch: ${mismatches.length} managed worktree(s) on this filesystem belong to another host identity. `
        + `This process reads ${me.path} (host ${me.id}, ${minted(me.minted_under)}). `
        + ordered.slice(0, 3).map(m => `The binding for ${m.source_ids.join(', ') || m.worktree_id} at ${m.local_path} is owned by host ${m.owner_host_id} (${m.owner_host.host_json_path}, ${minted(m.owner_host.minted_under)})`
          + `${m.reason === 'same_machine_id' ? ', minted on this same machine' : ', and this process\'s identity was minted after that binding under a different home'}.`).join(' ')
        + `${mismatches.length > 3 ? ` (first 3 of ${mismatches.length} shown.)` : ''} `
        + 'Every write from this process on those sources reports owner_unavailable (host_mismatch) and their maintenance never runs. '
        + `Fix on the supervisor of this process: ${fix ?? 'set GBRAIN_HOME to the owner\'s home (the parent of its .gbrain directory)'}, then restart it; never delete or regenerate either host.json.`,
      fix: agentFix(STATUS_ARGV, 'Read-only: shows local_host_id, each binding\'s owner_host_id and host.consumers with the owner\'s identity file path.', 'host_identity_mismatch', { docs: IDENTITY_DOCS }) };
  } catch (error) {
    return checkError('host_identity_mismatch', 'compare the host identity with the binding owners', error, { details: { count: 'unknown', health: 'unknown', docs: IDENTITY_DOCS } });
  }
}

async function runPersistenceConsumers(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  const hostId = localHostIdentity().id;
  checks.push(await twoConsumersOnHostCheck(engine, hostId));
  checks.push(await consumersWithoutHeartbeatCheck(engine, hostId));
  checks.push(await hostIdentityMismatchCheck(engine));
  return checks;
}

export const persistenceConsumersEntry: DoctorEntry = {
  name: 'two_consumers_on_host',
  emits: ['two_consumers_on_host', 'consumers_without_heartbeat', 'host_identity_mismatch'],
  run: runPersistenceConsumers,
};
