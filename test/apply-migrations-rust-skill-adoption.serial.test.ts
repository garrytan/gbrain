/**
 * The v0.53.0 shared-content migration adopts a source's skill pack on a brain swapped from PGLite to Rust.
 *
 * 1. Protects: on a swapped Rust brain, `gbrain sources writer activate --shared-skills` with the reviewed
 *    --expected-state turns shared skills on (a stale state refuses and writes nothing; a run while gbrain serve owns
 *    the brain refuses owner_unavailable and writes nothing). An upgrade's v0.53.0 rerun then adopts the content
 *    root's pack into the Rust skill store, a second run changes nothing, and a later local edit to a skill file is
 *    kept and reported as a conflict, never overwritten.
 * 2. Fails on: a reviewed activation that refuses engine_capability_missing, a Rust brain that stops at
 *    writer_not_quiesced after activation (the brain singleton reports skill sharing off), stops at
 *    writer_registration_required (the SQL worktree binding a Rust brain never has), or exits 1 on adoption's
 *    capability refusal.
 * 3. Existing coverage: test/apply-migrations-rust-swap.serial.test.ts upgrades a swapped brain with no content root;
 *    test/apply-migrations-rust-client-conflict.serial.test.ts runs the upgrade as a client of a serve.
 * 4. Seam: none for the steps under test; a child process reads the sealed pack from the Rust store to check it. It
 *    runs the real CLI (`src/cli.ts`, one child per command) and a real stdio `gbrain serve`, and needs the addon
 *    `bun run rust:build` writes; it skips without it (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { localIpcSocketPath } from '../src/core/context/ipc-path.ts';
import { ownerSocketPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { packagedSharedSkills } from '../src/core/shared-skills/setup-bundle.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1' || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1')) {
  throw new Error(`GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

interface Run { exitCode: number; out: string }

let root = '';
let home = '';
let content = '';

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key];
    if (/^(OPENCLAW_|HERMES_)/.test(key)) delete out[key];
  }
  return {
    ...out,
    PATH: `${join(root, 'bin')}:${out.PATH ?? ''}`,
    HOME: home,
    GBRAIN_HOME: home,
    // Harness config dirs win over HOME; point them into the fixture so nothing touches the caller's.
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'),
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0',
    TZ: 'UTC',
    GBRAIN_RUST_ENGINE_ADDON: ADDON,
  };
}

async function spawn(cmd: string[]): Promise<Run> {
  const proc = Bun.spawn(cmd, { cwd: root, env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, out: stdout + stderr };
}
const cli = (args: string[]) => spawn(['bun', 'run', CLI, ...args]);
const expectOk = (args: string[], run: Run) =>
  expect({ args, exitCode: run.exitCode, out: run.exitCode === 0 ? '' : run.out }).toEqual({ args, exitCode: 0, out: '' });
const useEngine = (engine: 'pglite' | 'rust') =>
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine, database_path: join(root, engine === 'rust' ? 'brain.rust' : 'brain.pglite') }));
const upgrade = () => cli(['apply-migrations', '--yes', '--non-interactive']);

/** Runs `body` in a child process against the Rust brain, with `engine` open, and returns what it prints. */
async function withRustBrain(body: string): Promise<Run> {
  const script = `
    import { createEngine } from ${JSON.stringify(join(ROOT, 'src/core/engine-factory.ts'))};
    import { rustHeads, rustPack, rustSource } from ${JSON.stringify(join(ROOT, 'src/core/shared-skills/rust-publication.ts'))};
    const config = { engine: 'rust', database_path: ${JSON.stringify(join(root, 'brain.rust'))} };
    const engine = await createEngine(config);
    await engine.connect(config);
    try { ${body} } finally { await engine.disconnect(); }`;
  const file = join(root, 'child.ts');
  writeFileSync(file, script);
  return spawn(['bun', 'run', file]);
}
/** The admin_state `gbrain sources writer status --json` prints for review. */
async function reviewedState(): Promise<string> {
  const run = await cli(['sources', 'writer', 'status', '--json']);
  expect(run.exitCode).toBe(0);
  return (JSON.parse(run.out.slice(run.out.indexOf('{'))) as { admin_state: string }).admin_state;
}
const activate = (state: string) => cli(['sources', 'writer', 'activate', '--shared-skills', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', state, '--json']);
const errorCode = (run: Run) => /"code":\s*"([a-z_]+)"/.exec(run.out)?.[1];
/** The team source's sealed pack in the Rust store: its manifest hash and each live head's SKILL.md hash. */
async function sealedTeamPack(): Promise<{ manifest_hash: string | null; skills: Record<string, string> }> {
  const run = await withRustBrain(`
    const source = await rustSource(engine, 'team');
    const pack = await rustPack(engine, 'team', source.incarnation);
    const heads = pack ? await rustHeads(engine, 'team', source.incarnation, pack.pack_id, ['brain-router', 'memory-care', 'memory-recall']) : [];
    console.log(JSON.stringify({ manifest_hash: pack?.manifest_hash ?? null, skills: Object.fromEntries(heads.filter(head => !head.deleted)
      .map(head => [head.name, head.files.find(file => file.path === 'skills/' + head.name + '/SKILL.md')?.sha256])) }));`);
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.out.trim().split('\n').at(-1)!);
}
const sha256 = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');

const describeRust = HAVE_ADDON ? describe : describe.skip;

describeRust('v0.53.0 adopts a content root\'s skill pack on a brain swapped to Rust', () => {
  beforeAll(async () => {
    // Resolved, so a symlinked temp dir (macOS /var) is not refused as a content root ancestor.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-rust-adopt-')));
    home = join(root, 'home');
    content = join(root, 'content');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'gbrain'), `#!/bin/sh\nexec bun run ${CLI} "$@"\n`);
    chmodSync(join(root, 'bin', 'gbrain'), 0o755);
    // A fully migrated PGLite brain, swapped to Rust (the same GBRAIN_HOME and ledger, a Rust store).
    useEngine('pglite');
    for (const args of [['init', '--migrate-only'], ['apply-migrations', '--yes', '--non-interactive']]) expectOk(args, await cli(args));
    useEngine('rust');
    expectOk(['init', '--migrate-only'], await cli(['init', '--migrate-only']));
    for (const [path, body] of Object.entries(packagedSharedSkills())) {
      mkdirSync(dirname(join(content, path)), { recursive: true });
      writeFileSync(join(content, path), body);
    }
    expectOk(['sources', 'add'], await cli(['sources', 'add', 'team', '--path', content, '--force']));
    // Before activation the source waits for it, as on a SQL brain.
    const before = await upgrade();
    expectOk(['apply-migrations (before activation)'], before);
    expect(before.out).toContain('[shared-skills] team: writer_not_quiesced');
  }, 900_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  // Value: protects=a reviewed activation run while gbrain serve owns the Rust brain refuses owner_unavailable and writes nothing; fails_when=the client activates, refuses with another code or changes the admin state; why_new=no test activated shared skills on a Rust brain from a client; seam=none; no_claim=PGLite has no client mode, so this step has no PGLite twin
  test('while gbrain serve owns the brain, a reviewed activation refuses owner_unavailable and writes nothing', async () => {
    const state = await reviewedState();
    const serve = Bun.spawn(['bun', 'run', CLI, 'serve'], { cwd: root, env: childEnv(), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    try {
      const socket = localIpcSocketPath(ownerSocketPath(join(root, 'brain.rust')));
      const deadline = Date.now() + 60_000;
      while (!existsSync(socket) && Date.now() < deadline) await Bun.sleep(250);
      expect(existsSync(socket)).toBe(true);
      const run = await activate(state);
      expect({ exitCode: run.exitCode, code: errorCode(run) }).toEqual({ exitCode: 1, code: 'owner_unavailable' });
    } finally { serve.kill(); await serve.exited; }
    expect(await reviewedState()).toBe(state);
    expect((await upgrade()).out).toContain('[shared-skills] team: writer_not_quiesced');
  }, 600_000);

  // Value: protects=a stale --expected-state refuses as on PGLite and writes nothing; fails_when=it activates or refuses another code; why_new=a reviewed activation never ran on a Rust brain; seam=none; no_claim=none
  test('a stale --expected-state refuses writer_admin_state_changed and writes nothing', async () => {
    const state = await reviewedState();
    const run = await activate('0'.repeat(64));
    expect({ exitCode: run.exitCode, code: errorCode(run) }).toEqual({ exitCode: 1, code: 'writer_admin_state_changed' });
    expect(await reviewedState()).toBe(state);
  }, 600_000);

  // Value: protects=the reviewed --expected-state activates shared skills on a swapped Rust brain; fails_when=it refuses engine_capability_missing; why_new=a reviewed activation never ran on a Rust brain; seam=none; no_claim=none
  test('the reviewed --expected-state activates shared skills', async () => {
    const run = await activate(await reviewedState());
    expectOk(['sources writer activate --shared-skills'], run);
    expect(run.out).toContain('"activated": true');
  }, 600_000);

  // Value: protects=an activated swapped Rust brain adopts its content root's pack on upgrade; fails_when=the source stops at writer_not_quiesced or writer_registration_required after activation, or the run exits non-zero; why_new=no test adopted a pack on a Rust brain through the migration; seam=the sealed pack is read back in a child process; no_claim=client follow approval and native activation (the members stage stays pending)
  test('after activation, the upgrade adopts the pack and a second upgrade changes nothing', async () => {
    expect(await sealedTeamPack()).toEqual({ manifest_hash: null, skills: {} });
    const first = await upgrade();
    expectOk(['apply-migrations (adopt)'], first);
    expect(first.out).not.toContain('[shared-skills] team: writer_not_quiesced');
    expect(first.out).not.toContain('[shared-skills] team: writer_registration_required');
    // The pack the content root holds is now the sealed publication in the Rust store, skill by skill.
    const names = ['brain-router', 'memory-care', 'memory-recall'];
    const expected = { manifest_hash: sha256(join(content, 'skillpack.json')),
      skills: Object.fromEntries(names.map(name => [name, sha256(join(content, 'skills', name, 'SKILL.md'))])) };
    expect(await sealedTeamPack()).toEqual(expected);
    const files = Object.fromEntries(Object.keys(packagedSharedSkills()).map(path => [path, readFileSync(join(content, path), 'utf8')]));
    expectOk(['apply-migrations (rerun)'], await upgrade());
    for (const [path, body] of Object.entries(files)) expect(readFileSync(join(content, path), 'utf8')).toBe(body);
    expect(await sealedTeamPack()).toEqual(expected);
  }, 600_000);

  // Value: protects=a local edit to an adopted skill on a Rust brain is kept and reported, never overwritten; fails_when=the upgrade rewrites the edited file or exits non-zero; why_new=no test edited an adopted skill on a Rust brain; seam=none; no_claim=reviewed acceptance of the edit
  test('a later local edit to a skill file is kept and reported as a conflict', async () => {
    const skill = Object.keys(packagedSharedSkills()).find(path => path.endsWith('/SKILL.md'))!;
    writeFileSync(join(content, skill), 'Local instructions\n');
    const run = await upgrade();
    expectOk(['apply-migrations (after edit)'], run);
    expect(run.out).toContain(`[shared-skills] team: Files changed since migration inventory`);
    expect(readFileSync(join(content, skill), 'utf8')).toBe('Local instructions\n');
  }, 600_000);
});
