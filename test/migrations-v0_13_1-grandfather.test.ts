// v0.41.37.0 #1581 — chunked, source-safe, soft-delete-filtered grandfather pass.
//
// The pre-#1581 per-page getPage+putPage loop hung CPU-bound for 70+ min on an
// 82K-page PGLite brain. The rewrite is a chunked bulk SQL pass keyed on
// pages.id (NOT slug — slug isn't globally unique), filtering deleted_at IS NULL.
// These tests drive phaseCGrandfather directly against a real PGLite engine.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { phaseCGrandfather, phaseDVerify } from '../src/commands/migrations/v0_13_1.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import type { OrchestratorOpts } from '../src/commands/migrations/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const ensureSource = (id: string) =>
  engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [id]);

const seed = (slug: string, frontmatter: Record<string, unknown>, sourceId = 'default') =>
  engine.putPage(slug, {
    type: 'concept', title: slug, compiled_truth: 'body', timeline: '', frontmatter,
  }, { sourceId });

const fmOf = async (slug: string, sourceId = 'default') => {
  const p = await engine.getPage(slug, { sourceId });
  return p?.frontmatter ?? null;
};

// Run the phase with an isolated GBRAIN_HOME so the rollback log lands in a
// tempdir (withEnv keeps R1 test-isolation compliance — no raw process.env writes).
async function gf(home: string, opts: Partial<OrchestratorOpts> = {}) {
  const full: OrchestratorOpts = { yes: true, dryRun: false, noAutopilotInstall: true, ...opts };
  return withEnv({ GBRAIN_HOME: home }, () => phaseCGrandfather(engine, full));
}

describe('#1581 phaseCGrandfather (chunked, source-safe)', () => {
  test('metadata-only migration preserves an already searchable projection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-search-'));
    try {
      await engine.putPage('concepts/search-example', {
        type: 'concept', title: 'Search Example', compiled_truth: 'amberbadger migration fixture', timeline: '', frontmatter: {},
      }, { sourceId: 'default' });
      await installFixtureChunks(engine, 'concepts/search-example', [{ chunk_index: 0, chunk_text: 'amberbadger migration fixture', chunk_source: 'compiled_truth' }]);
      const before = await engine.getPage('concepts/search-example', { sourceId: 'default' });
      expect((await engine.searchKeyword('amberbadger', { sourceId: 'default' })).length).toBe(1);
      expect((await gf(home)).result.status).toBe('complete');
      const after = await engine.getPage('concepts/search-example', { sourceId: 'default' });
      expect(after?.knowledge_revision).not.toBe(before?.knowledge_revision);
      expect(after?.text_projection_revision).toBe(after?.knowledge_revision);
      expect((await engine.searchKeyword('amberbadger', { sourceId: 'default' })).length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('does not certify an unsealed projection as searchable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-unsealed-'));
    try {
      await seed('concepts/unsealed-example', {});
      expect((await gf(home)).result.status).toBe('complete');
      const after = await engine.getPage('concepts/unsealed-example', { sourceId: 'default' });
      expect(after?.text_projection_revision).toBeNull();
      expect((await engine.executeRaw('SELECT 1 FROM page_projection_jobs WHERE slug=$1', ['concepts/unsealed-example'])).length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('absent validate key → validate:false', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-'));
    await seed('a', { foo: 1 });
    const { result } = await gf(home);
    expect(result.status).toBe('complete');
    expect((await fmOf('a'))?.validate).toBe(false);
  });

  test('explicit validate (true/false/null) is NOT modified', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-'));
    await seed('t', { validate: true });
    await seed('f', { validate: false });
    await seed('n', { validate: null });
    await gf(home);
    expect((await fmOf('t'))?.validate).toBe(true);
    expect((await fmOf('f'))?.validate).toBe(false);
    // null value still counts as "key present" → left untouched.
    expect((await fmOf('n'))?.validate ?? 'WAS_NULL').toBe('WAS_NULL');
  });

  test('soft-deleted pages are NOT grandfathered', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-'));
    await seed('live', { foo: 1 });
    await seed('dead', { foo: 1 });
    await engine.softDeletePage('dead');
    await gf(home);

    expect((await fmOf('live'))?.validate).toBe(false);
    const rows = await engine.executeRaw<{ fm: Record<string, unknown> }>(
      "SELECT frontmatter AS fm FROM pages WHERE slug = 'dead'",
    );
    expect(Object.prototype.hasOwnProperty.call(rows[0]?.fm ?? {}, 'validate')).toBe(false);
  });

  test('multi-source duplicate slugs: both grandfathered, no cross-contamination', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-'));
    await ensureSource('src2');
    await seed('people/dup', { src: 'a' }, 'default');
    await seed('people/dup', { src: 'b' }, 'src2');
    await gf(home);

    expect((await fmOf('people/dup', 'default'))?.validate).toBe(false);
    expect((await fmOf('people/dup', 'src2'))?.validate).toBe(false);
    expect((await fmOf('people/dup', 'default'))?.src).toBe('a');
    expect((await fmOf('people/dup', 'src2'))?.src).toBe('b');
  });

  test('rollback log carries source identity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-'));
    await ensureSource('src2');
    await seed('people/dup', { src: 'a' }, 'default');
    await seed('people/dup', { src: 'b' }, 'src2');
    await gf(home);

    // configDir() appends '.gbrain' to GBRAIN_HOME.
    const logPath = join(home, '.gbrain', 'migrations', 'v0_13_1-rollback.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.source_id).sort()).toEqual(['default', 'src2']);
    expect(lines.every(l => typeof l.id === 'number' && l.slug === 'people/dup')).toBe(true);
  });

  test('re-run is a no-op (idempotent)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-'));
    await seed('a', { foo: 1 });
    const first = await gf(home);
    expect(first.detail.touched).toBe(1);
    const second = await gf(home);
    expect(second.detail.touched).toBe(0);
  });

  test('dry-run counts without mutating', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-'));
    await seed('a', { foo: 1 });
    const { detail } = await gf(home, { dryRun: true });
    expect(detail.touched).toBe(1);
    expect((await fmOf('a'))?.validate ?? 'UNSET').toBe('UNSET');
  });

  test('large-N (1200 pages) completes via chunked pass (hang regression)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-'));
    for (let i = 0; i < 1200; i++) await seed(`bulk/${i}`, { i });
    const t0 = Date.now();
    const { result, detail } = await gf(home);
    expect(result.status).toBe('complete');
    expect(detail.touched).toBe(1200);
    expect((await fmOf('bulk/0'))?.validate).toBe(false);
    expect((await fmOf('bulk/1199'))?.validate).toBe(false);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });

  test('verify fails only for grandfathered pages still missing validate at the revision this run wrote', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gf-verify-'));
    try {
      await seed('kept', {});
      await seed('reimported', {});
      const { detail } = await gf(home);
      expect(detail.grandfathered.map(page => page.id).sort()).toEqual(
        [(await engine.getPage('kept'))!.id, (await engine.getPage('reimported'))!.id].sort());
      // A connector re-import during the run replaces the page and drops the flag.
      await seed('reimported', { connector: 'sync' });
      expect(await phaseDVerify(engine, detail.grandfathered)).toMatchObject({ status: 'complete', detail: 'verified=1 rewritten_concurrently=1' });
      // A claimed write that never landed: the recorded revision is current and the flag is absent.
      await seed('unwritten', {});
      const unwritten = (await engine.getPage('unwritten'))!;
      const failed = await phaseDVerify(engine, [...detail.grandfathered, { id: unwritten.id, revision: unwritten.knowledge_revision! }]);
      expect(failed.status).toBe('failed');
      expect(failed.detail).toBe(`verified=1 rewritten_concurrently=1 missing_validate=1 (page#${unwritten.id})`);
      // A receipt without a revision cannot prove a rewrite, so the flag must be present.
      const kept = (await engine.getPage('kept'))!;
      expect(await phaseDVerify(engine, [{ id: kept.id, revision: null }, { id: unwritten.id, revision: null }])).toMatchObject({
        status: 'failed', detail: `verified=1 rewritten_concurrently=0 missing_validate=1 (page#${unwritten.id})` });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
