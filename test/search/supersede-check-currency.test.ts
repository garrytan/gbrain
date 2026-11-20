/**
 * Search must never show a replaced page as current without saying so.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: (a) when the check for "a newer page supersedes this one" fails (a statement
 *     timeout, a dropped connection), search/query meta carries the degraded stage
 *     `supersede_check_failed` and the CLI renders the degraded-recall notice, instead of
 *     ranking the outdated page first with no flag and no marker; (b) a `supersedes` link added
 *     while the process keeps serving takes effect on the very next search.
 *  2. Regression: `readSupersededBy`'s silent catch (the failure became an empty map) and the
 *     5-minute memo of a negative "no supersedes edge exists" probe.
 *  3. Existing coverage misses it: supersede-downrank.test.ts pins the memo (an edge minted inside
 *     the TTL "is skipped") and fail-open without a marker; no test reads the failure from
 *     meta.degraded or runs add-link between two searches in one process.
 *  4. Seam: engine.supersedingPageSlugs is patched to throw SQLSTATE 57014, as
 *     keyword-arm-timeout-cli-7171.test.ts does for the keyword arm. Real PGLite brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { applyCliOpNotices, captureRetrievalNotices } from '../../src/cli/op-notices.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { hybridSearch, _resetSupersedeProbeForTests } from '../../src/core/search/hybrid.ts';

const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

describe('supersession check currency (PGLite)', () => {
  let engine: PGLiteEngine;
  let meta: Record<string, unknown> | null = null;
  const ctx = {
    get engine() { return engine; }, remote: false, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} }, emitNotice() {},
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') meta = value as Record<string, unknown>; },
  } as unknown as OperationContext;
  const realSupersedingPageSlugs = PGLiteEngine.prototype.supersedingPageSlugs;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { if (engine) await engine.disconnect(); });

  beforeEach(async () => {
    _resetSupersedeProbeForTests();
    engine.supersedingPageSlugs = realSupersedingPageSlugs;
    for (const slug of ['notes/pricing-v1', 'notes/pricing-v2']) await engine.deletePage(slug).catch(() => undefined);
    await importFromContent(engine, 'notes/pricing-v1', '# Pricing v1\n\nThe tapirword fee is 10.');
    await importFromContent(engine, 'notes/pricing-v2', '# Pricing v2\n\nThe tapirword fee is 20 now.');
  });

  const slugs = (rows: Array<{ slug: string }>) => rows.map(r => r.slug);

  test('a healthy search flags the outdated page and ranks it below (control)', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(slugs(rows)[0]).toBe('notes/pricing-v2');
    expect(rows.find(r => r.slug === 'notes/pricing-v1')).toMatchObject({ superseded: true, superseded_by: 'notes/pricing-v2' });
  });

  test('a failed supersession check reports supersede_check_failed (timeout) in hybridSearch meta', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    engine.supersedingPageSlugs = async () => { throw statementTimeout(); };
    let degraded: Array<{ stage: string; reason?: string }> = [];
    const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
    expect(rows.length).toBe(2);
    expect(degraded).toContainEqual({ stage: 'supersede_check_failed', reason: 'timeout' });
  });

  test('the marker only adds information: a failed check returns the same rows as a healthy search without the marker', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    const healthy = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    engine.supersedingPageSlugs = async () => { throw statementTimeout(); };
    const failed = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(slugs(failed).sort()).toEqual(slugs(healthy).sort());
    expect(failed.some(r => r.superseded === true)).toBe(false);
  });

  test('any other read error reports reason provider_error, and no raw error text reaches the marker', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    engine.supersedingPageSlugs = async () => { throw new Error('connection terminated postgres://user:secret@internal-host/db'); };
    let degraded: Array<{ stage: string; reason?: string }> = [];
    await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
    expect(degraded).toContainEqual({ stage: 'supersede_check_failed', reason: 'provider_error' });
    expect(JSON.stringify(degraded)).not.toContain('secret');
  });

  test('a brain whose links table does not exist yet stays silent (no edges can exist)', async () => {
    engine.supersedingPageSlugs = async () => { throw Object.assign(new Error('relation "links" does not exist'), { code: '42P01' }); };
    let degraded: Array<{ stage: string }> = [];
    const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
    expect(rows.length).toBe(2);
    expect(degraded.map(d => d.stage)).not.toContain('supersede_check_failed');
  });

  test('a healthy search with no supersedes edge reports nothing', async () => {
    let degraded: Array<{ stage: string }> = [];
    await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
    expect(degraded.map(d => d.stage)).not.toContain('supersede_check_failed');
  });

  for (const name of ['search', 'query'] as const) {
    test(`${name}: _meta.degraded names the stage and the CLI notice says results may include outdated pages`, async () => {
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      engine.supersedingPageSlugs = async () => { throw statementTimeout(); };
      meta = null;
      const params = { query: 'tapirword', use_cache: false, ...(name === 'query' ? { expand: false } : {}) };
      const rows = await operationsByName[name].handler(ctx, params) as Array<{ slug: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(meta!.degraded).toContainEqual({ stage: 'supersede_check_failed', reason: 'timeout' });
      captureRetrievalNotices(name, rows, meta, params, ctx.config);
      const { result, stderr } = applyCliOpNotices(rows, true);
      expect(Array.isArray(result)).toBe(true);
      expect(stderr).toContain('supersede_check_failed');
      expect(stderr).toMatch(/outdated/);
    });
  }

  test('one process: search before any supersedes link, add the link, search again — the outdated page is flagged and ranks below', async () => {
    const first = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(first.every(r => r.superseded !== true)).toBe(true);
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    const second = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(slugs(second)[0]).toBe('notes/pricing-v2');
    expect(second.find(r => r.slug === 'notes/pricing-v1')).toMatchObject({ superseded: true, superseded_by: 'notes/pricing-v2' });
  });

  for (const name of ['search', 'query'] as const) {
    test(`${name} (default cache): a link added between two calls reorders the second call`, async () => {
      const params = { query: 'tapirword', ...(name === 'query' ? { expand: false } : {}) };
      const before = await operationsByName[name].handler(ctx, params) as Array<{ slug: string; superseded?: boolean }>;
      expect(before.every(r => r.superseded !== true)).toBe(true);
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      const after = await operationsByName[name].handler(ctx, params) as Array<{ slug: string; superseded?: boolean }>;
      expect(slugs(after)[0]).toBe('notes/pricing-v2');
      expect(after.find(r => r.slug === 'notes/pricing-v1')?.superseded).toBe(true);
    });
  }

  test('a link written by another process (straight into the table) is seen at once, with no in-process write to invalidate', async () => {
    await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    const [from] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'notes/pricing-v2'`);
    const [to] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'notes/pricing-v1'`);
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'supersedes', 'manual')`,
      [from!.id, to!.id],
    );
    const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(slugs(rows)[0]).toBe('notes/pricing-v2');
    expect(rows.find(r => r.slug === 'notes/pricing-v1')?.superseded).toBe(true);
  });
});
