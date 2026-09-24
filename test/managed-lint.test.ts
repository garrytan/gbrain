// #5180: the cycle's lint phase on a managed brain. Legacy lint writes fixed
// files straight into the worktree, which the managed filesystem guard
// refuses (`writer_coordinator_required`), so every per-source cycle ended
// `partial`. On a managed brain lint now publishes each repair through the
// persistence coordinator (DB row + worktree file in one guarded write),
// leaves files it cannot rewrite pending instead of failing, and keeps the
// legacy filesystem path for unmanaged brains.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runLintCore } from '../src/commands/lint.ts';
import { runPhaseLint } from '../src/core/cycle.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const PREAMBLE = 'Of course. Here is a detailed brain page for Jane Doe.\n\n';
const BODY = '# Jane Doe\n\nContent that stays.\n';
const PAGE = `---\ntitle: Jane Doe\ntype: person\n---\n${PREAMBLE}${BODY}`;
// A page the coordinator wrote carries `ingested_at`, so lint sees TWO fixable
// issues on it: the LLM preamble and `missing-created` (promotable from
// `ingested_at`, #3958). A hand-written file has only the preamble to fix.
const FIXABLE_ON_INDEXED_PAGE = 2;

const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-managed-lint-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

async function fixture(run: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>, owner = true) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-lint-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `lint-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        if (owner) await claimWorktree(engine, sourceId, root);
        await run(engine, sourceId, root);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function seed(engine: BrainEngine, sourceId: string, slug = 'people/jane-doe') {
  const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: PAGE, request_id: randomUUID() } });
}

async function requests(engine: BrainEngine, sourceId: string): Promise<number> {
  return (await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).length;
}

test('managed lint publishes a repair through the coordinator: DB row and worktree file change together', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const file = join(root, 'people/jane-doe.md');
    expect(readFileSync(file, 'utf8')).toContain(PREAMBLE.trim());
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await requests(engine, sourceId);

    const result = await runLintCore({ target: root, fix: true, engine, sourceId });
    expect(result).toMatchObject({ pages_scanned: 1, total_fixable: FIXABLE_ON_INDEXED_PAGE, total_fixed: FIXABLE_ON_INDEXED_PAGE, fix_pending: 0, write_path: 'coordinator' });

    const snapshot = (await engine.readPageSnapshot('people/jane-doe', { sourceId }))!;
    expect(snapshot.page.compiled_truth).not.toContain('Of course');
    expect(snapshot.page.compiled_truth).toContain('Content that stays.');
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('Of course');
    expect(onDisk).toContain('Content that stays.');
    expect(await requests(engine, sourceId)).toBe(before + 1);

    // A second pass finds nothing to fix and admits nothing.
    const again = await runLintCore({ target: root, fix: true, engine, sourceId });
    expect(again).toMatchObject({ total_fixable: 0, total_fixed: 0, fix_pending: 0 });
    expect(await requests(engine, sourceId)).toBe(before + 1);
  });
}, 30_000);

test('managed lint dry-run reports the fixable issue and admits nothing', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const file = join(root, 'people/jane-doe.md');
    const bytes = readFileSync(file, 'utf8');
    const before = await requests(engine, sourceId);
    const result = await runLintCore({ target: root, fix: true, dryRun: true, engine, sourceId });
    expect(result).toMatchObject({ total_fixable: FIXABLE_ON_INDEXED_PAGE, dryRun: true, write_path: 'none', fix_pending: 0 });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(await requests(engine, sourceId)).toBe(before);
  });
}, 30_000);

test('managed lint leaves a file with no indexed page pending instead of writing the worktree', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    mkdirSync(join(root, 'notes'));
    const stray = join(root, 'notes/stray.md');
    writeFileSync(stray, PAGE);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await requests(engine, sourceId);

    const seen: Array<{ rel: string; rules: string[] }> = [];
    const result = await runLintCore({ target: root, fix: true, engine, sourceId,
      onPageIssues: (rel, issues) => seen.push({ rel, rules: issues.map(i => i.rule) }) });
    // jane-doe: 2 fixable, fixed. stray: preamble fixable but unpublishable (+1 pending issue), missing-created not promotable.
    expect(result).toMatchObject({ pages_scanned: 2, total_fixable: FIXABLE_ON_INDEXED_PAGE + 1, total_fixed: FIXABLE_ON_INDEXED_PAGE, fix_pending: 1, write_path: 'coordinator' });
    expect(readFileSync(stray, 'utf8')).toBe(PAGE);
    expect(seen.find(s => s.rel === 'notes/stray.md')?.rules).toContain('managed-write-pending');
    expect(readFileSync(join(root, 'people/jane-doe.md'), 'utf8')).not.toContain('Of course');
    expect(await requests(engine, sourceId)).toBe(before + 1);
    expect(await engine.readPageSnapshot('notes/stray', { sourceId })).toBeNull();
  });
}, 30_000);

test('the cycle lint phase reports the coordinator write path and stays ok on a healthy managed brain', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const result = await runPhaseLint(root, false, engine, undefined, sourceId);
    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({ issues: FIXABLE_ON_INDEXED_PAGE, fixed: FIXABLE_ON_INDEXED_PAGE, write_path: 'coordinator', fix_pending: 0 });
    expect(readFileSync(join(root, 'people/jane-doe.md'), 'utf8')).not.toContain('Of course');
  });
}, 30_000);

test('the cycle lint phase fails without an active canonical owner and never touches the worktree', async () => {
  await fixture(async (engine, sourceId, root) => {
    mkdirSync(join(root, 'people'));
    const file = join(root, 'people/jane-doe.md');
    writeFileSync(file, PAGE);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const result = await runPhaseLint(root, false, engine, undefined, sourceId);
    expect(result.status).toBe('fail');
    expect(result.error?.message).toContain('canonical owner');
    expect(readFileSync(file, 'utf8')).toBe(PAGE);
    expect(await requests(engine, sourceId)).toBe(0);
  }, false);
}, 30_000);

test('unmanaged lint keeps the legacy filesystem write path', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-legacy-lint-'));
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      mkdirSync(join(dir, 'people'));
      const file = join(dir, 'people/jane-doe.md');
      writeFileSync(file, PAGE);
      const result = await runLintCore({ target: dir, fix: true, engine });
      expect(result).toMatchObject({ total_fixed: 1, fix_pending: 0, write_path: 'filesystem' });
      expect(readFileSync(file, 'utf8')).not.toContain('Of course');
      expect(existsSync(join(dir, '.gbrain-owner.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 30_000);
