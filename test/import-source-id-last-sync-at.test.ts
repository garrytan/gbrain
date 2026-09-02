/**
 * #1691 — `gbrain import --source-id <id>` never touched `sources.last_sync_at`
 * for the target source. A source registered with `local_path` but ingested
 * only via `gbrain import` (no `gbrain sync`) reported "never synced" forever
 * in `gbrain doctor`'s `sync_freshness` check, even immediately after a clean,
 * current import. This stamps `last_sync_at` on a CLEAN (zero-failure,
 * zero-malformed-skip) import for a non-git, non-remote, non-connector source
 * whose registered `local_path` IS the canonical import target, fail-closed on
 * any import failure, and leaves a bare default import (no explicit sourceId)
 * untouched.
 *
 * Hermetic PGLite in-memory. Sandboxes the failure ledger under a temp
 * GBRAIN_HOME via `withEnv` so this test never touches the real
 * ~/.gbrain/sync-failures.jsonl on the machine running it (see #2121),
 * matching test/import-source-id-bookkeeping.test.ts's convention.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

async function lastSyncAt(sourceId: string): Promise<Date | string | null> {
  const rows = await engine.executeRaw<{ last_sync_at: Date | string | null }>(
    `SELECT last_sync_at FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0]?.last_sync_at ?? null;
}

/**
 * A `[sourceId]`-bound stamp query still runs (and PGLite just returns zero
 * rows) even if `sourceId` is `undefined` — binding params alone can't tell
 * a removed `sourceId &&` guard from a working one. This proxy records
 * every `executeRaw` SQL string so a test can assert the stamp's
 * characteristic SELECT was never issued at all.
 */
function spyOnExecuteRaw(real: PGLiteEngine): { engine: PGLiteEngine; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'executeRaw' && typeof value === 'function') {
        return (sql: string, ...rest: unknown[]) => {
          calls.push(sql);
          return (value as (...args: unknown[]) => unknown).call(target, sql, ...rest);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: proxy as PGLiteEngine, calls };
}

describe('import stamps sources.last_sync_at for a local_path-registered source (#1691)', () => {
  test('clean import → last_sync_at advances from NULL to a real timestamp', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-import-clean-'));
    writeFileSync(join(repo, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('dept-x', 'dept-x', $1)`,
      [repo],
    );
    expect(await lastSyncAt('dept-x')).toBeNull();

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const before = Date.now();
      const result = await runImport(engine, [repo, '--no-embed', '--json', '--source-id', 'dept-x']);
      expect(result.failures.length).toBe(0);

      const stamped = await lastSyncAt('dept-x');
      expect(stamped).not.toBeNull();
      expect(new Date(stamped!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    });
  });

  test('managedBookmark: true (performFullSync path) → last_sync_at stays untouched here', async () => {
    // performFullSync calls runImport with managedBookmark: true, then
    // stamps last_sync_at itself via writeSyncAnchor AFTER its own gate
    // (applySyncFailureGate) decides the sync actually advanced. If this
    // block stamped anyway, a clean-looking runImport with zero failures
    // could race ahead of a sync that the outer gate later blocks for an
    // unrelated reason (sentinel, history change) — a false "just synced"
    // signal on the primary sync path this whole check exists to protect.
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-import-managed-'));
    writeFileSync(join(repo, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('dept-x', 'dept-x', $1)`,
      [repo],
    );

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [repo, '--no-embed', '--json'], {
        sourceId: 'dept-x',
        managedBookmark: true,
      });
      expect(result.failures.length).toBe(0);
      expect(await lastSyncAt('dept-x')).toBeNull();
    });
  });

  test('source with a configured remote_url → last_sync_at stays untouched (autopilot owns that signal)', async () => {
    // Autopilot's own freshness-driven dispatcher (autopilot.ts) reads
    // last_sync_at to decide when to queue a `sync` job — which does the
    // real `git pull` — for a remote-backed source. A plain `import` run
    // never pulls, so stamping last_sync_at here would let it mask a stale
    // remote from that dispatcher.
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-import-remote-'));
    writeFileSync(join(repo, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');

    // CLAUDE.md JSONB footgun: never JSON.stringify into a ::jsonb cast
    // directly (postgres.js double-encodes it). Bind through
    // $2::text::jsonb instead — binds as text, the cast parses it.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('dept-x', 'dept-x', $1, $2::text::jsonb)`,
      [repo, JSON.stringify({ remote_url: 'https://example.invalid/dept-x.git' })],
    );

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [repo, '--no-embed', '--json', '--source-id', 'dept-x']);
      expect(result.failures.length).toBe(0);
      expect(await lastSyncAt('dept-x')).toBeNull();
    });
  });

  test('git-tracked local_path → last_sync_at stays untouched (scoped to non-git sources per #1691)', async () => {
    // `gbrain import` never advances the source's own last_commit — only
    // `gbrain sync` does. Stamping last_sync_at for a git checkout would
    // mask real commit-level staleness that sync (not import) is the
    // correct pipeline to detect.
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-import-git-'));
    writeFileSync(join(repo, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@t.t" && git config user.name "T"', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m seed', { cwd: repo, stdio: 'pipe' });

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('dept-x', 'dept-x', $1)`,
      [repo],
    );

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [repo, '--no-embed', '--json', '--source-id', 'dept-x']);
      expect(result.failures.length).toBe(0);
      expect(await lastSyncAt('dept-x')).toBeNull();
    });
  });

  test('local_path that is a SUBDIR of a git checkout → last_sync_at stays untouched (git-root discovery walks up)', async () => {
    // A bare `.git`-at-local_path probe would miss this shape: the #753/#774
    // monorepo pattern anchors a source at a subdirectory of a git repo.
    // discoverGitRoot (rev-parse --show-toplevel) walks up and finds the
    // ancestor root, so this source is excluded from the stamp too.
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-import-gitsub-'));
    const sub = join(repo, 'brain');
    mkdirSync(sub);
    writeFileSync(join(sub, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@t.t" && git config user.name "T"', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A && git commit -m seed', { cwd: repo, stdio: 'pipe' });

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('dept-sub', 'dept-sub', $1)`,
      [sub],
    );

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [sub, '--no-embed', '--json', '--source-id', 'dept-sub']);
      expect(result.failures.length).toBe(0);
      expect(await lastSyncAt('dept-sub')).toBeNull();
    });
  });

  test('connector-managed source (config.kind: google) → last_sync_at stays untouched', async () => {
    // v0.47 google sources register a real, non-git local_path with no
    // remote_url — the connector owns last_sync_at via its own sync path,
    // and `gbrain waiting`'s freshness gate reads it for google sources.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-google-'));
    writeFileSync(join(dir, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('g-acct', 'g-acct', $1, $2::text::jsonb)`,
      [dir, JSON.stringify({ kind: 'google', g_account: 't@t.t' })],
    );
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [dir, '--no-embed', '--json', '--source-id', 'g-acct']);
      expect(result.failures.length).toBe(0);
      expect(await lastSyncAt('g-acct')).toBeNull();
    });
  });

  test('connector kind survives a nested-JSON-string config (parseSourceConfig, #2829 shape) → untouched', async () => {
    // PGLite historically double-wrapped configs as nested JSON strings; a
    // bare JSON.parse sees a string, not an object, and misses `kind`.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-gnested-'));
    writeFileSync(join(dir, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    const nested = JSON.stringify(JSON.stringify(JSON.stringify({ kind: 'google', g_account: 't@t.t' })));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('g-nested', 'g-nested', $1, $2::text::jsonb)`,
      [dir, nested],
    );
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [dir, '--no-embed', '--json', '--source-id', 'g-nested']);
      expect(result.failures.length).toBe(0);
      expect(await lastSyncAt('g-nested')).toBeNull();
    });
  });

  test('import of a directory UNRELATED to the registered local_path → last_sync_at stays untouched', async () => {
    // Configured-root enforcement is default-off, so this import completes
    // cleanly — but it says nothing about the registered root's freshness.
    const rootA = mkdtempSync(join(tmpdir(), 'gbrain-import-rootA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'gbrain-import-dirB-'));
    writeFileSync(join(dirB, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('dept-a', 'dept-a', $1)`,
      [rootA],
    );
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [dirB, '--no-embed', '--json', '--source-id', 'dept-a']);
      expect(result.failures.length).toBe(0);
      expect(await lastSyncAt('dept-a')).toBeNull();
    });
  });

  test('import of a SUBDIRECTORY of the registered local_path → last_sync_at stays untouched', async () => {
    // A child-dir import proves nothing about the rest of the root — only an
    // import whose canonical target IS the registered root may stamp.
    const root = mkdtempSync(join(tmpdir(), 'gbrain-import-rootsub-'));
    const child = join(root, 'inbox');
    mkdirSync(child);
    writeFileSync(join(child, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('dept-r', 'dept-r', $1)`,
      [root],
    );
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [child, '--no-embed', '--json', '--source-id', 'dept-r']);
      expect(result.failures.length).toBe(0);
      expect(await lastSyncAt('dept-r')).toBeNull();
    });
  });

  test('clean import but with malformed-filename skips → last_sync_at stays untouched', async () => {
    // Malformed-filename exclusions (bracket/control-char names) never enter
    // `failures[]` — they're a silent walker-level skip. A run that dropped
    // files this way isn't "clean" for freshness purposes even at
    // failures.length === 0.
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-import-malformed-'));
    writeFileSync(join(repo, 'legit.md'), '---\ntype: note\n---\n# Legit\n\nbody\n');
    writeFileSync(join(repo, '[junk.md](https-example).md'), '---\ntype: note\n---\n# Junk\n\nbody\n');

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('dept-x', 'dept-x', $1)`,
      [repo],
    );

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [repo, '--no-embed', '--json', '--source-id', 'dept-x']);
      expect(result.failures.length).toBe(0);
      expect(result.malformedSkipped).toBeGreaterThan(0);
      expect(await lastSyncAt('dept-x')).toBeNull();
    });
  });

  test('import with a failure → last_sync_at stays NULL (fail-closed)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-import-partial-'));
    writeFileSync(join(repo, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    // Deterministic soft-failure, same technique as
    // import-source-id-bookkeeping.test.ts: import-file.ts rejects any file
    // over MAX_FILE_SIZE (5_000_000 bytes) with a real result.error, which
    // runImport pushes into failures[] without needing a thrown exception.
    writeFileSync(join(repo, 'oversized.md'), '---\ntype: note\n---\n' + 'x'.repeat(5_000_001));

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('dept-x', 'dept-x', $1)`,
      [repo],
    );

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const result = await runImport(engine, [repo, '--no-embed', '--json', '--source-id', 'dept-x']);
      expect(result.failures.length).toBe(1);
      expect(await lastSyncAt('dept-x')).toBeNull();
    });
  });

  test('bare default import (no --source-id) never issues the stamp query', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-import-default-'));
    writeFileSync(join(repo, 'seed.md'), '---\ntype: note\n---\n# Seed\n\nbody\n');
    // Give 'default' a real local_path so a broken `sourceId &&` guard
    // would still find something to stamp — the query params alone can't
    // prove the guard fired (an `undefined` sourceId just binds to no row),
    // so `calls` below asserts the SELECT itself was never issued.
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [repo]);

    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    await withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_SOURCE: undefined }, async () => {
      const { engine: spied, calls } = spyOnExecuteRaw(engine);
      const result = await runImport(spied, [repo, '--no-embed', '--json']);
      expect(result.failures.length).toBe(0);
      expect(calls.some((sql) => sql.includes('SELECT local_path, config FROM sources'))).toBe(false);
      expect(await lastSyncAt('default')).toBeNull();
    });
  });
});
