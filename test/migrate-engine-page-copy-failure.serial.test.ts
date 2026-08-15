/**
 * #3194 — `gbrain migrate` must not silently drop pages while reporting
 * success.
 *
 * Two things are pinned here:
 *
 *  1. `copyPageToTarget` normalizes JS `undefined` column values to an
 *     explicit `null` before handing them to `target.putPage`. PGLite can
 *     hand back `undefined` for a column that is legitimately NULL/empty;
 *     postgres.js's `UNDEFINED_VALUE` guard rejects a raw `undefined` bound
 *     parameter (but accepts `null` fine). Without this normalization, a
 *     migrated page carrying an `undefined` field throws mid-insert.
 *
 *  2. `runMigrateEngine`'s per-page copy loop must not let an unrecoverable
 *     per-page failure disappear into the success count: the failed page
 *     must be excluded from the resume manifest's `completed_slugs` (so a
 *     retry picks it back up) and the run must end with a non-zero CLI exit
 *     verdict instead of looking identical to a clean migration.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPageToTarget, runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { saveConfig, loadConfigFileOnly } from '../src/core/config.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';

function fakePage(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug: 'test-page',
    type: 'note',
    title: 'a title',
    compiled_truth: 'body',
    timeline: '',
    frontmatter: {},
    source_id: 'default',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('copyPageToTarget — undefined-column normalization (#3194)', () => {
  test('undefined page fields become explicit null before reaching target.putPage', async () => {
    const putPageCalls: unknown[] = [];
    const target = {
      putPage: async (slug: string, page: unknown, opts: unknown) => {
        putPageCalls.push({ slug, page, opts });
        return fakePage();
      },
    } as unknown as BrainEngine;
    const source = {
      getChunksWithEmbeddings: async () => [],
      getTags: async () => [],
      getTimeline: async () => [],
      getRawData: async () => [],
    } as unknown as BrainEngine;

    // Simulate the exact PGLite read-side shape from #3194: a page whose
    // `type` / `compiled_truth` / `content_hash` came back `undefined`
    // (legitimately NULL/absent on the source) rather than an empty string
    // or explicit `null`.
    const page = fakePage({
      type: undefined as unknown as string,
      compiled_truth: undefined as unknown as string,
      content_hash: undefined,
    });

    await copyPageToTarget(source, target, page);

    expect(putPageCalls.length).toBe(1);
    const call = putPageCalls[0] as { slug: string; page: Record<string, unknown>; opts: unknown };
    expect(call.slug).toBe('test-page');
    // The driver-shape `undefined` must have become an explicit SQL NULL...
    expect(call.page.type).toBeNull();
    expect(call.page.compiled_truth).toBeNull();
    expect(call.page.content_hash).toBeNull();
    // ...while legitimately-populated fields pass through untouched.
    expect(call.page.title).toBe('a title');
    expect(call.opts).toEqual({ sourceId: 'default' });
  });

  test('already-null / already-populated fields are left as-is (no double-mapping)', async () => {
    const putPageCalls: unknown[] = [];
    const target = {
      putPage: async (slug: string, page: unknown, opts: unknown) => {
        putPageCalls.push({ slug, page, opts });
        return fakePage();
      },
    } as unknown as BrainEngine;
    const source = {
      getChunksWithEmbeddings: async () => [],
      getTags: async () => [],
      getTimeline: async () => [],
      getRawData: async () => [],
    } as unknown as BrainEngine;

    const page = fakePage({ content_hash: 'abc123' });
    await copyPageToTarget(source, target, page);

    const call = putPageCalls[0] as { page: Record<string, unknown> };
    expect(call.page.content_hash).toBe('abc123');
    expect(call.page.type).toBe('note');
  });
});

describe('runMigrateEngine — per-page failures are surfaced, not swallowed (#3194)', () => {
  afterEach(() => {
    _resetCliExitVerdictForTests();
  });

  test('a page whose target write throws is excluded from the resume manifest and flips the exit verdict', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-')), 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;

    let source: PGLiteEngine | null = null;
    let verifyEngine: PGLiteEngine | null = null;
    const originalPutPage = PGLiteEngine.prototype.putPage;

    try {
      // #427-style hermeticity: no live DATABASE_URL must leak into the
      // config engine-inference logic (would force engine='postgres' with
      // database_path cleared, unrelated to what we're testing here).
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;

      // `runMigrateEngine`'s only use of the on-disk config is the
      // "already using this engine" guard + preserving unrelated file-plane
      // settings; it never reconnects using it (the caller-supplied
      // `sourceEngine` instance is used directly). engine='postgres' here
      // just satisfies "config.engine !== --to pglite" so the guard passes.
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('good-page', {
        type: 'note', title: 'Good', compiled_truth: 'good body', timeline: '', frontmatter: {},
      });
      await source.putPage('bad-page', {
        type: 'note', title: 'Bad', compiled_truth: 'bad body', timeline: '', frontmatter: {},
      });

      // Fault injection: the target's putPage throws for exactly one slug,
      // simulating the real #3194 failure mode (a per-page write that
      // can't land on the target) without needing a live Postgres target.
      PGLiteEngine.prototype.putPage = async function (
        this: PGLiteEngine,
        slug: string,
        page: Parameters<typeof originalPutPage>[1],
        opts?: Parameters<typeof originalPutPage>[2],
      ) {
        if (slug === 'bad-page') {
          throw new Error('simulated unrecoverable write failure for bad-page');
        }
        return originalPutPage.call(this, slug, page, opts);
      };

      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath]);

      // 1. Exit verdict must reflect the partial failure.
      expect(currentExitCode()).toBe(1);

      // 2. The resume manifest must exist (not cleared) and must exclude
      //    the failed page while including the successful one.
      const manifestPath = join(gbrainHome, '.gbrain', 'migrate-manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { completed_slugs: string[] };
      expect(manifest.completed_slugs).toContain('good-page');
      expect(manifest.completed_slugs).not.toContain('bad-page');

      // 3. The target actually has the good page and does NOT have the bad
      //    one — i.e. the bad page did not silently vanish while counted
      //    as copied.
      verifyEngine = new PGLiteEngine();
      await verifyEngine.connect({ database_path: targetDbPath });
      expect(await verifyEngine.getPage('good-page')).not.toBeNull();
      expect(await verifyEngine.getPage('bad-page')).toBeNull();
      await verifyEngine.disconnect();
      verifyEngine = null;

      // 4. A partial run must NOT flip the active config onto the
      //    incomplete target — otherwise every subsequent `gbrain`
      //    invocation would silently start using a brain missing pages,
      //    AND the natural retry below would hit the "already using X"
      //    guard instead of actually resuming.
      expect(loadConfigFileOnly()?.engine).toBe('postgres');

      // 5. Resume: fix the fault, re-run the SAME command with no --force.
      //    This must not hit the "target brain is not empty" guard (the
      //    target already has `good-page` from the run above) and must
      //    NOT re-wipe/lose `good-page` — only the previously-failed page
      //    should be (re-)written.
      _resetCliExitVerdictForTests();
      PGLiteEngine.prototype.putPage = originalPutPage;
      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath]);

      expect(currentExitCode()).toBe(0);
      expect(existsSync(manifestPath)).toBe(false); // clean run clears the manifest
      expect(loadConfigFileOnly()?.engine).toBe('pglite'); // now safe to switch

      verifyEngine = new PGLiteEngine();
      await verifyEngine.connect({ database_path: targetDbPath });
      expect(await verifyEngine.getPage('good-page')).not.toBeNull();
      expect(await verifyEngine.getPage('bad-page')).not.toBeNull();
    } finally {
      PGLiteEngine.prototype.putPage = originalPutPage;
      if (source) await source.disconnect();
      if (verifyEngine) await verifyEngine.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, 30000);

  test('a run where every page fails AFTER putPage lands still writes a manifest — no --force needed to resume', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-')), 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;

    let source: PGLiteEngine | null = null;
    let verifyEngine: PGLiteEngine | null = null;
    const originalGetRawData = PGLiteEngine.prototype.getRawData;

    try {
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('only-page', {
        type: 'note', title: 'Only', compiled_truth: 'only body', timeline: '', frontmatter: {},
      });

      // Fault injection: the SOURCE's getRawData throws — this runs AFTER
      // putPage has already landed the row on the target, so the page's
      // copy fails mid-way rather than before anything was written.
      // completed_slugs therefore never gets an entry for it.
      PGLiteEngine.prototype.getRawData = async function (
        this: PGLiteEngine,
        slug: string,
        rdSource?: string,
        opts?: { sourceId?: string },
      ) {
        if (slug === 'only-page') throw new Error('simulated post-putPage failure');
        return originalGetRawData.call(this, slug, rdSource, opts);
      };

      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath]);
      expect(currentExitCode()).toBe(1);

      // The target actually has the row (putPage succeeded) even though
      // the whole page-copy was counted as failed.
      verifyEngine = new PGLiteEngine();
      await verifyEngine.connect({ database_path: targetDbPath });
      expect(await verifyEngine.getPage('only-page')).not.toBeNull();
      await verifyEngine.disconnect();
      verifyEngine = null;

      // The manifest file must exist on disk (with an empty completed_slugs)
      // even though not a single page fully succeeded — otherwise the next
      // invocation can't tell this was a resumable in-progress migration
      // and would hit the non-empty guard demanding --force.
      const manifestPath = join(gbrainHome, '.gbrain', 'migrate-manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { completed_slugs: string[] };
      expect(manifest.completed_slugs).toEqual([]);

      // Retry with no --force: must resume cleanly (not hit the "target
      // brain is not empty" abort) since a matching manifest is present.
      _resetCliExitVerdictForTests();
      PGLiteEngine.prototype.getRawData = originalGetRawData;
      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath]);
      expect(currentExitCode()).toBe(0);
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      PGLiteEngine.prototype.getRawData = originalGetRawData;
      if (source) await source.disconnect();
      if (verifyEngine) await verifyEngine.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, 30000);

  test('--force always resets the manifest, even when the target looks empty (stale manifest from a recreated target)', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-'));
    const targetDbPath = join(targetDir, 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;

    let source: PGLiteEngine | null = null;
    let verifyEngine: PGLiteEngine | null = null;

    try {
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('real-page', {
        type: 'note', title: 'Real', compiled_truth: 'real body', timeline: '', frontmatter: {},
      });

      // Simulate a stale manifest surviving a target that was recreated
      // out-of-band (e.g. the operator deleted/rebuilt the target DB file
      // but ~/.gbrain/migrate-manifest.json was left behind): a manifest
      // matching this exact target_id claims `real-page` is already done,
      // even though the target directory is otherwise fresh/empty.
      const { migrationTargetId } = await import('../src/commands/migrate-engine.ts');
      const targetId = migrationTargetId({ engine: 'pglite', database_path: targetDbPath });
      const manifestPath = join(gbrainHome, '.gbrain', 'migrate-manifest.json');
      const fakeStaleManifest = {
        completed_slugs: ['real-page'],
        target_engine: 'pglite',
        target_id: targetId,
        schema_version: 2,
        started_at: new Date().toISOString(),
      };
      const { mkdirSync, writeFileSync } = await import('fs');
      mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(fakeStaleManifest, null, 2));

      // --force on an empty target must NOT trust that stale manifest —
      // `real-page` must actually get copied, not skipped as "already done".
      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath, '--force']);
      expect(currentExitCode()).toBe(0);

      verifyEngine = new PGLiteEngine();
      await verifyEngine.connect({ database_path: targetDbPath });
      expect(await verifyEngine.getPage('real-page')).not.toBeNull();
    } finally {
      if (source) await source.disconnect();
      if (verifyEngine) await verifyEngine.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  }, 30000);
});
