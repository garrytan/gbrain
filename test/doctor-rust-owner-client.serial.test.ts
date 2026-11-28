/**
 * `gbrain doctor` and `doctor --fix` from a second process while `gbrain serve` owns a Rust brain
 * (docs/designs/RUST_ENGINE.md, "Maintenance path").
 *
 * Regression pin, not fail-first: this already passes on rust-engine/main 9063ea55b5. Doctor reaches a running Rust
 * owner as an owner-IPC engine client (src/core/rust-engine/owner-ipc/election.ts electOwner), not through an
 * administration request.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: beside a running serve, `doctor --json` and `doctor --fix --json` exit as they do with no owner, with the
 *    same check names and statuses; a `--fix` repair (the `stale_locks` dead-holder reap) runs in the owner's store,
 *    and the serve still owns the brain afterwards.
 *  - Regression: a doctor that refuses or waits on a live owner, falls back to filesystem-only checks (what PGLite
 *    does beside its serve), or opens a second store whose fixes the owner never sees.
 *  - Why existing coverage misses it: test/resident-owner-rust-delegates.test.ts covers the administration delegates
 *    with stand-in owners; test/rust-cli-parity.serial.test.ts runs doctor with no owner running.
 *  - Seam: none. Real CLI children (src/cli.ts), a real stdio `gbrain serve` as the owner, and the addon
 *    `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 *    The dead holder is a real child that takes the lock through the owner and is killed with SIGKILL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { localIpcSocketPath } from '../src/core/context/ipc-path.ts';
import { ownerSocketPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' || process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1')) {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

/** The lock a dead sync holder leaves; `doctor --fix` reaps it once the holder is gone for the takeover grace. */
const LOCK_ID = 'gbrain-sync:default';
/** db-lock.ts HOLDER_TAKEOVER_GRACE_MS (60 s) plus a margin: a younger dead holder is never reaped. */
const REAP_AGE_MS = 62_000;

interface Run { exitCode: number; stdout: string; stderr: string }
interface DoctorDoc { status: string; checks: Array<{ name: string; status: string; message?: string }> }

let root = '';
let home = '';
let store = '';
let serve: ReturnType<typeof Bun.spawn> | null = null;

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON|GBRAIN_SKILLS_DIR|OPENCLAW_WORKSPACE)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key];
  }
  return { ...out, HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'), GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0',
    TZ: 'UTC', GBRAIN_RUST_ENGINE_ADDON: ADDON };
}

async function run(cmd: string[]): Promise<Run> {
  const proc = Bun.spawn(cmd, { cwd: root, env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}
const cli = (args: string[]) => run(['bun', 'run', CLI, ...args]);

function doc(r: Run): DoctorDoc {
  const at = r.stdout.indexOf('{');
  if (at < 0) throw new Error(`doctor printed no JSON (exit ${r.exitCode}): ${r.stderr.slice(0, 2000)}`);
  return JSON.parse(r.stdout.slice(at)) as DoctorDoc;
}
/** Each check's name and status, sorted: what a second process must see the same with and without an owner. */
const shape = (d: DoctorDoc) => d.checks.map(c => `${c.name}=${c.status}`).sort();
const check = (d: DoctorDoc, name: string) => d.checks.find(c => c.name === name);

/** Lock ids in the brain's store, read by a child that opens the engine (a client of the serve while it runs). */
async function lockIds(): Promise<string[]> {
  const r = await run(['bun', 'run', join(root, 'locks.ts')]);
  expect({ exitCode: r.exitCode, stderr: r.exitCode === 0 ? '' : r.stderr }).toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as string[];
}

const engineChild = (body: string) => [
  `import { loadConfig, toEngineConfig } from ${JSON.stringify(join(ROOT, 'src/core/config.ts'))};`,
  `import { createEngine } from ${JSON.stringify(join(ROOT, 'src/core/engine-factory.ts'))};`,
  `import { tryAcquireDbLock, listLiveLocks, listStaleLocks } from ${JSON.stringify(join(ROOT, 'src/core/db-lock.ts'))};`,
  'const config = toEngineConfig(loadConfig()!);',
  'const engine = await createEngine(config);',
  'await engine.connect(config);',
  body,
].join('\n');

const describeRust = HAVE_ADDON ? describe : describe.skip;

describeRust('doctor from a second process while gbrain serve owns a Rust brain', () => {
  let solo: { plain: Run; fix: Run };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-doctor-rust-owner-')));
    home = join(root, 'home');
    store = join(root, 'brain.rust');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: store }));
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'alpha.md'), '---\ntitle: Alpha\ntype: note\n---\n# Alpha\nAlpha links to [[beta]].\n');
    writeFileSync(join(notes, 'beta.md'), '---\ntitle: Beta\ntype: note\n---\n# Beta\nBeta body.\n');
    writeFileSync(join(root, 'take-lock.ts'), engineChild(
      `const held = await tryAcquireDbLock(engine, ${JSON.stringify(LOCK_ID)}, 30);\nconsole.log(held ? 'held' : 'busy');\nprocess.kill(process.pid, 'SIGKILL');`));
    writeFileSync(join(root, 'locks.ts'), engineChild(
      'const ids = [...new Set([...(await listLiveLocks(engine, 30)), ...(await listStaleLocks(engine))].map(l => l.id))].sort();\nawait engine.disconnect();\nconsole.log(JSON.stringify(ids));'));
    for (const args of [['init', '--migrate-only'], ['import', notes, '--no-embed']]) {
      const r = await cli(args);
      expect({ args, exitCode: r.exitCode, stderr: r.exitCode === 0 ? '' : r.stderr }).toEqual({ args, exitCode: 0, stderr: '' });
    }
    // The baseline: no owner runs, so each doctor run takes the owner role itself.
    solo = { plain: await cli(['doctor', '--json']), fix: await cli(['doctor', '--fix', '--json']) };
    // gbrain serve owns the brain from here on; every CLI run below is its client.
    serve = Bun.spawn(['bun', 'run', CLI, 'serve'], { cwd: root, env: childEnv(), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    const socket = localIpcSocketPath(ownerSocketPath(store));
    const deadline = Date.now() + 60_000;
    while (!existsSync(socket) && Date.now() < deadline) await Bun.sleep(250);
    expect(existsSync(socket)).toBe(true);
  }, 600_000);

  afterAll(async () => {
    if (serve) { serve.kill(); await serve.exited; }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // Value: protects=doctor and doctor --fix beside a live Rust owner run every check with the same statuses and exit code as with no owner; fails_when=doctor refuses or waits on the owner, or falls back to filesystem-only checks; why_new=no test ran doctor beside a running Rust owner; seam=none; no_claim=the derived-index rebuild (not built)
  test('doctor --json and doctor --fix --json match a run with no owner', async () => {
    const plain = await cli(['doctor', '--json']);
    const fix = await cli(['doctor', '--fix', '--json']);
    expect(serve!.exitCode).toBeNull();
    for (const [owned, alone] of [[plain, solo.plain], [fix, solo.fix]] as const) {
      expect(owned.exitCode).toBe(alone.exitCode);
      const ownedDoc = doc(owned);
      expect(check(ownedDoc, 'connection')?.status).toBe('ok');
      expect(ownedDoc.status).toBe(doc(alone).status);
      expect(shape(ownedDoc)).toEqual(shape(doc(alone)));
    }
    expect(solo.plain.exitCode).toBe(0);
    expect(doc(solo.plain).checks.length).toBeGreaterThan(100);
  }, 600_000);

  // Value: protects=a doctor --fix repair made from a second process lands in the running owner's store; fails_when=doctor opens a store of its own, or the fix is skipped beside an owner; why_new=no test ran a doctor fix through a Rust owner; seam=none (a real child takes the lock through the owner and is SIGKILLed); no_claim=the derived-index rebuild (not built)
  test('doctor --fix reaps a dead holder\'s lock in the owner\'s store', async () => {
    const take = await run(['bun', 'run', join(root, 'take-lock.ts')]);
    expect(take.stdout.trim().split('\n').at(-1)).toBe('held');
    const takenAt = Date.now();
    expect(await lockIds()).toContain(LOCK_ID);
    // A dead holder younger than the takeover grace is never reaped (PID-reuse guard).
    await Bun.sleep(Math.max(0, takenAt + REAP_AGE_MS - Date.now()));
    const fix = await cli(['doctor', '--fix', '--json']);
    expect(fix.exitCode).toBe(solo.fix.exitCode);
    const stale = check(doc(fix), 'stale_locks');
    expect(stale?.status).toBe('ok');
    expect(stale?.message).toContain(`Reaped 1 dead-holder lock(s): ${LOCK_ID}.`);
    expect(await lockIds()).not.toContain(LOCK_ID);
    expect(serve!.exitCode).toBeNull();
  }, 600_000);
});
