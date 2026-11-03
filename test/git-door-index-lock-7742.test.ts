/**
 * The door's index refresh after its commit is atomic against every Git writer that takes the index lock
 * (src/core/persistence/git-door.ts syncIndex, gbrain#7742). Protects, on both engines:
 *   - a stage attempted at the moment the door writes the index (after its last read of the entries) is never silently
 *     overwritten: Git refuses it on `index.lock`, the door's publication commits, and a retry of the stage then holds
 *     (red before: the stage was accepted, the door's update-index wrote its own blob over it and reported committed);
 *   - a stage that lands after the door's pre-commit check and before it takes the lock is left staged, and the refusal
 *     says the commit landed and names the path;
 *   - another writer holding `index.lock` while the door refreshes the index makes the refresh refuse with the landed
 *     failure; the holder's lock is left to its holder and the door leaves no lock or index copy behind;
 *   - plumbing: a failed update of the index copy releases the lock and removes the copy; in a linked worktree the lock
 *     and the refresh are on that worktree's own index (rev-parse --git-path index), never the main checkout's; an
 *     unrelated path staged between the door's pre-commit read and its lock survives the locked write; a lock the door
 *     cannot create for a reason other than an existing lock still reports the landed commit and names that cause.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { publishMutation, type PublicationHooks } from '../src/core/persistence/coordinator.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { INDEX_LOCK_GRACE_FOR_TESTS } from '../src/core/persistence/effect-git.ts';
import { commitThroughDoor, doorSeams } from '../src/core/persistence/git-door.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { proveIndexLockAbandoned } from '../src/core/persistence/index-lock-reclaim.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const refusal = (work: Promise<unknown>) => work.then(() => null, (error: { code?: string; message?: string }) => error);
const realGit = () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const SLUG = 'notes/probe';
const FILE = `${SLUG}.md`;
const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nA small single-file page body.\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const putPage = operations.find(op => op.name === 'put_page')!;
const dirs: string[] = [];
afterEach(() => { delete doorSeams.beforeUpdateRef; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/**
 * A git on PATH that hands every call to the real git. Once armed, the first call whose arguments contain ` <trigger> `
 * first runs `action` (a shell snippet with $REAL, $ROOT and $DIR set; GIT_INDEX_FILE is unset, so it acts on the
 * checkout's own index as a separate git process would).
 */
function gitShim(root: string, trigger: string, action: string): { dir: string; path: string; arm(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-shim-')));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'git'), [
    '#!/bin/sh',
    `REAL='${realGit()}'; ROOT='${root}'; DIR='${dir}'`,
    `case " $* " in *" ${trigger} "*)`,
    '  if [ -f "$DIR/arm" ] && [ ! -f "$DIR/fired" ]; then',
    '    : > "$DIR/fired"',
    `    ( unset GIT_INDEX_FILE; ${action} )`,
    '  fi;;',
    'esac',
    `PATH='${process.env.PATH}' exec "$REAL" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { dir, path: `${join(dir, 'bin')}:${process.env.PATH}`, arm: () => writeFileSync(join(dir, 'arm'), '') };
}

/** The shim action that stages $DIR/user.md as the page, recording the blob, the exit code and git's output. */
const STAGE_USER = `oid=$("$REAL" -C "$ROOT" hash-object -w -- "$DIR/user.md"); printf %s "$oid" > "$DIR/user.oid"; "$REAL" -C "$ROOT" update-index --add --cacheinfo "100644,$oid,${FILE}" > "$DIR/stage.out" 2>&1; echo $? > "$DIR/stage.rc"`;

/** A strict source holding one committed page titled First. */
async function committedPage(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
  expect(await putPage.handler(ctx, { slug: SLUG, content: page('First'), request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
}

/** One put_page publication of `content` through the door, with the coordinator's boundary hooks. */
async function publish(engine: BrainEngine, ctx: OperationContext, content: string, hooks: PublicationHooks = {}) {
  await disposePersistenceConsumer(engine);
  const host = localHostId(), binding = (await getWorktreeBinding(engine, 'default', host))!, old = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, SLUG);
  const intent = { slug: SLUG, content, expected_revision: old.revision };
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
    slug: SLUG, pageId: old.page.id, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, host))!;
  return publishMutation(engine, row, await preparePageMutation(engine, row, ctx.config), host, hooks);
}

/** Arms the shim once the publication's file is in place, with a user edit of the page ready to stage. */
const armAfterPublication = (root: string, shim: { dir: string; arm(): void }): PublicationHooks => ({ boundary: async name => {
  if (name !== 'after_publication') return;
  writeFileSync(join(shim.dir, 'user.md'), readFileSync(join(root, FILE), 'utf8').replace(/title: .*/, 'title: USER STAGED EDIT'));
  shim.arm();
} });

/** Index locks and door index copies left in the checkout's git directory. */
const leftovers = (root: string) => readdirSync(join(root, '.git')).filter(name => name === 'index.lock' || name.startsWith('index.gbrain-'));

for (const backend of testBackends()) describe(`[${backend}] the door's index refresh holds the index lock`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a stage attempted while the door writes the index is refused on index.lock, never overwritten; a retry then holds', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const shim = gitShim(root, 'update-index --add', STAGE_USER);
    const result = await withEnv({ PATH: shim.path }, () => publish(engine, ctx, page('Second'), armAfterPublication(root, shim)));
    expect(existsSync(join(shim.dir, 'fired'))).toBe(true);
    const userOid = readFileSync(join(shim.dir, 'user.oid'), 'utf8');
    const accepted = readFileSync(join(shim.dir, 'stage.rc'), 'utf8').trim() === '0';
    expect({ accepted, kept: git(root, 'rev-parse', `:${FILE}`) === userOid, refusedOnLock: /index\.lock/.test(readFileSync(join(shim.dir, 'stage.out'), 'utf8')) })
      .toEqual({ accepted: false, kept: false, refusedOnLock: true });
    expect(result).toMatchObject({ state: 'committed' });
    expect(git(root, 'rev-parse', `:${FILE}`)).toBe(git(root, 'rev-parse', `HEAD:${FILE}`));
    expect(leftovers(root)).toEqual([]);
    git(root, 'update-index', '--add', '--cacheinfo', `100644,${userOid},${FILE}`);
    expect(git(root, 'rev-parse', `:${FILE}`)).toBe(userOid);
  }, { databaseUrl, setup }), 120_000);

  test('a stage that lands after the pre-commit check and before the lock is left staged; the refusal says the commit landed and names the path', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const shim = gitShim(root, 'update-ref', STAGE_USER);
    const result = await withEnv({ PATH: shim.path }, () => publish(engine, ctx, page('Second'), armAfterPublication(root, shim)));
    expect(readFileSync(join(shim.dir, 'stage.rc'), 'utf8').trim()).toBe('0');
    const userOid = readFileSync(join(shim.dir, 'user.oid'), 'utf8');
    expect(git(root, 'rev-parse', `:${FILE}`)).toBe(userOid);
    expect(/^title: (.*)$/m.exec(git(root, 'show', `HEAD:${FILE}`))?.[1]).toBe('Second');
    expect(result).toMatchObject({ state: 'failed', error_code: 'git_unavailable', error_message: expect.stringMatching(new RegExp(`landed, but the index of .* was left as it was for ${FILE}`)),
      outcome: { persistence: { git_state: 'committed', git_commit: git(root, 'rev-parse', 'HEAD') } } });
    expect(leftovers(root)).toEqual([]);
  }, { databaseUrl, setup }), 120_000);

  test('another writer holding index.lock during the refresh makes it refuse with the landed failure; its lock is left to it and the door leaves nothing behind', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const shim = gitShim(root, 'update-ref', `printf 'held by another writer' > "$ROOT/.git/index.lock"`);
    const result = await withEnv({ PATH: shim.path }, () => publish(engine, ctx, page('Second'), armAfterPublication(root, shim)));
    expect(result).toMatchObject({ state: 'failed', error_code: 'git_unavailable', error_message: expect.stringMatching(/landed, but the index of .* was not updated for notes\/probe\.md/),
      outcome: { persistence: { git_state: 'committed', git_commit: git(root, 'rev-parse', 'HEAD') } } });
    expect(/^title: (.*)$/m.exec(git(root, 'show', `HEAD:${FILE}`))?.[1]).toBe('Second');
    expect(readFileSync(join(root, '.git', 'index.lock'), 'utf8')).toBe('held by another writer');
    expect(leftovers(root)).toEqual(['index.lock']);
    rmSync(join(root, '.git', 'index.lock'));
    expect(leftovers(root)).toEqual([]);
  }, { databaseUrl, setup }), 120_000);
});

describe('door plumbing: the index lock', () => {
  test('a failed update of the index copy releases the lock and removes the copy; the refusal says the commit landed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-lock-')));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/a.md'), 'a\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-shim-')));
    dirs.push(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" update-index "*) [ -n "$GIT_INDEX_FILE" ] && { echo 'fatal: refused by the test' >&2; exit 1; };; esac\nPATH='${process.env.PATH}' exec '${realGit()}' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(root, 'notes/a.md'), 'door\n');
    utimesSync(join(root, 'notes/a.md'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const error = await withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => refusal(commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }])));
    expect(error).toMatchObject({ code: 'git_unavailable', message: expect.stringContaining('landed, but the index') });
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('door');
    expect(leftovers(root)).toEqual([]);
  });

  test('in a linked worktree the door locks and refreshes that worktree\'s own index, never the main checkout\'s', async () => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-lock-')));
    dirs.push(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.name', 'Example Writer'); git(main, 'config', 'user.email', 'writer@example.invalid');
    mkdirSync(join(main, 'notes'));
    writeFileSync(join(main, 'notes/a.md'), 'a\n');
    git(main, 'add', '-A'); git(main, 'commit', '-qm', 'seed');
    const root = join(main, '..', `${main.split('/').pop()}-linked`);
    dirs.push(root);
    git(main, 'worktree', 'add', '-q', '-b', 'side', root);
    const lock = `${git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')}.lock`;
    expect(lock).not.toBe(join(main, '.git', 'index.lock'));
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-shim-')));
    dirs.push(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" update-index "*) [ -n "$GIT_INDEX_FILE" ] && { [ -f '${lock}' ] && : > '${bin}/locked'; [ -f '${join(main, '.git', 'index.lock')}' ] && : > '${bin}/main-locked'; };; esac\nPATH='${process.env.PATH}' exec '${realGit()}' "$@"\n`, { mode: 0o755 });
    const mainIndex = readFileSync(join(main, '.git', 'index'));
    writeFileSync(join(root, 'notes/a.md'), 'door\n');
    await withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }]));
    expect({ locked: existsSync(join(bin, 'locked')), mainLocked: existsSync(join(bin, 'main-locked')) }).toEqual({ locked: true, mainLocked: false });
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('door');
    expect(git(root, 'rev-parse', ':notes/a.md')).toBe(git(root, 'rev-parse', 'HEAD:notes/a.md'));
    expect(readFileSync(join(main, '.git', 'index')).equals(mainIndex)).toBe(true);
    expect(git(main, 'show', 'main:notes/a.md')).toBe('a');
    const gitDir = join(lock, '..');
    expect(readdirSync(gitDir).filter(name => name === 'index.lock' || name.startsWith('index.gbrain-'))).toEqual([]);
    expect(leftovers(main)).toEqual([]);
  });

  /** A plain repository whose seed commit holds notes/a.md and other/b.md. */
  const seeded = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-lock-')));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
    mkdirSync(join(root, 'notes')); mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'notes/a.md'), 'a\n'); writeFileSync(join(root, 'other/b.md'), 'b\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    return root;
  };

  // Value: protects=an unrelated path staged after the door's pre-commit index read stays staged once the door renames its locked index
  //   copy into place, and the target is refreshed; fails_when=the copy is taken before the lock (a stale snapshot) or holds only the
  //   targets; why_new=gbra133 stages its unrelated path before the write (index unmoved) and the #7705 mid-write stage is a target;
  //   seam=none; no_claim=a writer that stages without index.lock (doorSeams.beforeUpdateRef stands in for a concurrent git add)
  test('an unrelated path staged between the pre-commit read and the lock stays staged; the target is refreshed', async () => {
    const root = seeded();
    let staged = '';
    doorSeams.beforeUpdateRef = () => {
      writeFileSync(join(root, 'other/b.md'), 'staged meanwhile\n'); git(root, 'add', 'other/b.md');
      staged = git(root, 'rev-parse', ':other/b.md');
    };
    writeFileSync(join(root, 'notes/a.md'), 'door\n');
    const commit = await commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }]);
    expect(commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'show', '--name-only', '--format=', commit!)).toBe('notes/a.md');
    expect(git(root, 'rev-parse', ':notes/a.md')).toBe(git(root, 'rev-parse', 'HEAD:notes/a.md'));
    expect(git(root, 'rev-parse', ':other/b.md')).toBe(staged);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('other/b.md');
    expect(leftovers(root)).toEqual([]);
  });

  // Value: protects=a lock create failing other than EEXIST (an unwritable git dir) still reports the landed commit, names that cause and
  //   leaves the index as it was; fails_when=any lock error is reported as another git holding the lock, or escapes as not published;
  //   why_new=the existing lock test covers only EEXIST; seam=none; no_claim=root runs (chmod does not bind root, so the test skips there); a git shim makes the dir read-only after update-ref
  test.skipIf(process.getuid?.() === 0)('a lock the door cannot create for another reason reports the landed commit and names the cause; the index is left as it was', async () => {
    const root = seeded(), gitDir = join(root, '.git');
    const before = git(root, 'rev-parse', ':notes/a.md');
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-shim-')));
    dirs.push(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" update-ref "*) PATH='${process.env.PATH}' '${realGit()}' "$@"; rc=$?; chmod 555 '${gitDir}'; exit $rc;; esac\nPATH='${process.env.PATH}' exec '${realGit()}' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(root, 'notes/a.md'), 'door\n');
    let error: { code?: string; message?: string; suggestion?: string } | null;
    try {
      error = await withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => refusal(commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }])));
    } finally { chmodSync(gitDir, 0o755); }
    expect(error).toMatchObject({ code: 'git_unavailable', message: expect.stringContaining('landed, but the index'), suggestion: expect.stringMatching(/permission denied/i) });
    expect(/another git process holds the index lock/.test(error!.suggestion!)).toBe(false);
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('door');
    expect(git(root, 'rev-parse', ':notes/a.md')).toBe(before);
    expect(leftovers(root)).toEqual([]);
  });
  // Value: protects=a refresh whose index update changes nothing (only removals of paths the index lacks) leaves no index.lock behind and
  //   no hard-linked second name for the index; fails_when=the door renames an unwritten hard-linked copy onto the lock and the lock onto the
  //   index, a no-op that keeps both names; why_new=every other refresh case changes an entry, so Git writes a new file; seam=none;
  //   no_claim=indexes with a TREE extension, where Git always writes (doorSeams.beforeUpdateRef stands in for a concurrent git update-index)
  test('a refresh whose update changes nothing leaves no index.lock behind', async () => {
    const root = seeded();
    rmSync(join(root, '.git', 'index'));
    git(root, 'update-index', '--add', 'notes/a.md', 'other/b.md');
    doorSeams.beforeUpdateRef = () => {
      const oid = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'staged meanwhile\n', encoding: 'utf8' }).trim();
      git(root, 'update-index', '--cacheinfo', `100644,${oid},notes/a.md`);
    };
    writeFileSync(join(root, 'notes/a.md'), 'door\n');
    const error = await refusal(commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }, { path: join(root, 'notes/ghost.md'), planned: null }]));
    expect(error).toMatchObject({ code: 'git_unavailable', message: expect.stringContaining('was left as it was for notes/a.md') });
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('door');
    expect(leftovers(root)).toEqual([]);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('notes/a.md');
  });
  // Value: protects=the door, holding the writer lock, reclaims an index.lock no live process holds (#6932) and finishes its refresh,
  //   as it did when update-index ran through effect-git; fails_when=the door's own exclusive create answers any existing lock with the
  //   landed failure; why_new=the held-lock test uses a fresh lock no proof accepts; seam=none; no_claim=hosts where the proof cannot see
  //   every process, where the lock must stay and the landed failure stands (the oracle is the same proof the door runs)
  test('an abandoned index.lock is reclaimed under the writer lock and the refresh completes', async () => {
    const root = seeded(), lock = join(root, '.git', 'index.lock');
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-home-')));
    dirs.push(home);
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    writeFileSync(join(root, 'notes/a.md'), 'door\n');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const writer = (await tryAcquireNativeLock(join(home, 'writer.lock')))!;
      try {
        const provable = proveIndexLockAbandoned(lock, root, INDEX_LOCK_GRACE_FOR_TESTS).abandoned;
        const error = await refusal(commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }], writer));
        expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('door');
        if (!provable) {
          expect(error).toMatchObject({ code: 'git_unavailable', message: expect.stringContaining('landed, but the index') });
          expect(existsSync(lock)).toBe(true);
          return;
        }
        expect(error).toBeNull();
        expect(git(root, 'rev-parse', ':notes/a.md')).toBe(git(root, 'rev-parse', 'HEAD:notes/a.md'));
        expect(leftovers(root)).toEqual([]);
      } finally { await writer.release(); }
    });
  });
});
