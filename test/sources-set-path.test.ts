/**
 * gbrain sources set-path <id> <path> (#4739)
 *
 * Non-destructive local_path pointer repair. Validates:
 *   - Happy path: updates sources.local_path for an existing source +
 *     existing directory (prior NULL and prior non-NULL both).
 *   - Missing args → exit 2 with usage.
 *   - Unknown source → exit 4 (loud rejection, never a silent 0-row UPDATE).
 *   - Nonexistent path → exit 5, no mutation (never creates directories).
 *   - Path that exists but is a FILE → exit 5, no mutation.
 *   - Path overlapping another source's tree → exit 6 (`overlapping_path`,
 *     the same guard addSource enforces), no mutation; --force bypasses.
 *
 * Modeled on test/sources-set-cr-mode.test.ts (same runSources dispatch,
 * same process.exit stub).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';

describe('gbrain sources set-path', () => {
  let engine: PGLiteEngine;
  let origExit: typeof process.exit;
  let exitCode: number | null;
  const tmpDirs: string[] = [];

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'gb-setpath-'));
    tmpDirs.push(d);
    return d;
  }

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    process.exit = origExit;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    exitCode = null;
    origExit = process.exit;
    (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
      exitCode = n;
      throw new Error(`__test_exit_${n}__`);
    }) as never;
  });

  async function readLocalPath(id: string): Promise<string | null> {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [id],
    );
    return rows[0]?.local_path ?? null;
  }

  test('happy path: sets a NULL local_path to a real directory', async () => {
    const dir = makeDir();
    expect(await readLocalPath('default')).toBeNull();
    await runSources(engine, ['set-path', 'default', dir]);
    expect(await readLocalPath('default')).toBe(dir);
  });

  test('happy path: repoints an existing local_path', async () => {
    const first = makeDir();
    const second = makeDir();
    await runSources(engine, ['set-path', 'default', first]);
    await runSources(engine, ['set-path', 'default', second]);
    expect(await readLocalPath('default')).toBe(second);
  });

  test('normalizes a relative path to absolute before storing (#3696 phantom-path class)', async () => {
    // The repair command must apply the same resolvePath(msysToNativePath())
    // treatment addSource uses: storing '.' verbatim plants the exact
    // phantom-path class set-path exists to repair (a daemon at cwd=/ later
    // join-resolves a path that does not exist).
    const dir = makeDir();
    const origCwd = process.cwd();
    process.chdir(dir);
    let expected: string;
    try {
      expected = process.cwd(); // symlink-resolved spelling of dir
      await runSources(engine, ['set-path', 'default', '.']);
    } finally {
      process.chdir(origCwd);
    }
    const stored = await readLocalPath('default');
    expect(stored).toBe(expected);
  });

  test('rejection: missing arguments → exit 2 (usage)', async () => {
    try {
      await runSources(engine, ['set-path', 'default']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
    expect(await readLocalPath('default')).toBeNull(); // no mutation
  });

  test('rejection: unknown source → exit 4 (loud, never a silent 0-row UPDATE)', async () => {
    const dir = makeDir();
    try {
      await runSources(engine, ['set-path', 'nonexistent-source', dir]);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_4__');
    }
    expect(exitCode).toBe(4);
  });

  test('rejection: nonexistent path → exit 5, no mutation (never creates directories)', async () => {
    try {
      await runSources(engine, ['set-path', 'default', '/definitely/not/a/real/dir/xyz']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_5__');
    }
    expect(exitCode).toBe(5);
    expect(await readLocalPath('default')).toBeNull(); // no mutation
  });

  test('rejection: path exists but is a FILE → exit 5, no mutation', async () => {
    const dir = makeDir();
    const file = join(dir, 'not-a-dir.md');
    writeFileSync(file, 'a page, not a tree\n');
    try {
      await runSources(engine, ['set-path', 'default', file]);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_5__');
    }
    expect(exitCode).toBe(5);
    expect(await readLocalPath('default')).toBeNull(); // no mutation
  });

  // Review fix: the repair command bypassed the overlapping-path guard that
  // `sources add` enforces, so a repointed source could silently nest inside
  // (or swallow) another source's tree — the exact shape that makes sync and
  // write-through attribute files to the wrong source.
  async function seedSource(id: string, localPath: string): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ($1, $1, $2, '{}'::jsonb, NOW())`,
      [id, localPath],
    );
  }

  test('rejection: path inside another source\'s tree → exit 6 (overlapping_path), no mutation', async () => {
    const otherRoot = makeDir();
    await seedSource('other-src', otherRoot);
    const nested = join(otherRoot, 'nested');
    mkdirSync(nested);
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
    try {
      await runSources(engine, ['set-path', 'default', nested]);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_6__');
    } finally {
      console.error = origErr;
    }
    expect(exitCode).toBe(6);
    const out = errs.join('\n');
    expect(out).toContain('overlapping_path');
    // Same wording addSource uses, so the two surfaces never drift.
    expect(out).toContain(`overlaps with existing source "other-src" at "${otherRoot}"`);
    expect(await readLocalPath('default')).toBeNull(); // no mutation
  });

  test('rejection: path that CONTAINS another source\'s tree is also an overlap', async () => {
    const parent = makeDir();
    const child = join(parent, 'child');
    mkdirSync(child);
    await seedSource('other-src', child);
    try {
      await runSources(engine, ['set-path', 'default', parent]);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_6__');
    }
    expect(exitCode).toBe(6);
    expect(await readLocalPath('default')).toBeNull();
  });

  test('--force bypasses the overlap guard (operator override)', async () => {
    const otherRoot = makeDir();
    await seedSource('other-src', otherRoot);
    const nested = join(otherRoot, 'nested');
    mkdirSync(nested);
    await runSources(engine, ['set-path', 'default', nested, '--force']);
    expect(exitCode).toBeNull();
    expect(await readLocalPath('default')).toBe(nested);
  });

  test('a source\'s own current path is not an overlap with itself (idempotent re-set)', async () => {
    const dir = makeDir();
    await runSources(engine, ['set-path', 'default', dir]);
    await runSources(engine, ['set-path', 'default', dir]);
    expect(exitCode).toBeNull();
    expect(await readLocalPath('default')).toBe(dir);
  });

  // Ship-review fix: the overlap guard compared path STRINGS, so a symlink
  // whose spelling shares no prefix with another source's tree resolved onto
  // that very tree and passed without --force. Both sides are now compared by
  // realpath (when they exist) as well as by spelling.
  test('rejection: a SYMLINK into another source\'s tree is an overlap (realpath-compared), no mutation', async () => {
    const otherRoot = makeDir();
    await seedSource('other-src', otherRoot);
    const nested = join(otherRoot, 'nested');
    mkdirSync(nested);
    const linkHome = makeDir();
    const link = join(linkHome, 'looks-unrelated');
    symlinkSync(nested, link);
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
    try {
      await runSources(engine, ['set-path', 'default', link]);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_6__');
    } finally {
      console.error = origErr;
    }
    expect(exitCode).toBe(6);
    expect(errs.join('\n')).toContain('overlapping_path');
    expect(await readLocalPath('default')).toBeNull(); // no mutation
  });

  test('rejection: another source registered VIA a symlink is still an overlap for its real tree', async () => {
    const realRoot = makeDir();
    const linkHome = makeDir();
    const link = join(linkHome, 'alias-of-real-root');
    symlinkSync(realRoot, link);
    await seedSource('other-src', link); // sibling's local_path is the symlink spelling
    const nested = join(realRoot, 'nested');
    mkdirSync(nested);
    try {
      await runSources(engine, ['set-path', 'default', nested]);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_6__');
    }
    expect(exitCode).toBe(6);
    expect(await readLocalPath('default')).toBeNull();
  });

  test('--force still bypasses the realpath overlap guard', async () => {
    const otherRoot = makeDir();
    await seedSource('other-src', otherRoot);
    const linkHome = makeDir();
    const link = join(linkHome, 'forced-link');
    symlinkSync(otherRoot, link);
    await runSources(engine, ['set-path', 'default', link, '--force']);
    expect(exitCode).toBeNull();
    expect(await readLocalPath('default')).toBe(link);
  });

  test('a symlink to an UNRELATED tree is accepted and stored as typed', async () => {
    const realRoot = makeDir();
    const linkHome = makeDir();
    const link = join(linkHome, 'unrelated-link');
    symlinkSync(realRoot, link);
    await runSources(engine, ['set-path', 'default', link]);
    expect(exitCode).toBeNull();
    expect(await readLocalPath('default')).toBe(link);
  });
});
