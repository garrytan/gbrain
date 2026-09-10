/**
 * Ephemeral-CI-path guard — end-to-end regression for the 2026-09-08 incident.
 *
 * Incident: a shared brain's `wiki` source pointed at a durable machine path;
 * a CI job with brain credentials then ran gbrain from its runner checkout
 * (/home/runner/work/brain/brain) and the runner path was persisted into
 * `sources.local_path`, breaking `gbrain capture` (repo_not_found) on every
 * other machine mounting the brain until the row was repaired by hand.
 *
 * The #4369 ownership guard already refuses a sync-side REPOINT of a non-null
 * local_path — but it deliberately allows a null-anchor BOOTSTRAP, and
 * `sources add` / `sources set-path` bind paths outside sync entirely. This
 * suite pins the residual contract the ci-path-guard closes:
 *   - a sync from an ephemeral CI checkout still IMPORTS (session-scoped
 *     repo path; content lands) but never BOOTSTRAPS the durable anchor,
 *   - `addSource` refuses an ephemeral `--path` (INSERT and #3903 attach
 *     alike) without force,
 *   - GBRAIN_ALLOW_EPHEMERAL_REPO_PATH=1 restores the old behavior.
 *
 * Serial file: tests mutate process.env (via withEnv) — must stay out of the
 * test.concurrent codemod per test/helpers/with-env.ts's caveat.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { GUARD_ENV_VARS } from '../src/core/ci-path-guard.ts';

/**
 * Neutralize every env signal the guard reads, then apply per-test overrides.
 * This suite runs for real under GitHub Actions (CI=true, GITHUB_WORKSPACE
 * set), so control cases must not inherit ambient CI env.
 */
function guardEnv(overrides: Record<string, string | undefined> = {}) {
  // Built from the guard's own canonical env-var list so a provider added to
  // the classifier automatically reaches this control map — a hand-copied
  // list here would silently go stale and let ambient CI env leak into the
  // "outside CI" control cases.
  return {
    ...Object.fromEntries(GUARD_ENV_VARS.map((k) => [k, undefined])),
    ...overrides,
  };
}

function makeGitFixture(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
  mkdirSync(join(repo, 'people'), { recursive: true });
  writeFileSync(join(repo, 'people/alice.md'), [
    '---',
    'type: person',
    'title: Alice',
    '---',
    '',
    'Alice is a person.',
  ].join('\n'));
  execSync('git add -A && git commit -m "initial"', { cwd: repo, stdio: 'pipe' });
  return repo;
}

async function sourceLocalPath(engine: PGLiteEngine, id: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [id],
  );
  return rows[0]?.local_path ?? null;
}

describe('writeSyncAnchor ephemeral-CI-path guard (incident replica)', () => {
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
    ciCheckout = makeGitFixture('gbrain-ci-guard-');
    // A path-less source row — the bootstrap shape the #4369 ownership guard
    // deliberately allows through (first sync of a fresh source adopts the
    // dir). Without the ci-path-guard, a CI sync would bind the runner
    // checkout here and poison the shared row.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`,
      ['wiki'],
    );
  });

  afterEach(() => {
    if (ciCheckout) rmSync(ciCheckout, { recursive: true, force: true });
  });

  test('sync from a CI workspace imports content but does NOT bootstrap local_path', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await withEnv(
      // Self-hosted-runner shape: the checkout is whatever tmpdir gave us,
      // advertised via $GITHUB_WORKSPACE. (The literal /home/runner/work/
      // prefix can't host a real fixture on a dev machine; the workspace-env
      // rule exercises the same guard branch — the prefix rules are pinned
      // in test/ci-path-guard.test.ts.)
      guardEnv({ GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: ciCheckout }),
      () => performSync(engine, {
        sourceId: 'wiki',
        repoPath: ciCheckout,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      }),
    );

    // The sync itself is session-scoped and healthy: content landed.
    expect(['first_sync', 'synced']).toContain(result.status);
    expect(await engine.getPage('people/alice', { sourceId: 'wiki' })).not.toBeNull();

    // THE regression: the durable pointer is never bound to the CI checkout.
    expect(await sourceLocalPath(engine, 'wiki')).toBeNull();

    // Session-scoped means ONLY the path binding is skipped: the incremental
    // anchor still advances (a guard that also blocked last_commit would turn
    // every CI sync into a silent full re-walk).
    const anchorRows = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = 'wiki'`,
    );
    expect(anchorRows[0]!.last_commit).not.toBeNull();
  });

  test('outside CI the same sync bootstraps local_path (existing behavior preserved)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await withEnv(guardEnv(), () => performSync(engine, {
      sourceId: 'wiki',
      repoPath: ciCheckout,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    }));
    expect(await sourceLocalPath(engine, 'wiki')).toBe(ciCheckout);
  });

  test('GBRAIN_ALLOW_EPHEMERAL_REPO_PATH=1 escape hatch persists the CI path', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await withEnv(
      guardEnv({
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: ciCheckout,
        GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: '1',
      }),
      () => performSync(engine, {
        sourceId: 'wiki',
        repoPath: ciCheckout,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      }),
    );
    expect(await sourceLocalPath(engine, 'wiki')).toBe(ciCheckout);
  });

  test('a durable non-null local_path also survives a CI sync (guard + #4369 belt-and-braces)', async () => {
    const durable = '/Users/alice-example/brain';
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'wiki'`,
      [durable],
    );
    const { performSync } = await import('../src/commands/sync.ts');
    await withEnv(
      guardEnv({ GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: ciCheckout }),
      () => performSync(engine, {
        sourceId: 'wiki',
        repoPath: ciCheckout,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      }),
    );
    expect(await sourceLocalPath(engine, 'wiki')).toBe(durable);
  });

  test('legacy no-sourceId branch: sync.repo_path is not bootstrapped from a CI workspace', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await withEnv(
      guardEnv({ GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: ciCheckout }),
      () => performSync(engine, {
        repoPath: ciCheckout,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      }),
    );
    expect(await engine.getConfig('sync.repo_path')).toBeNull();
  });
});

describe('addSource ephemeral-CI-path guard', () => {
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

  test('refuses the literal incident path without any CI env (replayed runner path)', async () => {
    const { addSource, SourceOpError } = await import('../src/core/sources-ops.ts');
    const err = await withEnv(guardEnv(), () =>
      addSource(engine, { id: 'wiki', localPath: '/home/runner/work/brain/brain' })
        .then(() => null)
        .catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(SourceOpError);
    expect((err as InstanceType<typeof SourceOpError>).code).toBe('ephemeral_ci_path');
  });

  test('refuses the #3903 attach of an ephemeral path onto an existing path-less row', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('wiki', 'wiki', '{}'::jsonb)`,
    );
    const { addSource, SourceOpError } = await import('../src/core/sources-ops.ts');
    const err = await withEnv(
      guardEnv({ GITHUB_WORKSPACE: '/srv/agent/_work/brain/brain' }),
      () => addSource(engine, { id: 'wiki', localPath: '/srv/agent/_work/brain/brain' })
        .then(() => null)
        .catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(SourceOpError);
    expect((err as InstanceType<typeof SourceOpError>).code).toBe('ephemeral_ci_path');
    // The row's local_path was never attached.
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = 'wiki'`,
    );
    expect(rows[0]!.local_path).toBeNull();
  });

  test('fires BEFORE the collision check: a re-run against an already-bound id reports the real problem', async () => {
    // The docstring claim: a CI bootstrap re-running `sources add` must see
    // ephemeral_ci_path (actionable), not source_id_taken (a red herring that
    // steers the operator toward `sources remove --confirm-destructive`).
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('wiki', 'wiki', '/Users/alice-example/brain', '{}'::jsonb)`,
    );
    const { addSource, SourceOpError } = await import('../src/core/sources-ops.ts');
    const err = await withEnv(guardEnv(), () =>
      addSource(engine, { id: 'wiki', localPath: '/home/runner/work/brain/brain' })
        .then(() => null)
        .catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(SourceOpError);
    expect((err as InstanceType<typeof SourceOpError>).code).toBe('ephemeral_ci_path');
    // The existing binding is untouched.
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = 'wiki'`,
    );
    expect(rows[0]!.local_path).toBe('/Users/alice-example/brain');
  });

  test('force: true bypasses the refusal', async () => {
    const { addSource } = await import('../src/core/sources-ops.ts');
    const row = await withEnv(guardEnv(), () =>
      addSource(engine, {
        id: 'wiki',
        localPath: '/home/runner/work/brain/brain',
        force: true,
      }),
    );
    expect(row.local_path).toBe('/home/runner/work/brain/brain');
  });

  test('GBRAIN_ALLOW_EPHEMERAL_REPO_PATH=1 bypasses the refusal', async () => {
    const { addSource } = await import('../src/core/sources-ops.ts');
    const row = await withEnv(
      guardEnv({ GBRAIN_ALLOW_EPHEMERAL_REPO_PATH: '1' }),
      () => addSource(engine, { id: 'wiki', localPath: '/home/runner/work/brain/brain' }),
    );
    expect(row.local_path).toBe('/home/runner/work/brain/brain');
  });

  test('a durable path under CI=true is unaffected (bare CI is not a trigger)', async () => {
    // A real committed git repo in tmpdir, registered WITHOUT force, under
    // CI=true: neither the #2707 git check nor the ephemeral guard fires.
    const dir = makeGitFixture('gbrain-durable-');
    try {
      const { addSource } = await import('../src/core/sources-ops.ts');
      const row = await withEnv(guardEnv({ CI: 'true' }), () =>
        addSource(engine, { id: 'wiki', localPath: dir }),
      );
      expect(row.local_path).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
