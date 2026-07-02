/**
 * repo-path invariant (src/core/repo-path.ts): repo paths are resolved to
 * absolute at arg ingress; a relative path read back from storage is a hard
 * error, never silently resolved against cwd.
 *
 * Regression shape (incident 2026-07-02): `sync.repo_path` stored as "."
 * made a bare `gbrain sync` from an unrelated project directory import that
 * tree as the brain source and reconcile every real brain page as removed.
 * The performSync tests below seed exactly that state and assert the sync
 * refuses at the resolve_repo phase instead of importing the foreign cwd.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { resolve, isAbsolute } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resolveRepoArg, requireAbsoluteStoredPath } from '../src/core/repo-path.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { performSync } from '../src/commands/sync.ts';
import { runMigrations } from '../src/core/migrate.ts';

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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('resolveRepoArg', () => {
  test('resolves a relative arg against cwd', () => {
    expect(resolveRepoArg('foo/bar')).toBe(resolve(process.cwd(), 'foo/bar'));
  });

  test('resolves "." to cwd itself', () => {
    expect(resolveRepoArg('.')).toBe(process.cwd());
  });

  test('keeps an absolute arg unchanged', () => {
    const abs = resolve('/tmp', 'gbrain-repo-path-abs');
    expect(resolveRepoArg(abs)).toBe(abs);
  });
});

describe('requireAbsoluteStoredPath', () => {
  test('passes an absolute path through unchanged', () => {
    const abs = resolve('/tmp', 'gbrain-repo-path-abs');
    expect(requireAbsoluteStoredPath(abs, 'config sync.repo_path')).toBe(abs);
  });

  test('throws on "." naming the storage location', () => {
    expect(() => requireAbsoluteStoredPath('.', 'config sync.repo_path'))
      .toThrow(/config sync\.repo_path holds a relative path "\."/);
  });

  test('throws on a bare relative path with remediation in the message', () => {
    expect(() => requireAbsoluteStoredPath('brain', 'sources.local_path for "default"'))
      .toThrow(/gbrain sync --repo <absolute-path>/);
  });
});

// ---------------------------------------------------------------------------
// addSource — storage never holds a relative local_path
// ---------------------------------------------------------------------------

describe('addSource local_path normalization', () => {
  test('a relative --path is stored absolute (resolved against cwd)', async () => {
    const row = await addSource(engine, {
      id: 'rel-path',
      localPath: 'some/relative/dir',
      federated: null,
    });
    expect(row.local_path).toBe(resolve(process.cwd(), 'some/relative/dir'));
    expect(isAbsolute(row.local_path!)).toBe(true);
  });

  test('an absolute --path is stored unchanged', async () => {
    const abs = resolve('/tmp', 'gbrain-repo-path-source');
    const row = await addSource(engine, {
      id: 'abs-path',
      localPath: abs,
      federated: null,
    });
    expect(row.local_path).toBe(abs);
  });
});

// ---------------------------------------------------------------------------
// performSync — resolve_repo refuses stored relative anchors
// ---------------------------------------------------------------------------

describe('performSync stored-anchor guard', () => {
  test('bare sync with sync.repo_path="." throws instead of using cwd', async () => {
    await engine.setConfig('sync.repo_path', '.');
    await expect(performSync(engine, { skipLock: true }))
      .rejects.toThrow(/config sync\.repo_path holds a relative path "\."/);
  });

  test('per-source sync with a legacy relative local_path names the source', async () => {
    // Raw INSERT bypasses addSource on purpose: simulates a legacy row
    // persisted before normalization existed.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('legacy', 'legacy', '.')`,
    );
    await expect(performSync(engine, { skipLock: true, sourceId: 'legacy' }))
      .rejects.toThrow(/sources\.local_path for "legacy" holds a relative path/);
  });

  test('a caller-supplied relative repoPath is resolved, not refused', async () => {
    // The cwd IS this invocation's intent for explicit args; expect sync to
    // proceed past resolve_repo and fail later on the non-repo directory,
    // NOT with the stored-anchor refusal.
    await expect(performSync(engine, { skipLock: true, repoPath: 'no/such/dir', noPull: true }))
      .rejects.not.toThrow(/holds a relative path/);
  });
});

// ---------------------------------------------------------------------------
// Migration 120 — legacy relative anchors are cleared, absolute ones survive
// ---------------------------------------------------------------------------

describe('migration 120 — repo_path_anchors_absolute_only', () => {
  test('clears relative anchors, keeps POSIX and Windows absolute ones', async () => {
    // Seed directly (bypassing the now-normalizing writers) to simulate rows
    // persisted by a pre-invariant binary.
    await engine.setConfig('sync.repo_path', '.');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES
         ('legacy-rel', 'legacy-rel', 'brain'),
         ('ok-posix',   'ok-posix',   '/abs/brain'),
         ('ok-win',     'ok-win',     'C:\\brain'),
         ('ok-unc',     'ok-unc',     '\\\\host\\share')`,
    );

    // Rewind to just before 120 so runMigrations replays only this migration.
    await engine.setConfig('version', '119');
    await runMigrations(engine);

    expect(await engine.getConfig('sync.repo_path')).toBeFalsy();
    const rows = await engine.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources ORDER BY id`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.local_path]));
    expect(byId['legacy-rel']).toBeNull();
    expect(byId['ok-posix']).toBe('/abs/brain');
    expect(byId['ok-win']).toBe('C:\\brain');
    expect(byId['ok-unc']).toBe('\\\\host\\share');
  });

  test('keeps an absolute config anchor', async () => {
    await engine.setConfig('sync.repo_path', '/abs/brain');
    await engine.setConfig('version', '119');
    await runMigrations(engine);
    expect(await engine.getConfig('sync.repo_path')).toBe('/abs/brain');
  });
});
