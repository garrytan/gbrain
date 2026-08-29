/**
 * #4350 — `gbrain migrate` must carry the WHOLE brain, not just pages.
 *
 * Pre-fix, the engine migration copied pages/chunks/tags/timeline/links/
 * sources plus exactly three config keys. Everything else was silently
 * dropped: the facts table (hot memory — `recall` came back empty on the
 * new engine) and every other config row (`sync.repo_path` among them, so
 * the first `sync` on the new engine had to be re-pointed by hand).
 *
 * Pinned here:
 *  1. Facts migrate verbatim: ids, supersession chains (`superseded_by`
 *     self-FK where an OLD row points at a NEWER id), embeddings, and the
 *     id sequence (a post-migration insert must not collide).
 *  2. ALL config rows migrate except the explicit engine-local denylist
 *     (`version` = the target's own schema ledger; the physical-column
 *     registry keys) — and the denylist is skipped loudly, not silently.
 *  3. The run prints a per-table copied-count summary so any omission is
 *     visible instead of silent.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runMigrateEngine,
  copyMigrationFacts,
  copyMigrationConfig,
  MIGRATE_CONFIG_ENGINE_LOCAL_KEYS,
} from '../src/commands/migrate-engine.ts';
import { saveConfig } from '../src/core/config.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('runMigrateEngine — facts + config completeness (#4350)', () => {
  afterEach(() => {
    _resetCliExitVerdictForTests();
  });

  test('facts (chains, embeddings, sequence) and non-engine-local config rows arrive on the target', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-')), 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;
    const originalLog = console.log;

    let source: PGLiteEngine | null = null;
    let target: PGLiteEngine | null = null;

    try {
      // #427-style hermeticity: no live DATABASE_URL must leak into config
      // engine inference.
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('a-page', {
        type: 'note', title: 'A', compiled_truth: 'body', timeline: '', frontmatter: {},
      });

      // f1 → superseded by f3 (supersession sets the OLD row's superseded_by
      // to the NEW, HIGHER id — the exact ordering an id-ordered naive copy
      // would trip over on the self-FK). f2 carries an embedding.
      const f1 = await source.insertFact(
        { fact: 'user prefers dark mode', kind: 'preference', source: 'cli:think' },
        { source_id: 'default' },
      );
      const dim = parseInt((await source.getConfig('embedding_dimensions')) ?? '1536', 10);
      const emb = new Float32Array(dim);
      emb[0] = 0.5;
      emb[1] = -0.25;
      const f2 = await source.insertFact(
        { fact: 'user is based in lisbon', source: 'mcp:extract_facts', embedding: emb },
        { source_id: 'default' },
      );
      const f3 = await source.insertFact(
        { fact: 'user prefers light mode', kind: 'preference', source: 'cli:think' },
        { source_id: 'default', supersedeId: f1.id },
      );

      // Config rows the pre-fix allowlist dropped...
      await source.setConfig('sync.repo_path', '/tmp/example-vault');
      await source.setConfig('search.mode', 'tokenmax');
      // ...and engine-local rows that must NOT follow the data:
      // `version` is the schema-migration ledger — the target's own
      // initSchema owns it; a stale source value must not clobber it.
      await source.setConfig('version', '1');
      await source.setConfig('embedding_columns', '{"voyage": {"model": "voyage-3"}}');

      const logLines: string[] = [];
      console.log = (...args: unknown[]) => { logLines.push(args.join(' ')); };
      try {
        await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath]);
      } finally {
        console.log = originalLog;
      }
      expect(currentExitCode()).toBe(0);

      target = new PGLiteEngine();
      await target.connect({ database_path: targetDbPath });

      // 1. All three facts arrived, ids preserved.
      const rows = await target.executeRaw<{
        id: number | string;
        fact: string;
        expired_at: unknown;
        superseded_by: number | string | null;
        has_embedding: boolean;
      }>(`SELECT id, fact, expired_at, superseded_by,
                 (embedding IS NOT NULL) AS has_embedding
            FROM facts ORDER BY id`);
      expect(rows.length).toBe(3);
      expect(rows.map(r => Number(r.id))).toEqual([f1.id, f2.id, f3.id]);

      // Supersession chain intact: f1 expired and pointing at f3.
      expect(rows[0].expired_at).not.toBeNull();
      expect(Number(rows[0].superseded_by)).toBe(f3.id);
      // Embedding survived the copy.
      expect(rows[1].has_embedding).toBe(true);

      // 2. The id sequence advanced past the copied rows: a fresh insert on
      //    the target must not collide with a migrated id.
      const post = await target.insertFact(
        { fact: 'post-migration insert', source: 'cli:test' },
        { source_id: 'default' },
      );
      expect(post.status).toBe('inserted');
      expect(post.id).toBeGreaterThan(f3.id);

      // 3. Config rows arrived...
      expect(await target.getConfig('sync.repo_path')).toBe('/tmp/example-vault');
      expect(await target.getConfig('search.mode')).toBe('tokenmax');
      // ...while engine-local keys did not: the target keeps its own schema
      // ledger position (set by its own initSchema, i.e. the latest version),
      // and the physical-column registry does not advertise columns the
      // target database doesn't have.
      const { LATEST_VERSION } = await import('../src/core/migrate.ts');
      expect(await target.getConfig('version')).toBe(String(LATEST_VERSION));
      expect(await target.getConfig('embedding_columns')).toBeNull();

      // 4. The per-table summary makes the copy auditable: facts and config
      //    counts are printed, so a future omission is visible.
      const summary = logLines.join('\n');
      expect(summary).toMatch(/facts\s+3/);
      expect(summary).toMatch(/config rows\s+/);
    } finally {
      console.log = originalLog;
      if (source) await source.disconnect();
      if (target) await target.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, 60000);
});

describe('runMigrateEngine — facts-only foreign target guard', () => {
  afterEach(() => {
    _resetCliExitVerdictForTests();
  });

  test('a facts-only target (zero pages, no manifest) refuses instead of wiping facts', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-home-'));
    const targetDbPath = join(mkdtempSync(join(tmpdir(), 'gbrain-migrate-target-')), 'brain.pglite');
    const prevGbrainHome = process.env.GBRAIN_HOME;
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    const prevExitCode = process.exitCode;
    const originalLog = console.log;
    const originalError = console.error;

    let source: PGLiteEngine | null = null;
    let target: PGLiteEngine | null = null;

    try {
      delete process.env.DATABASE_URL;
      delete process.env.GBRAIN_DATABASE_URL;
      process.env.GBRAIN_HOME = gbrainHome;
      saveConfig({ engine: 'postgres', database_url: 'postgresql://unused/guard-only' });

      // Target: a DB-only remember corpus — zero pages, one conversation
      // fact. The page_count-only guard can't see it, so pre-fix the
      // migration proceeded and copyMigrationFacts's DELETE FROM facts
      // destroyed the target's only copy (conversation facts have no
      // markdown fence to re-sync from).
      target = new PGLiteEngine();
      await target.connect({ database_path: targetDbPath });
      await target.initSchema();
      const kept = await target.insertFact(
        { fact: 'target-only conversation memory', kind: 'preference', source: 'cli:think' },
        { source_id: 'default' },
      );
      await target.disconnect();
      target = null;

      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      await source.putPage('a-page', {
        type: 'note', title: 'A', compiled_truth: 'body', timeline: '', frontmatter: {},
      });
      await source.insertFact(
        { fact: 'source fact that must NOT replace target memory', source: 'cli:think' },
        { source_id: 'default' },
      );

      const errLines: string[] = [];
      console.log = () => {};
      console.error = (...args: unknown[]) => { errLines.push(args.join(' ')); };
      try {
        await runMigrateEngine(source, ['--to', 'pglite', '--path', targetDbPath]);
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }

      // Refused with the same shape as the page guard: non-zero verdict +
      // the actionable overwrite/empty-brain message.
      expect(currentExitCode()).toBe(1);
      const stderr = errLines.join('\n');
      expect(stderr).toContain('not empty');
      expect(stderr).toContain('facts');
      expect(stderr).toContain('--force');

      // The destructive delete never ran: the target's memory survives
      // verbatim and nothing from the source landed.
      target = new PGLiteEngine();
      await target.connect({ database_path: targetDbPath });
      const facts = await target.executeRaw<{ id: number | string; fact: string }>(
        'SELECT id, fact FROM facts ORDER BY id',
      );
      expect(facts.length).toBe(1);
      expect(Number(facts[0].id)).toBe(kept.id);
      expect(facts[0].fact).toBe('target-only conversation memory');
      const pages = await target.executeRaw<{ n: number | string }>('SELECT COUNT(*) AS n FROM pages');
      expect(Number(pages[0].n)).toBe(0);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      if (source) await source.disconnect();
      if (target) await target.disconnect();
      _resetCliExitVerdictForTests();
      process.exitCode = prevExitCode;
      if (prevGbrainHome !== undefined) process.env.GBRAIN_HOME = prevGbrainHome; else delete process.env.GBRAIN_HOME;
      if (prevDatabaseUrl !== undefined) process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevGbrainDatabaseUrl !== undefined) process.env.GBRAIN_DATABASE_URL = prevGbrainDatabaseUrl;
      rmSync(gbrainHome, { recursive: true, force: true });
      rmSync(join(targetDbPath, '..'), { recursive: true, force: true });
    }
  }, 60000);
});

describe('copyMigrationFacts — convergence and schema tolerance (#4350)', () => {
  test('re-copy converges the target to source truth and an older source schema (missing columns) still copies', async () => {
    let source: PGLiteEngine | null = null;
    let target: PGLiteEngine | null = null;
    try {
      source = new PGLiteEngine();
      await source.connect({});
      await source.initSchema();
      target = new PGLiteEngine();
      await target.connect({});
      await target.initSchema();

      // Simulate a source brain whose schema predates newer fact columns:
      // the copy must intersect on the columns both sides actually have.
      await source.executeRaw('ALTER TABLE facts DROP COLUMN event_type');

      await source.insertFact({ fact: 'alpha', source: 'cli:think' }, { source_id: 'default' });
      await source.insertFact({ fact: 'beta', source: 'cli:think' }, { source_id: 'default' });

      // A stale row on the target (e.g. left by a prior partial run whose
      // source has since changed) must not survive the re-copy.
      await target.insertFact({ fact: 'stale leftover', source: 'cli:think' }, { source_id: 'default' });

      const first = await copyMigrationFacts(source, target);
      expect(first.copied).toBe(2);
      expect(first.failed.length).toBe(0);

      const factsOnTarget = async () => (await target!.executeRaw<{ fact: string }>(
        'SELECT fact FROM facts ORDER BY id',
      )).map(r => r.fact);
      expect(await factsOnTarget()).toEqual(['alpha', 'beta']);

      // Idempotent: running the copy again converges to the same state.
      const second = await copyMigrationFacts(source, target);
      expect(second.copied).toBe(2);
      expect(await factsOnTarget()).toEqual(['alpha', 'beta']);
    } finally {
      if (source) await source.disconnect();
      if (target) await target.disconnect();
    }
  }, 60000);
});

describe('copyMigrationConfig — copy-all with an explicit engine-local denylist (#4350)', () => {
  test('every row copies except denylisted keys, which are reported as skipped', async () => {
    const sourceRows = [
      { key: 'embedding_columns', value: '{}' },
      { key: 'engine', value: 'pglite' },
      { key: 'search.mode', value: 'balanced' },
      { key: 'search_embedding_column', value: 'embedding_voyage' },
      { key: 'sync.repo_path', value: '/tmp/vault' },
      { key: 'version', value: '99' },
    ];
    const source = {
      executeRaw: async () => sourceRows,
    } as unknown as BrainEngine;
    const writes: Array<[string, string]> = [];
    const target = {
      setConfig: async (key: string, value: string) => { writes.push([key, value]); },
    } as unknown as BrainEngine;

    const result = await copyMigrationConfig(source, target);
    expect(result.copied).toBe(2);
    expect([...result.skipped].sort()).toEqual(['embedding_columns', 'engine', 'search_embedding_column', 'version']);
    expect(writes).toEqual([
      ['search.mode', 'balanced'],
      ['sync.repo_path', '/tmp/vault'],
    ]);
    // Every skipped key must come from the exported denylist — nothing is
    // dropped that isn't explicitly declared engine-local.
    for (const key of result.skipped) {
      expect(MIGRATE_CONFIG_ENGINE_LOCAL_KEYS.has(key)).toBe(true);
    }
  });
});
