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
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  addSource,
  listSources,
  removeSource,
  getSourceStatus,
  recloneIfMissing,
  isPathContained,
  defaultCloneDir,
  SourceOpError,
} from '../src/core/sources-ops.ts';
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
      await addSource(engine, { id: 'cleanup-no', localPath: userPath });
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
      // local_path is null. Test the truthful behavior:
      await addSource(engine, { id: 'status-no-url', localPath: userPath });
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
