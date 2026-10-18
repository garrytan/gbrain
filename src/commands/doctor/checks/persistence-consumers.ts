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
 *
 * #6696 C6: `serve_build_drift` (its own entry, one read) compares the live
 * resident consumers' heartbeat `version` with this binary's VERSION and warns
 * when serve or a worker runs an older build than this checkout, with the
 * installed service's restart command (else the pid) and a verify. A serve
 * that predates heartbeats has no row; `consumers_without_heartbeat` names it.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { listHostConsumers, RESIDENT_CONSUMER_KINDS, type ListedConsumer } from '../../../core/persistence/consumer-heartbeat.ts';
import { compareWriterVersions } from '../../../core/persistence/writer-versions.ts';
import { launchdPlistPath, SERVE_LAUNCHD_LABEL, SERVE_SYSTEMD_UNIT, systemdUnitPath } from '../../../core/serve-service.ts';
import { VERSION } from '../../../version.ts';
import { consumerOverlap, hostIdentityMismatches, ownersWithoutHeartbeat, OVERLAP_MIN_AGE_MS } from '../../../core/persistence/consumer-diagnostics.ts';
import { localHostIdentity } from '../../../core/persistence/identity.ts';
import { agentFix, checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/troubleshooting.md#two-consumers-on-host';
const IDENTITY_DOCS = 'docs/guides/troubleshooting.md#host-identity-mismatch';
const DRIFT_DOCS = 'docs/guides/troubleshooting.md#serve-build-drift';
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

export interface ServiceHost { platform: string; home: string; uid: number }

/** The restart for one consumer: the installed serve service's own command, else stopping that pid for its supervisor or operator to start again. */
function restartArgv(row: ListedConsumer, service: ServiceHost): string[] {
  if (row.kind === 'serve' && service.platform === 'darwin' && existsSync(launchdPlistPath(service.home))) return ['launchctl', 'kickstart', '-k', `gui/${service.uid}/${SERVE_LAUNCHD_LABEL}`];
  if (row.kind === 'serve' && service.platform === 'linux' && existsSync(systemdUnitPath(service.home))) return ['systemctl', '--user', 'restart', SERVE_SYSTEMD_UNIT];
  return ['kill', String(row.pid)];
}

export async function serveBuildDriftCheck(engine: BrainEngine, hostId: string,
  service: ServiceHost = { platform: process.platform, home: homedir(), uid: process.getuid?.() ?? 501 }): Promise<Check> {
  if (engine.kind === 'pglite') return { name: 'serve_build_drift', status: 'ok', message: 'PGLite admits one process; no consumer heartbeat rows are kept to compare builds.', details: { count: 0, docs: DRIFT_DOCS } };
  try {
    const live = (await listHostConsumers(engine, hostId)).filter(row => row.liveness === 'live' && !row.self && RESIDENT_CONSUMER_KINDS.includes(row.kind));
    const owner = live.find(row => row.mode === 'full' || row.mode === 'promoted') ?? live[0] ?? null;
    const order = (row: ListedConsumer) => compareWriterVersions(row.version, VERSION) ?? -1;
    const older = live.filter(row => order(row) < 0), newer = live.filter(row => order(row) > 0);
    const label = (row: ListedConsumer) => `${row.kind} pid ${row.pid} v${row.version}`;
    const details = { count: older.length, this_version: VERSION, owner: owner ? { kind: owner.kind, pid: owner.pid, mode: owner.mode, version: owner.version } : null,
      older: older.map(row => ({ kind: row.kind, pid: row.pid, mode: row.mode, version: row.version })), newer: newer.map(row => ({ kind: row.kind, pid: row.pid, version: row.version })), docs: DRIFT_DOCS };
    if (!live.length) return { name: 'serve_build_drift', status: 'ok', details,
      message: 'No live gbrain consumer on this host writes a heartbeat row. A serve that predates heartbeats writes none; consumers_without_heartbeat names it when it holds claims.' };
    if (!older.length) return { name: 'serve_build_drift', status: 'ok', details,
      message: newer.length ? `This checkout (v${VERSION}) is older than the running ${newer.map(label).join('; ')}; upgrade this checkout before running one-shot commands from it.`
        : `Every live consumer on this host runs this build (v${VERSION}).` };
    const target = older.find(row => row.kind === 'serve') ?? older[0]!;
    const argv = restartArgv(target, service);
    return { name: 'serve_build_drift', status: 'warn', details,
      message: `serve_build_drift: serve is running an older build than this checkout; restart serve and workers. This binary is v${VERSION}; running: ${older.map(label).join('; ')}. `
        + 'Until they restart, one-shot commands from this checkout run newer code against an older consumer. '
        + `Restart with \`${argv.join(' ')}\`${argv[0] === 'kill' ? ' and start it again the way it was launched' : ''}, then restart each other listed process. `
        + 'A serve that predates heartbeats writes no row; consumers_without_heartbeat names it.',
      fix: { argv, consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify('serve_build_drift'), docs: DRIFT_DOCS,
        why: `Restarts ${label(target)} on this build (v${VERSION}); restart every other listed process the same way.` } };
  } catch (error) {
    return checkError('serve_build_drift', 'read the consumer heartbeat rows', error, { details: { count: 'unknown', health: 'unknown', docs: DRIFT_DOCS } });
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

async function runServeBuildDrift(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await serveBuildDriftCheck(connectedEngine(ctx), localHostIdentity().id));
  return checks;
}

export const serveBuildDriftEntry: DoctorEntry = {
  name: 'serve_build_drift',
  emits: ['serve_build_drift'],
  tier: 'ops',
  run: runServeBuildDrift,
};
