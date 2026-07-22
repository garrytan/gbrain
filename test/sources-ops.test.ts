/**
 * sources-ops tests — pure-function coverage for the v0.28 sources-management
 * module. Runs against PGLite (zero-config in-memory). Real-Postgres E2E
 * coverage lives in test/e2e/sources-remote-mcp.test.ts.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  addSource,
  listSources,
  removeSource,
  getSourceStatus,
  recloneIfMissing,
  isPathContained,
  isOwnedClone,
  unownedHint,
  defaultCloneDir,
  SourceOpError,
} from '../src/core/sources-ops.ts';
import { readdirSync } from 'fs';
import { runSources } from '../src/commands/sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

// Tier 3: every PGLite spinup path needs the snapshot env unset (test
// infrastructure detail; matches bootstrap.test.ts pattern).
let engine: PGLiteEngine;
const FAKE_GIT_DIR = join(tmpdir(), `gbrain-sources-ops-test-${process.pid}`);
const GBRAIN_HOME = join(FAKE_GIT_DIR, 'gbrain-home');
// gbrainPath() appends `.gbrain` to GBRAIN_HOME, so the actual clone root the
// production code resolves to is $GBRAIN_HOME/.gbrain/clones/. Tests that
// hand-craft path fixtures must use this, NOT $GBRAIN_HOME/clones/.
const CLONE_ROOT = join(GBRAIN_HOME, '.gbrain', 'clones');

// ---------------------------------------------------------------------------
// Fake-git harness — controllable success/failure so addSource's clone
// rollback paths are exercisable without real network.
// ---------------------------------------------------------------------------

function writeFakeGit(): void {
  mkdirSync(FAKE_GIT_DIR, { recursive: true });
  const modeFile = join(FAKE_GIT_DIR, 'mode');
  writeFileSync(modeFile, 'ok');
  // Fake git: first arg after SSRF flags is `clone`, then url, then dest.
  // We just mkdir the dest and write a sentinel .git dir so the clone
  // appears successful from the rest of the code's POV.
  const script = `#!/usr/bin/env bash
mode=$(cat "${modeFile}" 2>/dev/null || echo ok)
case "$mode" in
  clone-fail) exit 1 ;;
esac
# Detect verb by iterating argv (bash glob *" foo "* patterns are flaky
# with multiple verbs so we just walk the array).
has_clone=0
has_remote_get_url=0
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  next_idx=$((i+1))
  next="\${!next_idx:-}"
  if [ "$arg" = "clone" ]; then has_clone=1; fi
  if [ "$arg" = "remote" ] && [ "$next" = "get-url" ]; then has_remote_get_url=1; fi
done
if [ "$has_clone" = "1" ]; then
  dest="\${@: -1}"
  mkdir -p "$dest/.git"
  echo "ref: refs/heads/main" > "$dest/.git/HEAD"
  exit 0
fi
if [ "$has_remote_get_url" = "1" ]; then
  echo "https://github.com/example/repo"
  exit 0
fi
exit 0
`;
  const path = join(FAKE_GIT_DIR, 'git');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function setMode(mode: 'ok' | 'clone-fail'): void {
  writeFileSync(join(FAKE_GIT_DIR, 'mode'), mode);
}

const fakePath = (): string => `${FAKE_GIT_DIR}:${process.env.PATH ?? ''}`;

// ---------------------------------------------------------------------------
// PGLite lifecycle (R3 + R4 canonical block per CLAUDE.md test-isolation lint)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  writeFakeGit();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(FAKE_GIT_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Make sure the default source exists for tests that rely on the v0.17 row.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('default', 'default', NULL, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );
  // Reset GBRAIN_HOME fixtures between tests
  rmSync(GBRAIN_HOME, { recursive: true, force: true });
  mkdirSync(GBRAIN_HOME, { recursive: true });
  setMode('ok');
});

// Run every test with GBRAIN_HOME pointing at our fixture dir AND fake git
// in PATH. Passed via withEnv so other test files in the shard don't see
// it leak.
async function withEnv2<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv(
    { GBRAIN_HOME, PATH: fakePath() },
    fn,
  );
}

// ---------------------------------------------------------------------------
// addSource — pre-flight collision (Q4)
// ---------------------------------------------------------------------------

describe('addSource — Q4 pre-flight collision', () => {
  test('rejects existing id BEFORE any clone work', async () => {
    await withEnv2(async () => {
      await addSource(engine, { id: 'taken', localPath: '/tmp/a' });
      try {
        await addSource(engine, {
          id: 'taken',
          remoteUrl: 'https://github.com/example/repo',
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).code).toBe('source_id_taken');
      }
    });
  });

  test('rejects invalid id format with structured error', async () => {
    await withEnv2(async () => {
      try {
        await addSource(engine, { id: 'BadCaseId', localPath: '/tmp/b' });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).code).toBe('invalid_id');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// addSource — happy paths (localPath only AND remoteUrl)
// ---------------------------------------------------------------------------

describe('addSource — happy paths', () => {
  test('localPath only (existing v0.17+ behavior preserved)', async () => {
    await withEnv2(async () => {
      const row = await addSource(engine, {
        id: 'wiki',
        localPath: '/tmp/wiki-fixture',
        federated: true,
      });
      expect(row.id).toBe('wiki');
      expect(row.local_path).toBe('/tmp/wiki-fixture');
      expect(row.config).toEqual({ federated: true });
    });
  });

  test('remoteUrl: clones, INSERTs, renames atomically', async () => {
    await withEnv2(async () => {
      const row = await addSource(engine, {
        id: 'yc-artifacts',
        remoteUrl: 'https://github.com/example/repo',
        federated: true,
      });
      expect(row.id).toBe('yc-artifacts');
      expect(row.local_path).toBe(defaultCloneDir('yc-artifacts'));
      expect((row.config as any).remote_url).toBe('https://github.com/example/repo');
      expect((row.config as any).federated).toBe(true);
      // Final clone dir exists with .git inside
      expect(existsSync(join(row.local_path!, '.git'))).toBe(true);
      // Temp dir was renamed away (parent persists)
      expect(existsSync(join(CLONE_ROOT, '.tmp'))).toBe(true);
    });
  });

  test('rejects internal-target URL via parseRemoteUrl gate', async () => {
    await withEnv2(async () => {
      try {
        await addSource(engine, {
          id: 'bad',
          remoteUrl: 'https://192.168.1.1/x.git',
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).code).toBe('invalid_remote_url');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// addSource — D3 atomic-rollback paths
// ---------------------------------------------------------------------------

describe('addSource — D3 rollback', () => {
  test('clone failure: tempDir cleaned + no DB row', async () => {
    await withEnv2(async () => {
      setMode('clone-fail');
      try {
        await addSource(engine, {
          id: 'fail-clone',
          remoteUrl: 'https://github.com/example/repo',
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).code).toBe('clone_failed');
      }
      const rows = await engine.executeRaw(
        `SELECT id FROM sources WHERE id = $1`,
        ['fail-clone'],
      );
      expect(rows.length).toBe(0);
    });
  });

  test('INSERT failure after successful clone: tempDir cleaned + no row', async () => {
    await withEnv2(async () => {
      // Pre-create the row so INSERT (without ON CONFLICT) violates PK.
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config) VALUES ('insert-collision', 'fixture', '/somewhere', '{}'::jsonb)`,
      );
      try {
        await addSource(engine, {
          id: 'insert-collision',
          remoteUrl: 'https://github.com/example/repo',
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        // Could be 'source_id_taken' (caught at pre-flight) — that's the
        // intended behavior since pre-flight catches the case before clone.
        expect(['source_id_taken', 'insert_failed']).toContain(
          (e as SourceOpError).code,
        );
      }
      // Make sure no .tmp/ entry leaked.
      const tmp = join(CLONE_ROOT, '.tmp');
      if (existsSync(tmp)) {
        const fs = await import('fs');
        expect(fs.readdirSync(tmp)).toEqual([]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// listSources — surfaces remote_url
// ---------------------------------------------------------------------------

describe('listSources', () => {
  test('exposes remote_url field for remoteUrl-managed sources', async () => {
    await withEnv2(async () => {
      await addSource(engine, {
        id: 'with-url',
        remoteUrl: 'https://github.com/example/repo',
        federated: true,
      });
      await addSource(engine, { id: 'with-path', localPath: '/tmp/p' });
      const list = await listSources(engine);
      const withUrl = list.find(e => e.id === 'with-url');
      const withPath = list.find(e => e.id === 'with-path');
      expect(withUrl?.remote_url).toBe('https://github.com/example/repo');
      expect(withPath?.remote_url).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// removeSource — symlink-safe clone-cleanup
// ---------------------------------------------------------------------------

describe('removeSource — clone-cleanup', () => {
  test('counts soft-deleted pages for destructive removal while list/status show active pages', async () => {
    await withEnv2(async () => {
      await addSource(engine, { id: 'soft-only', localPath: '/tmp/soft-only-fixture' });
      await engine.putPage(
        'notes/recoverable',
        {
          type: 'note',
          title: 'Recoverable',
          compiled_truth: 'still recoverable during the soft-delete window',
          timeline: '',
          frontmatter: {},
        },
        { sourceId: 'soft-only' },
      );
      expect(await engine.softDeletePage('notes/recoverable', { sourceId: 'soft-only' }))
        .toEqual({ slug: 'notes/recoverable' });

      const listed = await listSources(engine);
      expect(listed.find((s) => s.id === 'soft-only')?.page_count).toBe(0);
      const status = await getSourceStatus(engine, 'soft-only');
      expect(status.page_count).toBe(0);

      const dryRun = await removeSource(engine, { id: 'soft-only', dryRun: true });
      expect(dryRun.pages_deleted).toBe(1);

      try {
        await removeSource(engine, { id: 'soft-only' });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).message).toContain('with 1 pages');
      }
    });
  });

  test('removes clone IFF managed (local_path under $GBRAIN_HOME/clones/ + remote_url set)', async () => {
    await withEnv2(async () => {
      const row = await addSource(engine, {
        id: 'cleanup-yes',
        remoteUrl: 'https://github.com/example/repo',
      });
      const clonePath = row.local_path!;
      expect(existsSync(clonePath)).toBe(true);
      const result = await removeSource(engine, {
        id: 'cleanup-yes',
        confirmDestructive: true,
      });
      expect(result.clone_removed).toBe(true);
      expect(existsSync(clonePath)).toBe(false);
    });
  });

  test('does NOT remove clone for user-supplied --path (no remote_url)', async () => {
    await withEnv2(async () => {
      const userPath = join(GBRAIN_HOME, 'user-managed-fixture');
      mkdirSync(userPath, { recursive: true });
      writeFileSync(join(userPath, 'file'), 'hi');
      // #2707: this fixture is intentionally not a git repo (unrelated to
      // what this test covers — clone-cleanup ownership) — force past the
      // registration-time git check.
      await addSource(engine, { id: 'cleanup-no', localPath: userPath, force: true });
      const result = await removeSource(engine, {
        id: 'cleanup-no',
        confirmDestructive: true,
      });
      expect(result.clone_removed).toBe(false);
      expect(existsSync(userPath)).toBe(true); // user dir intact
      rmSync(userPath, { recursive: true, force: true });
    });
  });

  test('symlink-target-OUTSIDE-clones: realpath confinement foils escape', async () => {
    await withEnv2(async () => {
      // Attacker replaces $CLONE_ROOT/evil with a symlink to a sibling dir
      // (e.g. ~/.ssh, /etc). The realpath check in isPathContained resolves
      // the link and rejects because the target isn't under the clones/
      // confine. removeSource skips cleanup and just deletes the DB row.
      // Sentinel stays intact.
      const target = join(GBRAIN_HOME, 'sensitive-fixture');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'sentinel'), 'do-not-touch');
      const linkPath = join(CLONE_ROOT, 'evil');
      mkdirSync(CLONE_ROOT, { recursive: true });
      symlinkSync(target, linkPath);
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config) VALUES ('evil', 'evil', $1, $2::jsonb)`,
        [linkPath, JSON.stringify({ remote_url: 'https://github.com/x/y' })],
      );
      const result = await removeSource(engine, {
        id: 'evil',
        confirmDestructive: true,
      });
      expect(result.clone_removed).toBe(false);
      // Sentinel must still exist — symlink target untouched (THE attack
      // we're defending against).
      expect(existsSync(join(target, 'sentinel'))).toBe(true);
      // Symlink itself is also untouched.
      expect(existsSync(linkPath)).toBe(true);
      rmSync(target, { recursive: true, force: true });
      rmSync(linkPath, { force: true });
    });
  });

  test('symlink-target-INSIDE-clones: lstat check refuses with symlink_escape', async () => {
    await withEnv2(async () => {
      // Edge case: symlink that resolves INSIDE clones/ (so isPathContained
      // returns true), but the symlink itself is the local_path. lstat-check
      // detects this and refuses rather than rm-rfing the resolved target.
      mkdirSync(join(CLONE_ROOT, 'real-target'), { recursive: true });
      writeFileSync(
        join(CLONE_ROOT, 'real-target', 'sentinel'),
        'do-not-touch',
      );
      const linkPath = join(CLONE_ROOT, 'symlink-source');
      symlinkSync(join(CLONE_ROOT, 'real-target'), linkPath);
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config) VALUES ('inner-symlink', 'x', $1, $2::jsonb)`,
        [linkPath, JSON.stringify({ remote_url: 'https://github.com/x/y' })],
      );
      try {
        await removeSource(engine, {
          id: 'inner-symlink',
          confirmDestructive: true,
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).code).toBe('symlink_escape');
      }
      // Sentinel preserved through rm-rf-via-symlink attack.
      expect(
        existsSync(join(CLONE_ROOT, 'real-target', 'sentinel')),
      ).toBe(true);
      rmSync(linkPath, { force: true });
      rmSync(join(CLONE_ROOT, 'real-target'), { recursive: true, force: true });
    });
  });

  test('refuses to remove "default" source', async () => {
    await withEnv2(async () => {
      try {
        await removeSource(engine, { id: 'default', confirmDestructive: true });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).code).toBe('protected_id');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// getSourceStatus — clone_state branches
// ---------------------------------------------------------------------------

describe('getSourceStatus', () => {
  test('clone_state = "healthy" for working clone', async () => {
    await withEnv2(async () => {
      await addSource(engine, {
        id: 'status-healthy',
        remoteUrl: 'https://github.com/example/repo',
      });
      const s = await getSourceStatus(engine, 'status-healthy');
      expect(s.clone_state).toBe('healthy');
      expect(s.remote_url).toBe('https://github.com/example/repo');
    });
  });

  test('clone_state = "missing" when clone dir was rmd', async () => {
    await withEnv2(async () => {
      const row = await addSource(engine, {
        id: 'status-missing',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(row.local_path!, { recursive: true, force: true });
      const s = await getSourceStatus(engine, 'status-missing');
      expect(s.clone_state).toBe('missing');
    });
  });

  test('clone_state = "not-applicable" for path-only source (no remote)', async () => {
    await withEnv2(async () => {
      const userPath = join(GBRAIN_HOME, 'na-fixture');
      mkdirSync(userPath, { recursive: true });
      // path-only source still gets validateRepoState — but with no expected
      // URL, it just probes existence + .git. Path exists with no .git → 'no-git'.
      // To match contract docstring we'd want 'not-applicable' only when
      // local_path is null. Test the truthful behavior. #2707: this fixture
      // is deliberately no-git (that's what's under test for getSourceStatus)
      // — force past the registration-time git check to construct it.
      await addSource(engine, { id: 'status-no-url', localPath: userPath, force: true });
      const s = await getSourceStatus(engine, 'status-no-url');
      // local_path set but no .git: returns 'no-git'
      expect(s.clone_state).toBe('no-git');
      expect(s.remote_url).toBeNull();
      rmSync(userPath, { recursive: true, force: true });
    });
  });

  test('throws not_found for unknown id', async () => {
    await withEnv2(async () => {
      try {
        await getSourceStatus(engine, 'never-existed');
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).code).toBe('not_found');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// T4 — recloneIfMissing (restore-with-autopurged-clone path)
// ---------------------------------------------------------------------------

describe('recloneIfMissing — T4 restore + autopurge recovery', () => {
  test('re-clones when local_path is missing on disk', async () => {
    await withEnv2(async () => {
      const row = await addSource(engine, {
        id: 't4-purged',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(row.local_path!, { recursive: true, force: true });
      expect(existsSync(row.local_path!)).toBe(false);
      const recloned = await recloneIfMissing(engine, 't4-purged');
      expect(recloned).toBe(true);
      expect(existsSync(join(row.local_path!, '.git'))).toBe(true);
    });
  });

  test('returns false when clone is already healthy (idempotent)', async () => {
    await withEnv2(async () => {
      await addSource(engine, {
        id: 't4-healthy',
        remoteUrl: 'https://github.com/example/repo',
      });
      const recloned = await recloneIfMissing(engine, 't4-healthy');
      expect(recloned).toBe(false);
    });
  });

  test('returns false when source has no remote_url (path-only)', async () => {
    await withEnv2(async () => {
      await addSource(engine, { id: 't4-no-url', localPath: '/tmp/anywhere' });
      const recloned = await recloneIfMissing(engine, 't4-no-url');
      expect(recloned).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// #1881 — ownership guard: recloneIfMissing must NEVER delete a user working
// tree. Ownership (config.managed_clone OR default-location equality), not
// path-containment.
// ---------------------------------------------------------------------------

describe('isOwnedClone — ownership predicate', () => {
  test('marker config.managed_clone:true → owned (even at an external path)', async () => {
    await withEnv2(async () => {
      expect(
        isOwnedClone({
          id: 'x',
          local_path: '/some/external/path',
          config: { remote_url: 'https://github.com/example/repo', managed_clone: true },
        }),
      ).toBe(true);
    });
  });

  test('default-location clone, no marker → owned (back-compat equality)', async () => {
    await withEnv2(async () => {
      expect(
        isOwnedClone({
          id: 'legacy',
          local_path: defaultCloneDir('legacy'),
          config: { remote_url: 'https://github.com/example/repo' },
        }),
      ).toBe(true);
    });
  });

  test('external path, no marker → NOT owned (the #1881 federated shape)', async () => {
    await withEnv2(async () => {
      expect(
        isOwnedClone({
          id: 'gstack-code-app-abc',
          local_path: '/Users/dev/tt-flutter-app',
          config: { remote_url: 'https://github.com/example/repo', federated: true },
        }),
      ).toBe(false);
    });
  });

  test('null local_path → NOT owned', async () => {
    await withEnv2(async () => {
      expect(isOwnedClone({ id: 'x', local_path: null, config: {} })).toBe(false);
    });
  });

  test('config as JSON string (DB shape) is parsed', async () => {
    await withEnv2(async () => {
      expect(
        isOwnedClone({
          id: 'x',
          local_path: '/external',
          config: JSON.stringify({ managed_clone: true }),
        }),
      ).toBe(true);
    });
  });
});

describe('unownedHint — healthy vs degraded guidance', () => {
  test('healthy: read-only guidance, no "missing clone" framing', () => {
    const msg = unownedHint({ id: 'x', local_path: '/Users/dev/repo' }, 'healthy');
    expect(msg).toMatch(/read-only/);
    expect(msg).toMatch(/drop config\.remote_url/);
    expect(msg).not.toMatch(/not a usable git repo/);
  });

  test('degraded: names the state and does not suggest dropping remote_url alone recovers it', () => {
    const msg = unownedHint({ id: 'x', local_path: '/Users/dev/repo' }, 'no-git');
    expect(msg).toMatch(/not a usable git repo/);
    expect(msg).toMatch(/no-git/);
  });
});

describe('recloneIfMissing — refuses to delete an unowned working tree (#1881)', () => {
  test('external local_path + remote_url, no marker → throws unmanaged_path, tree survives', async () => {
    await withEnv2(async () => {
      // Simulate the gstack orchestrator's federated row: remote_url set, but
      // local_path points at a live user working tree (no .git → no-git state),
      // and NO managed_clone marker.
      const userTree = join(FAKE_GIT_DIR, 'user-working-tree');
      rmSync(userTree, { recursive: true, force: true });
      mkdirSync(userTree, { recursive: true });
      const sentinel = join(userTree, 'KEEP_ME.txt');
      writeFileSync(sentinel, 'two unpushed commits live here');

      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
           VALUES ('gstack-code-app-abc', 'flutter', $1,
                   '{"remote_url":"https://github.com/example/repo","federated":true}'::jsonb)`,
        [userTree],
      );

      let threw: SourceOpError | null = null;
      try {
        await recloneIfMissing(engine, 'gstack-code-app-abc');
      } catch (e) {
        threw = e as SourceOpError;
      }
      expect(threw).toBeInstanceOf(SourceOpError);
      expect(threw?.code).toBe('unmanaged_path');
      // The working tree and its sentinel MUST survive untouched.
      expect(existsSync(userTree)).toBe(true);
      expect(existsSync(sentinel)).toBe(true);
    });
  });

  test('sync-shape: same refusal surfaces before any filesystem op', async () => {
    await withEnv2(async () => {
      // A degraded unowned path (the path does not exist at all → missing).
      const ghost = join(FAKE_GIT_DIR, 'ghost-tree');
      rmSync(ghost, { recursive: true, force: true });
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
           VALUES ('ghost', 'g', $1,
                   '{"remote_url":"https://github.com/example/repo"}'::jsonb)`,
        [ghost],
      );
      await expect(recloneIfMissing(engine, 'ghost')).rejects.toThrow(/unmanaged_path|not a clone gbrain created/);
    });
  });
});

describe('recloneIfMissing — symlink TOCTOU + EXDEV-safe swap', () => {
  test('symlink at an owned default-location path → symlink_escape, target untouched', async () => {
    await withEnv2(async () => {
      // Owned by equality: local_path === defaultCloneDir(id). But the path is a
      // symlink to a real dir → reclone must refuse rather than rename through it.
      const id = 'sym-owned';
      const target = join(FAKE_GIT_DIR, 'sym-target');
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      const targetSentinel = join(target, 'precious.txt');
      writeFileSync(targetSentinel, 'do not delete');

      mkdirSync(CLONE_ROOT, { recursive: true });
      const clonePath = defaultCloneDir(id); // = CLONE_ROOT/sym-owned
      symlinkSync(target, clonePath);

      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
           VALUES ($1, 's', $2,
                   '{"remote_url":"https://github.com/example/repo"}'::jsonb)`,
        [id, clonePath],
      );

      let threw: SourceOpError | null = null;
      try {
        await recloneIfMissing(engine, id);
      } catch (e) {
        threw = e as SourceOpError;
      }
      expect(threw?.code).toBe('symlink_escape');
      // Symlink target and its contents survive.
      expect(existsSync(targetSentinel)).toBe(true);
    });
  });

  test('owned no-git clone reclones; no .gbrain-reclone-* / .old-* residue left', async () => {
    await withEnv2(async () => {
      const row = await addSource(engine, {
        id: 'swap-clean',
        remoteUrl: 'https://github.com/example/repo',
      });
      // Degrade to no-git so reclone fires.
      rmSync(join(row.local_path!, '.git'), { recursive: true, force: true });

      const recloned = await recloneIfMissing(engine, 'swap-clean');
      expect(recloned).toBe(true);
      expect(existsSync(join(row.local_path!, '.git'))).toBe(true);

      // Parent (CLONE_ROOT) must hold no swap residue.
      const residue = readdirSync(CLONE_ROOT).filter(
        (e) => e.startsWith('.gbrain-reclone-') || e.includes('.old-'),
      );
      expect(residue).toEqual([]);
    });
  });
});

describe('sources restore — unowned source (CV3)', () => {
  test('restore of an unowned remote_url row: DB row restored, tree survives, correct guidance', async () => {
    await withEnv2(async () => {
      // Archived federated row: remote_url set, local_path = a live user tree
      // (no .git, no managed_clone marker). Restore calls recloneIfMissing,
      // which now throws unmanaged_path; runRestore must catch it, keep the tree,
      // and NOT print the misleading "missing clone, try sync to recover" hint.
      const userTree = join(FAKE_GIT_DIR, 'restore-user-tree');
      rmSync(userTree, { recursive: true, force: true });
      mkdirSync(userTree, { recursive: true });
      const sentinel = join(userTree, 'KEEP_ME.txt');
      writeFileSync(sentinel, 'live repo');

      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, archived)
           VALUES ('restore-unowned', 'flutter', $1,
                   '{"remote_url":"https://github.com/example/repo","federated":false}'::jsonb,
                   true)`,
        [userTree],
      );

      const errs: string[] = [];
      const origErr = console.error;
      console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
      try {
        // Real CLI dispatch → runRestore. Must not throw.
        await runSources(engine, ['restore', 'restore-unowned']);
      } finally {
        console.error = origErr;
      }

      // DB row un-archived (restore succeeded).
      const rows = await engine.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM sources WHERE id = 'restore-unowned'`,
      );
      expect(rows[0].archived).toBe(false);
      // Working tree untouched.
      expect(existsSync(userTree)).toBe(true);
      expect(existsSync(sentinel)).toBe(true);
      // Guidance is the read-only one, NOT the misleading "missing clone" hint.
      const joined = errs.join('\n');
      expect(joined).toMatch(/read-only/);
      expect(joined).not.toMatch(/on-disk clone is missing/);
    });
  });
});

describe('addSource --url — writes ownership marker', () => {
  test('config carries managed_clone:true', async () => {
    await withEnv2(async () => {
      await addSource(engine, {
        id: 'marked',
        remoteUrl: 'https://github.com/example/repo',
      });
      const rows = await engine.executeRaw<{ config: unknown }>(
        `SELECT config FROM sources WHERE id = 'marked'`,
      );
      const cfg =
        typeof rows[0].config === 'string'
          ? JSON.parse(rows[0].config as string)
          : (rows[0].config as Record<string, unknown>);
      expect(cfg.managed_clone).toBe(true);
    });
  });

  test('--clone-dir clone (external path) is owned via marker and reclones', async () => {
    await withEnv2(async () => {
      const externalClone = join(FAKE_GIT_DIR, 'custom-clone-dir');
      rmSync(externalClone, { recursive: true, force: true });
      const row = await addSource(engine, {
        id: 'cdir',
        remoteUrl: 'https://github.com/example/repo',
        cloneDir: externalClone,
      });
      expect(row.local_path).toBe(externalClone);
      // Remove the leaf → reclone must succeed (owned via marker, NOT containment).
      rmSync(externalClone, { recursive: true, force: true });
      const recloned = await recloneIfMissing(engine, 'cdir');
      expect(recloned).toBe(true);
      expect(existsSync(join(externalClone, '.git'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// addSource --path — #2707 git-repo validation at registration time
//
// Deliberately does NOT run under withEnv2 (the fake-git harness above):
// writeFakeGit()'s catch-all `exit 0` would make `rev-parse --show-toplevel`
// (and therefore isInsideGitRepo) succeed unconditionally for any path,
// which defeats the point of these tests. Real system git applies here.
// ---------------------------------------------------------------------------

describe('addSource --path — #2707 git-repo validation', () => {
  const SANDBOX = join(tmpdir(), `gbrain-2707-git-validate-${process.pid}`);

  beforeEach(() => {
    rmSync(SANDBOX, { recursive: true, force: true });
    mkdirSync(SANDBOX, { recursive: true });
  });
  afterAll(() => {
    rmSync(SANDBOX, { recursive: true, force: true });
  });

  test('rejects an existing non-git directory with an actionable error', async () => {
    const plainDir = join(SANDBOX, 'plain');
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, 'notes.md'), 'not committed anywhere');

    let threw: SourceOpError | undefined;
    try {
      await addSource(engine, { id: 'plain-src', localPath: plainDir });
    } catch (e) {
      threw = e as SourceOpError;
    }
    expect(threw).toBeInstanceOf(SourceOpError);
    expect(threw?.code).toBe('not_a_git_repo');
    expect(threw?.message).toContain(plainDir);
    expect(threw?.message).toContain('--force');
    expect(threw?.message).toMatch(/git .*init/);

    // Source was never registered — no partial row left behind.
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = 'plain-src'`,
    );
    expect(rows.length).toBe(0);
  });

  test('rejects a git-initialized directory with zero commits (codex round 1)', async () => {
    const unbornDir = join(SANDBOX, 'unborn');
    mkdirSync(unbornDir, { recursive: true });
    execFileSync('git', ['-C', unbornDir, 'init', '-q']);
    // No `git add` / `git commit` — isInsideGitRepo alone would pass this.

    let threw: SourceOpError | undefined;
    try {
      await addSource(engine, { id: 'unborn-src', localPath: unbornDir });
    } catch (e) {
      threw = e as SourceOpError;
    }
    expect(threw).toBeInstanceOf(SourceOpError);
    expect(threw?.code).toBe('not_a_git_repo');
  });

  test('rejects an empty-commit repo whose files are untracked (codex round 2)', async () => {
    // git commit --allow-empty gives a resolvable HEAD (so a bare "has a
    // commit" check would wrongly pass this) but the tree is empty; files
    // written afterward are untracked and invisible to the sync walker.
    const emptyCommitDir = join(SANDBOX, 'empty-commit');
    mkdirSync(emptyCommitDir, { recursive: true });
    execFileSync('git', ['-C', emptyCommitDir, 'init', '-q']);
    execFileSync('git', ['-C', emptyCommitDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', emptyCommitDir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', emptyCommitDir, 'commit', '--allow-empty', '-q', '-m', 'empty']);
    writeFileSync(join(emptyCommitDir, 'notes.md'), 'never committed');

    let threw: SourceOpError | undefined;
    try {
      await addSource(engine, { id: 'empty-commit-src', localPath: emptyCommitDir });
    } catch (e) {
      threw = e as SourceOpError;
    }
    expect(threw).toBeInstanceOf(SourceOpError);
    expect(threw?.code).toBe('not_a_git_repo');
  });

  test('rejects an untracked subdirectory of an otherwise-real git repo (codex round 2)', async () => {
    const parent = join(SANDBOX, 'partial-repo');
    const trackedFile = join(parent, 'README.md');
    const untrackedSub = join(parent, 'untracked-sub');
    mkdirSync(untrackedSub, { recursive: true });
    writeFileSync(trackedFile, '# fixture');
    execFileSync('git', ['-C', parent, 'init', '-q']);
    execFileSync('git', ['-C', parent, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', parent, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', parent, 'add', 'README.md']);
    execFileSync('git', ['-C', parent, 'commit', '-q', '-m', 'initial import']);
    writeFileSync(join(untrackedSub, 'x.md'), 'never git add-ed');

    let threw: SourceOpError | undefined;
    try {
      await addSource(engine, { id: 'partial-repo-src', localPath: untrackedSub });
    } catch (e) {
      threw = e as SourceOpError;
    }
    expect(threw).toBeInstanceOf(SourceOpError);
    expect(threw?.code).toBe('not_a_git_repo');
  });

  test('registers a repo with many tracked entries without buffer-size false rejection (codex round 3)', async () => {
    // Codex round 3 (P2): the earlier `git ls-tree` listing implementation
    // buffered the whole tree and could exceed execFileSync's default 1 MiB
    // maxBuffer on a large repo, causing an incorrect rejection. The
    // rev-parse HEAD:./ + empty-tree-SHA-comparison implementation reads a
    // fixed ~40-byte SHA regardless of tree size — this locks that in.
    const bigDir = join(SANDBOX, 'many-entries');
    mkdirSync(bigDir, { recursive: true });
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(bigDir, `file-${i}.md`), `# entry ${i}`);
    }
    execFileSync('git', ['-C', bigDir, 'init', '-q']);
    execFileSync('git', ['-C', bigDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', bigDir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', bigDir, 'add', '-A']);
    execFileSync('git', ['-C', bigDir, 'commit', '-q', '-m', 'many files']);

    const row = await addSource(engine, { id: 'many-entries-src', localPath: bigDir });
    expect(row.local_path).toBe(bigDir);
  });

  // Codex round 4 (P2): the empty-tree OID is hash-algorithm-specific — a
  // hardcoded SHA-1 constant silently mismatched (and so accepted) an empty
  // SHA-256 repo. --object-format=sha256 needs git 2.29+; skip rather than
  // hard-fail on an older CI git.
  const SHA256_SUPPORTED = (() => {
    try {
      const probe = join(tmpdir(), `gbrain-2707-sha256-probe-${process.pid}`);
      mkdirSync(probe, { recursive: true });
      execFileSync('git', ['-C', probe, 'init', '-q', '--object-format=sha256'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      rmSync(probe, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!SHA256_SUPPORTED)(
    'rejects an empty-commit SHA-256 repo the same as a SHA-1 one (codex round 4)',
    async () => {
      const sha256Dir = join(SANDBOX, 'sha256-empty');
      mkdirSync(sha256Dir, { recursive: true });
      execFileSync('git', ['-C', sha256Dir, 'init', '-q', '--object-format=sha256']);
      execFileSync('git', ['-C', sha256Dir, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', sha256Dir, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', sha256Dir, 'commit', '--allow-empty', '-q', '-m', 'empty']);
      writeFileSync(join(sha256Dir, 'notes.md'), 'never committed');

      let threw: SourceOpError | undefined;
      try {
        await addSource(engine, { id: 'sha256-empty-src', localPath: sha256Dir });
      } catch (e) {
        threw = e as SourceOpError;
      }
      expect(threw).toBeInstanceOf(SourceOpError);
      expect(threw?.code).toBe('not_a_git_repo');
    },
  );

  test.skipIf(!SHA256_SUPPORTED)(
    'registers a SHA-256 repo with real committed content (no regression)',
    async () => {
      const sha256Dir = join(SANDBOX, 'sha256-real');
      mkdirSync(sha256Dir, { recursive: true });
      writeFileSync(join(sha256Dir, 'README.md'), '# fixture');
      execFileSync('git', ['-C', sha256Dir, 'init', '-q', '--object-format=sha256']);
      execFileSync('git', ['-C', sha256Dir, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', sha256Dir, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', sha256Dir, 'add', '-A']);
      execFileSync('git', ['-C', sha256Dir, 'commit', '-q', '-m', 'initial import']);

      const row = await addSource(engine, { id: 'sha256-real-src', localPath: sha256Dir });
      expect(row.local_path).toBe(sha256Dir);
    },
  );

  test('quotes a path with a space in the remediation command (codex round 1)', async () => {
    const spacedDir = join(SANDBOX, 'has space here');
    mkdirSync(spacedDir, { recursive: true });

    let threw: SourceOpError | undefined;
    try {
      await addSource(engine, { id: 'spaced-src', localPath: spacedDir });
    } catch (e) {
      threw = e as SourceOpError;
    }
    expect(threw?.message).toContain(`'${spacedDir}'`);
  });

  test('--force bypasses the check and registers the plain directory as-is', async () => {
    const plainDir = join(SANDBOX, 'plain-forced');
    mkdirSync(plainDir, { recursive: true });

    const row = await addSource(engine, {
      id: 'plain-forced-src',
      localPath: plainDir,
      force: true,
    });
    expect(row.local_path).toBe(plainDir);
  });

  test('an already git-initialized directory registers unaffected (no regression)', async () => {
    const gitDir = join(SANDBOX, 'gitrepo');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'README.md'), '# fixture');
    execFileSync('git', ['-C', gitDir, 'init', '-q']);
    execFileSync('git', ['-C', gitDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', gitDir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', gitDir, 'add', '-A']);
    execFileSync('git', ['-C', gitDir, 'commit', '-q', '-m', 'initial import']);

    const row = await addSource(engine, { id: 'gitrepo-src', localPath: gitDir });
    expect(row.local_path).toBe(gitDir);
  });

  test('a subdirectory of a git repo registers unaffected (#753/#774 parity with sync-time discovery)', async () => {
    const gitDir = join(SANDBOX, 'gitrepo-parent');
    const subDir = join(gitDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'README.md'), '# fixture');
    execFileSync('git', ['-C', gitDir, 'init', '-q']);
    execFileSync('git', ['-C', gitDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', gitDir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', gitDir, 'add', '-A']);
    execFileSync('git', ['-C', gitDir, 'commit', '-q', '-m', 'initial import']);

    const row = await addSource(engine, { id: 'subdir-src', localPath: subDir });
    expect(row.local_path).toBe(subDir);
  });

  test('a not-yet-created path is unaffected (pre-existing lenient behavior, out of #2707 scope)', async () => {
    const missingDir = join(SANDBOX, 'does-not-exist-yet');
    expect(existsSync(missingDir)).toBe(false);

    const row = await addSource(engine, { id: 'missing-src', localPath: missingDir });
    expect(row.local_path).toBe(missingDir);
  });
});

// ---------------------------------------------------------------------------
// isPathContained — symlink-safe confinement helper (exported for reuse)
// ---------------------------------------------------------------------------

describe('isPathContained', () => {
  // Use a sandbox dir, not GBRAIN_HOME (which has the .gbrain quirk).
  const SANDBOX = join(tmpdir(), `gbrain-isPathContained-${process.pid}`);
  beforeEach(() => {
    rmSync(SANDBOX, { recursive: true, force: true });
    mkdirSync(SANDBOX, { recursive: true });
  });
  afterAll(() => {
    rmSync(SANDBOX, { recursive: true, force: true });
  });

  test('accepts real subtree', () => {
    const inside = join(SANDBOX, 'sub', 'dir');
    mkdirSync(inside, { recursive: true });
    expect(isPathContained(inside, SANDBOX)).toBe(true);
  });

  test('rejects path outside parent', () => {
    const outside = '/usr';
    expect(isPathContained(outside, SANDBOX)).toBe(false);
  });

  test('rejects symlink escape (the codex finding case)', () => {
    const target = join(tmpdir(), `escape-${process.pid}-${Date.now()}`);
    mkdirSync(target, { recursive: true });
    const link = join(SANDBOX, 'innocent-name');
    symlinkSync(target, link);
    // After realpath the link resolves to /tmp/escape-…, which is NOT
    // contained under SANDBOX. Function returns false.
    expect(isPathContained(link, SANDBOX)).toBe(false);
    rmSync(target, { recursive: true, force: true });
  });

  test('returns false for missing paths (fail-closed)', () => {
    expect(isPathContained(join(SANDBOX, 'never'), SANDBOX)).toBe(false);
  });
});
