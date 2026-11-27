/**
 * a7689d79: a keep-checkout publish that does not report a push copies none of the child's stderr.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when the remote branch moved, pushGitRoot hands the push to a `gbrain git commit-push --push-only
 *    --keep-checkout` child. A child that exits without a JSON report fails `push_unconfirmed`; its message and
 *    suggestion name the exit and one reason code from GIT_REASONS (git-diagnostic.ts), and the error carries the
 *    diagnostic { phase: push, step: commit-push, reason }. The child's stderr is read once, in memory, to pick the code:
 *    no token, private path or URL password from it reaches the error, the stored effect, or `gbrain sync status`
 *    (JSON or text).
 *  - Regression: the first 300 characters of the child's stderr copied into the suggestion (and from there into
 *    receipts, logs and sync status).
 *  - Why existing coverage misses it: effect-git-secret-gate.test.ts checks only the rerun command of a rejected push;
 *    the GCH-01 tests cover the commit and push steps run in process, not the publish child.
 *  - Seam: GBRAIN_JOB_CHILD_CLI points the publish child at a script that prints the secrets on stderr and exits 1.
 *    Real Git checkouts and real engines.
 *
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { pushGitRoot } from '../src/core/persistence/effect-git.ts';
import { gitDiagnosticOf } from '../src/core/persistence/git-diagnostic.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { runSyncStatus } from '../src/commands/sync/operator.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { type Repo, bindSource, createGitCoalescingFixture, git, harden, pass, pauseGitEffects, putPage, release } from './helpers/git-coalescing-fixture.ts';

const { makeRepo, withBrain, dispose } = createGitCoalescingFixture('a7689d79');
const scratch: string[] = [];
afterAll(() => { dispose(); for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const SECRETS = ['sk_live_8fJ2kQ9xZ7vP3mN1', 'alice-example', 'pa/ss', 'git.example.invalid', '/home/alice-example/private-notes', 'zz8bearervalue'];
const STDERR = `fatal: unable to access 'https://alice-example:pa/ss@git.example.invalid/acme.git/': key sk_live_8fJ2kQ9xZ7vP3mN1 `
  + `read from /home/alice-example/private-notes; Authorization: Bearer zz8bearervalue`;
const DIAGNOSTIC = { phase: 'push', step: 'commit-push', reason: 'remote_unreachable' } as const;

/** A publish child that prints the secrets on stderr, writes nothing on stdout and exits 1. */
function leakyChild(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-a7689d79-child-')); scratch.push(dir);
  const cli = join(dir, 'gbrain-child');
  writeFileSync(cli, `#!/bin/sh\necho ${JSON.stringify(STDERR)} >&2\nexit 1\n`, { mode: 0o755 });
  return cli;
}

/** Another clone pushes a commit, so the checkout's next push is not a fast-forward and goes to the publish child. */
function moveRemote(repo: Repo, home: string): void {
  const other = join(home, 'other');
  git(home, 'clone', '-q', '-b', 'main', repo.remote, other);
  git(other, 'config', 'user.name', 'Other Machine'); git(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'other.md'), 'From the other machine\n');
  git(other, 'add', 'other.md'); git(other, 'commit', '-q', '-m', 'Other machine'); git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
}

const leaked = (text: string) => SECRETS.filter(secret => text.includes(secret));

async function statusText(engine: BrainEngine): Promise<string> {
  const lines: string[] = [];
  const log = console.log, write = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await runSyncStatus(engine, ['--source', 'default']);
    await runSyncStatus(engine, ['--source', 'default', '--json']);
  } finally { console.log = log; process.stdout.write = write; }
  return lines.join('\n');
}

if (testBackends().includes('pglite')) describe('a7689d79 pushGitRoot through a keep-checkout child that reports nothing', () => {
  test('push_unconfirmed names the exit and a reason code, carries the diagnostic, and copies none of the stderr', () => withBrain('pglite', async ({ home }) => {
    const repo = makeRepo(home, 'single');
    harden(repo);
    moveRemote(repo, home);
    writeFileSync(join(repo.root, 'local.md'), 'local\n');
    git(repo.root, 'add', 'local.md'); git(repo.root, 'commit', '-q', '-m', 'Local commit');
    const error = await withEnv({ GBRAIN_JOB_CHILD_CLI: leakyChild() }, () => pushGitRoot(repo.root).then(() => null, (e: unknown) => e));
    expect(error).toBeInstanceOf(OperationError);
    const op = error as OperationError;
    expect(op.code).toBe('push_unconfirmed');
    expect(gitDiagnosticOf(op)).toEqual(DIAGNOSTIC);
    expect(op.suggestion).toContain('exit 1, reason remote_unreachable');
    expect(leaked(`${op.message} ${op.suggestion ?? ''} ${op.detail ?? ''} ${JSON.stringify(op)}`)).toEqual([]);
  }), 120_000);
});

for (const kind of testBackends()) describe(`a7689d79 the held push stores and prints no stderr (${kind})`, () => {
  if (kind === 'postgres') process.env.GBRAIN_TEST_COALESCE_PG ??= process.env.DATABASE_URL;

  test('the effect keeps { phase, step, reason } only; sync status JSON and text show none of the secrets', () => withBrain(kind, async ({ engine, home, ctx }) => {
    const repo = makeRepo(home, 'content');
    await bindSource(engine, 'default', repo);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    harden(repo);
    await pauseGitEffects(engine, () => putPage(ctx('default'), 1));
    await release(engine);
    await pass(engine);
    moveRemote(repo, home);
    await pauseGitEffects(engine, () => putPage(ctx('default'), 2));
    await withEnv({ GBRAIN_JOB_CHILD_CLI: leakyChild() }, async () => { await release(engine); await pass(engine); });
    const rows = await engine.executeRaw<{ state: string; error_code: string | null; last_error: Record<string, unknown> | null; row: string }>(
      "SELECT state, error_code, data->'last_error' AS last_error, row_to_json(e)::text AS row FROM persistence_effects e WHERE kind='git' ORDER BY id DESC LIMIT 1");
    expect({ state: rows[0]!.state, error_code: rows[0]!.error_code, last_error: rows[0]!.last_error })
      .toEqual({ state: 'queued', error_code: 'push_unconfirmed', last_error: DIAGNOSTIC });
    expect(leaked(rows[0]!.row)).toEqual([]);
    const status = await readSyncStatus(engine, 'default');
    expect(status.git_push_holds.map(hold => ({ retrying: hold.retrying, parked: hold.parked, codes: hold.codes, last_error: hold.last_error })))
      .toEqual([{ retrying: 1, parked: 0, codes: ['push_unconfirmed'], last_error: DIAGNOSTIC }]);
    expect(leaked(JSON.stringify(status))).toEqual([]);
    const text = await statusText(engine);
    expect(text).toContain('(push_unconfirmed) since ');
    expect(text).toContain(' at step commit-push (reason: remote_unreachable)');
    expect(leaked(text)).toEqual([]);
    // F1: the reason survives the park (five failures), and still nothing of the stderr is kept.
    await withEnv({ GBRAIN_JOB_CHILD_CLI: leakyChild() }, async () => { for (let i = 0; i < 4; i++) { await release(engine); await pass(engine); } });
    const parked = await readSyncStatus(engine, 'default');
    expect(parked.git_push_holds.map(hold => ({ parked: hold.parked, codes: hold.codes, last_error: hold.last_error })))
      .toEqual([{ parked: 1, codes: ['push_unconfirmed'], last_error: DIAGNOSTIC }]);
    const [stored] = await engine.executeRaw<{ row: string }>("SELECT row_to_json(e)::text AS row FROM persistence_effects e WHERE kind='git' ORDER BY id DESC LIMIT 1");
    expect(leaked(stored!.row + JSON.stringify(parked) + await statusText(engine))).toEqual([]);
  }), 300_000);
});
