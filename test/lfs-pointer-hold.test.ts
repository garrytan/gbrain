/**
 * Wave C 1D (§4.6, C3): a page file committed as a Git LFS pointer is held `lfs_pointer_unsmudged` by the managed sync
 * freeze, in committed and in working mode, and never replaces the stored page. Before this, the freeze imported the
 * pointer's ~130 bytes as the page body (red at the base: the page's text became the pointer). The fix plan's managed
 * branch (the real bytes and the plan's own .gitattributes override, run by a shell under a wildcard LFS rule,
 * committed through gbrain git commit-push, which on a managed worktree only commits) clears the hold on the next sync. The plain-checkout and hosted branches are pinned by shape.
 *
 * Both engines: PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { gitHoldFix, readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { lfsPointerHoldFix, lfsPointerRefusal, lfsWriterFor, readLfsPointerHolds } from '../src/core/persistence/lfs-pointer.ts';
import { runGit } from '../src/commands/git.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { lfsPagePointersEntry } from '../src/commands/doctor/checks/lfs-page-pointers.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const pointerOf = (real: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(real).digest('hex')}\nsize ${Buffer.byteLength(real)}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const BIG_V1 = note('Big', 'The first version of the big page.');
const BIG_V2 = note('Big', 'The second version of the big page, stored in LFS by mistake.');
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(root, 'notes/seed.md'), note('Seed', 'Seed body.')); writeFileSync(join(root, 'notes/big.md'), BIG_V1);
  commit(root, 'seed');
};
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ t: string }>(
  "SELECT compiled_truth AS t FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0]?.t ?? null;
const doctor = async (engine: BrainEngine): Promise<Check> => (await lfsPagePointersEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0]!;
const holds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []);

describe('lfsPointerRefusal', () => {
  test('a pointer is refused; a page that only quotes pointer lines, an over-size file and an image are not', () => {
    expect(lfsPointerRefusal('notes/a.md', pointerOf('x'))?.code).toBe('lfs_pointer_unsmudged');
    expect(lfsPointerRefusal('notes/a.md', `# Notes\n\n${pointerOf('x')}`)).toBeNull();
    expect(lfsPointerRefusal('notes/a.md', pointerOf('x') + 'x'.repeat(1100))).toBeNull();
    expect(lfsPointerRefusal('images/a.png', pointerOf('x'))).toBeNull();
    expect(lfsPointerRefusal('notes/a.md', pointerOf('x').replace(/\n/g, '\r\n'))?.code).toBe('lfs_pointer_unsmudged');
  });
  test('the fix names the branch for the writer: a checkout pushes, a managed worktree only commits, a hosted one takes the bytes from the user clone', () => {
    const record = { source_id: 'source-a', path: 'notes/a.md' };
    const checkout = lfsPointerHoldFix({ ...record, meta: { lfs_writer: 'checkout' } });
    expect(checkout).toMatchObject({ actor: 'user', argv: ['gbrain', 'sources', 'status', 'source-a', '--json'], then: { argv: ['gbrain', 'sync', '--source', 'source-a', '--no-pull'] } });
    expect(checkout.user_message).toContain("git lfs pull --include 'notes/a.md'");
    expect(checkout.user_message).toContain("printf '%s -filter -diff -merge\\n' '/notes/a.md' >> .gitattributes, then git add --renormalize -- 'notes/a.md' .gitattributes");
    expect(checkout.user_message).toContain("gbrain git commit-push -m 'Store notes/a.md without LFS' -- 'notes/a.md' .gitattributes");
    expect(checkout.user_message).not.toContain('lfs untrack');
    const managed = lfsPointerHoldFix({ ...record, meta: { lfs_writer: 'managed' } });
    expect(managed.user_message).toContain("gbrain git commit-push -m 'Store notes/a.md without LFS' -- 'notes/a.md' .gitattributes: in a managed canonical worktree it commits only those paths");
    const hosted = lfsPointerHoldFix({ ...record, meta: { lfs_writer: 'hosted' } });
    expect(hosted.user_message).toContain('in your own clone of the hosted repository');
    expect(hosted.user_message).toContain('in the source\'s hosted worktree');
    expect(hosted.user_message).toContain("gbrain git commit-push -m 'Store notes/a.md without LFS' -- 'notes/a.md' .gitattributes in that worktree");
    for (const fix of [checkout, managed, hosted]) expect(fix.verify).toEqual({ argv: ['gbrain', 'sources', 'status', 'source-a', '--json'] });
    expect(lfsWriterFor('/nonexistent-root', { hosted_repo: { repository: '/r' } })).toBe('hosted');
    expect(lfsWriterFor('/nonexistent-root', null)).toBe('checkout');
  });
  test('a path that holds shell syntax is single-quoted, so running the plan never expands it', () => {
    const fix = lfsPointerHoldFix({ source_id: 'source-a', path: "notes/it's $(touch pwned) a.md", meta: {} });
    expect(fix.user_message).toContain("git lfs pull --include 'notes/it'\\''s $(touch pwned) a.md'");
    expect(fix.user_message).toContain("'/notes/it'\\''s[[:space:]]$(touch[[:space:]]pwned)[[:space:]]a.md'");
    expect(fix.user_message).toContain("-m 'Store notes/it'\\''s $(touch pwned) a.md without LFS'");
  });
});

for (const backend of testBackends()) describe(`[${backend}] Wave C 1D: an LFS pointer never replaces a page`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  beforeAll(async () => { if (databaseUrl) template = await persistencePostgresTemplate(databaseUrl); }, 120_000);
  afterAll(async () => { await template?.dispose(); });
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(template ? { open: template.clone } : {}), setup });

  test('committed mode: a pointer over a stored page and a new pointer file are held; the page keeps its text', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const before = await body(engine, 'notes/big');
    expect(before).toContain('The first version of the big page.');
    writeFileSync(join(root, '.gitattributes'), 'notes/big.md filter=lfs diff=lfs merge=lfs -text\nnotes/new.md filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(root, 'notes/big.md'), pointerOf(BIG_V2)); writeFileSync(join(root, 'notes/new.md'), pointerOf('new real bytes'));
    writeFileSync(join(root, 'notes/ok.md'), note('Ok', 'Ok body.'));
    commit(root, 'lfs');
    const result = await performManagedSync(engine, OPTS);
    expect(result.held?.map(hold => [hold.path, hold.code]).sort()).toEqual([['notes/big.md', 'lfs_pointer_unsmudged'], ['notes/new.md', 'lfs_pointer_unsmudged']]);
    expect(await body(engine, 'notes/big')).toBe(before);
    expect(await body(engine, 'notes/new')).toBeNull();
    expect(await body(engine, 'notes/ok')).toContain('Ok body.');
    const held = (await holds(engine)).find(hold => hold.path === 'notes/big.md')!;
    expect(held.meta.lfs_writer).toBe('managed');
    expect(held.message).toContain('notes/big.md is a Git LFS pointer');
    expect(await readLfsPointerHolds(engine, 5)).toEqual([{ source_id: 'default', held: 2, paths: ['notes/big.md', 'notes/new.md'] }]);
    const check = await doctor(engine);
    expect(check).toMatchObject({ name: 'lfs_page_pointers', status: 'warn', details: { held: 2 }, fix: { argv: ['gbrain', 'sources', 'status', 'default', '--json'] } });
    expect(check.message).toContain('default: 2 (notes/big.md, notes/new.md)');
  }), 240_000);

  test('working mode: an uncommitted pointer file and a CRLF pointer over a stored page are held; neither changes a page', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const before = await body(engine, 'notes/big');
    writeFileSync(join(root, 'notes/wip.md'), pointerOf('working bytes'));
    writeFileSync(join(root, 'notes/big.md'), pointerOf(BIG_V2).replace(/\n/g, '\r\n'));
    const result = await performManagedSync(engine, { ...OPTS, workingTree: true });
    expect(result.held?.map(hold => [hold.path, hold.code]).sort()).toEqual([['notes/big.md', 'lfs_pointer_unsmudged'], ['notes/wip.md', 'lfs_pointer_unsmudged']]);
    expect(await body(engine, 'notes/big')).toBe(before);
    expect((await holds(engine)).find(hold => hold.path === 'notes/wip.md')?.meta.working).toBe(true);
    expect(await body(engine, 'notes/wip')).toBeNull();
  }), 240_000);

  test('with sync.holds=fail the run stops with the typed lfs_pointer_unsmudged refusal', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    writeFileSync(join(root, 'notes/big.md'), pointerOf(BIG_V2)); commit(root, 'lfs');
    await expect(performManagedSync(engine, OPTS)).rejects.toMatchObject({ code: 'lfs_pointer_unsmudged' });
    expect(await body(engine, 'notes/big')).toContain('The first version of the big page.');
  }), 240_000);

  test('the managed branch of the fix: the real bytes and .gitattributes through commit-push, then the sync clears the hold', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, '.gitattributes'), 'notes/big*.md filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(root, 'notes/big.md'), pointerOf(BIG_V2)); commit(root, 'lfs');
    await performManagedSync(engine, OPTS);
    const [held] = await holds(engine);
    const fix = gitHoldFix(held!);
    expect(fix.user_message).toContain("gbrain git commit-push -m 'Store notes/big.md without LFS' -- 'notes/big.md' .gitattributes: in a managed canonical worktree");
    // (2) what git lfs pull writes: the real bytes in the working tree; (3) the plan's own override line, run by a shell,
    // which takes the file out of the wildcard rule.
    writeFileSync(join(root, 'notes/big.md'), BIG_V2);
    const step3 = fix.user_message!.slice(fix.user_message!.indexOf('(3) ') + 4, fix.user_message!.indexOf(', then git add --renormalize'));
    execFileSync('sh', ['-c', step3], { cwd: root });
    expect(git(root, 'check-attr', 'filter', '--', 'notes/big.md')).toBe('notes/big.md: filter: unset');
    expect(git(root, 'check-attr', 'filter', '--', 'notes/big2.md')).toBe('notes/big2.md: filter: lfs');
    // (4) the commit through gbrain git commit-push, which on a managed worktree commits only the named paths.
    const cwd = process.cwd();
    try { process.chdir(root); expect(await runGit(['commit-push', '-m', 'Store notes/big.md without LFS', '--json', '--', 'notes/big.md', '.gitattributes'])).toBe(0); } finally { process.chdir(cwd); }
    expect(git(root, 'show', 'HEAD:.gitattributes')).toBe('notes/big*.md filter=lfs diff=lfs merge=lfs -text\n/notes/big.md -filter -diff -merge');
    expect(git(root, 'status', '--porcelain')).toBe('');
    // Verify: the same sync, then no pointer is held and the page has the real text.
    await performManagedSync(engine, OPTS);
    expect((await holds(engine)).filter(hold => hold.code === 'lfs_pointer_unsmudged')).toEqual([]);
    expect(await body(engine, 'notes/big')).toContain('The second version of the big page');
    expect(await readLfsPointerHolds(engine, 5)).toEqual([]);
    expect((await doctor(engine)).status).toBe('ok');
  }), 240_000);
});
