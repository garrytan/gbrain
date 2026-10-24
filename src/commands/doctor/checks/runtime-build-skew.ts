/**
 * #7245: doctor `runtime_build_skew`. Each long-running gbrain process keeps
 * the code it loaded at start, while `gbrain jobs run-child` spawns a fresh
 * process from the install on disk for every job, so after a checkout reset or
 * an upgrade on disk one host can run several builds at once: serve on one, the
 * supervisor and worker parents on another (in memory), job children on a third
 * (from disk). `serve_build_drift` compares the consumer heartbeat rows with
 * this binary only; this check compares the running processes with each other
 * and with the build each one's install holds on disk now:
 *
 * - serve and the other resident consumers: their `persistence_consumers`
 *   heartbeat `version` (Postgres; PGLite keeps none);
 * - the jobs supervisor: lines 4-5 of its PID file (`readSupervisorBuild`);
 * - worker parents (`gbrain jobs work`, autopilot-spawned ones included): the
 *   `version` and `install_root` of their worker-registry entries;
 * - job children: the `job_build_skew:` history entry a child writes when its
 *   build differs from its worker's (`jobChildBuildVerdict`), on the newest 500
 *   jobs of the last 24 h, counted while that worker is still alive.
 *
 * Read-only. Two or more builds among the running processes (and their recent
 * job children) fail the check (GBRA-175); one process older than its install
 * alone warns. The fix asks the user, then runs `gbrain upgrade --restart-only`,
 * which restarts every process onto the installed build and verifies one build
 * runs; the message also names the first manual restart (serve first, then the
 * supervisor, then a worker). Nothing restarts automatically. Output carries
 * pids and versions only, never a path.
 */
import { homedir } from 'node:os';
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { listHostConsumers, RESIDENT_CONSUMER_KINDS } from '../../../core/persistence/consumer-heartbeat.ts';
import { localHostIdentity } from '../../../core/persistence/identity.ts';
import { compareWriterVersions } from '../../../core/persistence/writer-versions.ts';
import { installedVersion } from '../../../core/runtime-build.ts';
import { JOB_BUILD_SKEW_PREFIX } from '../../../core/minions/child-readiness.ts';
import { readWorkers, type WorkerRegistryEntry } from '../../../core/minions/worker-registry.ts';
import { readSupervisorBuild, readSupervisorPid } from '../../../core/minions/supervisor-pid.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { restartArgv, type ServiceHost } from './persistence-consumers.ts';

const DOCS = 'docs/guides/troubleshooting.md#runtime-build-skew';
const CHILD_WINDOW_HOURS = 24;
const CHILD_SCAN_JOBS = 500;
const ROLE_ORDER = ['serve', 'supervisor', 'worker'];
const RESTART_ARGV = ['gbrain', 'upgrade', '--restart-only'];

export interface RunningBuild { role: string; pid: number; version: string | null; installed_version: string | null }
export interface ChildBuild { job_id: number; child_version: string; worker_pid: number; worker_version: string; refused: boolean }

export interface RuntimeBuildSources {
  workers: () => Array<Pick<WorkerRegistryEntry, 'pid' | 'version' | 'install_root'>>;
  supervisor: () => Promise<{ pid: number; version: string | null; install_root: string | null } | null>;
  installedVersion: (root: string | null | undefined) => string | null;
}

const CHILD_LINE = new RegExp(`^${JOB_BUILD_SKEW_PREFIX} job child v(\\S+) (ran|refused to run) under worker pid (\\d+) v([0-9.]+)`);

const defaultSources: RuntimeBuildSources = {
  workers: () => readWorkers(() => null),
  supervisor: async () => {
    const { DEFAULT_PID_FILE } = await import('../../../core/minions/supervisor.ts');
    const status = readSupervisorPid(DEFAULT_PID_FILE);
    if (!status.running || status.pid === null) return null;
    const build = readSupervisorBuild(DEFAULT_PID_FILE);
    return { pid: status.pid, version: build?.version ?? null, install_root: build?.install_root ?? null };
  },
  installedVersion,
};

async function recentChildBuilds(engine: BrainEngine): Promise<ChildBuild[]> {
  const rows = await engine.executeRaw<{ id: number; line: string }>(
    `SELECT j.id, e.line FROM (
       SELECT id, stacktrace FROM minion_jobs
        WHERE jsonb_typeof(stacktrace) = 'array' AND updated_at > now() - interval '${CHILD_WINDOW_HOURS} hours'
        ORDER BY id DESC LIMIT ${CHILD_SCAN_JOBS}) j
     CROSS JOIN LATERAL jsonb_array_elements_text(j.stacktrace) AS e(line)
     WHERE e.line LIKE $1`, [`${JOB_BUILD_SKEW_PREFIX}%`]);
  return rows.flatMap(row => {
    const match = CHILD_LINE.exec(row.line);
    return match ? [{ job_id: Number(row.id), child_version: match[1]!, worker_pid: Number(match[3]), worker_version: match[4]!, refused: match[2] === 'refused to run' }] : [];
  });
}

const label = (p: RunningBuild) => `${p.role} pid ${p.pid} v${p.version}${p.installed_version && p.installed_version !== p.version ? ` (its install now holds v${p.installed_version})` : ''}`;

function restartFor(target: RunningBuild, service: ServiceHost): string[] {
  if (target.role === 'supervisor') return ['gbrain', 'jobs', 'supervisor', 'stop'];
  return restartArgv({ kind: target.role, pid: target.pid }, service);
}

export async function runtimeBuildSkewCheck(engine: BrainEngine, hostId: string, sources: RuntimeBuildSources = defaultSources,
  service: ServiceHost = { platform: process.platform, home: homedir(), uid: process.getuid?.() ?? 501 }): Promise<Check> {
  try {
    const byPid = new Map<number, RunningBuild>();
    for (const row of await listHostConsumers(engine, hostId)) {
      if (row.liveness !== 'live' || row.self || !RESIDENT_CONSUMER_KINDS.includes(row.kind)) continue;
      byPid.set(row.pid, { role: row.kind, pid: row.pid, version: row.version || null, installed_version: null });
    }
    for (const entry of sources.workers()) {
      byPid.set(entry.pid, { role: 'worker', pid: entry.pid, version: entry.version ?? byPid.get(entry.pid)?.version ?? null, installed_version: sources.installedVersion(entry.install_root) });
    }
    const supervisor = await sources.supervisor();
    if (supervisor) byPid.set(supervisor.pid, { role: 'supervisor', pid: supervisor.pid, version: supervisor.version, installed_version: sources.installedVersion(supervisor.install_root) });
    const processes = [...byPid.values()].sort((a, b) => (ROLE_ORDER.indexOf(a.role) + 1 || 99) - (ROLE_ORDER.indexOf(b.role) + 1 || 99) || a.pid - b.pid);
    const children = await recentChildBuilds(engine);
    const liveChildren = children.filter(child => byPid.has(child.worker_pid));
    const versions = new Set<string>([...processes.flatMap(p => p.version ? [p.version] : []), ...liveChildren.map(child => child.child_version)]);
    const newest = [...versions].sort((a, b) => compareWriterVersions(b, a) ?? 0)[0] ?? null;
    const stale = processes.filter(p => p.version && ((newest && (compareWriterVersions(p.version, newest) ?? 0) < 0) || (p.installed_version && p.installed_version !== p.version)));
    const unknown = processes.filter(p => !p.version);
    const details = { count: stale.length, newest, builds: [...versions],
      processes: processes.map(p => ({ role: p.role, pid: p.pid, version: p.version, installed_version: p.installed_version })),
      stale: stale.map(p => ({ role: p.role, pid: p.pid, version: p.version, installed_version: p.installed_version })),
      job_children: liveChildren, earlier_job_children: children.length - liveChildren.length, unknown_builds: unknown.map(p => ({ role: p.role, pid: p.pid })), docs: DOCS };
    const unknownNote = unknown.length ? ` ${unknown.map(p => `${p.role} pid ${p.pid}`).join('; ')} started before builds were recorded; restart it to report one.` : '';
    if (!stale.length) {
      return { name: 'runtime_build_skew', status: 'ok', details,
        message: (processes.length ? `Every long-running gbrain process on this host that records its build runs ${newest ? `v${newest}` : 'an unrecorded build'} (${processes.map(p => `${p.role} pid ${p.pid}`).join('; ')}).`
          : 'No long-running gbrain process (serve, jobs supervisor, worker) is running on this host.') + unknownNote };
    }
    const target = stale[0]!;
    const argv = restartFor(target, service);
    const childLines = [...new Map(liveChildren.map(c => [`${c.worker_pid}|${c.child_version}|${c.refused}`, c])).values()].map(c => {
      const jobs = liveChildren.filter(o => o.worker_pid === c.worker_pid && o.child_version === c.child_version && o.refused === c.refused).map(o => `#${o.job_id}`);
      return `job children of worker pid ${c.worker_pid} ${c.refused ? 'refused to run' : 'ran'} v${c.child_version} (jobs ${jobs.slice(0, 5).join(', ')}${jobs.length > 5 ? `, +${jobs.length - 5} more` : ''})`;
    });
    const restartHow = target.role === 'supervisor' ? ' and start it again with `gbrain jobs supervisor start --detach` (it respawns its worker from the install on disk)'
      : argv[0] === 'kill' ? ' (SIGTERM: it drains its jobs; a supervisor respawns a worker from the install on disk) and start it again the way it was launched if nothing supervises it' : '';
    const running = processes.filter(p => p.version).map(label).join('; ');
    return { name: 'runtime_build_skew', status: versions.size > 1 ? 'fail' : 'warn', details,
      message: `runtime_build_skew: ${versions.size > 1 ? `${versions.size} gbrain builds are running on this host` : 'a gbrain process runs an older build than its install'} (newest v${newest}): `
        + `${running}${childLines.length ? `; ${childLines.join('; ')}` : ''}. `
        + 'A process keeps the build it started with, and every job child it spawns runs the build its install holds on disk now. '
        + `\`gbrain upgrade --restart-only\` restarts every listed process onto the installed build and verifies one build runs (it refuses, naming the step, for a process it cannot restart). `
        + `By hand: restart with \`${argv.join(' ')}\`${restartHow}, then restart each other process listed on an older build. Nothing restarts automatically.${unknownNote}`,
      fix: { ask_user: true, argv: RESTART_ARGV, consent: [], actor: 'agent', requires_exclusive: false, verify: doctorVerify('runtime_build_skew'), docs: DOCS,
        why: `Restarts every gbrain process on this host that is not on the installed build (first ${label(target)}), drain-first, then verifies they all report one build and the warm CLI socket accepts it.`,
        user_message: `gbrain processes on this host run different builds (${running}). Restart them onto the installed build with \`gbrain upgrade --restart-only\`? Serve and the jobs worker drain and come back within a minute.` } };
  } catch (error) {
    return checkError('runtime_build_skew', 'read the builds of this host\'s gbrain processes', error, { details: { count: 'unknown', health: 'unknown', docs: DOCS } });
  }
}

async function runRuntimeBuildSkew(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await runtimeBuildSkewCheck(connectedEngine(ctx), localHostIdentity().id));
  return checks;
}

export const runtimeBuildSkewEntry: DoctorEntry = {
  name: 'runtime_build_skew',
  emits: ['runtime_build_skew'],
  run: runRuntimeBuildSkew,
};
