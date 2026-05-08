/**
 * sources sync re-clone recovery — exercises the v0.28 branch in
 * src/commands/sync.ts that recovers from a missing/corrupted clone dir
 * by re-cloning when the source has a remote_url.
 *
 * Setup uses fake-git in PATH so we can simulate clones without network.
 * Real-Postgres E2E coverage of the same flow lives in
 * test/e2e/sources-remote-mcp.test.ts.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addSource, recloneIfMissing } from '../src/core/sources-ops.ts';
import { validateRepoState } from '../src/core/git-remote.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const FAKE_GIT_DIR = join(tmpdir(), `gbrain-resync-test-${process.pid}`);
const GBRAIN_HOME = join(FAKE_GIT_DIR, 'gbrain-home');
const CLONE_ROOT = join(GBRAIN_HOME, '.gbrain', 'clones');

function writeFakeGit(): void {
  mkdirSync(FAKE_GIT_DIR, { recursive: true });
  writeFileSync(join(FAKE_GIT_DIR, 'mode'), 'ok');
  const script = `#!/usr/bin/env bash
mode=$(cat "${join(FAKE_GIT_DIR, 'mode')}" 2>/dev/null || echo ok)
url_to_return=\${REMOTE_GET_URL_OUTPUT:-https://github.com/example/repo}
case "$mode" in
  clone-fail) exit 1 ;;
esac
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
  echo "$url_to_return"
  exit 0
fi
exit 0
`;
  const path = join(FAKE_GIT_DIR, 'git');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

const fakePath = (): string => `${FAKE_GIT_DIR}:${process.env.PATH ?? ''}`;

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
  rmSync(GBRAIN_HOME, { recursive: true, force: true });
  mkdirSync(GBRAIN_HOME, { recursive: true });
  writeFileSync(join(FAKE_GIT_DIR, 'mode'), 'ok');
});

// ---------------------------------------------------------------------------
// validateRepoState — direct probe of all 6 states using the fake git
// ---------------------------------------------------------------------------

describe('validateRepoState — full state matrix (sync re-clone driver)', () => {
  test('healthy: existing .git + matching origin URL', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'state-healthy',
        remoteUrl: 'https://github.com/example/repo',
      });
      expect(validateRepoState(row.local_path!, 'https://github.com/example/repo'))
        .toBe('healthy');
    });
  });

  test('missing: clone dir was rmd', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'state-missing',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(row.local_path!, { recursive: true, force: true });
      expect(validateRepoState(row.local_path!, 'https://github.com/example/repo'))
        .toBe('missing');
    });
  });

  test('not-a-dir: clone path is a file', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'state-file',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(row.local_path!, { recursive: true, force: true });
      mkdirSync(CLONE_ROOT, { recursive: true });
      writeFileSync(row.local_path!, 'corrupted');
      expect(validateRepoState(row.local_path!, 'https://github.com/example/repo'))
        .toBe('not-a-dir');
    });
  });

  test('no-git: directory exists but no .git/ inside', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'state-no-git',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(join(row.local_path!, '.git'), { recursive: true, force: true });
      expect(validateRepoState(row.local_path!, 'https://github.com/example/repo'))
        .toBe('no-git');
    });
  });

  test('corrupted: .git exists but git remote get-url fails', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'state-corrupted',
        remoteUrl: 'https://github.com/example/repo',
      });
      writeFileSync(join(FAKE_GIT_DIR, 'mode'), 'clone-fail'); // makes git exit 1 always
      expect(validateRepoState(row.local_path!, 'https://github.com/example/repo'))
        .toBe('corrupted');
    });
  });

  test('url-drift: remote points elsewhere', async () => {
    await withEnv(
      { GBRAIN_HOME, PATH: fakePath(), REMOTE_GET_URL_OUTPUT: 'https://github.com/different/repo' },
      async () => {
        const row = await addSource(engine, {
          id: 'state-drift',
          remoteUrl: 'https://github.com/example/repo',
        });
        expect(validateRepoState(row.local_path!, 'https://github.com/example/repo'))
          .toBe('url-drift');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// recloneIfMissing — recovery contract under each starting state
// ---------------------------------------------------------------------------

describe('recloneIfMissing — recovery from each degraded state', () => {
  test('recovers from "missing" by re-cloning', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'rec-missing',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(row.local_path!, { recursive: true, force: true });
      const recloned = await recloneIfMissing(engine, 'rec-missing');
      expect(recloned).toBe(true);
      expect(existsSync(join(row.local_path!, '.git'))).toBe(true);
    });
  });

  test('recovers from "no-git" by re-cloning over the empty dir', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'rec-nogit',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(join(row.local_path!, '.git'), { recursive: true, force: true });
      const recloned = await recloneIfMissing(engine, 'rec-nogit');
      expect(recloned).toBe(true);
      expect(existsSync(join(row.local_path!, '.git'))).toBe(true);
    });
  });

  test('recovers from "not-a-dir" by replacing the file with a clone', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'rec-file',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(row.local_path!, { recursive: true, force: true });
      mkdirSync(CLONE_ROOT, { recursive: true });
      writeFileSync(row.local_path!, 'corrupted');
      const recloned = await recloneIfMissing(engine, 'rec-file');
      expect(recloned).toBe(true);
      expect(existsSync(join(row.local_path!, '.git'))).toBe(true);
    });
  });

  test('idempotent on healthy clones (returns false, no clone)', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      await addSource(engine, {
        id: 'rec-healthy',
        remoteUrl: 'https://github.com/example/repo',
      });
      expect(await recloneIfMissing(engine, 'rec-healthy')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Sync-time integration: the same path performSync uses
// ---------------------------------------------------------------------------

describe('performSync re-clone branch (driven by sync.ts:320 logic)', () => {
  test('healthy clone: validateRepoState passes through to existing pull path', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'sync-healthy',
        remoteUrl: 'https://github.com/example/repo',
      });
      // Simulate the sync.ts:320 lookup
      const cfgRows = await engine.executeRaw<{ config: unknown }>(
        `SELECT config FROM sources WHERE id = $1`,
        ['sync-healthy'],
      );
      const cfg = cfgRows[0].config as Record<string, unknown>;
      const remoteUrl = cfg.remote_url as string;
      const state = validateRepoState(row.local_path!, remoteUrl);
      expect(state).toBe('healthy');
    });
  });

  test('missing clone: state becomes "missing", re-clone fires', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const row = await addSource(engine, {
        id: 'sync-missing',
        remoteUrl: 'https://github.com/example/repo',
      });
      rmSync(row.local_path!, { recursive: true, force: true });
      // sync.ts:320 detects 'missing' and calls recloneIfMissing
      const state = validateRepoState(row.local_path!, 'https://github.com/example/repo');
      expect(state).toBe('missing');
      const recloned = await recloneIfMissing(engine, 'sync-missing');
      expect(recloned).toBe(true);
    });
  });
});
