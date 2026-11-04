/**
 * GST-1209 follow-up: a managed-sync hold on a page whose stored segment rows do not cover its body.
 *
 * 1. Protects: the freeze hold naming `page_body_rows_unreadable` (the page doctor `segmented_tiling` lists) reads
 *    needs_human with safe_actions repair and a fix that previews `gbrain repair segmented-tiling --source <id> --slug <slug>`,
 *    never a `sources retry-held` that cannot succeed; `gbrain sync unblock` refuses it by name with that fix; and
 *    `gbrain sync status --json` finds it among many holds without paging: `--slug` and `--code` (the hold code or the
 *    page-body fault code) filter the listing, each hold names its `fault_code`, and `holds_summary.by_fault_code` counts them.
 * 2. Fails when: the hold reads retry / no person, its fix names retry-held, unblock reports it as "not something unblock
 *    performs", a filter is ignored or its cursor replays against the unfiltered list, or the fault code is missing.
 * 3. PGLite, and Postgres when DATABASE_URL is set; holds are seeded with writeGitHold.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { holdVerdict, readSyncStatus, unblockSync } from '../src/core/persistence/sync-status.ts';
import { gitHoldFix, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { runSyncStatus } from '../src/commands/sync/operator.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { validateCommandFlags } from '../src/cli/main.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-untiled-hold-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SLUG = 'people/person-example';
const FILE = `${SLUG}.md`;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

const failure = (code: string) => ({ code, origin: 'freeze', error_class: code, errno: null, request_id: null, attempts: 1, gbrain_version: 'x' });
const freezeHold = (code: string) => ({ source_id: 'source-a', path: FILE, slug: SLUG, code: 'page_write_failed', held_at: new Date().toISOString(),
  meta: { attempts: 1, write_failure: failure(code) } }) as never;

test('doctor runs segmented_tiling as its own entry, so a default run reports it even when the wave checks run out of budget', () => {
  const owners = DOCTOR_CHECK_REGISTRY.filter(entry => entry.emits.includes('segmented_tiling'));
  expect(owners.map(entry => [entry.name, entry.emits])).toEqual([['segmented_tiling', ['segmented_tiling']]]);
  expect(owners[0]!.tier ?? 'standard').toBe('standard');
});

test('a freeze hold on a page whose segment rows do not cover its body points to the segmented-tiling repair', () => {
  expect(holdVerdict(freezeHold('page_body_rows_unreadable'), undefined)).toMatchObject({ class: 'page', safe_actions: ['repair'], needs_human: true,
    human_reason: expect.stringContaining('gbrain repair segmented-tiling') });
  const fix = gitHoldFix(freezeHold('page_body_rows_unreadable'));
  expect(fix.argv).toEqual(['gbrain', 'repair', 'segmented-tiling', '--source', 'source-a', '--slug', SLUG]);
  expect(fix.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'segmented_tiling', '--json']);
  expect(fix.then).toBeUndefined();
  expect(fix.why).toContain('writes nothing');
  expect(gitHoldFix(freezeHold('page_body_segmented')).argv).toEqual(['gbrain', 'sources', 'retry-held', 'source-a']);
  expect(gitHoldFix(freezeHold('storage_error')).argv).toEqual(['gbrain', 'sources', 'retry-held', 'source-a']);
});

test('a receipt hold whose write failed page_body_rows_unreadable gets the same repair fix as its verdict', () => {
  const receiptHold = { source_id: 'source-a', path: FILE, slug: SLUG, code: 'page_write_failed', held_at: new Date().toISOString(),
    meta: { attempts: 3, write_failure: { ...failure('page_body_rows_unreadable'), origin: 'page_write', request_id: 'req-example', attempts: 3 } } } as never;
  expect(holdVerdict(receiptHold, undefined)).toMatchObject({ safe_actions: ['repair'], needs_human: true });
  expect(gitHoldFix(receiptHold).argv).toEqual(['gbrain', 'repair', 'segmented-tiling', '--source', 'source-a', '--slug', SLUG]);
});

test('the CLI flag gate accepts sync status --code and --slug', () => {
  expect(validateCommandFlags('sync', ['status', '--source', 'source-a', '--code', 'page_body_rows_unreadable', '--slug', SLUG, '--json'])).toBeNull();
});

async function syncedSource(engine: BrainEngine) {
  const id = `uh-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'alice-example.md'), '---\ntitle: Alice Example\n---\nAlice keeps the acme-example ledger.\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
  const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  return { id, incarnation: row!.incarnation };
}

async function printed(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return out.join('\n');
}
type Hold = { path: string; slug: string | null; code: string; fault_code?: string; needs_human: boolean; safe_actions: string[]; fix: { argv: string[] } };
type StatusJson = { holds: Hold[]; holds_summary: { total: number; by_code: { counts: Record<string, number> }; by_fault_code: { counts: Record<string, number>; other: number } };
  holds_filter?: Record<string, string>; holds_page?: { next_cursor: string | null; next_command: string[] | null } };
const statusJson = async (engine: BrainEngine, args: string[]) => JSON.parse(await printed(() => runSyncStatus(engine, args))) as StatusJson;

test('sync status finds the hold among many without paging; unblock refuses it with the repair', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const s = await syncedSource(engine);
    const now = new Date().toISOString();
    const hold = (path: string, code: 'concurrent_write' | 'page_write_failed', meta: Record<string, unknown>) => writeGitHold(engine, { source_id: s.id, incarnation: s.incarnation, path,
      source_path: path, slug: path.replace(/\.md$/, ''), page_id: null, code, message: `${path} is held (fixture).`, upstream_version: null, observed_at: now, run_id: null, mode: 'managed', meta: meta as never });
    for (let i = 0; i < 130; i++) await hold(`aa/note-${String(i).padStart(4, '0')}.md`, 'concurrent_write', { recovery_version: 1 });
    await hold('aa/storage-example.md', 'page_write_failed', { recovery_version: 1, write_failure: failure('storage_error') });
    await hold(FILE, 'page_write_failed', { recovery_version: 1, write_failure: failure('page_body_rows_unreadable') });

    const status = await readSyncStatus(engine, s.id, { detail: false });
    const untiled = status.holds.find(h => h.path === FILE)!;
    expect(untiled).toMatchObject({ code: 'page_write_failed', fault_code: 'page_body_rows_unreadable', needs_human: true, safe_actions: ['repair'] });
    expect(untiled.fix.argv).toEqual(['gbrain', 'repair', 'segmented-tiling', '--source', s.id, '--slug', SLUG]);
    expect(status.holds.find(h => h.path === 'aa/storage-example.md')).toMatchObject({ fault_code: 'storage_error' });
    expect(status.holds.find(h => h.path === 'aa/note-0000.md')!.fault_code).toBeUndefined();

    const plain = await statusJson(engine, ['--source', s.id, '--json']);
    expect(plain.holds_summary.by_fault_code).toEqual({ counts: { page_body_rows_unreadable: 1, storage_error: 1 }, other: 0 });
    expect(plain.holds_summary.total).toBe(132);

    for (const args of [['--slug', SLUG], ['--code', 'page_body_rows_unreadable']]) {
      const found = await statusJson(engine, ['--source', s.id, ...args, '--json']);
      expect(found.holds.map(h => [h.path, h.fault_code, h.fix.argv[2]])).toEqual([[FILE, 'page_body_rows_unreadable', 'segmented-tiling']]);
      expect(found.holds_summary.total).toBe(132);
      expect(found.holds_filter).toEqual(args[0] === '--slug' ? { slug: SLUG } : { code: 'page_body_rows_unreadable' });
    }
    expect((await statusJson(engine, ['--source', s.id, '--code', 'page_write_failed', '--json'])).holds.map(h => h.path).sort()).toEqual(['aa/storage-example.md', FILE].sort());
    expect((await statusJson(engine, ['--source', s.id, '--slug', 'aa/note-0007', '--json'])).holds.map(h => h.path)).toEqual(['aa/note-0007.md']);

    const page = await statusJson(engine, ['--source', s.id, '--detail', '--code', 'concurrent_write', '--json']);
    expect(page.holds.every(h => h.code === 'concurrent_write')).toBe(true);
    expect(page.holds_page!.next_command).toEqual(expect.arrayContaining(['--code', 'concurrent_write']));
    const next = await statusJson(engine, ['--source', s.id, '--detail', '--code', 'concurrent_write', '--cursor', page.holds_page!.next_cursor!, '--json']);
    expect(next.holds.every(h => h.code === 'concurrent_write')).toBe(true);
    expect(page.holds.length + next.holds.length).toBe(130);
    await expect(printed(() => runSyncStatus(engine, ['--source', s.id, '--detail', '--cursor', page.holds_page!.next_cursor!, '--json']))).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(printed(() => runSyncStatus(engine, ['--source', s.id, '--slug']))).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(printed(() => runSyncStatus(engine, ['--source', s.id, '--code', '--json']))).rejects.toMatchObject({ code: 'invalid_params' });

    const unblock = await unblockSync(engine, s.id, { apply: false });
    const refused = unblock.refused.find(r => r.path === FILE)!;
    expect(refused).toMatchObject({ needs_human: true, reason: expect.stringContaining('gbrain repair segmented-tiling') });
    expect(refused.fix.argv).toEqual(['gbrain', 'repair', 'segmented-tiling', '--source', s.id, '--slug', SLUG]);
  }
}), 300_000);
