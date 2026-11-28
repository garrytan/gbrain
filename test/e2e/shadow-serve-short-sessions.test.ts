/**
 * Short MCP stdio serve sessions and the shadow coverage watermark, on a real Postgres primary with the real addon.
 *
 * MCP clients start `gbrain serve` for a few seconds at a time. Each session must be able to finish a full reconcile
 * pass (or carry a clean one over from the session before it), so `engine shadow status` shows a valid coverage
 * watermark and clean full passes counting up. Without that the swap check stays at follower_behind for ever.
 * Carrying evidence over must fail closed: a write the follower never saw between two sessions (a line another
 * process left in follower-invalidations.jsonl, or a direct SQL write the writer hooks recorded) must not be trusted.
 *
 * Every session here is about 10 s long, well under the 60 s the reconciler used to wait before its first check.
 * Needs DATABASE_URL and the addon `bun run rust:build` writes; skips without either
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { hasDatabase } from './helpers.ts';

const ROOT = join(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const BUILT = join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const SESSION_MS = 10_000;

interface Pass { kind: string; started_at: string; finished_at?: string; repaired_rows?: number; error?: unknown }
interface Snapshot { valid: boolean; reason: string | null; through: string | null; clean: number; passes: Pass[] }

let home = '';
let dir = '';
let env: Record<string, string> = {};
let database = '';
let brainUrl = '';
let admin: ReturnType<typeof postgres> | undefined;

const cli = (args: string[], input?: string) => spawnSync('bun', ['--no-env-file', CLI, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000, input });

function snapshot(): Snapshot {
  const r = cli(['engine', 'shadow', 'status', '--json']);
  expect(r.status).toBe(0);
  const s = JSON.parse(r.stdout) as { directory: string; follower?: { coverage_watermark?: { valid: boolean; through: string | null; invalidated_reason: string | null } }; reconcile?: { consecutive_clean_full_passes?: number } };
  dir = s.directory;
  let passes: Pass[] = [];
  try { passes = readFileSync(join(dir, 'reconcile', 'passes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Pass); } catch { /* no pass yet */ }
  const w = s.follower?.coverage_watermark;
  return { valid: w?.valid === true, reason: w?.invalidated_reason ?? null, through: w?.through ?? null, clean: s.reconcile?.consecutive_clean_full_passes ?? 0, passes };
}

/** Full passes that started inside [from, to]. */
const fullPassesIn = (s: Snapshot, from: number, to: number): Pass[] =>
  s.passes.filter((p) => p.kind === 'full' && Date.parse(p.started_at) >= from && Date.parse(p.started_at) <= to);

/** Waits (bounded) until no shadow child for this brain is running, so follower.json holds what the session ended with. */
async function childGone(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    let running = false;
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let cmd = '';
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (cmd.includes('__child') && cmd.includes(dir)) { running = true; break; }
    }
    if (!running) return;
    await Bun.sleep(200);
  }
  throw new Error('the shadow child did not exit within 15 s of the serve session');
}

/** One MCP stdio serve session of about `ms`: connect, list pages (optionally write one), idle, close. */
async function serve(tag: string, o: { write?: boolean; ms?: number } = {}): Promise<{ from: number; to: number }> {
  const log = openSync(join(home, `serve-${tag}.log`), 'a');
  const transport = new StdioClientTransport({ command: 'bun', args: ['--no-env-file', CLI, 'serve'], cwd: ROOT, env, stderr: log });
  const client = new Client({ name: 'short-sessions', version: '1.0.0' }, { capabilities: {} });
  const from = Date.now();
  try {
    await client.connect(transport);
    if (o.write) await client.callTool({ name: 'put_page', arguments: { slug: `sessions/${tag}`, content: `---\ntitle: Session ${tag}\ntype: concept\n---\n\n# Session ${tag}\n\nbody\n` } });
    await client.callTool({ name: 'list_pages', arguments: {} });
    const left = (o.ms ?? SESSION_MS) - (Date.now() - from);
    if (left > 0) await Bun.sleep(left);
  } finally {
    await client.close().catch(() => undefined);
    closeSync(log);
  }
  await childGone();
  return { from, to: Date.now() };
}

const describeIf = hasDatabase() && HAVE_ADDON ? describe : describe.skip;

describeIf('short MCP serve sessions on Postgres', () => {
  beforeAll(async () => {
    const base = process.env.DATABASE_URL!;
    assertSafeE2eDatabaseUrl(base);
    database = `gbrain_test_short_sessions_${randomUUID().replace(/-/g, '')}`;
    admin = postgres(base, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = new URL(base);
    url.pathname = `/${database}`;
    brainUrl = url.toString();
    home = mkdtempSync(join(tmpdir(), 'gbrain-short-sessions-'));
    env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_RUST_ENGINE_ADDON: BUILT });
    expect(cli(['init', '--url', brainUrl, '--no-embedding', '--non-interactive', '--db-only']).status).toBe(0);
    expect(cli(['engine', 'shadow', 'seed']).status).toBe(0);
    const plan = cli(['engine', 'shadow', 'start', '--plan']);
    const hash = /plan_hash:?\s+(\S+)/.exec(plan.stdout + plan.stderr)?.[1];
    expect(hash).toBeDefined();
    expect(cli(['engine', 'shadow', 'start', '--yes', '--expect', hash!]).status).toBe(0);
    snapshot();
  }, 120_000);

  afterAll(async () => {
    if (home) cli(['engine', 'shadow', 'stop', '--delete']);
    if (admin) { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined); await admin.end(); }
    if (home) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('each short session reaches a valid watermark, and a quiet session keeps it without a new pass', async () => {
    const s1 = await serve('one');
    const a = snapshot();
    expect({ valid: a.valid, reason: a.reason }).toEqual({ valid: true, reason: null });
    expect(fullPassesIn(a, s1.from, s1.to).filter((p) => !p.error && (p.repaired_rows ?? 0) === 0).length).toBe(1);
    expect(a.clean).toBe(1);

    // Nothing wrote between the sessions and nothing in this one invalidated coverage: the clean evidence carries over.
    const s2 = await serve('two');
    const b = snapshot();
    expect({ valid: b.valid, reason: b.reason }).toEqual({ valid: true, reason: null });
    expect(fullPassesIn(b, s2.from, s2.to)).toEqual([]);
    expect(b.clean).toBe(1);
  }, 90_000);

  test('a session that writes still ends with a clean full pass that started after its write', async () => {
    const s = await serve('three', { write: true });
    const after = snapshot();
    const passes = fullPassesIn(after, s.from, s.to).filter((p) => !p.error && (p.repaired_rows ?? 0) === 0);
    expect(passes.length).toBeGreaterThanOrEqual(1);
    expect(after.clean).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test('a line another process left between sessions is not trusted: the next session runs a full pass', async () => {
    // Make sure the session before ended valid, so only the line can be the reason for the pass.
    const before = snapshot();
    if (!before.valid) await serve('settle');
    expect(snapshot().valid).toBe(true);
    appendFileSync(join(dir, 'follower-invalidations.jsonl'), `${JSON.stringify({ at: Date.now(), pid: 1, reason: 'test_foreign_write' })}\n`);
    const s = await serve('four');
    const after = snapshot();
    expect(fullPassesIn(after, s.from, s.to).length).toBeGreaterThanOrEqual(1);
    expect(after.valid).toBe(true);
  }, 60_000);

  test('a direct SQL write between sessions is not trusted: the next session repairs it and the clean count starts over', async () => {
    if (!snapshot().valid) await serve('settle-2');
    expect(snapshot().valid).toBe(true);
    // A connection that is not a gbrain process adds a page alias behind the follower's back, then goes away. (Not a
    // pages row: every pages update queues a projection job, and the serving process's worker then rewrites that page,
    // so the follower re-reads it on its own. Nothing in gbrain reacts to a new alias row.)
    const direct = postgres(brainUrl, { max: 1, prepare: false });
    try {
      const [{ n }] = await direct.unsafe(`WITH u AS (INSERT INTO page_aliases (source_id, alias_norm, slug, alias_text) VALUES ('default', 'behind the follower', 'sessions/three', 'Behind the follower') RETURNING 1) SELECT count(*)::int AS n FROM u`) as unknown as [{ n: number }];
      expect(n).toBe(1);
    } finally { await direct.end(); }
    const s = await serve('five');
    const after = snapshot();
    const passes = fullPassesIn(after, s.from, s.to);
    expect(passes.length).toBeGreaterThanOrEqual(1);
    expect((passes[0] as Pass & { repaired_by_relation?: Record<string, number> }).repaired_by_relation?.page_aliases ?? 0).toBeGreaterThanOrEqual(1);
    expect(after.clean).toBe(0);
  }, 60_000);
});
