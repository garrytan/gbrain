/**
 * Indexing scope must reach callers that never touch the CLI.
 *
 * `--exclude` is a per-invocation flag, so before this only CLI callers could
 * narrow what gets indexed. autopilot, minion sync jobs and the dream cycle
 * call sync internally with nowhere to put exclusions, so a repo whose
 * indexing scope is narrower than its git tree was honored on one path and
 * ignored on the others — and ignored silently, because failing to exclude
 * something is not an error for an indexer.
 *
 * Under test:
 *   1. `sync.exclude` config is honored with NO flag passed (the internal-caller
 *      path, on the incremental diff — which is what runs in production).
 *   2. A per-call flag UNIONS with the persisted scope instead of replacing it:
 *      an ad-hoc `--exclude` narrows further, never re-opens what the operator
 *      persisted.
 *   3. A directory prefix (`raw/`) is normalized to a subtree glob (`raw/**`).
 *      Without the `**` the pattern matches the directory entry and none of
 *      the files inside it — the same gap in a different shape, and equally
 *      silent.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
let repoPath: string;
const SOURCE_ID = 'testsrc-excl-cfg';

function commitAll(msg: string): void {
  execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoPath, stdio: 'pipe' });
}

async function pageExists(slug: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
    [slug, SOURCE_ID],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** No `exclude` key: this is exactly what an internal caller passes. */
const baseOpts = () => ({
  repoPath,
  sourceId: SOURCE_ID,
  noPull: true,
  noEmbed: true,
  noExtract: true,
});

describe('sync.exclude config reaches non-CLI callers', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await runSources(engine, ['add', SOURCE_ID, '--no-federated']);

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-excl-cfg-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'notes'), { recursive: true });
    writeFileSync(join(repoPath, 'notes/base.md'), '# Base\n\ncommitted\n');
    commitAll('base');

    // First sync = full walk; establishes last_commit so later runs are incremental.
    const first = await performSync(engine, baseOpts());
    expect(first.status).toBe('first_sync');
    expect(await pageExists('notes/base')).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  }, 60_000);

  test('with no config and no flag, everything in the tree is indexed', async () => {
    // Baseline: without it, a passing exclusion test could just mean the file
    // never made it into the repo.
    mkdirSync(join(repoPath, 'raw'), { recursive: true });
    writeFileSync(join(repoPath, 'raw/first.md'), '# Raw one\n\nbaseline\n');
    commitAll('raw baseline');

    await performSync(engine, baseOpts());
    expect(await pageExists('raw/first')).toBe(true);
  }, 60_000);

  test('persisted sync.exclude is honored with no flag passed', async () => {
    await engine.setConfig('sync.exclude', 'raw/');

    writeFileSync(join(repoPath, 'raw/second.md'), '# Raw two\n\nmust not be indexed\n');
    writeFileSync(join(repoPath, 'notes/kept.md'), '# Kept\n\nmust be indexed\n');
    commitAll('raw two + kept');

    await performSync(engine, baseOpts());

    // The whole point: no caller passed --exclude, and the scope still held.
    expect(await pageExists('raw/second')).toBe(false);
    expect(await pageExists('notes/kept')).toBe(true);
  }, 60_000);

  test('a trailing slash covers the files inside, not just the directory entry', async () => {
    // `raw/` without the `**` normalization matches the directory and nothing
    // in it, so this asserts the normalization rather than the config plumbing.
    writeFileSync(join(repoPath, 'raw/nested.md'), '# Nested\n\nstill excluded\n');
    mkdirSync(join(repoPath, 'raw/deeper'), { recursive: true });
    writeFileSync(join(repoPath, 'raw/deeper/leaf.md'), '# Leaf\n\nexcluded too\n');
    commitAll('nested raw');

    await performSync(engine, baseOpts());

    expect(await pageExists('raw/nested')).toBe(false);
    expect(await pageExists('raw/deeper/leaf')).toBe(false);
  }, 60_000);

  test('a per-call flag narrows further without re-opening the persisted scope', async () => {
    writeFileSync(join(repoPath, 'raw/third.md'), '# Raw three\n\nstill excluded by config\n');
    writeFileSync(join(repoPath, 'notes/adhoc.md'), '# Ad hoc\n\nexcluded by the flag\n');
    writeFileSync(join(repoPath, 'notes/plain.md'), '# Plain\n\nindexed\n');
    commitAll('flag union case');

    await performSync(engine, { ...baseOpts(), exclude: ['notes/adhoc.md'] });

    expect(await pageExists('notes/adhoc')).toBe(false);  // the flag applies
    expect(await pageExists('raw/third')).toBe(false);    // the config still applies
    expect(await pageExists('notes/plain')).toBe(true);   // neither matches
  }, 60_000);

  test('an unreadable scope never breaks a sync', async () => {
    // Best-effort read, same posture as sync.include_working_tree: a config
    // problem must degrade to "no persisted scope", not to a failed sync.
    await engine.setConfig('sync.exclude', '');

    writeFileSync(join(repoPath, 'notes/after-empty.md'), '# After\n\nindexed\n');
    commitAll('empty scope');

    const result = await performSync(engine, baseOpts());
    expect(result.status).toBe('synced');
    expect(await pageExists('notes/after-empty')).toBe(true);
  }, 60_000);
});

/**
 * FIRST-SYNC pin: the config union must resolve ABOVE performSyncInner's
 * three performFullSync early returns (gc'd anchor / first sync /
 * --include-gitignored). The first sync is exactly where exclusion pollution
 * is permanent: a full walk that ignores the persisted scope imports every
 * excluded derivative file, and no later incremental sync ever revisits
 * them. A fresh engine + fresh repo so the scope is persisted BEFORE any
 * sync has run.
 */
describe('sync.exclude config is honored on the very first sync (full-walk path)', () => {
  let fsEngine: PGLiteEngine;
  let fsRepoPath: string;
  const FS_SOURCE_ID = 'testsrc-excl-first';

  async function fsPageExists(slug: string): Promise<boolean> {
    const rows = await fsEngine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
      [slug, FS_SOURCE_ID],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  beforeAll(async () => {
    fsEngine = new PGLiteEngine();
    await fsEngine.connect({});
    await fsEngine.initSchema();
    await runSources(fsEngine, ['add', FS_SOURCE_ID, '--no-federated']);

    fsRepoPath = mkdtempSync(join(tmpdir(), 'gbrain-excl-first-'));
    execSync('git init', { cwd: fsRepoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: fsRepoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: fsRepoPath, stdio: 'pipe' });
    mkdirSync(join(fsRepoPath, 'notes'), { recursive: true });
    mkdirSync(join(fsRepoPath, 'raw/deep'), { recursive: true });
    writeFileSync(join(fsRepoPath, 'notes/kept.md'), '# Kept\n\nindexed on first sync\n');
    writeFileSync(join(fsRepoPath, 'raw/skipped.md'), '# Skipped\n\nexcluded on first sync\n');
    writeFileSync(join(fsRepoPath, 'raw/deep/leaf.md'), '# Leaf\n\nexcluded too\n');
    execSync('git add -A', { cwd: fsRepoPath, stdio: 'pipe' });
    execSync('git commit -m "first"', { cwd: fsRepoPath, stdio: 'pipe' });
  }, 120_000);

  afterAll(async () => {
    if (fsEngine) await fsEngine.disconnect();
    if (fsRepoPath) rmSync(fsRepoPath, { recursive: true, force: true });
  }, 60_000);

  test('persisted scope excludes on the first full walk, with no flag passed', async () => {
    // Persist the scope BEFORE any sync has run — the trailing '/' also pins
    // the subtree-glob normalization on this path.
    await fsEngine.setConfig('sync.exclude', 'raw/');

    const first = await performSync(fsEngine, {
      repoPath: fsRepoPath,
      sourceId: FS_SOURCE_ID,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(first.status).toBe('first_sync');

    // The whole point of the hoist: the first_sync early return runs BELOW
    // the config union, so the full walk already carries the scope.
    expect(await fsPageExists('notes/kept')).toBe(true);
    expect(await fsPageExists('raw/skipped')).toBe(false);
    expect(await fsPageExists('raw/deep/leaf')).toBe(false);
  }, 60_000);
});

/**
 * Wave-audit pins: multi-pattern parsing (commas AND newlines in one value),
 * the conservative posture (exclusion never deletes previously-imported
 * pages — not on incremental syncs, not on the full-sync reconcile), and the
 * getConfig THROW branch (an unreadable config degrades to "no persisted
 * scope applied", never a failed sync). Fresh engine + repo so the ordering
 * games of the describes above can't leak in.
 */
describe('sync.exclude — multi-pattern value, conservative posture, getConfig throw', () => {
  let mpEngine: PGLiteEngine;
  let mpRepoPath: string;
  const MP_SOURCE_ID = 'testsrc-excl-multi';

  function mpCommitAll(msg: string): void {
    execSync('git add -A', { cwd: mpRepoPath, stdio: 'pipe' });
    execSync(`git commit -m "${msg}"`, { cwd: mpRepoPath, stdio: 'pipe' });
  }

  async function mpPageExists(slug: string): Promise<boolean> {
    const rows = await mpEngine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
      [slug, MP_SOURCE_ID],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  const mpOpts = () => ({
    repoPath: mpRepoPath,
    sourceId: MP_SOURCE_ID,
    noPull: true,
    noEmbed: true,
    noExtract: true,
  });

  beforeAll(async () => {
    mpEngine = new PGLiteEngine();
    await mpEngine.connect({});
    await mpEngine.initSchema();
    await runSources(mpEngine, ['add', MP_SOURCE_ID, '--no-federated']);

    mpRepoPath = mkdtempSync(join(tmpdir(), 'gbrain-excl-multi-'));
    execSync('git init', { cwd: mpRepoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: mpRepoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: mpRepoPath, stdio: 'pipe' });
    mkdirSync(join(mpRepoPath, 'notes'), { recursive: true });
    mkdirSync(join(mpRepoPath, 'raw'), { recursive: true });
    writeFileSync(join(mpRepoPath, 'notes/base.md'), '# Base\n\ncommitted\n');
    // Imported BEFORE any exclusion exists — the conservative-posture subject.
    writeFileSync(join(mpRepoPath, 'raw/pre.md'), '# Pre\n\nimported before the scope\n');
    mpCommitAll('base + pre');

    const first = await performSync(mpEngine, mpOpts());
    expect(first.status).toBe('first_sync');
    expect(await mpPageExists('raw/pre')).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (mpEngine) await mpEngine.disconnect();
    if (mpRepoPath) rmSync(mpRepoPath, { recursive: true, force: true });
  }, 60_000);

  test("a mixed comma+newline value ('raw/, tmp/\\nlogs/') excludes all three subtrees", async () => {
    await mpEngine.setConfig('sync.exclude', 'raw/, tmp/\nlogs/');

    mkdirSync(join(mpRepoPath, 'tmp'), { recursive: true });
    mkdirSync(join(mpRepoPath, 'logs'), { recursive: true });
    writeFileSync(join(mpRepoPath, 'raw/a.md'), '# A\n\nexcluded (comma-separated)\n');
    writeFileSync(join(mpRepoPath, 'tmp/b.md'), '# B\n\nexcluded (comma then newline)\n');
    writeFileSync(join(mpRepoPath, 'logs/c.md'), '# C\n\nexcluded (newline-separated)\n');
    writeFileSync(join(mpRepoPath, 'notes/keep.md'), '# Keep\n\nindexed\n');
    mpCommitAll('multi-pattern candidates');

    const result = await performSync(mpEngine, mpOpts());
    expect(result.status).toBe('synced');

    expect(await mpPageExists('raw/a')).toBe(false);
    expect(await mpPageExists('tmp/b')).toBe(false);
    expect(await mpPageExists('logs/c')).toBe(false);
    expect(await mpPageExists('notes/keep')).toBe(true);
  }, 60_000);

  test('conservative posture: a page imported BEFORE the exclusion stays LIVE across syncs, incl. full-sync reconcile', async () => {
    // raw/pre was imported before sync.exclude covered raw/. Exclusion gates
    // IMPORTS only — it must never delete (or soft-delete) an existing page.
    // Incremental pass (ran in the previous test) left it live:
    expect(await mpPageExists('raw/pre')).toBe(true);

    // And the full-sync reconcile must not treat "excluded but on disk" as
    // "file removed" (the reconcile's currentFiles walk carries no exclude).
    const full = await performSync(mpEngine, { ...mpOpts(), full: true });
    expect(['synced', 'up_to_date', 'first_sync']).toContain(full.status);

    expect(await mpPageExists('raw/pre')).toBe(true);
    const tombstone = await mpEngine.executeRaw<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'raw/pre' AND source_id = $1`,
      [MP_SOURCE_ID],
    );
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0]!.deleted_at).toBeNull();
  }, 60_000);

  test('getConfig THROWING degrades to no-persisted-scope: sync completes and the scope is NOT applied', async () => {
    // The catch branch proper — distinct from the empty-string case the
    // first describe covers. The persisted 'raw/…' scope is still in config,
    // but the read blows up, so this run must behave as if no scope existed.
    const originalGetConfig = mpEngine.getConfig.bind(mpEngine);
    mpEngine.getConfig = (async (key: string): Promise<string | null> => {
      if (key === 'sync.exclude') throw new Error('config table unavailable (injected)');
      return originalGetConfig(key);
    }) as typeof mpEngine.getConfig;

    try {
      writeFileSync(join(mpRepoPath, 'raw/late.md'), '# Late\n\nimported because the scope read failed\n');
      mpCommitAll('late raw file');

      const result = await performSync(mpEngine, mpOpts());
      // 1. The sync COMPLETED (never break a sync over the scope read).
      expect(result.status).toBe('synced');
      // 2. No persisted scope was applied: the raw/ file imported.
      expect(await mpPageExists('raw/late')).toBe(true);
    } finally {
      mpEngine.getConfig = originalGetConfig;
    }
  }, 60_000);
});
