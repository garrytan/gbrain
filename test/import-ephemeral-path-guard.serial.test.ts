/**
 * runImport ephemeral-CI-path guard — closes the writer the ship review's
 * testing specialist found: `gbrain import <dir>` persisted `sync.repo_path`
 * via a direct `engine.setConfig` gated only by `ownsGlobalSyncAnchor`, whose
 * null-anchor bootstrap deliberately allows a first bind — so an import run
 * from a CI checkout on an anchor-less shared brain re-opened the 2026-09-08
 * incident class the sync-side guard closes. The contract pinned here mirrors
 * writeSyncAnchor's: the import stays session-scoped (content and the sync
 * bookmark land) and only the path binding is skipped.
 *
 * Serial file: mutates process.env via withEnv — must stay out of the
 * test.concurrent codemod per test/helpers/with-env.ts's caveat.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { GUARD_ENV_VARS } from '../src/core/ci-path-guard.ts';

function guardEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ...Object.fromEntries(GUARD_ENV_VARS.map((k) => [k, undefined])),
    ...overrides,
  };
}

describe('runImport ephemeral-CI-path guard', () => {
  let engine: PGLiteEngine;
  let ciCheckout: string;

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
    // realpath the fixture up front: runImport realpaths the dir before
    // persisting (macOS /var → /private/var), so control assertions compare
    // the spelling that actually lands in config.
    ciCheckout = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-import-ci-')));
    execSync('git init', { cwd: ciCheckout, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: ciCheckout, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: ciCheckout, stdio: 'pipe' });
    mkdirSync(join(ciCheckout, 'people'), { recursive: true });
    writeFileSync(
      join(ciCheckout, 'people/alice.md'),
      '---\ntype: person\ntitle: Alice\n---\n\nAlice is a person.\n',
    );
    execSync('git add -A && git commit -m init', { cwd: ciCheckout, stdio: 'pipe' });
  });

  afterEach(() => {
    if (ciCheckout) rmSync(ciCheckout, { recursive: true, force: true });
  });

  test('import from a CI workspace does NOT bootstrap sync.repo_path; content and bookmark still land', async () => {
    const { runImport } = await import('../src/commands/import.ts');
    await withEnv(
      guardEnv({ GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: ciCheckout }),
      () => runImport(engine, [ciCheckout, '--no-embed'], {}),
    );
    // Session-scoped: the import itself is healthy.
    expect(await engine.getPage('people/alice', { sourceId: 'default' })).not.toBeNull();
    expect(await engine.getConfig('sync.last_commit')).toBeTruthy();
    // THE regression: the durable pointer is never bound to the CI checkout.
    expect(await engine.getConfig('sync.repo_path')).toBeNull();
  });

  test('outside CI the same import bootstraps sync.repo_path (existing behavior preserved)', async () => {
    const { runImport } = await import('../src/commands/import.ts');
    await withEnv(guardEnv(), () => runImport(engine, [ciCheckout, '--no-embed'], {}));
    expect(await engine.getConfig('sync.repo_path')).toBe(ciCheckout);
  });

  test('GBRAIN_ALLOW_EPHEMERAL_REPO_PATH=1 escape hatch persists the CI path', async () => {
    const { runImport } = await import('../src/commands/import.ts');
    await withEnv(
      guardEnv({
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: ciCheckout,
        GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: '1',
      }),
      () => runImport(engine, [ciCheckout, '--no-embed'], {}),
    );
    expect(await engine.getConfig('sync.repo_path')).toBe(ciCheckout);
  });
});
