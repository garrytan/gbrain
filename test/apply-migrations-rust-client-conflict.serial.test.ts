/**
 * `gbrain apply-migrations` run as a client of a Rust brain's serve, on a brain swapped from PGLite with a populated
 * content root.
 *
 * 1. Protects: while `gbrain serve` owns a swapped Rust brain, an upgrade's v0.53.0 rerun cannot read the Rust skill
 *    store (owner-only), so a source whose skill inventory changed cannot be checked. That run must exit 0, name the
 *    source, and never count toward the wedge counter (3 partial runs in a row), which would stop v0.53.0 for good
 *    and, on a brain with no later completed migration, fail every later upgrade with `migrations_pending`.
 * 2. Fails on: a client run that writes a v0.53.0 `partial` ledger row, reports the unreadable store as a conflict to
 *    settle, leaves v0.53.0 wedged, or exits non-zero.
 * 3. Existing coverage: test/apply-migrations-rust-swap.serial.test.ts upgrades a swapped brain with no content root
 *    and no serve; test/shared-skills-setup.test.ts keeps the reviewed inventory when the sealed read fails.
 * 4. Seam: the second and third cases rewrite the ledger file from the brain's own rows. It runs the real CLI
 *    (`src/cli.ts`, one child per command) and a real stdio `gbrain serve` as the brain's owner, and needs the addon
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
import { compareVersions } from '../src/core/migration-ledger.ts';

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
let serve: ReturnType<typeof Bun.spawn> | null = null;

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

async function cli(args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, out: stdout + stderr };
}

const useEngine = (engine: 'pglite' | 'rust') =>
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine, database_path: join(root, engine === 'rust' ? 'brain.rust' : 'brain.pglite') }));
const ledgerPath = () => join(home, '.gbrain', 'migrations', 'completed.jsonl');
/** The v0.53.0 rows of this brain's migration ledger, oldest first. */
const v053Rows = () => readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean)
  .map(line => JSON.parse(line) as { version: string; status: string }).filter(row => row.version === '0.53.0');
const expectOk = (args: string[], run: Run) =>
  expect({ args, exitCode: run.exitCode, out: run.exitCode === 0 ? '' : run.out }).toEqual({ args, exitCode: 0, out: '' });

/** Five upgrade runs as a client of the serve, each with its exit code and output. */
async function clientRuns(): Promise<Run[]> {
  const runs: Run[] = [];
  for (let i = 0; i < 5; i++) runs.push(await cli(['apply-migrations', '--yes', '--non-interactive']));
  return runs;
}
const OWNER_ONLY = "[shared-skills] team: owner_unavailable: this run is a client of the process that owns this Rust brain";
const SETTLE = 'that a person has to settle';
/** Rewrites the ledger from the swapped brain's own rows: without v0.53.0, and with later rows marked as fresh-install stamps when asked. */
function ledgerWith(opts: { dropV053: boolean; laterAsFreshInstall?: boolean }) {
  const rows = originalLedger.map(line => JSON.parse(line) as { version: string; status: string; fresh_install?: boolean })
    .filter(row => !(opts.dropV053 && row.version === '0.53.0'))
    .map(row => (opts.laterAsFreshInstall && row.status === 'complete' && compareVersions(row.version, '0.53.0') > 0 ? { ...row, fresh_install: true } : row));
  writeFileSync(ledgerPath(), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
let originalLedger: string[] = [];

/** v0.53.0's state in the run plan (`apply-migrations --list --json`): applied, partial, pending or wedged. */
async function planState(): Promise<string | undefined> {
  const run = await cli(['apply-migrations', '--list', '--json']);
  expect(run.exitCode).toBe(0);
  const doc = JSON.parse(run.out.slice(run.out.indexOf('{'))) as { migrations?: Array<{ version: string; status: string }> };
  return doc.migrations?.find(row => row.version === '0.53.0')?.status;
}

const describeRust = HAVE_ADDON ? describe : describe.skip;

describeRust('apply-migrations as a client of a swapped Rust brain\'s serve, with a populated content root', () => {
  beforeAll(async () => {
    // Resolved, so a symlinked temp dir (macOS /var) is not refused as a content root ancestor.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-rust-client-')));
    home = join(root, 'home');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'gbrain'), `#!/bin/sh\nexec bun run ${CLI} "$@"\n`);
    chmodSync(join(root, 'bin', 'gbrain'), 0o755);
    // A fully migrated PGLite brain, swapped to Rust (the same GBRAIN_HOME and ledger, a Rust store).
    useEngine('pglite');
    for (const args of [['init', '--migrate-only'], ['apply-migrations', '--yes', '--non-interactive']]) expectOk(args, await cli(args));
    useEngine('rust');
    expectOk(['init', '--migrate-only'], await cli(['init', '--migrate-only']));
    // A content source whose root holds the packaged skill pack; the owner's run saves its v0.53.0 inventory.
    const content = join(root, 'content');
    for (const [path, body] of Object.entries(packagedSharedSkills())) {
      mkdirSync(dirname(join(content, path)), { recursive: true });
      writeFileSync(join(content, path), body);
    }
    expectOk(['sources', 'add'], await cli(['sources', 'add', 'team', '--path', content, '--force']));
    const owner = await cli(['apply-migrations', '--yes', '--non-interactive']);
    expectOk(['apply-migrations (owner)'], owner);
    expect(owner.out).toContain('[shared-skills] team: writer_not_quiesced');
    // Only skillpack.json's bytes change, so the rerun must read the sealed pack to tell whether the edit is its own.
    const manifest = join(content, 'skillpack.json');
    writeFileSync(manifest, JSON.stringify(JSON.parse(readFileSync(manifest, 'utf8')), null, 4) + '\n');
    // gbrain serve owns the brain from here on; every CLI run below is its client.
    serve = Bun.spawn(['bun', 'run', CLI, 'serve'], { cwd: root, env: childEnv(), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    // The socket the owner binds: the store's path, or its short fallback when that path is too long for a socket.
    const socket = localIpcSocketPath(ownerSocketPath(join(root, 'brain.rust')));
    const deadline = Date.now() + 60_000;
    while (!existsSync(socket) && Date.now() < deadline) await Bun.sleep(250);
    expect(existsSync(socket)).toBe(true);
    originalLedger = readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean);
  }, 900_000);
  afterAll(async () => {
    if (serve) { serve.kill(); await serve.exited; }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // Value: protects=an upgrade while a serve owns a swapped Rust brain names the owner-only check and writes no ledger row; fails_when=a client run exits non-zero, writes a v0.53.0 row or reports the unreadable store as a conflict; why_new=no test ran an upgrade as a Rust serve's client; seam=none; no_claim=skill adoption on Rust (stops at writer_not_quiesced)
  test('v0.53.0 completed once: client runs exit 0, name the owner-only check, and write no ledger row', async () => {
    ledgerWith({ dropV053: false });
    const before = v053Rows();
    expect(before.some(row => row.status === 'complete')).toBe(true);
    for (const run of await clientRuns()) {
      expect({ exitCode: run.exitCode, ownerOnly: run.out.includes(OWNER_ONLY), settle: run.out.includes(SETTLE) }).toEqual({ exitCode: 0, ownerOnly: true, settle: false });
    }
    expect(v053Rows()).toEqual(before);
  }, 600_000);

  // Value: protects=a brain swapped before v0.53.0 ever completed is not wedged by client runs that could not read the owner-only store; fails_when=client runs append v0.53.0 partial rows until it is wedged; why_new=no test ran an upgrade as a Rust serve's client; seam=the ledger file is rewritten without v0.53.0's rows; no_claim=wedges a real conflict on the owner causes
  test('v0.53.0 never completed: five client runs write no partial row and never report a conflict to settle', async () => {
    ledgerWith({ dropV053: true });
    for (const run of await clientRuns()) {
      expect({ exitCode: run.exitCode, ownerOnly: run.out.includes(OWNER_ONLY), settle: run.out.includes(SETTLE) }).toEqual({ exitCode: 0, ownerOnly: true, settle: false });
    }
    expect(v053Rows().filter(row => row.status === 'partial')).toEqual([]);
    expect(await planState()).not.toBe('wedged');
  }, 600_000);

  // Value: protects=a brain whose later migrations are fresh-install stamps keeps exiting 0 as a client; fails_when=the fourth client run fails migrations_pending (reason wedged) because no later migration really completed; why_new=no test ran an upgrade as a Rust serve's client; seam=the ledger file is rewritten without v0.53.0's rows and with later rows as fresh-install stamps; no_claim=a brain gbrain init made at this version (it stamps v0.53.0 complete)
  test('no later migration really completed: five client runs all exit 0', async () => {
    ledgerWith({ dropV053: true, laterAsFreshInstall: true });
    const runs = await clientRuns();
    expect(runs.map(run => run.exitCode)).toEqual([0, 0, 0, 0, 0]);
    expect(runs.some(run => run.out.includes('migrations_pending'))).toBe(false);
  }, 600_000);
});
