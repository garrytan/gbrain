/**
 * Refactor wave 1 (W4 doctor, EO11 / TE4): doctor mode matrix through the
 * registry runner.
 *
 * For each mode, `buildChecks` runs with every DOCTOR_CHECK_REGISTRY entry
 * wrapped by a recorder (entry order, what each returned, the context it saw)
 * and the engine wrapped by a call recorder, then the test asserts which
 * entries (probes) ran, where the run stopped, which engine calls happened,
 * and which mutations landed:
 *
 *   default             every entry, no STOP, no --fix mutation
 *   --fast              filesystem entries only, STOP at the DB-checks gate,
 *                       getStats never called
 *   --fix               DRY auto-repair writes SKILL.md BEFORE the resolver
 *                       scan (the post-fix scan is clean), dead-holder lock reaped
 *   --fix --dry-run     auto-fix report produced, SKILL.md and the lock untouched
 *   null engine         synthesized `connection` warn, STOP at the DB-checks gate
 *   connection failure  classified `connection` fail, STOP at the connection gate
 *
 * Serial: HOME / GBRAIN_HOME / audit dirs / PATH point at a fresh temp home
 * (doctor reads them), like test/doctor-early-stop-golden.serial.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { buildChecks, type Check } from '../src/commands/doctor.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { STOP_DOCTOR, type DoctorContext, type DoctorEntry } from '../src/commands/doctor/context.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ENV_KEYS = ['PATH', 'GBRAIN_HOME', 'HOME', 'GBRAIN_AUDIT_DIR', 'GBRAIN_SYNC_FAILURES_DIR', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SKILLS_DIR', 'OPENCLAW_WORKSPACE'] as const;
const SKILL_BODY = '## Iron Law: Back-Linking (MANDATORY)\n\nbody paragraph.\n';
const LOCK_ID = 'gbrain-sync:mode-matrix-example';

let pglite: PGLiteEngine;
let saved: Record<string, string | undefined> = {};
let home = '';
let skillsDir = '';

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
});

afterAll(async () => {
  await pglite.disconnect();
});

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-mode-matrix-'));
  mkdirSync(join(home, 'bin'), { recursive: true });
  process.env.HOME = home;
  process.env.GBRAIN_HOME = home;
  process.env.GBRAIN_AUDIT_DIR = join(home, 'audit');
  process.env.GBRAIN_SYNC_FAILURES_DIR = join(home, 'sync-failures');
  process.env.PATH = [join(home, 'bin'), '/usr/bin', '/bin'].join(delimiter);
  for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SKILLS_DIR', 'OPENCLAW_WORKSPACE']) delete process.env[k];
  skillsDir = makeSkillsRepo(join(home, 'workspace'));
  await resetPgliteState(pglite);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

/** A committed skills tree whose one skill carries a DRY violation `--fix` can repair. */
function makeSkillsRepo(root: string): string {
  const dir = join(root, 'skills');
  mkdirSync(join(dir, 'demo-example'), { recursive: true });
  writeFileSync(join(dir, 'RESOLVER.md'), '## Test\n| Trigger | Skill |\n|-----|-----|\n| "demo-example" | `skills/demo-example/SKILL.md` |\n');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ skills: [{ name: 'demo-example', path: 'demo-example/SKILL.md' }] }, null, 2));
  writeFileSync(join(dir, 'demo-example', 'SKILL.md'), `---\nname: demo-example\ndescription: test\ntriggers:\n  - "demo-example"\n---\n${SKILL_BODY}`);
  const git = { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } };
  execSync('git init --quiet', git);
  execSync('git config user.email alice-example@example.com && git config user.name alice-example', git);
  execSync('git add -A && git commit --quiet -m init', git);
  return dir;
}

const skillFile = () => readFileSync(join(skillsDir, 'demo-example', 'SKILL.md'), 'utf-8');

/** A lock row the --fix reaper removes: this host, a pid that has exited, past the reuse grace. */
async function seedDeadHolderLock(): Promise<void> {
  const deadPid = spawnSync('true').pid;
  await pglite.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
    [LOCK_ID, deadPid, hostname()],
  );
}

async function lockPresent(): Promise<boolean> {
  const rows = await pglite.executeRaw<{ id: string }>(`SELECT id FROM gbrain_cycle_locks WHERE id = $1`, [LOCK_ID]);
  return rows.length === 1;
}

/** Records every method call on the wrapped engine. */
function recordingEngine(target: BrainEngine, calls: string[]): BrainEngine {
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        calls.push(String(prop));
        return (v as (...args: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}

/** Every method resolves benign-empty except getStats, which rejects. */
function statsRejectingEngine(calls: string[]): BrainEngine {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'kind') return 'postgres';
      if (prop === 'then') return undefined;
      return (..._a: unknown[]) => {
        calls.push(String(prop));
        if (prop === 'getStats') return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1'));
        if (prop === 'getConfig') return Promise.resolve(null);
        return Promise.resolve([]);
      };
    },
  }) as unknown as BrainEngine;
}

interface Ran {
  entry: number;
  name: string;
  result: 'stop' | number;
}
interface Run {
  checks: Check[];
  ran: Ran[];
  ctx: DoctorContext | null;
  engineCalls: string[];
}

/** buildChecks with a recorder around every registry entry (restored afterwards). */
async function runMode(engine: BrainEngine | null, args: string[], engineCalls: string[], dbSource?: 'config-file'): Promise<Run> {
  const ran: Ran[] = [];
  let ctx: DoctorContext | null = null;
  const originals = DOCTOR_CHECK_REGISTRY.map((e) => e.run);
  DOCTOR_CHECK_REGISTRY.forEach((e: DoctorEntry, i) => {
    const orig = originals[i];
    e.run = async (c) => {
      ctx = c;
      const r = await orig(c);
      ran.push({ entry: i, name: e.name, result: r === STOP_DOCTOR ? 'stop' : r.length });
      return r;
    };
  });
  try {
    const checks = await buildChecks(engine, ['--json', '--skills-dir', skillsDir, ...args], dbSource);
    return { checks, ran, ctx, engineCalls };
  } finally {
    DOCTOR_CHECK_REGISTRY.forEach((e, i) => { e.run = originals[i]; });
  }
}

const indexOf = (entry: DoctorEntry) => DOCTOR_CHECK_REGISTRY.indexOf(entry);
const byName = (name: string, e: DoctorEntry[] = [...DOCTOR_CHECK_REGISTRY]) => e.filter((x) => x.name === name);
const [OFFLINE, DB_GATE, LIVE, CONN_GATE] = byName('connection');
const RESOLVER = byName('resolver_health')[0];
const SEARCH_MODE = DOCTOR_CHECK_REGISTRY.at(-1)!;
const upTo = (entry: DoctorEntry) => DOCTOR_CHECK_REGISTRY.slice(0, indexOf(entry) + 1).map((_, i) => i);
const dryViolations = (checks: Check[]) =>
  (checks.find((c) => c.name === 'resolver_health')?.issues ?? []).filter((i) => i.type === 'dry_violation' && i.skill === 'demo-example');

describe('doctor mode matrix (registry runner, EO11)', () => {
  test('gate entries sit where master returned early', () => {
    expect([OFFLINE, DB_GATE, LIVE, CONN_GATE].map((e) => e.emits.length > 0)).toEqual([true, false, true, false]);
    expect(indexOf(DB_GATE)).toBe(indexOf(OFFLINE) + 1);
    expect(indexOf(CONN_GATE)).toBe(indexOf(LIVE) + 1);
    expect(indexOf(RESOLVER)).toBe(0);
  });

  test('default: every entry runs, no STOP, no --fix mutation', async () => {
    await seedDeadHolderLock();
    await pglite.setConfig('version', String(LATEST_VERSION));
    const calls: string[] = [];
    const run = await runMode(recordingEngine(pglite, calls), [], calls);
    expect(run.ran.map((r) => r.entry)).toEqual(DOCTOR_CHECK_REGISTRY.map((_, i) => i));
    expect(run.ran.some((r) => r.result === 'stop')).toBe(false);
    expect(run.ran.find((r) => r.entry === indexOf(OFFLINE))?.result).toBe(0);
    expect(run.checks.find((c) => c.name === 'connection')?.status).toBe('ok');
    expect(calls.filter((c) => c === 'getStats').length).toBeGreaterThanOrEqual(1);
    expect(run.ctx?.autoFixReport).toBeNull();
    expect(run.ctx?.connectionFailed).toBe(false);
    expect(run.ctx?.schemaVersion).toBe(LATEST_VERSION);
    expect(skillFile()).toContain(SKILL_BODY);
    expect(dryViolations(run.checks).length).toBeGreaterThan(0);
    expect(await lockPresent()).toBe(true);
  }, 180_000);

  test('--fast: filesystem entries only, STOP at the DB-checks gate, no connection probe', async () => {
    await seedDeadHolderLock();
    const calls: string[] = [];
    const run = await runMode(recordingEngine(pglite, calls), ['--fast'], calls);
    expect(run.ran.map((r) => r.entry)).toEqual(upTo(DB_GATE));
    expect(run.ran.at(-1)).toEqual({ entry: indexOf(DB_GATE), name: 'connection', result: 'stop' });
    expect(run.ran.find((r) => r.entry === indexOf(OFFLINE))?.result).toBe(0);
    expect(calls).not.toContain('getStats');
    expect(run.checks.some((c) => c.name === 'connection')).toBe(false);
    expect(run.ctx?.schemaVersion).toBe(0);
    expect(await lockPresent()).toBe(true);
  }, 180_000);

  test('--fix: DRY auto-repair lands before the resolver scan and dead-holder locks are reaped', async () => {
    await seedDeadHolderLock();
    const calls: string[] = [];
    const run = await runMode(recordingEngine(pglite, calls), ['--fix'], calls);
    expect(run.ran.map((r) => r.entry)).toEqual(DOCTOR_CHECK_REGISTRY.map((_, i) => i));
    expect(run.ctx?.autoFixReport?.fixed.map((f) => f.skill)).toEqual(['demo-example']);
    expect(skillFile()).not.toContain(SKILL_BODY);
    expect(dryViolations(run.checks)).toEqual([]);
    expect(await lockPresent()).toBe(false);
    expect(run.checks.find((c) => c.name === 'stale_locks')?.message).toContain(`Reaped 1 dead-holder lock(s): ${LOCK_ID}.`);
  }, 180_000);

  test('--fix --dry-run: the fix is proposed, nothing is written or reaped', async () => {
    await seedDeadHolderLock();
    const calls: string[] = [];
    const run = await runMode(recordingEngine(pglite, calls), ['--fix', '--dry-run'], calls);
    expect(run.ran.map((r) => r.entry)).toEqual(DOCTOR_CHECK_REGISTRY.map((_, i) => i));
    expect(run.ctx?.autoFixReport?.fixed.map((f) => f.skill)).toEqual(['demo-example']);
    expect(skillFile()).toContain(SKILL_BODY);
    expect(dryViolations(run.checks).length).toBeGreaterThan(0);
    expect(await lockPresent()).toBe(true);
  }, 180_000);

  test('null engine: synthesized connection check, STOP at the DB-checks gate', async () => {
    const run = await runMode(null, [], []);
    expect(run.ran.map((r) => r.entry)).toEqual(upTo(DB_GATE));
    expect(run.ran.at(-1)?.result).toBe('stop');
    expect(run.ran.find((r) => r.entry === indexOf(OFFLINE))?.result).toBeGreaterThanOrEqual(1);
    const conn = run.checks.filter((c) => c.name === 'connection');
    expect(conn).toHaveLength(1);
    // E10: the message names the config path it looked in; the check carries a fix and an unknown readiness.
    expect(conn[0]).toMatchObject({ name: 'connection', status: 'warn', readiness_state: 'unknown', fix: { argv: ['gbrain', 'init', '--pglite'] } });
    expect(conn[0].message).toMatch(/^No database configured \(filesystem checks only; no URL in the environment or in .*config\.json\)\. Set GBRAIN_DATABASE_URL or run `gbrain init`\.$/);
    expect(run.ctx?.connectionFailed).toBe(false);
  }, 180_000);

  test('connection failure: classified connection fail, STOP at the connection gate', async () => {
    const calls: string[] = [];
    const run = await runMode(statsRejectingEngine(calls), [], calls);
    expect(run.ran.map((r) => r.entry)).toEqual(upTo(CONN_GATE));
    expect(run.ran.at(-1)).toEqual({ entry: indexOf(CONN_GATE), name: 'connection', result: 'stop' });
    expect(run.ctx?.connectionFailed).toBe(true);
    expect(run.checks.at(-1)?.name).toBe('connection');
    expect(run.checks.at(-1)?.status).toBe('fail');
    expect(calls.filter((c) => c === 'getStats')).toEqual(['getStats']);
    expect(run.ran.some((r) => r.entry === indexOf(SEARCH_MODE))).toBe(false);
  }, 180_000);
});
