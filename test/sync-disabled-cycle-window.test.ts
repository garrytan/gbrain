/**
 * #8573: a per-source cycle that runs no sync for its source works on the
 * source's pages changed since its previous cycle. A git source with
 * `config.syncEnabled=false` (an external scheduler runs
 * `gbrain sync --source` itself) got the freshness phases without `sync` and
 * no changed-page window, so extract_facts and recompute_emotional_weight
 * walked every page of the source on every cycle; past about 27k pages each
 * cycle died at the 30-minute job timeout and never stamped. A source with no
 * recorded cycle walks its pages in bounded, resumable chunks.
 *
 * Real handler, cycle and sync on every configured engine. The fixture
 * toggles the brain-wide persistence switch and process env.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { makeAutopilotCycleHandler } from '../src/core/minions/handlers/autopilot-cycle.ts';
import { SOURCE_FRESHNESS_PHASES } from '../src/core/cycle/phase-scope.ts';
import { sourceCycleWindowStamp, sourceWindow } from '../src/core/cycle/source-window.ts';
import { performSync } from '../src/commands/sync.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
const { engines, env, source } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);
const DEFAULT_PAGE_LIMIT = sourceWindow.pageLimit;
afterEach(() => { sourceWindow.pageLimit = DEFAULT_PAGE_LIMIT; });

const NO_SYNC_PHASES = SOURCE_FRESHNESS_PHASES.filter(p => p !== 'sync');
const PAGES = 12;
type Phase = { phase: string; status: string; details: Record<string, unknown> };
type Out = { status: string; report: { phases: Phase[] } };

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
const commit = (root: string, message: string) => {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
};
const note = (i: number) => `---\ntitle: Note ${i}\ntype: note\n---\nSynthetic note ${i}.\n`;
const factPage = `---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nBody.\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded Acme Example | fact | 1.0 | world | high | 2017-01-01 |  | example |  |
<!--- gbrain:facts:end -->
`;

async function cycle(engine: BrainEngine, sourceId: string, id: number, phases: readonly string[] | undefined = NO_SYNC_PHASES) {
  const out = await makeAutopilotCycleHandler(engine)({ id, data: { source_id: sourceId, ...(phases ? { phases } : {}) } } as never) as Out;
  const facts = out.report.phases.find(p => p.phase === 'extract_facts');
  const weight = out.report.phases.find(p => p.phase === 'recompute_emotional_weight');
  expect(facts?.status).not.toBe('fail');
  expect(weight?.status).not.toBe('fail');
  return { scanned: Number(facts!.details.pagesScanned), weight: weight!.details, extract: out.report.phases.find(p => p.phase === 'extract')?.details };
}

async function config(engine: BrainEngine, sourceId: string) {
  return (await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', [sourceId]))[0]!.config;
}

async function liveFacts(engine: BrainEngine, sourceId: string, slug: string) {
  return Number((await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL', [sourceId, slug]))[0]!.n);
}

describe('#8573 sync-disabled source cycle window', () => {
  test('the window advances only when every phase that works on it ran without failing', () => {
    const window = { since: { at: '2026-01-01T00:00:00Z', slug: 'b' }, next: { at: '2026-01-02T00:00:00Z', slug: '' }, slugs: ['a'] };
    const ran = (fail?: string) => ['extract', 'extract_facts', 'recompute_emotional_weight'].map(phase => ({ phase, status: phase === fail ? 'fail' : 'ok' }));
    expect(sourceCycleWindowStamp(ran(), window)).toEqual({ last_source_cycle_window_at: '2026-01-02T00:00:00Z', last_source_cycle_window_slug: '' });
    for (const phase of ['extract', 'extract_facts', 'recompute_emotional_weight']) {
      expect(sourceCycleWindowStamp(ran(phase), window)).toEqual({ last_source_cycle_window_at: '2026-01-01T00:00:00Z', last_source_cycle_window_slug: 'b' });
      expect(sourceCycleWindowStamp(ran().filter(r => r.phase !== phase), window)).toEqual({ last_source_cycle_window_at: '2026-01-01T00:00:00Z', last_source_cycle_window_slug: 'b' });
    }
    expect(sourceCycleWindowStamp(ran(), { ...window, since: { at: null, slug: '' } })).toMatchObject({ last_source_cycle_window_at: '2026-01-02T00:00:00Z' });
    expect(sourceCycleWindowStamp(ran('extract'), { ...window, since: { at: null, slug: '' } })).toEqual({ last_source_cycle_window_at: '', last_source_cycle_window_slug: '' });
    expect(sourceCycleWindowStamp([...ran(), { phase: 'lint', status: 'fail' }], window)).toMatchObject({ last_source_cycle_window_at: '2026-01-02T00:00:00Z' });
  });

  test('a sync-disabled git source reconciles only pages changed since its last cycle; an explicit sync between cycles lands in the next window', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { id, dir } = await source(engine, { syncEnabled: false });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        git(dir, 'init', '-q');
        mkdirSync(join(dir, 'notes'));
        for (let i = 0; i < PAGES; i++) writeFileSync(join(dir, 'notes', `n-${i}.md`), note(i));
        commit(dir, 'seed');
        await performSync(engine, { repoPath: dir, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
        // The source's earlier cycles stamped freshness before its automatic sync was turned off.
        await engine.updateSourceConfig(id, { last_source_cycle_at: new Date(Date.now() - 60_000).toISOString() });

        const first = await cycle(engine, id, 1);
        expect(first.weight).toMatchObject({ mode: 'incremental' });
        // Nothing changed since: no page is walked (pre-fix: every page of the source, every cycle).
        const idle = await cycle(engine, id, 2);
        expect(idle.scanned).toBe(0);
        expect(idle.weight).toMatchObject({ mode: 'incremental', pages_recomputed: 0 });
        expect(idle.extract).toMatchObject({ incremental: true, pages_processed: 0 });

        // The external scheduler's explicit sync between cycles imports a page with a facts fence.
        mkdirSync(join(dir, 'people'));
        writeFileSync(join(dir, 'people', 'alice-example.md'), factPage);
        commit(dir, 'fact page');
        await performSync(engine, { repoPath: dir, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
        const after = await cycle(engine, id, 3);
        expect(after.scanned).toBe(1);
        expect(after.weight).toMatchObject({ mode: 'incremental', pages_recomputed: 1 });
        expect(after.extract).toMatchObject({ incremental: true, pages_processed: 1 });
        expect(await liveFacts(engine, id, 'people/alice-example')).toBe(1);
        // The fact receipt page cycle 3 wrote after its listing is the next window; then the source is idle again.
        expect((await cycle(engine, id, 4)).scanned).toBe(1);
        expect((await cycle(engine, id, 5)).scanned).toBe(0);
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    }
  }), 180_000);

  test('a source with no recorded cycle walks its pages in bounded windows and resumes; a page changed during the walk lands in it', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { id } = await source(engine, { syncEnabled: false });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        for (let i = 0; i < 5; i++) {
          await engine.putPage(`walk/n-${i}`, { title: `Note ${i}`, type: 'note', compiled_truth: `Body ${i}.` }, { sourceId: id });
        }
        sourceWindow.pageLimit = 2;
        const one = await cycle(engine, id, 1);
        expect(one.scanned).toBe(2);
        expect(one.weight).toMatchObject({ mode: 'incremental', pages_recomputed: 2 });
        expect(await config(engine, id)).toMatchObject({ last_source_cycle_window_slug: 'walk/n-1' });

        // Edited after the first window passed it: it moves to the end of the walk.
        await engine.putPage('walk/n-0', { title: 'Note 0', type: 'note', compiled_truth: 'Body 0, edited.' }, { sourceId: id });
        expect((await cycle(engine, id, 2)).weight).toMatchObject({ pages_recomputed: 2 });
        expect(await config(engine, id)).toMatchObject({ last_source_cycle_window_slug: 'walk/n-3' });
        expect((await cycle(engine, id, 3)).weight).toMatchObject({ pages_recomputed: 2 });
        expect(await config(engine, id)).toMatchObject({ last_source_cycle_window_slug: '' });
        expect((await cycle(engine, id, 4)).weight).toMatchObject({ mode: 'incremental', pages_recomputed: 0 });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    }
  }), 180_000);

  test('a large change between cycles (a bulk explicit sync) is worked through in bounded windows; a cycle without the window phases does not advance it', async () => withEnv(env, async () => {
    for (const engine of engines) {
      sourceWindow.pageLimit = DEFAULT_PAGE_LIMIT;
      const { id } = await source(engine, { syncEnabled: false });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        for (let i = 0; i < 5; i++) {
          await engine.putPage(`bulk/n-${i}`, { title: `Note ${i}`, type: 'note', compiled_truth: `Body ${i}.` }, { sourceId: id });
        }
        await cycle(engine, id, 1);
        expect((await cycle(engine, id, 2)).weight).toMatchObject({ pages_recomputed: 0 });
        for (let i = 0; i < 5; i++) {
          await engine.putPage(`bulk/n-${i}`, { title: `Note ${i}`, type: 'note', compiled_truth: `Body ${i}, re-imported.` }, { sourceId: id });
        }
        sourceWindow.pageLimit = 2;
        const before = await config(engine, id);
        await makeAutopilotCycleHandler(engine)({ id: 3, data: { source_id: id, phases: ['lint', 'backlinks'] } } as never);
        expect(await config(engine, id)).toMatchObject({ last_source_cycle_window_at: before.last_source_cycle_window_at, last_source_cycle_window_slug: '' });
        const counts: number[] = [];
        for (let n = 4; n < 8; n++) counts.push(Number((await cycle(engine, id, n)).weight.pages_recomputed));
        expect(counts).toEqual([2, 2, 1, 0]);
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    }
  }), 180_000);

  test('a source with no checkout (repo-less) gets the window too: writes between cycles land, an idle cycle walks nothing', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { id } = await source(engine, {});
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        await engine.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1', [id]);
        for (let i = 0; i < PAGES; i++) {
          await engine.putPage(`db-only/n-${i}`, { title: `Note ${i}`, type: 'note', compiled_truth: `Body ${i}.` }, { sourceId: id });
        }
        await cycle(engine, id, 1, SOURCE_FRESHNESS_PHASES);
        const idle = await cycle(engine, id, 2, SOURCE_FRESHNESS_PHASES);
        expect(idle.scanned).toBe(0);
        expect(idle.weight).toMatchObject({ mode: 'incremental', pages_recomputed: 0 });
        await engine.putPage('db-only/n-3', { title: 'Note 3', type: 'note', compiled_truth: 'Body 3, edited.' }, { sourceId: id });
        expect((await cycle(engine, id, 3, SOURCE_FRESHNESS_PHASES)).weight).toMatchObject({ mode: 'incremental', pages_recomputed: 1 });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    }
  }), 180_000);
  test('a write whose transaction began before a cycle listed its pages and committed after lands in the next window (Postgres)', async () => withEnv(env, async () => {
    const engine = engines.find(e => e.kind === 'postgres');
    if (!engine) return;
    const { id } = await source(engine, { syncEnabled: false });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const [{ name }] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    const writer = postgres(url.toString(), { max: 1, prepare: false });
    try {
      for (let i = 0; i < 3; i++) {
        await engine.putPage(`race/n-${i}`, { title: `Note ${i}`, type: 'note', compiled_truth: `Body ${i}.` }, { sourceId: id });
      }
      await cycle(engine, id, 1);
      expect((await cycle(engine, id, 2)).weight).toMatchObject({ pages_recomputed: 0 });
      // pages.updated_at is the writer's transaction start, which is before the next cycle's listing.
      const reserved = await writer.reserve();
      await reserved.unsafe('BEGIN');
      await reserved.unsafe("UPDATE pages SET compiled_truth='Body 1, edited.', updated_at=now() WHERE source_id=$1 AND slug='race/n-1'", [id]);
      await Bun.sleep(20);
      expect((await cycle(engine, id, 3)).weight).toMatchObject({ pages_recomputed: 0 });
      await reserved.unsafe('COMMIT');
      reserved.release();
      expect((await cycle(engine, id, 4)).weight).toMatchObject({ mode: 'incremental', pages_recomputed: 1 });
    } finally {
      await writer.end();
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }), 180_000);
});
