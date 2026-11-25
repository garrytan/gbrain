/**
 * `gbrain apply-migrations` and `gbrain post-upgrade` on a brain swapped from PGLite to Rust.
 *
 * 1. Protects: a user who swaps a fully migrated PGLite brain to the Rust engine and then upgrades gets exit 0 from
 *    `gbrain apply-migrations --yes` and from `gbrain post-upgrade`. On a swapped brain every upgrade migration is
 *    already recorded, so the only one that runs is v0.53.0 (the shared-content migration, which rechecks every source
 *    on every run); its output on the Rust brain equals its output on the PGLite brain it came from.
 * 2. Fails on: v0.53.0 reading the source list, the sealed pack or its heads through raw SQL on a Rust brain (the
 *    typed `raw_sql` refusal: "This brain's engine does not support executeRaw yet"); any other upgrade step that
 *    stops a swapped brain's upgrade.
 * 3. Existing coverage: test/apply-migrations-rust-owner.serial.test.ts runs single migrations on a new Rust brain and
 *    pins v0.53.0 as a named stop; nothing ran an upgrade on a swapped brain.
 * 4. Seam: none. It runs the real CLI (`src/cli.ts`, one child per command) and needs the addon `bun run rust:build`
 *    writes; it skips without it (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 makes a missing addon an error).
 *
 * The swap here is the config switch: the same GBRAIN_HOME (and so the same migration ledger) with `engine: rust`
 * and a Rust store. Seeding the store from the PGLite brain does not change which migrations the ledger runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

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
    // Harness config dirs win over HOME; point them into the fixture so post-upgrade never touches the caller's.
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

/** The lines of one migration's run: from its banner to the next banner or the end, with the store path made common. */
function stepLines(out: string, version: string): string[] {
  const lines = out.split('\n');
  const start = lines.findIndex(l => l.startsWith(`=== Applying migration v${version}`));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l.startsWith('=== Applying migration v'));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))]
    .map(l => l.split(root).join('<root>'))
    .filter(l => l.trim() !== '');
}

const describeRust = HAVE_ADDON ? describe : describe.skip;

describeRust('an upgrade on a brain swapped from PGLite to Rust', () => {
  let pgliteStep: string[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-rust-swap-'));
    home = join(root, 'home');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'gbrain'), `#!/bin/sh\nexec bun run ${CLI} "$@"\n`);
    chmodSync(join(root, 'bin', 'gbrain'), 0o755);
    useEngine('pglite');
    for (const args of [['init', '--migrate-only'], ['apply-migrations', '--yes', '--non-interactive']]) {
      const run = await cli(args);
      expect({ args, exitCode: run.exitCode, out: run.exitCode === 0 ? '' : run.out }).toEqual({ args, exitCode: 0, out: '' });
    }
    // The fully migrated PGLite brain's own v0.53.0 rerun: the reference for the same step after the swap.
    const reference = await cli(['apply-migrations', '--yes', '--non-interactive']);
    expect(reference.exitCode).toBe(0);
    pgliteStep = stepLines(reference.out, '0.53.0');
    useEngine('rust');
    const init = await cli(['init', '--migrate-only']);
    expect({ exitCode: init.exitCode, out: init.exitCode === 0 ? '' : init.out }).toEqual({ exitCode: 0, out: '' });
  }, 900_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  // Value: protects=apply-migrations on a swapped brain exits 0 and its one migration (v0.53.0) prints what it prints on the PGLite brain it came from; fails_when=v0.53.0 reads sources, the sealed pack or its heads through raw SQL on Rust; why_new=no upgrade ran on a swapped brain; seam=none; no_claim=the other upgrade migrations, which a swapped brain has recorded
  test('apply-migrations exits 0, and the v0.53.0 step equals the PGLite brain\'s', async () => {
    const run = await cli(['apply-migrations', '--yes', '--non-interactive']);
    expect({ exitCode: run.exitCode, raw_sql: run.out.includes('does not support executeRaw') }).toEqual({ exitCode: 0, raw_sql: false });
    expect(pgliteStep.length).toBeGreaterThan(0);
    expect(stepLines(run.out, '0.53.0')).toEqual(pgliteStep);
  }, 300_000);

  // Value: protects=gbrain upgrade's post-upgrade step exits 0 on a swapped brain; fails_when=its in-process apply-migrations (upgrade.ts) stops on v0.53.0 or any later post-upgrade step refuses on Rust; why_new=no upgrade ran on a swapped brain; seam=none; no_claim=the binary swap itself
  test('post-upgrade exits 0', async () => {
    const run = await cli(['post-upgrade']);
    expect({ exitCode: run.exitCode, migration_failed: run.out.includes('migration_failed') }).toEqual({ exitCode: 0, migration_failed: false });
  }, 600_000);
});
