/**
 * Wave C 1H-a (spec §3.5): a strict file publication hashes its bytes into Git before it takes the writer lock, and the
 * door turn hashes nothing. Under the lock the door rechecks what the pre-hash stood for: the file must still hold the
 * planned bytes (git_target_changed otherwise, as before) and the path's attributes must be the ones the blob was hashed
 * under; a changed plan or changed attributes (an ident attribute added meanwhile) make the door hash the file in place.
 * A path with a clean filter is never pre-hashed. GIT_TRACE shows which hash-object calls ran.
 *
 * The recheck is batched (one check-attr per door turn, however many files), covers the checkout's line-ending config
 * (core.autocrlf / core.eol / core.safecrlf, which convert bytes as attributes do), and confirms the blobs are still
 * stored (one cat-file --batch-check): a blob pruned meanwhile (gc --prune=now) is hashed again, never committed missing.
 * A recheck that cannot answer (a step that is killed or overflows, exits non-zero, or answers incompletely) drops every
 * pre-hash and the door hashes under the lock as before; it never refuses the publication. A git shim on PATH forces
 * each failure.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { gitChildEnv } from '../../src/core/git-env.ts';
import { operations } from '../../src/core/operations.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { runImport } from '../../src/commands/import.ts';
import { commitThroughDoor, prehashDoorFile, type DoorFile } from '../../src/core/persistence/git-door.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(dir); return dir; };
/** The hash-object command lines a GIT_TRACE file recorded. */
const traced = (trace: string) => existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(line => /trace: (built-in|exec): git /.test(line)).map(line => line.replace(/^.*?trace: (built-in|exec): git /, '')) : [];
/** The check-attr calls of each door turn a GIT_TRACE file recorded (a turn runs from its symbolic-ref of HEAD to its update-ref). */
const checkAttrPerTurn = (trace: string) => {
  const turns: number[] = [];
  let open = false;
  for (const call of traced(trace)) {
    if (call.startsWith('symbolic-ref -q HEAD')) { turns.push(0); open = true; }
    else if (call.startsWith('update-ref')) open = false;
    else if (open && call.startsWith('check-attr')) turns[turns.length - 1]!++;
  }
  return turns;
};
const hashCalls = (trace: string) => existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(line => /trace: (built-in|exec): git hash-object/.test(line)).map(line => line.replace(/^.*?git hash-object/, 'hash-object')) : [];

function repo(): string {
  const root = scratch('gbrain-prehash-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'seed.md'), 'seed\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  return root;
}
const put = (root: string, path: string, body: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };

describe('door pre-hash: rechecks under the lock', () => {
  test('a blob hashed before the lock is committed as is; the door turn runs no hash-object of the file', async () => {
    const root = repo(), trace = join(scratch('gbrain-trace-'), 'trace');
    const body = 'pre-hashed body\n';
    const prehashed = await prehashDoorFile(root, join(root, 'notes/a.md'), body);
    expect(prehashed).toMatchObject({ planned: sha256(body) });
    put(root, 'notes/a.md', body);
    await withEnv({ GIT_TRACE: trace }, () => commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256(body), prehashed }]));
    expect(git(root, 'rev-parse', 'HEAD:notes/a.md')).toBe(prehashed!.oid);
    expect(hashCalls(trace).filter(call => !call.includes('-t tree'))).toEqual([]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('attributes that changed after the pre-hash make the door hash the file in place', async () => {
    const root = repo(), trace = join(scratch('gbrain-trace-'), 'trace');
    const body = 'Revision $Id: stale-expansion $ of the page.\n';
    const prehashed = await prehashDoorFile(root, join(root, 'notes/b.md'), body);
    writeFileSync(join(root, '.gitattributes'), '*.md ident\n');
    put(root, 'notes/b.md', body);
    await withEnv({ GIT_TRACE: trace }, () => commitThroughDoor(root, [{ path: join(root, 'notes/b.md'), planned: sha256(body), prehashed }]));
    expect(git(root, 'rev-parse', 'HEAD:notes/b.md')).not.toBe(prehashed!.oid);
    expect(git(root, 'cat-file', '-p', 'HEAD:notes/b.md')).toContain('$Id$');
    expect(hashCalls(trace).some(call => call.includes('notes/b.md') && !call.includes('--path'))).toBe(true);
  });

  test('a pre-hash of other bytes than the plan is not used', async () => {
    const root = repo();
    const prehashed = await prehashDoorFile(root, join(root, 'notes/c.md'), 'an earlier draft\n');
    put(root, 'notes/c.md', 'the planned body\n');
    await commitThroughDoor(root, [{ path: join(root, 'notes/c.md'), planned: sha256('the planned body\n'), prehashed }]);
    expect(git(root, 'show', 'HEAD:notes/c.md')).toBe('the planned body');
  });

  test('a file rewritten after the pre-hash still refuses git_target_changed', async () => {
    const root = repo();
    const body = 'planned\n';
    const prehashed = await prehashDoorFile(root, join(root, 'notes/d.md'), body);
    put(root, 'notes/d.md', 'edited on disk\n');
    const refused = await commitThroughDoor(root, [{ path: join(root, 'notes/d.md'), planned: sha256(body), prehashed }]).then(() => null, (error: { code?: string }) => error);
    expect(refused?.code).toBe('git_target_changed');
    expect(() => git(root, 'rev-parse', 'HEAD:notes/d.md')).toThrow();
  });

  test('a multi-file publication rechecks every attribute with one check-attr in the door turn', async () => {
    const root = repo(), trace = join(scratch('gbrain-trace-'), 'trace');
    writeFileSync(join(root, '.gitattributes'), '*.md text eol=lf\nnotes/sub/*.md diff=markdown linguist-generated\n');
    git(root, 'add', '.gitattributes'); git(root, 'commit', '-qm', 'attributes');
    const files = ['notes/f1.md', 'notes/f2.md', 'notes/sub/f3.md'].map(path => ({ path, body: path + ' body\n' }));
    const door: DoorFile[] = [];
    for (const { path, body } of files) {
      const prehashed = await prehashDoorFile(root, join(root, path), body);
      put(root, path, body);
      door.push({ path: join(root, path), planned: sha256(body), prehashed });
    }
    await withEnv({ GIT_TRACE: trace }, () => commitThroughDoor(root, door));
    expect(traced(trace).filter(call => call.startsWith('check-attr')).length).toBe(1);
    for (const [i, { path }] of files.entries()) expect(git(root, 'rev-parse', 'HEAD:' + path)).toBe(door[i]!.prehashed!.oid);
    expect(hashCalls(trace).filter(call => !call.includes('-t tree'))).toEqual([]);
  });

  test('core.autocrlf flipped after the pre-hash makes the door hash the file in place', async () => {
    const root = repo();
    const body = 'line one\r\nline two\r\n';
    const prehashed = await prehashDoorFile(root, join(root, 'notes/crlf.md'), body);
    git(root, 'config', 'core.autocrlf', 'true');
    put(root, 'notes/crlf.md', body);
    await commitThroughDoor(root, [{ path: join(root, 'notes/crlf.md'), planned: sha256(body), prehashed }]);
    const inLock = git(root, 'hash-object', '--', 'notes/crlf.md');
    expect(inLock).not.toBe(prehashed!.oid);
    expect(git(root, 'rev-parse', 'HEAD:notes/crlf.md')).toBe(inLock);
  });

  test('a pre-hashed blob pruned before the commit is hashed again, so the tree has no missing object', async () => {
    const root = repo();
    const body = 'a blob gc prunes before the door turn\n';
    const prehashed = await prehashDoorFile(root, join(root, 'notes/pruned.md'), body);
    git(root, 'gc', '-q', '--prune=now');
    expect(() => git(root, 'cat-file', '-e', prehashed!.oid)).toThrow();
    put(root, 'notes/pruned.md', body);
    await commitThroughDoor(root, [{ path: join(root, 'notes/pruned.md'), planned: sha256(body), prehashed }]);
    expect(git(root, 'show', 'HEAD:notes/pruned.md')).toBe(body.trim());
    expect(git(root, 'fsck', '--connectivity-only', '--no-dangling')).toBe('');
  });

  test('a path with a clean filter is not pre-hashed', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitattributes'), '*.md filter=example\n');
    expect(await prehashDoorFile(root, join(root, 'notes/e.md'), 'body\n')).toBeNull();
  });
});

/** A PATH whose git answers one recheck step (check-attr, the line-ending config read, cat-file --batch-check) as the mode says. */
function shim(mode: string): Record<string, string> {
  const dir = scratch('gbrain-git-shim-');
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), [
    '#!/bin/bash',
    'step=',
    'for a in "$@"; do case "$a" in check-attr) step=check-attr;; --get-regexp) step=config;; --batch-check) step=cat-file;; esac; done',
    'drain() { [ "$step" = config ] || cat >/dev/null; }',
    'case "$GBRAIN_TEST_GIT_SHIM:$step" in',
    '  *-killed:"${GBRAIN_TEST_GIT_SHIM%-killed}") drain; kill -KILL $$;;',
    '  *-exit:"${GBRAIN_TEST_GIT_SHIM%-exit}") drain; exit 128;;',
    '  check-attr-truncated:check-attr) "' + real + '" "$@" | head -c 7; exit 0;;',
    '  cat-file-short:cat-file) "' + real + '" "$@" | head -n 1; exit 0;;',
    'esac',
    'exec "' + real + '" "$@"',
    '',
  ].join('\n'));
  chmodSync(join(dir, 'git'), 0o755);
  return { PATH: dir + ':' + process.env.PATH, GBRAIN_TEST_GIT_SHIM: mode };
}

describe('door pre-hash: a recheck that cannot answer never refuses', () => {
  /** Three pre-hashed files (one with an attribute), committed under the shim; returns the paths and the in-lock hash-object calls. */
  async function publish(mode: string) {
    const root = repo(), trace = join(scratch('gbrain-trace-'), 'trace');
    writeFileSync(join(root, '.gitattributes'), 'notes/attr-*.md diff=markdown\n');
    git(root, 'add', '.gitattributes'); git(root, 'commit', '-qm', 'attributes');
    const paths = ['notes/plain-1.md', 'notes/plain-2.md', 'notes/attr-3.md'];
    const door: DoorFile[] = [];
    for (const path of paths) {
      const body = path + ' body\n';
      door.push({ path: join(root, path), planned: sha256(body), prehashed: await prehashDoorFile(root, join(root, path), body) });
      put(root, path, body);
    }
    expect(door.every(file => file.prehashed)).toBe(true);
    await withEnv({ ...shim(mode), GIT_TRACE: trace }, () => commitThroughDoor(root, door));
    for (const path of paths) expect(git(root, 'rev-parse', 'HEAD:' + path)).toBe(git(root, 'hash-object', '--', path));
    expect(git(root, 'status', '--porcelain')).toBe('');
    return { paths, inLock: hashCalls(trace).filter(call => !call.includes('-t tree') && !call.includes('--path')) };
  }

  for (const step of ['check-attr', 'config', 'cat-file']) {
    test(step + ' killed under the lock (a throw from git()): every file is hashed in place and the commit lands', async () => {
      const { paths, inLock } = await publish(step + '-killed');
      for (const path of paths) expect(inLock.some(call => call.includes(path))).toBe(true);
    });
    test(step + ' exiting non-zero: every file is hashed in place and the commit lands', async () => {
      const { paths, inLock } = await publish(step + '-exit');
      for (const path of paths) expect(inLock.some(call => call.includes(path))).toBe(true);
    });
  }

  for (const mode of ['check-attr-truncated', 'cat-file-short']) test(mode + ': an incomplete answer drops every pre-hash, not just the unanswered ones', async () => {
    const { paths, inLock } = await publish(mode);
    for (const path of paths) expect(inLock.some(call => call.includes(path))).toBe(true);
  });

  test('a check-attr answer over 1 MiB (hundreds of long paths, several attributes each) is read whole: the pre-hashed blobs commit', async () => {
    const root = repo(), trace = join(scratch('gbrain-trace-'), 'trace');
    writeFileSync(join(root, '.gitattributes'), '*.md text diff=markdown merge=union linguist-generated linguist-vendored review-a review-b review-c\n');
    git(root, 'add', '.gitattributes'); git(root, 'commit', '-qm', 'attributes');
    const dir = 'notes/' + 'd'.repeat(200) + '/' + 'e'.repeat(200);
    const door: DoorFile[] = [];
    for (let start = 0; start < 400; start += 50) {
      door.push(...await Promise.all(Array.from({ length: 50 }, async (_, k) => {
        const path = dir + '/file-' + (start + k) + '.md', body = 'body ' + (start + k) + '\n';
        const prehashed = await prehashDoorFile(root, join(root, path), body);
        put(root, path, body);
        return { path: join(root, path), planned: sha256(body), prehashed };
      })));
    }
    expect(door.every(file => file.prehashed)).toBe(true);
    expect(door.reduce((sum, file) => sum + file.prehashed!.attributes.length, 0)).toBeGreaterThan(1024 * 1024);
    await withEnv({ GIT_TRACE: trace }, () => commitThroughDoor(root, door));
    for (const file of door.slice(0, 5)) expect(git(root, 'rev-parse', 'HEAD:' + file.path.slice(root.length + 1))).toBe(file.prehashed!.oid);
    expect(hashCalls(trace).filter(call => !call.includes('-t tree'))).toEqual([]);
  }, 120_000);
});

const strict = (engine: BrainEngine) => engine.executeRaw("UPDATE sources SET config = config || '{\"canonical\":\"git\"}'::jsonb WHERE id='default'");
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

for (const backend of testBackends()) describe('[' + backend + '] a strict put pre-hashes before the writer lock', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('the committed blob is the pre-hashed one and the door hashes no file', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const trace = join(scratch('gbrain-trace-'), 'trace');
    const content = '---\ntype: note\ntitle: Prehash\n---\n\nA page whose blob is stored before the writer lock.\n';
    const result = await withEnv({ GIT_TRACE: trace }, () => operations.find(op => op.name === 'put_page')!.handler(ctx,
      { slug: 'notes/prehash', content, request_id: randomUUID(), wait_ms: 30_000 })) as Record<string, unknown>;
    expect(result).toMatchObject({ state: 'committed' });
    const calls = hashCalls(trace);
    expect(calls.filter(call => call.includes('-w') && call.includes('--path=notes/prehash.md')).length).toBe(1);
    expect(calls.filter(call => /-w -- notes\/prehash\.md/.test(call))).toEqual([]);
    expect(git(root, 'show', 'HEAD:notes/prehash.md')).toContain('stored before the writer lock');
  }, { databaseUrl, setup }), 120_000);

  test('a strict import of several files runs one check-attr per door turn', () => managedBrain(async ({ engine, root }) => {
    await strict(engine);
    const trace = join(scratch('gbrain-trace-'), 'trace');
    const slugs = ['notes/batch-one', 'notes/batch-two', 'notes/batch-three'];
    mkdirSync(join(root, 'notes'), { recursive: true });
    for (const slug of slugs) writeFileSync(join(root, slug + '.md'), '---\ntitle: ' + slug + '\nsummary: reordered\ntype: note\n---\n\n' + slug + ' body.\n');
    const result = await withEnv({ GIT_TRACE: trace }, () => runImport(engine, [root, '--no-embed'], { sourceId: 'default' }));
    expect(result).toMatchObject({ imported: slugs.length, errors: 0 });
    expect(hashCalls(trace).filter(call => call.includes('--path=notes/batch-')).length).toBe(slugs.length);
    expect(hashCalls(trace).filter(call => /-w -- notes\/batch-/.test(call))).toEqual([]);
    const turns = checkAttrPerTurn(trace);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.filter(count => count > 1)).toEqual([]);
    expect(turns.reduce((sum, count) => sum + count, 0)).toBe(turns.length);
    for (const slug of slugs) expect(git(root, 'show', 'HEAD:' + slug + '.md')).toContain(slug + ' body.');
  }, { databaseUrl, setup }), 120_000);
});
