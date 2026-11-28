/**
 * Postgres twin of test/shadow-write-compare.test.ts: the preimage read, the scratch replay with the real addon, the counts that
 * must never be comparable and the promise that the pilot never changes a primary write (scenarios in
 * test/helpers/shadow-write-compare-scenarios.ts), from a real Postgres primary. Needs DATABASE_URL and the addon
 * `bun run rust:build` writes for the replay scenarios; skips without a database (a missing addon skips only the replay,
 * and GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes it an error).
 *
 * The last block runs the real `gbrain serve` over MCP stdio with write sampling on, sends a burst of page writes, then
 * closes the session the way an MCP client does (stdin ends, SIGTERM 2 s later).
 * 1. Protects: every write sample the serving process owed the shadow child reaches the child before the serving process
 *    exits, so the write tally books none as `uncomparable/pipe_unflushed` or `capability_missing/pipe_unflushed_nonqualifying`.
 * 2. Regression it catches: a child that saves its tally once per sample falls behind a burst, the samples pile up in the
 *    serving process's pipe buffer, and the process exits before the pipe drains; or an exit drain that gives up early.
 * 3. Existing coverage drives the supervisor and the child with fakes or in process; none runs a serve session whose exit
 *    races a backlog in a real pipe.
 * 4. No production seam: it uses only the CLI, the MCP SDK client and the status JSON.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { loadRustAddon, type RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { defineFenceNegatives, defineWriteCompareScenarios } from '../helpers/shadow-write-compare-scenarios.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let addon: RustAddon | undefined;
const dirs: string[] = [];

(hasDatabase() ? describe : describe.skip)('write comparisons on Postgres', () => {
  beforeAll(async () => {
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    if (HAVE_ADDON) addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => {
    await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  defineWriteCompareScenarios({
    primary: () => engine, reset: async () => {}, kind: 'postgres',
    tempDir: () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-write-compare-pg-')); dirs.push(dir); return dir; },
    ...(HAVE_ADDON ? { addon: () => addon!, addonPath: BUILT } : {}),
  });
  defineFenceNegatives({
    primary: () => engine, reset: async () => {}, kind: 'postgres',
    tempDir: () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-write-compare-pg-')); dirs.push(dir); return dir; },
    ...(HAVE_ADDON ? { addon: () => addon!, addonPath: BUILT } : {}),
  });
});

const ROOT = join(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const PAGES = 60;

(hasDatabase() && HAVE_ADDON ? describe : describe.skip)('write samples across an MCP stdio serve exit on Postgres', () => {
  let home = '';
  let env: Record<string, string> = {};
  let database = '';
  let admin: ReturnType<typeof postgres> | undefined;
  const cli = (args: string[]) => spawnSync('bun', ['--no-env-file', CLI, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
  const status = (): Record<string, any> => {
    const r = cli(['engine', 'shadow', 'status', '--json']);
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL!;
    assertSafeE2eDatabaseUrl(base);
    database = `gbrain_test_serve_drain_${randomUUID().replace(/-/g, '')}`;
    admin = postgres(base, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = new URL(base); url.pathname = `/${database}`;
    home = mkdtempSync(join(tmpdir(), 'gbrain-serve-drain-'));
    env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_RUST_ENGINE_ADDON: BUILT });
    const init = cli(['init', '--url', url.toString(), '--no-embedding', '--non-interactive', '--db-only']);
    expect(init.status).toBe(0);
    expect(cli(['engine', 'shadow', 'seed']).status).toBe(0);
    const plan = cli(['engine', 'shadow', 'start', '--plan', '--write-sample-rate', '1']);
    const hash = /plan_hash:?\s+(\S+)/.exec(plan.stdout + plan.stderr)?.[1];
    expect(hash).toBeTruthy();
    expect(cli(['engine', 'shadow', 'start', '--yes', '--expect', hash!, '--write-sample-rate', '1']).status).toBe(0);
  }, 300_000);

  afterAll(async () => {
    if (home) cli(['engine', 'shadow', 'stop', '--delete']);
    if (admin) { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {}); await admin.end(); }
    if (home) rmSync(home, { recursive: true, force: true });
  }, 120_000);

  test('a burst of page writes then a client close loses no owed write sample', async () => {
    const dir = String(status().directory);
    const log = openSync(join(home, 'serve.log'), 'a');
    const transport = new StdioClientTransport({ command: 'bun', args: ['--no-env-file', CLI, 'serve'], cwd: ROOT, env, stderr: log });
    const client = new Client({ name: 'gbrain-serve-drain-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      for (let i = 0; i < PAGES; i++) {
        const content = `---\ntitle: Drain ${i}\ntype: concept\ntags: [drain]\n---\n\n# Drain ${i}\n\nA placeholder page. See [[drain/page-${(i + 1) % PAGES}]].\n\n## Timeline\n\n- **2026-03-01** | placeholder event ${i}\n`;
        const r = await client.callTool({ name: 'put_page', arguments: { slug: `drain/page-${i}`, content } }) as { isError?: boolean };
        expect(r.isError ?? false).toBe(false);
      }
    } finally {
      await client.close().catch(() => {}); // ends stdin, then SIGTERM after 2 s and SIGKILL after 2 s more: what an MCP client does
      closeSync(log);
    }
    // The child settles the session's owed file at the end of its input and removes it.
    const owedLeft = () => readdirSync(dir).filter((f) => f.startsWith('write-owed.') || f.startsWith('write-pending.'));
    const until = Date.now() + 120_000;
    while (owedLeft().length && Date.now() < until) await Bun.sleep(500);
    const w = status().write_comparisons as Record<string, any>;
    const lost = {
      pipe_unflushed: w.uncomparable_by_reason?.pipe_unflushed ?? 0,
      pipe_unflushed_nonqualifying: w.capability_missing_by_family?.pipe_unflushed_nonqualifying ?? 0,
      line_unreadable: w.uncomparable_by_reason?.line_unreadable ?? 0,
      child_exit_deadline: w.uncomparable_by_reason?.child_exit_deadline ?? 0,
    };
    expect(lost).toEqual({ pipe_unflushed: 0, pipe_unflushed_nonqualifying: 0, line_unreadable: 0, child_exit_deadline: 0 });
    expect(owedLeft()).toEqual([]);
    expect(w.comparable).toBeGreaterThan(0);
  }, 300_000);
});
