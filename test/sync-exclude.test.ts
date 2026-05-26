/**
 * v0.40.9.0 `.gbrainignore` + --exclude + sources.config.excludePatterns
 * end-to-end coverage.
 *
 * IRON RULE — these four cases MUST stay green; the plan-eng-review
 * REGRESSION-CRITICAL gate calls them out:
 *   - Reconciliation safety guard >50% ratio blocks deletion
 *   - Reconciliation safety guard >1000 absolute blocks deletion
 *   - Negation-aware descent-prune fallback walks dirs when `!` present (A3)
 *   - Autopilot cycle path honors cfg.excludePatterns + cfg.strategy (A1)
 *
 * Plus the smaller positive cases that pin the wiring contracts. PGLite
 * in-memory; no DATABASE_URL. Hermetic temp git repos drive performSync
 * end-to-end so the test exercises real git state + the diff path.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { resolveExclusions, _resetGbrainignoreCache } from '../src/core/gbrainignore.ts';
import { addSource as opsAddSource, updateSource as opsUpdateSource } from '../src/core/sources-ops.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let tmp: string;

function initGitRepo(dir: string): void {
  execSync('git init --quiet', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
}

function commitAll(dir: string, message: string): void {
  execSync('git add -A', { cwd: dir });
  execSync(`git commit --quiet --allow-empty -m "${message}"`, { cwd: dir });
}

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
  _resetGbrainignoreCache();
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-sync-exclude-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── Walker / collectSyncableFiles wiring ─────────────────────────────────────

describe('collectSyncableFiles with ignoreMatcher (walker wiring)', () => {
  test('respects .gbrainignore: data/ dir skipped at descent', () => {
    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n');
    writeFileSync(join(tmp, 'notes.md'), '# notes\n');
    mkdirSync(join(tmp, 'data'), { recursive: true });
    writeFileSync(join(tmp, 'data', 'excluded.md'), '# excluded\n');
    writeFileSync(join(tmp, 'data', 'also-excluded.md'), '# excluded2\n');
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'kept.md'), '# kept\n');

    const matcher = resolveExclusions({ repoPath: tmp });
    const files = collectSyncableFiles(tmp, {
      strategy: 'markdown',
      ignoreMatcher: matcher,
    });

    expect(files).toContain(join(tmp, 'notes.md'));
    expect(files).toContain(join(tmp, 'src', 'kept.md'));
    expect(files).not.toContain(join(tmp, 'data', 'excluded.md'));
    expect(files).not.toContain(join(tmp, 'data', 'also-excluded.md'));
  });

  test('A3 IRON RULE: negation pattern forces dir to be walked, not pruned', () => {
    // Without the safeForDescentPrune guard, walker would short-circuit
    // descent into data/ and miss data/keep.md. With the guard, dir is
    // walked and per-file matcher check rescues keep.md.
    writeFileSync(join(tmp, '.gbrainignore'), 'data/*\n!data/keep.md\n');
    mkdirSync(join(tmp, 'data'), { recursive: true });
    writeFileSync(join(tmp, 'data', 'skip.md'), '# skip\n');
    writeFileSync(join(tmp, 'data', 'keep.md'), '# rescued by negation\n');

    const matcher = resolveExclusions({ repoPath: tmp });
    expect(matcher.safeForDescentPrune).toBe(false); // negation present

    const files = collectSyncableFiles(tmp, {
      strategy: 'markdown',
      ignoreMatcher: matcher,
    });

    expect(files).toContain(join(tmp, 'data', 'keep.md'));
    expect(files).not.toContain(join(tmp, 'data', 'skip.md'));
  });

  test('descent-prune optimization fires when safe (no negations)', () => {
    // Smoke check that the fast path runs. We can't easily count readdir
    // calls without monkey-patching fs, but we can assert behavior: a
    // file UNDER an excluded dir is never emitted, and the matcher
    // reports descent-prune safe.
    writeFileSync(join(tmp, '.gbrainignore'), 'vendor/\n');
    mkdirSync(join(tmp, 'vendor', 'deep', 'deeper'), { recursive: true });
    writeFileSync(join(tmp, 'vendor', 'deep', 'deeper', 'bury.md'), '# buried\n');
    writeFileSync(join(tmp, 'top.md'), '# top\n');

    const matcher = resolveExclusions({ repoPath: tmp });
    expect(matcher.safeForDescentPrune).toBe(true);
    const files = collectSyncableFiles(tmp, {
      strategy: 'markdown',
      ignoreMatcher: matcher,
    });
    expect(files).toContain(join(tmp, 'top.md'));
    expect(files.some((f) => f.includes('vendor/'))).toBe(false);
  });

  test('no .gbrainignore = backward-compatible (every syncable file emitted)', () => {
    writeFileSync(join(tmp, 'a.md'), '# a\n');
    mkdirSync(join(tmp, 'data'));
    writeFileSync(join(tmp, 'data', 'b.md'), '# b\n');

    const matcher = resolveExclusions({ repoPath: tmp });
    const files = collectSyncableFiles(tmp, {
      strategy: 'markdown',
      ignoreMatcher: matcher,
    });
    expect(files).toContain(join(tmp, 'a.md'));
    expect(files).toContain(join(tmp, 'data', 'b.md'));
  });
});

// ── performSync full-pipeline wiring ─────────────────────────────────────────

describe('performSync with exclusion layers (E2E)', () => {
  test('first sync honors .gbrainignore — excluded files never land as pages', async () => {
    initGitRepo(tmp);

    // Source plus a few syncable + excluded files, plus the dotfile.
    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n*.parquet\n');
    writeFileSync(join(tmp, 'notes.md'), '# kept\n');
    mkdirSync(join(tmp, 'data'));
    writeFileSync(join(tmp, 'data', 'orphan.md'), '# excluded\n');
    writeFileSync(join(tmp, 'big.parquet'), 'binary data');
    commitAll(tmp, 'initial');

    await opsAddSource(engine, {
      id: 'repo-a',
      localPath: tmp,
    });

    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-a',
      noPull: true,
      noEmbed: true,
      full: true,
    });

    const pages = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 ORDER BY slug`,
      ['repo-a'],
    );
    const slugs = pages.map((r) => r.slug);
    expect(slugs.some((s) => s.includes('notes'))).toBe(true);
    expect(slugs.some((s) => s.includes('orphan') || s.includes('data/'))).toBe(false);
  });

  test('CLI excludePatterns override + dotfile compose additively', async () => {
    initGitRepo(tmp);
    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n');
    writeFileSync(join(tmp, 'notes.md'), '# kept\n');
    mkdirSync(join(tmp, 'data'));
    writeFileSync(join(tmp, 'data', 'd.md'), '# from data\n');
    mkdirSync(join(tmp, 'tmp'));
    writeFileSync(join(tmp, 'tmp', 't.md'), '# from tmp\n');
    commitAll(tmp, 'initial');

    await opsAddSource(engine, { id: 'repo-b', localPath: tmp });

    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-b',
      noPull: true,
      noEmbed: true,
      full: true,
      excludePatterns: ['tmp/'], // CLI: also exclude tmp
    });

    const pages = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 ORDER BY slug`,
      ['repo-b'],
    );
    const slugs = pages.map((r) => r.slug);
    expect(slugs.some((s) => s.includes('notes'))).toBe(true);
    expect(slugs.some((s) => s.includes('tmp/'))).toBe(false);
    expect(slugs.some((s) => s.includes('data/'))).toBe(false);
  });

  test('source.config.excludePatterns honored alongside dotfile', async () => {
    initGitRepo(tmp);
    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n');
    writeFileSync(join(tmp, 'notes.md'), '# kept\n');
    mkdirSync(join(tmp, 'fixtures'));
    writeFileSync(join(tmp, 'fixtures', 'f.md'), '# from fixtures\n');
    commitAll(tmp, 'initial');

    await opsAddSource(engine, {
      id: 'repo-c',
      localPath: tmp,
      excludePatterns: ['fixtures/'],
    });

    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-c',
      noPull: true,
      noEmbed: true,
      full: true,
    });

    const pages = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1`,
      ['repo-c'],
    );
    const slugs = pages.map((r) => r.slug);
    expect(slugs.some((s) => s.includes('notes'))).toBe(true);
    expect(slugs.some((s) => s.includes('fixtures'))).toBe(false);
  });

  test('A2: reconciliation pass deletes orphan pages when patterns change', async () => {
    initGitRepo(tmp);
    // 10 keeper files + 2 excluded files = 20% deletion ratio (under 50%
    // safety guard) so reconciliation can proceed without forceReconcile.
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(tmp, `notes${i}.md`), `# notes ${i}\n`);
    }
    mkdirSync(join(tmp, 'data'));
    writeFileSync(join(tmp, 'data', 'one.md'), '# one\n');
    writeFileSync(join(tmp, 'data', 'two.md'), '# two\n');
    commitAll(tmp, 'initial');

    await opsAddSource(engine, { id: 'repo-d', localPath: tmp });

    // First sync: no dotfile, everything indexed.
    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-d',
      noPull: true,
      noEmbed: true,
      full: true,
    });

    let count = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      ['repo-d'],
    );
    expect(count[0].n).toBe(12);

    // Add the dotfile (no git commit, just a working-tree edit) so the
    // diff manifest is empty AND patterns hash changes. Reconciliation
    // is the only thing that can catch these orphans.
    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n');
    _resetGbrainignoreCache(); // mtime cache busts on real edits; force reset

    // Second sync.
    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-d',
      noPull: true,
      noEmbed: true,
    });

    count = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      ['repo-d'],
    );
    // 10 notes files remain; 2 data/*.md reaped by reconciliation.
    expect(count[0].n).toBe(10);
  });

  test('A2 IRON RULE: >50% deletion ratio trips safety guard without forceReconcile', async () => {
    initGitRepo(tmp);
    // Three files; about to be 100% excluded — far over the 50% guard.
    mkdirSync(join(tmp, 'data'));
    writeFileSync(join(tmp, 'data', 'a.md'), '# a\n');
    writeFileSync(join(tmp, 'data', 'b.md'), '# b\n');
    writeFileSync(join(tmp, 'data', 'c.md'), '# c\n');
    commitAll(tmp, 'initial');

    await opsAddSource(engine, { id: 'repo-e', localPath: tmp });
    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-e',
      noPull: true,
      noEmbed: true,
      full: true,
    });

    let count = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      ['repo-e'],
    );
    const before = count[0].n;
    expect(before).toBeGreaterThan(0);

    // Now add a dotfile that would wipe everything (100% > 50% guard).
    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n');
    _resetGbrainignoreCache();

    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-e',
      noPull: true,
      noEmbed: true,
      // forceReconcile: undefined ← the safety guard fires
    });

    // Pages survive — safety guard refused the cleanup.
    count = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      ['repo-e'],
    );
    expect(count[0].n).toBe(before);
  });

  test('A2 IRON RULE: forceReconcile=true bypasses the safety guard', async () => {
    initGitRepo(tmp);
    mkdirSync(join(tmp, 'data'));
    writeFileSync(join(tmp, 'data', 'a.md'), '# a\n');
    writeFileSync(join(tmp, 'data', 'b.md'), '# b\n');
    commitAll(tmp, 'initial');

    await opsAddSource(engine, { id: 'repo-f', localPath: tmp });
    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-f',
      noPull: true,
      noEmbed: true,
      full: true,
    });

    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n');
    _resetGbrainignoreCache();

    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-f',
      noPull: true,
      noEmbed: true,
      forceReconcile: true, // ← user explicitly opted in via --yes
    });

    const count = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      ['repo-f'],
    );
    // forceReconcile lets the deletion proceed.
    expect(count[0].n).toBe(0);
  });

  test('A2 fast path: reconciliation skipped when patterns hash unchanged', async () => {
    initGitRepo(tmp);
    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n');
    writeFileSync(join(tmp, 'notes.md'), '# kept\n');
    commitAll(tmp, 'initial');

    await opsAddSource(engine, { id: 'repo-g', localPath: tmp });

    // First sync writes the hash.
    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-g',
      noPull: true,
      noEmbed: true,
      full: true,
    });

    const cfgRows = await engine.executeRaw<{ config: unknown }>(
      `SELECT config FROM sources WHERE id = $1`,
      ['repo-g'],
    );
    const cfg =
      typeof cfgRows[0]?.config === 'string'
        ? (JSON.parse(cfgRows[0].config as string) as Record<string, unknown>)
        : ((cfgRows[0]?.config ?? {}) as Record<string, unknown>);
    const firstHash = cfg.excludePatternsHash;
    expect(typeof firstHash).toBe('string');

    // Second sync with no pattern change: hash should stay identical.
    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-g',
      noPull: true,
      noEmbed: true,
    });

    const after = await engine.executeRaw<{ config: unknown }>(
      `SELECT config FROM sources WHERE id = $1`,
      ['repo-g'],
    );
    const afterCfg =
      typeof after[0]?.config === 'string'
        ? (JSON.parse(after[0].config as string) as Record<string, unknown>)
        : ((after[0]?.config ?? {}) as Record<string, unknown>);
    expect(afterCfg.excludePatternsHash).toBe(firstHash);
  });

  test('reconciliation handles 1000+ rows by streaming in batches (P1 wiring)', async () => {
    initGitRepo(tmp);
    // Seed > 1000 pages so we cross at least one BATCH_SIZE boundary.
    // Far cheaper than committing 1000 markdown files — insert directly.
    await opsAddSource(engine, { id: 'repo-h', localPath: tmp });

    // Make a small repo on disk so performSync's git probe doesn't choke.
    writeFileSync(join(tmp, 'notes.md'), '# stub\n');
    commitAll(tmp, 'initial');

    const BATCH = 1100;
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < BATCH; i++) {
      const idx = i * 2;
      // Columns mirror src/core/pglite-schema.ts pages table — slug, type,
      // title, compiled_truth, timeline default '', source_path, source_id.
      values.push(`($${idx + 1}, $${idx + 2}, 'repo-h', 'note', 'stub')`);
      params.push(`data/p${i}`);  // slug
      params.push(`data/p${i}.md`); // source_path
    }
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_path, source_id, type, title)
         VALUES ${values.join(', ')}`,
      params,
    );

    // Force reconciliation by adding patterns that match all 1100.
    writeFileSync(join(tmp, '.gbrainignore'), 'data/\n');
    _resetGbrainignoreCache();

    const before = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      ['repo-h'],
    );
    expect(before[0].n).toBeGreaterThanOrEqual(1100);

    // forceReconcile because the seeded count is well over the absolute
    // guard (1000); without it the safety would (correctly) refuse.
    await performSync(engine, {
      repoPath: tmp,
      sourceId: 'repo-h',
      noPull: true,
      noEmbed: true,
      forceReconcile: true,
    });

    const after = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND slug LIKE 'data/%'`,
      ['repo-h'],
    );
    // All data/ pages reaped despite crossing the 1000-row batch boundary.
    expect(after[0].n).toBe(0);
  });
});

// ── opsUpdateSource integration ─────────────────────────────────────────────

describe('opsUpdateSource — excludePatterns mutations', () => {
  test('append: existing patterns + new patterns dedup correctly', async () => {
    await resetPgliteState(engine);
    await opsAddSource(engine, {
      id: 'upd-a',
      localPath: '/fake/a',
      excludePatterns: ['data/', 'tmp/'],
    });

    await opsUpdateSource(engine, {
      id: 'upd-a',
      excludePatterns: ['tmp/', 'fixtures/'], // tmp/ dedups, fixtures/ appends
    });

    const rows = await engine.executeRaw<{ config: unknown }>(
      `SELECT config FROM sources WHERE id = $1`,
      ['upd-a'],
    );
    const cfg =
      typeof rows[0]?.config === 'string'
        ? (JSON.parse(rows[0].config as string) as Record<string, unknown>)
        : ((rows[0]?.config ?? {}) as Record<string, unknown>);
    const patterns = cfg.excludePatterns as string[];
    expect(new Set(patterns)).toEqual(new Set(['data/', 'tmp/', 'fixtures/']));
  });

  test('clear: --clear-excludes resets to empty and invalidates hash', async () => {
    await resetPgliteState(engine);
    await opsAddSource(engine, {
      id: 'upd-b',
      localPath: '/fake/b',
      excludePatterns: ['data/'],
    });

    // Seed an excludePatternsHash so we can verify it gets cleared.
    await engine.executeRaw(
      `UPDATE sources SET config = config || '{"excludePatternsHash":"deadbeef"}'::jsonb WHERE id = $1`,
      ['upd-b'],
    );

    await opsUpdateSource(engine, { id: 'upd-b', clearExcludes: true });

    const rows = await engine.executeRaw<{ config: unknown }>(
      `SELECT config FROM sources WHERE id = $1`,
      ['upd-b'],
    );
    const cfg =
      typeof rows[0]?.config === 'string'
        ? (JSON.parse(rows[0].config as string) as Record<string, unknown>)
        : ((rows[0]?.config ?? {}) as Record<string, unknown>);
    expect(cfg.excludePatterns).toBeUndefined();
    expect(cfg.excludePatternsHash).toBeUndefined();
  });

  test('rejects --clear + --exclude combined', async () => {
    await resetPgliteState(engine);
    await opsAddSource(engine, { id: 'upd-c', localPath: '/fake/c' });

    let caught: unknown = null;
    try {
      await opsUpdateSource(engine, {
        id: 'upd-c',
        excludePatterns: ['data/'],
        clearExcludes: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as Error).message).toContain('Cannot combine');
  });
});
