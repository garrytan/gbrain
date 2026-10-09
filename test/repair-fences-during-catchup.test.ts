/**
 * #6278 R2: `gbrain repair fences --apply` during a live managed catch-up.
 *
 * Protects: a source whose sync is running is no longer skipped as a whole.
 * While a sync member is being prepared, the candidate it names and a
 * candidate still ahead in the run's frozen manifest are `sync_in_progress`
 * and nothing is written to them; between two entries of the same run a held
 * candidate (the hold's bytes unchanged, so not in the manifest) and an
 * unsynced working-tree candidate are repaired, while the far-ahead one still
 * waits; the sync then finishes with no `source_changed` refusal and imports
 * the entry it had ahead. A plan approved before a sync started is not
 * applied to a candidate that sync froze in between (`sync_in_progress` at
 * apply), and the entry imports once the sync reaches it.
 * Fails when: the blanket skip comes back (nothing repaired during a sync),
 * a manifest-ahead or in-flight candidate is written (the sync would refuse
 * it on its raw hash), or a held path counts as busy.
 * Seams: installFaultHook (`consumer:preparing`, `sync:mid_checkpoint`) pauses
 * the real sync; __setChatTransportForTests answers the model tier.
 * Postgres arm: test/e2e/repair-fences-during-catchup-postgres.test.ts.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { installFaultHook, type FaultDetail, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-catchup-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: 'sk-test-not-used',
  GBRAIN_FENCE_REPAIR_SCAN_MS: '60000', GBRAIN_SYNC_BULK: '0' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const quiet = { info() {}, warn() {}, error() {} };

const CLAIM = 'Sentinelcatchup ships quarterly';
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const NARROW = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const SEP = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const row = (claim: string) => `| 1 | ${claim} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |`;
const md = (title: string, body: string) => `---\ntitle: ${title}\n---\nA synthetic page.\n\n${body}`;
/** Tier 3: rows but no header (held by the sync). */
const noHeader = (claim = CLAIM) => `${FB}\n${row(claim)}\n${FBE}\n`;
/** Tier 1: a missing end marker and an invented kind (admitted by the sync, normalized on import). */
const fixable = (claim: string) => `${FB}\n${FH}\n| 1 | ${claim} | partnership | 0.9 | private | high | 2026-01-01 |  | chat |  |\n`;
const answer = (claim: string): ChatResult => ({ text: `${NARROW}\n${SEP}\n${row(claim)}`, blocks: [], stopReason: 'end',
  usage: { input_tokens: 500, output_tokens: 120, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-opus-4-7', providerId: 'anthropic' });

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterEach(() => { installFaultHook(undefined); __setChatTransportForTests(null); });
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); resetGateway(); rmSync(home, { recursive: true, force: true });
});

async function managed(engine: BrainEngine, files: Record<string, string>) {
  const id = `catchup-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root, 'fixture');
  writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const run = async (opts: { apply?: boolean; expect?: string; only?: string[] } = {}) => {
    const runner = await repairRunner(engine, { apply: opts.apply === true, noEmbed: true, logger: quiet });
    return runner.run('fences', await resolveRepairScope(engine, id), { explicit: true, sourceFlag: id, expect: opts.expect, only: opts.only });
  };
  const failed = async () => engine.executeRaw<{ request_id: string; error_code: string | null; slug: string }>(
    "SELECT request_id::text AS request_id, error_code, slug FROM persistence_requests WHERE source_id=$1 AND state IN ('failed','conflict')", [id]);
  const cursor = async () => (await engine.executeRaw<{ index: string | null; run_id: string | null }>(`SELECT completed_keys->0->>'index' AS index, completed_keys->0->>'runId' AS run_id
    FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true' AND completed_keys->0->>'sourceId'=$1`, [id]))[0] ?? null;
  return { id, root, write, read: (path: string) => readFileSync(join(root, path), 'utf8'), sync, holds, run, failed, cursor };
}

/** A gate the fault hook parks the sync at: `reached` resolves when it is hit, `release()` lets the sync go on. */
function gate() {
  let release!: () => void, reached!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const hit = new Promise<void>(resolve => { reached = resolve; });
  return { release, reached, hit, released };
}
const hashOf = (result: RepairResult) => result.apply_command.split('--expect ')[1]!.split(' ')[0]!;
const classes = (result: RepairResult, prefix: string) => Object.fromEntries((result.listing ?? []).map(entry => [entry.item.slice(prefix.length + 1), entry.class]));

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6' } as never);
    for (const engine of engines) {
      try { await run(engine); } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
    }
  });
}

test('during a live catch-up: the admitted and the far-ahead candidates wait, the held and the working-tree candidates repair, and the sync finishes clean', () => each(async engine => {
  const s = await managed(engine, { 'people/held.md': md('Held', noHeader()), 'notes/plain.md': md('Plain', 'Nothing here.\n') });
  expect((await s.sync()).held_count).toBe(1);
  // Commit 2: the entry the sync admits first (a Tier 1 defect, so it is a census file candidate until it imports) and one far behind it.
  s.write('people/aa-admitted.md', md('Admitted', fixable('Synthetic admitted partnership')));
  s.write('people/zz-ahead.md', md('Ahead', fixable('Synthetic ahead partnership')));
  commit(s.root, 'two fences');
  // Never synced, never committed: a working-tree candidate outside the manifest.
  s.write('people/later.md', md('Later', fixable('Synthetic later partnership')));
  let calls = 0;
  __setChatTransportForTests(async () => { calls++; return answer(CLAIM); });
  const preparing = gate(), between = gate();
  let pausedPreparing = false, pausedBetween = false;
  installFaultHook(async (point: FaultPoint, detail: FaultDetail) => {
    if (detail.sourceId !== s.id) return;
    if (point === 'consumer:preparing' && !pausedPreparing) {
      const [req] = await engine.executeRaw<{ path: string | null }>("SELECT intent->>'path' AS path FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
      if (req?.path !== 'people/aa-admitted.md') return;
      pausedPreparing = true; preparing.reached(); await preparing.released;
    }
    if (point === 'sync:mid_checkpoint' && pausedPreparing && !pausedBetween && (await s.cursor())?.index === '1') {
      pausedBetween = true; between.reached(); await between.released;
    }
  });
  const sync = s.sync();
  await preparing.hit;
  // Entry 0 is admitted and preparing; entry 1 is frozen in the manifest and not admitted.
  const [running] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state='running'", [s.id]);
  expect(running!.n).toBe(1);
  const busyPreview = await s.run({ only: ['people/aa-admitted.md', 'people/zz-ahead.md'] });
  expect(classes(busyPreview, s.id)).toEqual({ 'people/aa-admitted.md': 'sync_in_progress', 'people/zz-ahead.md': 'sync_in_progress' });
  expect(busyPreview.affected).toBe(0);
  const busyApply = await s.run({ apply: true, only: ['people/aa-admitted.md', 'people/zz-ahead.md'] });
  expect(busyApply).toMatchObject({ applied: 0, remaining: { sync_in_progress: 2 } });
  expect(s.read('people/aa-admitted.md')).toBe(md('Admitted', fixable('Synthetic admitted partnership')));
  expect(s.read('people/zz-ahead.md')).toBe(md('Ahead', fixable('Synthetic ahead partnership')));
  preparing.release();
  await between.hit;
  // Entry 0 committed, entry 1 still ahead: the held and the working-tree candidates repair now; the far-ahead one waits.
  expect(await s.failed()).toEqual([]);
  const preview = await s.run();
  expect(classes(preview, s.id)).toEqual({ 'people/held.md': 'llm', 'people/later.md': 'deterministic', 'people/zz-ahead.md': 'sync_in_progress' });
  const applied = await s.run({ apply: true });
  expect(applied).toMatchObject({ repaired: 2, remaining: { sync_in_progress: 1 } });
  expect(calls).toBe(1);
  expect(s.read('people/held.md')).toContain(FH.split('\n')[0]!);
  expect(s.read('people/later.md')).toContain(FBE);
  expect(s.read('people/zz-ahead.md')).toBe(md('Ahead', fixable('Synthetic ahead partnership')));
  expect(await s.holds()).toEqual([]);
  between.release();
  const result = await sync;
  expect(result.status).not.toBe('error');
  expect(await s.failed()).toEqual([]);
  expect(await s.cursor()).toBeNull();
  // The far-ahead entry imported on the bytes the sync froze, and the import normalized its fence.
  expect(await engine.readPageSnapshot('people/zz-ahead', { sourceId: s.id })).not.toBeNull();
  expect(s.read('people/zz-ahead.md')).toContain(FBE);
  expect((await s.run()).affected).toBe(0);
}), 240_000);

test('a plan approved before a sync started is not applied to a candidate that sync froze; the entry imports once the sync reaches it', () => each(async engine => {
  const s = await managed(engine, { 'notes/plain.md': md('Plain', 'Nothing here.\n') });
  expect((await s.sync()).held_count ?? 0).toBe(0);
  s.write('people/race.md', md('Race', fixable('Synthetic race partnership')));
  commit(s.root, 'a fence');
  // Approved in the same plan, never committed: outside the manifest the sync is about to freeze.
  s.write('people/other.md', md('Other', fixable('Synthetic other partnership')));
  const approved = await s.run();
  expect(classes(approved, s.id)).toEqual({ 'people/race.md': 'deterministic', 'people/other.md': 'deterministic' });
  const frozen = gate();
  let paused = false;
  installFaultHook(async (point: FaultPoint, detail: FaultDetail) => {
    if (point !== 'sync:mid_checkpoint' || detail.sourceId !== s.id || paused) return;
    paused = true; frozen.reached(); await frozen.released;
  });
  const sync = s.sync();
  await frozen.hit;
  expect(await s.cursor()).toMatchObject({ index: '0' });
  const raced = await s.run({ apply: true, expect: hashOf(approved) });
  expect(raced).toMatchObject({ applied: 1, outcomes: { skipped: 1, repaired: 1 } });
  expect(raced.outcome_items!.find(item => item.item.endsWith('people/race'))).toMatchObject({ outcome: 'skipped', reason: 'sync_in_progress' });
  expect(raced.outcome_items!.find(item => item.item.endsWith('people/other'))).toMatchObject({ outcome: 'repaired' });
  expect(s.read('people/race.md')).toBe(md('Race', fixable('Synthetic race partnership')));
  expect(s.read('people/other.md')).toContain(FBE);
  frozen.release();
  const result = await sync;
  expect(result.status).not.toBe('error');
  expect(await s.failed()).toEqual([]);
  expect(await engine.readPageSnapshot('people/race', { sourceId: s.id })).not.toBeNull();
  expect(s.read('people/race.md')).toContain(FBE);
}), 240_000);
