/**
 * GST-3328 follow-up: the history read behind a file-drift re-screen (`pathBlobHistories`) stays bounded on a deep
 * repository. Real Git repositories; the stream seam only delays, cuts or replays a real read.
 *   - a group whose read is cut short keeps the blobs it already read;
 *   - no group starts once the deadline has passed;
 *   - the caller hears a beat while a long group read streams, not only when it ends;
 *   - a path listed twice still ends its group's walk early, and a blob counts once however often it recurs;
 *   - a sync whose history read is cut short marks the hold `history_unread`, and the next plain sync screens it again;
 *     a read cut short again on that retry leaves an ordinary hold, so sync settles
 *     (real PGLite, and Postgres when DATABASE_URL is set, with a managed worktree).
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { hardenedGitStream } from '../src/core/hardened-git.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { __setSyncGitStreamForTests, pathBlobHistories } from '../src/core/persistence/sync-git-stream.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => __setSyncGitStreamForTests());

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository whose `notes/a.md` held each of `bodies` in turn (one commit each), plus `others` files committed first. */
function repo(bodies: string[], others = 0): { root: string; head: string; blobs: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-history-read-'));
  dirs.push(root);
  git(root, 'init', '-q');
  execFileSync('mkdir', ['-p', join(root, 'notes')]);
  for (let i = 0; i < others; i++) writeFileSync(join(root, 'notes', `other-${i}.md`), `Other note ${i}.\n`);
  if (others) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'others'); }
  const blobs: string[] = [];
  for (const body of bodies) {
    writeFileSync(join(root, 'notes/a.md'), body);
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'edit');
    blobs.push(git(root, 'rev-parse', 'HEAD:notes/a.md'));
  }
  return { root, head: git(root, 'rev-parse', 'HEAD'), blobs };
}

test('a history read that is cut short keeps the versions it already read', async () => {
  const { root, head, blobs } = repo(['One.\n', 'Two.\n', 'Three.\n']);
  __setSyncGitStreamForTests(async (gitRoot, args, opts) => {
    const result = await hardenedGitStream(gitRoot, args, opts);
    return args[0] === 'log' ? { ok: false, reason: 'timeout' } : result;
  });
  const partial = new Set<string>();
  const read = await pathBlobHistories(root, head, ['notes/a.md', 'notes/missing.md'], 5, undefined, { partial });
  expect(read.get('notes/a.md')).toEqual([...blobs].reverse());
  expect(read.has('notes/missing.md')).toBe(false);
  expect([...partial].sort()).toEqual(['notes/a.md', 'notes/missing.md']);
  const full = new Set<string>();
  expect((await pathBlobHistories(root, head, ['notes/a.md', 'notes/missing.md'], 3, undefined, { partial: full })).get('notes/a.md')).toHaveLength(3);
  expect([...full]).toEqual(['notes/missing.md']);
});

test('no history group starts once the deadline has passed, and a group read before it keeps its versions', async () => {
  const { root, head, blobs } = repo(['One.\n', 'Two.\n'], 100);
  const groups: number[] = [];
  __setSyncGitStreamForTests(async (gitRoot, args, opts) => {
    if (args[0] !== 'log') return hardenedGitStream(gitRoot, args, opts);
    groups.push(args.length);
    const result = await hardenedGitStream(gitRoot, args, { ...opts, timeoutMs: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 300));
    return result;
  });
  const paths = ['notes/a.md', ...Array.from({ length: 100 }, (_, i) => `notes/other-${i}.md`)];
  const unstarted = new Set<string>();
  const read = await pathBlobHistories(root, head, paths, 5, undefined, { deadline: Date.now() + 100, unstarted });
  expect(groups).toHaveLength(1);
  expect(read.get('notes/a.md')).toEqual([...blobs].reverse());
  expect(read.has('notes/other-99.md')).toBe(false);
  expect([...unstarted]).toEqual(['notes/other-99.md']);
  const none = new Set<string>();
  expect(await pathBlobHistories(root, head, [...paths, 'notes/new\nline.md'], 5, undefined, { deadline: Date.now() - 1, unstarted: none })).toEqual(new Map());
  expect(none.size).toBe(paths.length);
});

test('a long history read beats while it streams, not only when it ends', async () => {
  const { root, head } = repo(['One.\n', 'Two.\n', 'Three.\n']);
  const events: string[] = [];
  __setSyncGitStreamForTests(async (gitRoot, args, opts) => {
    if (args[0] !== 'log') return hardenedGitStream(gitRoot, args, opts);
    const chunks: Buffer[] = [];
    const result = await hardenedGitStream(gitRoot, args, { ...opts, onChunk: chunk => { chunks.push(Buffer.from(chunk)); } });
    const all = Buffer.concat(chunks);
    for (const part of [all.subarray(0, 1), all.subarray(1)]) {
      await new Promise(resolve => setTimeout(resolve, 1_100));
      await opts.onChunk?.(part);
    }
    events.push('read ended');
    return result;
  });
  await pathBlobHistories(root, head, ['notes/a.md'], 5, () => events.push('path'), { beat: () => events.push('beat') });
  expect(events.indexOf('beat')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('beat')).toBeLessThan(events.indexOf('read ended'));
});

test('a path listed twice still ends its group\'s walk early, and a recurring blob counts once', async () => {
  const { root, head, blobs } = repo(['One.\n', 'Two.\n', 'One.\n', 'Three.\n']);
  let stoppedEarly = false;
  __setSyncGitStreamForTests(async (gitRoot, args, opts) => hardenedGitStream(gitRoot, args, opts).catch((error: unknown) => {
    if (args[0] === 'log') stoppedEarly = true;
    throw error;
  }));
  expect((await pathBlobHistories(root, head, ['notes/a.md', 'notes/a.md'], 2)).get('notes/a.md')).toEqual([blobs[3], blobs[2]]);
  expect(stoppedEarly).toBe(true);
  stoppedEarly = false;
  expect((await pathBlobHistories(root, head, ['notes/a.md'], 5)).get('notes/a.md')).toEqual([blobs[3], blobs[2], blobs[1]]);
  expect(stoppedEarly).toBe(false);
});

const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'The committed body.'));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
  const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ path: string; unread: string | null }>(
    "SELECT completed_keys->0->>'path' AS path, completed_keys->0->'meta'->>'history_unread' AS unread FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'code'='file_drift' ORDER BY 1"));

  test(`[${backend}] a held note whose history read was cut short is screened again by the next sync, with no retry-held`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // An older gbrain imported the page: no import record and a revision no sync request wrote, still holding the first commit's body.
    await coordinated(engine, "DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
    await coordinated(engine, `UPDATE pages SET knowledge_revision = $1::uuid, revision_write_request_id = NULL, updated_at = now() - interval '1 hour'
      WHERE source_id='default' AND slug='notes/a'`, [randomUUID()]);
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A Git edit.')); git(root, 'commit', '-qam', 'edit');
    await coordinated(engine, "UPDATE sources SET last_commit='0123456789abcdef0123456789abcdef01234567' WHERE id='default'");
    __setSyncGitStreamForTests(async (gitRoot, args, opts) => args[0] === 'log' ? { ok: false, reason: 'timeout' } : hardenedGitStream(gitRoot, args, opts));
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([{ path: 'notes/a.md', unread: 'true' }]);

    __setSyncGitStreamForTests();
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([]);
    const [page] = await engine.executeRaw<{ t: string }>("SELECT compiled_truth AS t FROM pages WHERE source_id='default' AND slug='notes/a'");
    expect(page!.t).toContain('A Git edit.');
  }, { databaseUrl, setup }), 240_000);

  test(`[${backend}] a held note whose history read is cut short again on its retry keeps an ordinary hold, so sync settles`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await coordinated(engine, "DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
    await coordinated(engine, `UPDATE pages SET knowledge_revision = $1::uuid, revision_write_request_id = NULL, updated_at = now() - interval '1 hour'
      WHERE source_id='default' AND slug='notes/a'`, [randomUUID()]);
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A Git edit.')); git(root, 'commit', '-qam', 'edit');
    await coordinated(engine, "UPDATE sources SET last_commit='0123456789abcdef0123456789abcdef01234567' WHERE id='default'");
    __setSyncGitStreamForTests(async (gitRoot, args, opts) => args[0] === 'log' ? { ok: false, reason: 'timeout' } : hardenedGitStream(gitRoot, args, opts));
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([{ path: 'notes/a.md', unread: 'true' }]);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([{ path: 'notes/a.md', unread: null }]);
  }, { databaseUrl, setup }), 240_000);
}
