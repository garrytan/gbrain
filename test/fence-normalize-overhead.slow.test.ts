/**
 * #6188 foreground overhead budget (Codex Eng #15). A managed catch-up of
 * mostly clean files pays nothing for Tier 1: a file with no fence marker does
 * no fence work, a clean fence costs the one shared scan, and no clean file
 * issues any of the only statements Tier 1 can add (the `fences.normalize`
 * read, the stored-row loads for renumbering, the TE1 prior-takes read). The
 * catch-up alternates on identical sources with the fence step live and with
 * it replaced by a no-op; the statement totals and throughput of each arm are
 * printed for the release report (totals vary a little run to run with the
 * consumer's polling, so they are reported, not compared exactly).
 * FENCE_BENCH_FILES sizes it (default 300; the PR reports 10000) and
 * FENCE_BENCH_ROUNDS the live/no-op pairs (default 1). Synthetic content only.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import * as tier1 from '../src/core/fence-repair/tier1.ts';
import * as fenceConfig from '../src/core/fence-repair/config.ts';
import * as importStep from '../src/core/fence-repair/import-step.ts';
import { withEnv } from './helpers/with-env.ts';

const FILES = Number(process.env.FENCE_BENCH_FILES ?? 300);
const ROUNDS = Number(process.env.FENCE_BENCH_ROUNDS ?? 1);
/** The statements Tier 1 can add: the switch read, the stored-row loads (renumber) and the TE1 prior-takes read. */
const TIER1_STATEMENT = (sql: string, params: unknown) => (Array.isArray(params) && params.includes('fences.normalize'))
  || sql === 'SELECT row_num, claim FROM takes WHERE page_id=$1' || sql === 'SELECT row_num FROM takes WHERE page_id=$1'
  || sql.startsWith('SELECT row_num, fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL');
const home = mkdtempSync(join(tmpdir(), 'gbrain-fence-overhead-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';

/** 90% plain notes, 10% pages with a clean facts and takes fence (the shape of a real catch-up). */
function fixture(i: number): [string, string] {
  if (i % 10 !== 0) return [`notes/n${String(i).padStart(5, '0')}.md`, `---\ntitle: Note ${i}\n---\nA synthetic observation number ${i} about routine work.\n`];
  return [`people/p${String(i).padStart(5, '0')}.md`, `---\ntitle: Person ${i}\n---\nA synthetic person page.\n\n<!--- gbrain:facts:begin -->\n${FH}\n`
    + `| 1 | Synthetic fact ${i} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n<!--- gbrain:facts:end -->\n\n`
    + `<!--- gbrain:takes:begin -->\n${TH}\n| 1 | Synthetic take ${i} | take | brain | 0.7 | 2026-01 | chat |\n<!--- gbrain:takes:end -->\n`];
}

let engine: PGLiteEngine;
beforeAll(async () => withEnv(env, async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }), 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function source(files: number): Promise<string> {
  const id = `bench-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < files; i++) {
    const [path, content] = fixture(i);
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}

/** Every statement the engine sends to PGLite (its one connection carries transactions too), and the Tier 1 ones among them. */
function countStatements(): { count: () => number; tier1: () => number; restore: () => void } {
  const db = (engine as unknown as { _db: Record<'query' | 'exec', (...args: unknown[]) => Promise<unknown>> })._db;
  const original = { query: db.query, exec: db.exec };
  let n = 0, tier1Statements = 0;
  db.query = (...args) => { n++; if (TIER1_STATEMENT(String(args[0]), args[1])) tier1Statements++; return original.query.apply(db, args); };
  db.exec = (...args) => { n++; return original.exec.apply(db, args); };
  return { count: () => n, tier1: () => tier1Statements, restore: () => { db.query = original.query; db.exec = original.exec; } };
}

async function catchUp(live: boolean, files = FILES) {
  const id = await source(files);
  await disposePersistenceConsumer(engine);
  const stub = live ? null : spyOn(tier1, 'fenceStep').mockImplementation(() => ({ status: 'clean' }));
  const statements = countStatements();
  const started = performance.now();
  try {
    const result = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
    const ms = performance.now() - started;
    await disposePersistenceConsumer(engine);
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(files);
    expect(result.fences_normalized).toBeUndefined();
    return { ms, statements: statements.count(), tier1: statements.tier1(), filesPerSecond: files / (ms / 1000) };
  } finally { statements.restore(); stub?.mockRestore(); }
}

test(`a ${FILES}-file managed catch-up of clean files: Tier 1 adds no statement, no switch read and no stored-row read`, () => withEnv(env, async () => {
  const switchReads = spyOn(fenceConfig, 'fencesNormalizeEnabled');
  const storedReads = spyOn(importStep, 'storedFenceRows');
  try {
    await catchUp(true, Math.min(FILES, 200)); // warm the JIT and the schema caches before measuring
    const runs = [];
    for (let round = 0; round < ROUNDS; round++) for (const live of [true, false]) runs.push({ live, ...await catchUp(live) });
    const live = runs.filter(r => r.live), stubbed = runs.filter(r => !r.live);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const report = { files: FILES, rounds: ROUNDS, live_fps: live.map(r => Number(r.filesPerSecond.toFixed(1))), noop_fps: stubbed.map(r => Number(r.filesPerSecond.toFixed(1))),
      time_ratio_live_over_noop: Number((median(live.map(r => r.ms)) / median(stubbed.map(r => r.ms))).toFixed(3)),
      statements_live: live.map(r => r.statements), statements_noop: stubbed.map(r => r.statements) };
    console.log(`[fence-overhead] ${JSON.stringify(report)}`);
    // No clean file read the switch or the stored rows, and no Tier 1 statement was sent.
    expect(switchReads).not.toHaveBeenCalled();
    expect(storedReads).not.toHaveBeenCalled();
    expect(runs.map(r => r.tier1)).toEqual(runs.map(() => 0));
  } finally { switchReads.mockRestore(); storedReads.mockRestore(); }
}), 3_600_000);
