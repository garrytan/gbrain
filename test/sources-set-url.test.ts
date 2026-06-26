/**
 * gbrain sources set-url <id> <url>
 *
 * Records `config.remote_url` on an EXISTING source (non-destructively) so a
 * path-mode clone becomes self-healing managed: a subsequent sync can compare
 * the clone's origin against the recorded url (`validateRepoState`) and re-clone
 * / repair instead of wedging. Mirrors `set-strategy` (ADR-0038, Sub-plan 1).
 *
 * Validates:
 *   - Happy path: writes config.remote_url
 *   - Invalid url (non-https / malformed) → exit code 2, no mutation
 *   - Missing source id → exit code 4
 *   - Missing arguments / missing url → exit code 2
 *   - Other config fields (e.g. federated) are preserved
 *   - Origin-match guard: after set-url to the clone's real origin,
 *     validateRepoState(localPath, recordedUrl) === 'healthy'; a mismatched
 *     url yields 'url-drift' (the guard's WARN trigger).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';
import { validateRepoState } from '../src/core/git-remote.ts';

describe('gbrain sources set-url', () => {
  let engine: PGLiteEngine;
  let origExit: typeof process.exit;
  let exitCode: number | null;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    process.exit = origExit;
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

  async function seedSource(id: string, config = '{}', localPath: string | null = null): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, local_path) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, id, config, localPath],
    );
  }

  async function readUrl(id: string): Promise<string | null> {
    const rows = await engine.executeRaw<{ remote_url: string | null }>(
      `SELECT config->>'remote_url' AS remote_url FROM sources WHERE id = $1`,
      [id],
    );
    return rows[0]?.remote_url ?? null;
  }

  const GOOD_URL = 'https://github.com/test/repo.git';

  test('happy path: records remote_url', async () => {
    await seedSource('test-src');
    await runSources(engine, ['set-url', 'test-src', GOOD_URL]);
    expect(await readUrl('test-src')).toBe(GOOD_URL);
  });

  test('preserves other config fields (federated)', async () => {
    await seedSource('test-src', '{"federated": true}');
    await runSources(engine, ['set-url', 'test-src', GOOD_URL]);
    const rows = await engine.executeRaw<{ federated: boolean | null; remote_url: string | null }>(
      `SELECT (config->>'federated')::boolean AS federated, config->>'remote_url' AS remote_url
       FROM sources WHERE id = 'test-src'`,
    );
    expect(rows[0].remote_url).toBe(GOOD_URL);
    expect(rows[0].federated).toBe(true);
  });

  test('rejection: invalid url (non-https) → exit 2, no mutation', async () => {
    await seedSource('test-src');
    try {
      await runSources(engine, ['set-url', 'test-src', 'http://github.com/test/repo.git']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
    expect(await readUrl('test-src')).toBeNull(); // no mutation
  });

  test('rejection: invalid url (malformed) → exit 2', async () => {
    await seedSource('test-src');
    try {
      await runSources(engine, ['set-url', 'test-src', 'not-a-url']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
    expect(await readUrl('test-src')).toBeNull();
  });

  test('rejection: missing source id → exit 4', async () => {
    try {
      await runSources(engine, ['set-url', 'nonexistent-source', GOOD_URL]);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_4__');
    }
    expect(exitCode).toBe(4);
  });

  test('rejection: missing arguments → exit 2', async () => {
    try {
      await runSources(engine, ['set-url']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
  });

  test('rejection: missing url (only id) → exit 2', async () => {
    await seedSource('test-src');
    try {
      await runSources(engine, ['set-url', 'test-src']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
    expect(await readUrl('test-src')).toBeNull();
  });

  test('origin-match guard: set-url to clone origin → validateRepoState healthy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-seturl-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', GOOD_URL], { stdio: 'ignore' });
      await seedSource('clone-src', '{}', dir);
      await runSources(engine, ['set-url', 'clone-src', GOOD_URL]);
      expect(await readUrl('clone-src')).toBe(GOOD_URL);
      // Recorded url matches the clone's real origin → healthy, sync won't wedge.
      expect(validateRepoState(dir, GOOD_URL)).toBe('healthy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('origin-match guard: mismatched origin → url-drift (WARN trigger)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-seturl-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/other/repo.git'], { stdio: 'ignore' });
      await seedSource('drift-src', '{}', dir);
      // set-url records the new url (non-destructive); does NOT hard-fail on drift.
      await runSources(engine, ['set-url', 'drift-src', GOOD_URL]);
      expect(await readUrl('drift-src')).toBe(GOOD_URL);
      // Clone origin still differs from the recorded url → drift the guard warns about.
      expect(validateRepoState(dir, GOOD_URL)).toBe('url-drift');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
