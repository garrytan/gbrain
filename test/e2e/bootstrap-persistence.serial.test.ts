/**
 * GAP 7 — session-end persistence chain, UNMOCKED end-to-end.
 *
 * `test/hook-command.serial.test.ts` proves session-end up to the mocked
 * `io.spawnPush` seam (it only records that a push WOULD fire). This file
 * closes the remaining gap: it drives the session-end hook against a REAL
 * local bare git remote with the REAL push implementation — the same
 * `workspacePush` the detached `gbrain sources push` child runs — so the full
 * hook → scan → commit → push chain is exercised and its outcome verified on
 * the remote.
 *
 * The only concession to a hermetic test is `allowUnverifiedRemote: true`:
 * `workspacePush`'s privacy gate can only confirm PRIVATE visibility for a
 * real GitHub origin via `gh`, which a `file://` bare remote isn't — every
 * sibling `workspace-push.serial.test.ts` case makes the same concession. The
 * scan/commit/push machinery under test is otherwise identical to production.
 *
 * Serial: mutates HOME/GBRAIN_HOME + spawns git subprocesses. All secrets are
 * synthetic fixtures; GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1 permits file transport.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { runHook } from '../../src/commands/hook.ts';
import { workspacePush, type WorkspacePushResult } from '../../src/core/workspace-push.ts';
import { writeManifest, writeReceipt } from '../../src/core/bootstrap/format.ts';

const OPENAI_KEY = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
const ENV_KEYS = ['HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_HOOKS', 'GBRAIN_GIT_ALLOW_FILE_TRANSPORT'] as const;

// #2943: env: process.env is REQUIRED — Bun snapshots env at startup, so a
// spawned git would otherwise be blind to beforeEach's HOME/GBRAIN_HOME swap.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}
function originHead(bare: string): string {
  return git(bare, 'rev-parse', 'refs/heads/main');
}

const MANIFEST = {
  format_version: 1 as const,
  initialized: true as const,
  agent_name: 'persist-test',
  created_by: 'test',
  created_at: '2026-01-01T00:00:00.000Z',
  source_id: 'workspace',
};

let root: string;
let bare: string;
let work: string;
let saved: Record<string, string | undefined>;

/** Real push path, in-process: exactly what `gbrain sources push --path`
 * invokes. Captured so the test can await the chain the hook kicks off. */
let pushes: Promise<WorkspacePushResult>[];
const realSpawnPush = (r: string) => {
  pushes.push(workspacePush({ dir: r, branch: 'main', allowUnverifiedRemote: true }));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gb-persist-'));
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_HOOKS'] as const) delete process.env[k];
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  // CX2-8: GBRAIN_HOME is a PARENT dir → effective home is $HOME/.gbrain.
  process.env.GBRAIN_HOME = process.env.HOME;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';

  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', env: process.env });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore', env: process.env });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }

  // The initialized manifest is the security boundary the hook gates on.
  writeManifest(work, MANIFEST);
  // Repo phase complete: the receipt binds this workspace to its verified
  // origin (exact-URL binding for non-github transports) — without it the
  // no-daemon pushes defer by design (create-repo-first race protection).
  const toplevel = git(work, 'rev-parse', '--show-toplevel');
  mkdirSync(join(process.env.HOME!, '.gbrain', 'bootstrap'), { recursive: true });
  writeReceipt(join(process.env.HOME!, '.gbrain'), {
    receipt_version: 1,
    workspace_dir: toplevel,
    source_id: 'workspace',
    agent_name: 'persist-test',
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: 'test',
    brain_created_by_bootstrap: false,
    created_paths: [],
    registrations: [],
    repo_url: bare,
  } as Parameters<typeof writeReceipt>[1] & { repo_url: string });
  pushes = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('session-end → real workspace push', () => {
  test('authored session content actually lands on the bare remote', async () => {
    // The agent authored real work into the brain during the session.
    mkdirSync(join(work, 'brain'), { recursive: true });
    const authored = 'the acme-example roadmap decision: ship the memory layer in Q3';
    writeFileSync(join(work, 'brain', 'decision.md'), `# decision\n\n${authored}\n`);

    const before = originHead(bare);
    const code = await runHook(['session-end'], {
      write: () => {},
      cwd: work,
      spawnPush: realSpawnPush,
      stdin: JSON.stringify({ session_id: 'persist-ok', cwd: work }),
    });
    expect(code).toBe(0);

    // The hook kicked off exactly one real push; await its completion.
    expect(pushes).toHaveLength(1);
    const res = await pushes[0];
    expect(res.status).toBe('pushed');
    expect(res.ok).toBe(true);
    expect(res.committed).toBe(true);

    // Origin advanced, and the authored file+content are physically there.
    expect(originHead(bare)).not.toBe(before);
    const verify = mkdtempSync(join(root, 'verify-'));
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, verify], { stdio: 'ignore', env: process.env });
    const landed = join(verify, 'brain', 'decision.md');
    expect(existsSync(landed)).toBe(true);
    expect(readFileSync(landed, 'utf-8')).toContain(authored);
  }, 60_000);

  test('a planted secret in authored content is BLOCKED at the push gate — nothing leaves', async () => {
    mkdirSync(join(work, 'brain'), { recursive: true });
    // A genuine note plus a file that leaks a synthetic OpenAI key.
    writeFileSync(join(work, 'brain', 'safe.md'), '# safe\n\nno secrets here\n');
    writeFileSync(join(work, 'brain', 'leak.md'), `# oops\n\napi key: ${OPENAI_KEY}\n`);

    const before = originHead(bare);
    const code = await runHook(['session-end'], {
      write: () => {},
      cwd: work,
      spawnPush: realSpawnPush,
      stdin: JSON.stringify({ session_id: 'persist-leak', cwd: work }),
    });
    expect(code).toBe(0);

    expect(pushes).toHaveLength(1);
    const res = await pushes[0];
    // The scan gate fired: nothing committed, nothing pushed, secret named.
    expect(res.status).toBe('blocked_secrets');
    expect(res.ok).toBe(false);
    expect(res.findings?.some((f) => f.file === 'brain/leak.md' && f.pattern === 'openai')).toBe(true);
    // The secret VALUE never surfaces in the result payload.
    expect(JSON.stringify(res).includes(OPENAI_KEY)).toBe(false);

    // Origin is untouched — the leak never left the machine.
    expect(originHead(bare)).toBe(before);
    const shipped = git(bare, 'ls-tree', '-r', '--name-only', 'main');
    expect(shipped).not.toContain('brain/leak.md');
    expect(shipped).not.toContain('brain/safe.md'); // blocked atomically — nothing in the batch shipped
  }, 60_000);
});

// ── per-turn Stop push [D3]: the /exit + VM-reclaim durability lane ─────────
//
// SessionEnd never fires on /exit; the Stop hook fires after EVERY assistant
// turn. This chain proves a turn's authored work physically lands on the real
// bare remote from a single `gbrain hook stop`, and that the per-root debounce
// holds across consecutive stops.

describe('stop → real workspace push (per-turn durability)', () => {
  test('one stop banks the turn to origin; the next stop inside the window debounces', async () => {
    process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN = '60';
    try {
      mkdirSync(join(work, 'brain'), { recursive: true });
      writeFileSync(join(work, 'brain', 'turn-note.md'), '# turn\n\nlearned during the turn\n');

      const before = originHead(bare);
      const code = await runHook(['stop'], {
        write: () => {},
        cwd: work,
        spawnPush: realSpawnPush,
        stdin: JSON.stringify({ session_id: 'persist-stop', cwd: work }),
      });
      expect(code).toBe(0);
      expect(pushes).toHaveLength(1);
      const res = await pushes[0];
      expect(res.ok).toBe(true);
      expect(res.status).toBe('pushed');
      expect(originHead(bare)).not.toBe(before);

      // Second stop, same window, clean tree — debounced, no second spawn.
      const code2 = await runHook(['stop'], {
        write: () => {},
        cwd: work,
        spawnPush: realSpawnPush,
        stdin: JSON.stringify({ session_id: 'persist-stop-2', cwd: work }),
      });
      expect(code2).toBe(0);
      expect(pushes).toHaveLength(1);
    } finally {
      delete process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN;
    }
  }, 60_000);

  test('debounce 0 (the cloud-sandbox default): consecutive dirty turns both land', async () => {
    process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN = '0';
    try {
      mkdirSync(join(work, 'brain'), { recursive: true });
      writeFileSync(join(work, 'brain', 'a.md'), '# a\n');
      await runHook(['stop'], {
        write: () => {},
        cwd: work,
        spawnPush: realSpawnPush,
        stdin: JSON.stringify({ session_id: 'ps-z1', cwd: work }),
      });
      expect(pushes).toHaveLength(1);
      expect((await pushes[0]).ok).toBe(true);
      writeFileSync(join(work, 'brain', 'b.md'), '# b\n');
      await runHook(['stop'], {
        write: () => {},
        cwd: work,
        spawnPush: realSpawnPush,
        stdin: JSON.stringify({ session_id: 'ps-z2', cwd: work }),
      });
      expect(pushes).toHaveLength(2);
      const res2 = await pushes[1];
      expect(res2.ok).toBe(true);
      const shipped = git(bare, 'ls-tree', '-r', '--name-only', 'main');
      expect(shipped).toContain('brain/a.md');
      expect(shipped).toContain('brain/b.md');
    } finally {
      delete process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN;
    }
  }, 60_000);
});
