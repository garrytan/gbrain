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
