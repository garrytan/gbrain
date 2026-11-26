/**
 * `gbrain init` and `gbrain apply-migrations` on a Rust-engine brain run no SQL schema migration (v335 included). Init refuses
 * nothing; apply-migrations runs the upgrade chain (PR 10319) and stops at the first named raw SQL stop, v0.14.0.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: a Rust brain upgrades and re-inits without a raw-SQL refusal. Schema migrations (src/core/migrate.ts) run
 *    only from the SQL engines' initSchema; the Rust store creates its tables when it opens, and its initSchema
 *    (rust-engine/store-members/init-schema.ts) seeds the embedding rows only. Migration v335 reads the server encoding
 *    with raw SQL (`SHOW server_encoding`, slug-spelling-key.ts serverEncoding) and builds an index; on a Rust brain
 *    that would stop the command on the typed raw_sql refusal.
 * 2. Fails when: init exits non-zero on a Rust brain, or either command prints a capability refusal or the v335 notice.
 * 3. Existing coverage: test/rust-cli-parity.serial.test.ts runs read commands and doctor on a Rust brain; no test runs
 *    init on an existing Rust brain or apply-migrations there.
 * 4. Seams: the real CLI entry (src/cli.ts, one child process per command) on a temp GBRAIN_HOME. It needs the addon
 *    `bun run rust:build` writes; it skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON
  || (TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '');
const HAVE_ADDON = !!ADDON && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

interface Run { exitCode: number; stdout: string; stderr: string }
let home = '';

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key];
  }
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0',
    TZ: 'UTC', GBRAIN_RUST_ENGINE_ADDON: ADDON };
}

async function cli(args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: home, env: env(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

/** What a run must not show: a non-zero exit, a capability refusal, or the v335 migration's own notice. */
const outcome = (run: Run) => ({
  exitCode: run.exitCode,
  refused: /engine_capability_missing|raw_sql/.test(run.stdout + run.stderr),
  v335: /\[335\]|idx_pages_spelling_key/.test(run.stdout + run.stderr),
  detail: run.exitCode === 0 ? '' : (run.stderr || run.stdout).slice(0, 600),
});

describe.skipIf(!HAVE_ADDON)('schema migration commands on a Rust brain', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gb-rust-migrate-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: join(home, 'db') }));
  });
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  test('init on the existing Rust brain refuses nothing, and apply-migrations runs no SQL schema migration and stops only at the named v0.14.0 raw SQL stop', async () => {
    const ok = { exitCode: 0, refused: false, v335: false, detail: '' };
    // The first command opens the store, which creates its tables.
    expect({ step: 'init', ...outcome(await cli(['init', '--non-interactive', '--json'])) }).toEqual({ step: 'init', ...ok });
    // apply-migrations runs no SQL schema migration (no v335 step). Since PR 10319 it takes its lock from a file beside the
    // brain and runs the upgrade chain on a Rust brain; the chain stops at the first migration whose phase still needs raw
    // SQL, v0.14.0 (test/apply-migrations-rust-owner.serial.test.ts pins every such named stop). So it must refuse by that
    // typed raw_sql refusal and by nothing earlier, and never reach v335. Its exit code is 1 for that stop.
    const applied = await cli(['apply-migrations', '--yes', '--no-autopilot-install']);
    const text = applied.stdout + applied.stderr;
    expect({ step: 'apply-migrations', exitCode: applied.exitCode, v335: outcome(applied).v335, stoppedAtV0140: /Migration v0\.14\.0 failed \(schema: [^\n]*raw_sql capability/.test(text), earlierStop: /Migration v0\.(?:1[0-3]\.\d+|[0-9]\.\d+) failed/.test(text) })
      .toEqual({ step: 'apply-migrations', exitCode: 1, v335: false, stoppedAtV0140: true, earlierStop: false });
    expect({ step: 'init again', ...outcome(await cli(['init', '--non-interactive', '--json'])) }).toEqual({ step: 'init again', ...ok });
  }, 300_000);
});
