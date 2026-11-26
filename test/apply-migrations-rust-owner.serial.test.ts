/**
 * `gbrain apply-migrations` on a Rust brain: the upgrade migrations that start a `gbrain` child, against the same
 * migrations on a PGLite brain.
 *
 * 1. Protects: on a Rust brain, v0.11.0's Phase B (`gbrain jobs smoke`, a child process) passes and prints what it
 *    prints on PGLite, and v0.12.2 (the JSONB repair, which has nothing to repair outside Postgres) completes with
 *    PGLite's exact output, and `gbrain repair-jsonb` names the Rust engine in its no-op line. `gbrain upgrade` reaches the same runner (upgrade.ts starts `gbrain post-upgrade`, which
 *    calls applyMigrations in process).
 * 2. Fails on: the migration lock opening a Rust brain for the run (the parent then owns it, and the smoke child
 *    waits on an owner that is blocked in the synchronous spawn: `owner_unavailable`); repair-jsonb treating a Rust
 *    brain as Postgres (`No database URL`); a named stop below that starts passing (drop its row) or refuses for
 *    another reason.
 * 3. Existing coverage: test/apply-migrations-pglite-spawn.test.ts runs the chain on PGLite only; nothing ran an
 *    upgrade migration on a Rust brain.
 * 4. Seam: none. It runs the real CLI (`src/cli.ts`, one child per command) and needs the addon `bun run rust:build`
 *    writes; it skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 *
 * The named stops: upgrade migrations that still refuse on a Rust brain, each by the member and capability it needs
 * and the work that owns it. Each row must refuse exactly so; a row that passes or refuses otherwise fails the test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { acquireMigrationOrchestrationLock } from '../src/core/migration-orchestration-lock.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' || process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1')) {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

type Backend = 'pglite' | 'rust';
interface Brain { backend: Backend; home: string; db: string }
interface Run { exitCode: number; out: string }

/** Upgrade migrations that still refuse on a Rust brain: the phase that stops, the member and capability, the owner. */
const STOPS: ReadonlyArray<{ version: string; phase: string; member: string; capability: string; owner: string }> = [
  { version: '0.14.0', phase: 'schema', member: 'executeRaw', capability: 'raw_sql', owner: 'rust-engine apply-migrations item 2 (old SQL repairs on a Rust store)' },
  { version: '0.16.0', phase: 'verify', member: 'executeRaw', capability: 'raw_sql', owner: 'rust-engine apply-migrations item 2 (old SQL repairs on a Rust store)' },
  { version: '0.18.0', phase: 'backfill_storage', member: 'executeRaw', capability: 'raw_sql', owner: 'rust-engine apply-migrations item 2 (old SQL repairs on a Rust store)' },
  { version: '0.28.0', phase: 'schema', member: 'executeRaw', capability: 'raw_sql', owner: 'rust-engine apply-migrations item 2 (old SQL repairs on a Rust store)' },
  { version: '0.29.1', phase: 'backfill_effective_date', member: 'executeRaw', capability: 'raw_sql', owner: 'rust-engine apply-migrations item 2 (old SQL repairs on a Rust store)' },
  { version: '0.31.0', phase: 'schema', member: 'executeRaw', capability: 'raw_sql', owner: 'rust-engine apply-migrations item 2 (old SQL repairs on a Rust store)' },
  { version: '0.32.2', phase: 'schema', member: 'executeRaw', capability: 'raw_sql', owner: 'rust-engine apply-migrations item 2 (old SQL repairs on a Rust store)' },
  { version: '0.60.31', phase: 'credential_projection', member: 'executeRaw', capability: 'raw_sql', owner: 'managed-mode / owner-write work (runs once; a swapped brain has it recorded)' },
];

let root = '';
const brains = {} as Record<Backend, Brain>;

function childEnv(brain: Brain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key];
  }
  return {
    ...out,
    // The orchestrators start `gbrain ...` children by name; the shim runs this checkout's CLI.
    PATH: `${join(root, 'bin')}:${out.PATH ?? ''}`,
    HOME: brain.home,
    GBRAIN_HOME: brain.home,
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0',
    TZ: 'UTC',
    ...(brain.backend === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

async function cli(brain: Brain, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: childEnv(brain), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, out: stdout + stderr };
}

function makeBrain(backend: Backend): Brain {
  const home = join(root, backend, 'home');
  const db = join(root, backend, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: backend, database_path: db }));
  return { backend, home, db };
}

const migrate = (brain: Brain, version: string) => cli(brain, ['apply-migrations', '--migration', version, '--yes', '--non-interactive']);

/** The phases the ledger recorded for `version` on this brain, by name. */
function recordedPhases(brain: Brain, version: string): Record<string, string> {
  const ledger = join(brain.home, '.gbrain', 'migrations', 'completed.jsonl');
  const rows = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { version: string; phases?: Array<{ name: string; status: string }> });
  const row = rows.filter(r => r.version === version).at(-1);
  return Object.fromEntries((row?.phases ?? []).map(p => [p.name, p.status]));
}

/**
 * Phase B's lines of a v0.11.0 run: what the smoke child printed, between the migration banner and Phase C's mode line,
 * with the engine name and the elapsed seconds made common. The smoke prints a two-line note about the `jobs work`
 * daemon on PGLite only (src/commands/jobs/smoke.ts); that note is the engine's own and is set aside here.
 */
function phaseBLines(out: string): string[] {
  const lines = out.split('\n');
  const start = lines.findIndex(l => l.startsWith('=== Applying migration v0.11.0'));
  const end = lines.findIndex(l => l.startsWith('Defaulting minion_mode='));
  return lines.slice(start + 1, end)
    .filter(l => !l.startsWith('Note: the `gbrain jobs work` daemon requires Postgres.') && l !== 'supports inline execution only (`submit --follow`).')
    .map(l => l.replace(/in \d+(\.\d+)?s \(engine: (pglite|rust)\)/, 'in <s>s (engine: <engine>)'));
}

const describeRust = HAVE_ADDON ? describe : describe.skip;

describeRust('apply-migrations on a Rust brain', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-apply-migrations-rust-'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'gbrain'), `#!/bin/sh\nexec bun run ${CLI} "$@"\n`);
    chmodSync(join(root, 'bin', 'gbrain'), 0o755);
    for (const backend of ['pglite', 'rust'] as const) {
      brains[backend] = makeBrain(backend);
      const init = await cli(brains[backend], ['init', '--migrate-only']);
      expect({ backend, exitCode: init.exitCode, out: init.exitCode === 0 ? '' : init.out }).toEqual({ backend, exitCode: 0, out: '' });
    }
  }, 600_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  // Value: protects=v0.11.0's smoke child runs on a Rust brain with nothing holding the brain, and prints PGLite's lines; fails_when=the migration lock keeps the brain open for the run (the child fails owner_unavailable); why_new=no upgrade migration ran on a Rust brain; seam=none; no_claim=the other v0.11.0 phases' engine-specific lines
  test('v0.11.0: Phase B (gbrain jobs smoke) passes on Rust and prints what it prints on PGLite', async () => {
    const pglite = await migrate(brains.pglite, '0.11.0');
    const rust = await migrate(brains.rust, '0.11.0');
    expect(pglite.exitCode).toBe(0);
    expect({ exitCode: rust.exitCode, owner_unavailable: rust.out.includes('owner_unavailable') }).toEqual({ exitCode: 0, owner_unavailable: false });
    expect(recordedPhases(brains.rust, '0.11.0').smoke).toBe('complete');
    expect(phaseBLines(rust.out)).toEqual(phaseBLines(pglite.out));
    expect(phaseBLines(rust.out)).toContain('SMOKE PASS — Minions healthy in <s>s (engine: <engine>)');
  }, 300_000);

  // Value: protects=v0.12.2's repair-jsonb child, which has nothing to repair outside Postgres, completes on a Rust brain with PGLite's exact output; fails_when=repair-jsonb treats a Rust brain as Postgres (No database URL); why_new=no upgrade migration ran on a Rust brain; seam=none; no_claim=Postgres repairs
  test('v0.12.2: the JSONB repair completes on Rust with output byte-identical to PGLite', async () => {
    const pglite = await migrate(brains.pglite, '0.12.2');
    const rust = await migrate(brains.rust, '0.12.2');
    expect(pglite.exitCode).toBe(0);
    expect({ exitCode: rust.exitCode, out: rust.out }).toEqual({ exitCode: 0, out: pglite.out });
  }, 300_000);

  // Value: protects=`gbrain repair-jsonb` in text mode names the Rust engine and the no-op on a Rust brain, as it names PGLite's; fails_when=the renderer handles PGLite only and prints Engine: postgres for Rust; why_new=the Rust no-op is new; seam=none; no_claim=Postgres repairs
  test('repair-jsonb in text mode names the Rust engine and the no-op, with and without --dry-run', async () => {
    for (const flags of [[], ['--dry-run']]) {
      const pglite = await cli(brains.pglite, ['repair-jsonb', ...flags]);
      const rust = await cli(brains.rust, ['repair-jsonb', ...flags]);
      expect({ flags, exitCode: rust.exitCode, out: rust.out }).toEqual({ flags, exitCode: 0, out: pglite.out.replace('Engine: pglite', 'Engine: rust') });
      expect(rust.out).not.toContain('Engine: postgres');
    }
  }, 300_000);

  // Value: protects=a Rust brain's migration lock excludes a second runner, as PGLite's does: while one process holds it, apply-migrations exits 75 and names the holder, and runs nothing; fails_when=a Rust brain gets a no-op lock (two upgrades run at once); why_new=the Rust lock is new; seam=the lock is taken in this process through the real acquire; no_claim=recovery after a holder dies (the native lock's own tests)
  test('the migration lock on a Rust brain refuses a second runner (exit 75) while another process holds it', async () => {
    // The lock constructs the Rust engine first (not opened), so this process needs the addon the brain's CLI uses.
    const held = await withEnv({ GBRAIN_RUST_ENGINE_ADDON: ADDON }, () =>
      acquireMigrationOrchestrationLock({ engine: 'rust', database_path: brains.rust.db } as GBrainConfig));
    expect(held).not.toBeNull();
    try {
      const second = await migrate(brains.rust, '0.12.2');
      expect({ exitCode: second.exitCode, running: second.out.includes('another apply-migrations is running'), pid: second.out.includes(`pid ${process.pid}`) })
        .toEqual({ exitCode: 75, running: true, pid: true });
    } finally { await held!.release(); }
  }, 300_000);

  // Value: protects=a Rust brain whose addon is missing is refused before the run touches the migration ledger, as the old open did, so three failed runs never wedge v0.11.0; fails_when=the file lock admits the run before the engine is checked; why_new=the Rust lock no longer opens the brain; seam=GBRAIN_RUST_ENGINE_ADDON names a missing file; no_claim=which addon error code the loader picks
  test('a Rust brain with no addon is refused before any migration ledger write', async () => {
    const home = join(root, 'no-addon', 'home');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: join(root, 'no-addon', 'db') }));
    const brain: Brain = { backend: 'rust', home, db: join(root, 'no-addon', 'db') };
    const proc = Bun.spawn(['bun', 'run', CLI, 'apply-migrations', '--yes', '--non-interactive'], {
      cwd: root, env: { ...childEnv(brain), GBRAIN_RUST_ENGINE_ADDON: join(root, 'no-such-addon.node') }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).not.toBe(0);
    expect(out + err).not.toContain('Applying migration');
    expect(existsSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'))).toBe(false);
  }, 300_000);

  // Value: protects=each upgrade migration that still refuses on a Rust brain refuses with the typed raw_sql refusal of the phase named here, and a new pass or a different refusal is seen at once; fails_when=a stop starts passing (drop its row) or refuses for another reason; why_new=the stops are new; seam=none; no_claim=what the owners of these stops build
  test('named stops: each remaining upgrade migration refuses on Rust with the typed refusal of its named phase', async () => {
    const seen: Array<{ version: string; exitCode: number; refused: boolean }> = [];
    for (const stop of STOPS) {
      const run = await migrate(brains.rust, stop.version);
      const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const refusal = `This brain's engine does not support ${stop.member} yet (it needs the ${stop.capability} capability)`;
      const typed = new RegExp(`Migration v${esc(stop.version)} failed \\([^\\n]*${esc(stop.phase)}: [^\\n]*?${esc(refusal)}`);
      seen.push({ version: stop.version, exitCode: run.exitCode, refused: typed.test(run.out) });
    }
    expect(seen).toEqual(STOPS.map(s => ({ version: s.version, exitCode: 1, refused: true })));
  }, 900_000);
});
