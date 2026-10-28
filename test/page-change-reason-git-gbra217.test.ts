/**
 * GBRA-217: a page write's reason reaches Git as a path-mapped trailer, `gbrain-reason: <path>: <text>`.
 *
 * 1. Protects: the door (strict) and the effect commit (non-strict) put one trailer per path, beside a repair's
 *    `gbrain-repair:` trailer in the same block, so `git interpret-trailers --parse` returns every one; a write without
 *    a reason commits the same message as before; a private page's reason is in no commit message, a group commit for
 *    other paths included; a non-strict write whose Git effect is superseded never lends its reason to the newer
 *    commit and its receipt says so (`reason_not_committed`); a message too large for the command line goes through
 *    a message file.
 * 2. Fails when: a trailer is lost, merged or misattributed, the message of a reasonless write changes, a private reason
 *    reaches Git, or a large group commit fails on the argument limit.
 * 3. Seams: none. Real repositories, the real door and effect commit, real engines (Postgres through
 *    test/e2e/page-change-reason-git-gbra217-postgres.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { commitGitTargets, commitMessage, commitMessageArgs, COMMIT_MESSAGE_ARG_BYTES } from '../src/core/persistence/effect-git.ts';
import type { GitCommitNote } from '../src/core/persistence/effect-model.ts';
import { commitThroughDoor } from '../src/core/persistence/git-door.ts';
import { hashFile } from '../src/core/persistence/large-file.ts';
import { withReasonNote } from '../src/core/persistence/change-reason.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { strictSource } from './helpers/strict-door-audit.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const env = gitChildEnv();
const raw = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
const git = (root: string, ...args: string[]) => raw(root, ...args).trim();
/** A sandbox's git wrapper may append a co-author trailer to every `git commit` (never to commit-tree): read without it. */
const unshimmed = (message: string) => message.replace(/^Co-authored-by: .*\n/gm, '').replace(/\n+$/, '\n');
const parsed = (root: string, ref = 'HEAD') => execFileSync('git', ['-C', root, 'interpret-trailers', '--parse'], { input: raw(root, 'log', '-1', '--format=%B', ref), encoding: 'utf8', env })
  .split('\n').filter(line => line && !line.startsWith('Co-authored-by:'));
const roots: string[] = [];
function repo(files: Record<string, string>): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-reason-git-')));
  roots.push(top);
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.name', 'Example Writer'); git(top, 'config', 'user.email', 'writer@example.invalid');
  for (const [path, body] of Object.entries(files)) put(top, path, body);
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'seed');
  return top;
}
function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('reason trailers in commit messages', () => {
  const repair: GitCommitNote = { subject: 'gbrain: repair notes/a.md', line: 'notes/a.md (invalid_fence)', trailers: ['gbrain-repair: invalid_fence deterministic high'] };
  const notes = new Map<string, GitCommitNote>([
    ['notes/a.md', withReasonNote('notes/a.md', 'Fence fixed: status: done', repair)],
    ['notes/b.md', withReasonNote('notes/b.md', 'Client asked for the 30-day window.')],
  ]);

  test('door and effect commits agree, alone and in a group; interpret-trailers returns every reason and repair trailer', async () => {
    const seed = { 'notes/a.md': 'a\n', 'notes/b.md': 'b\n', 'notes/c.md': 'c\n' };
    for (const paths of [['notes/a.md'], ['notes/b.md'], ['notes/a.md', 'notes/b.md', 'notes/c.md']]) {
      const porcelain = repo(seed), plumbing = repo(seed);
      for (const root of [porcelain, plumbing]) for (const path of paths) put(root, path, `${path}, second revision\n`);
      const noted = new Map(paths.flatMap(path => notes.has(path) ? [[path, notes.get(path)!] as const] : []));
      await commitGitTargets(porcelain, paths, undefined, noted);
      await commitThroughDoor(plumbing, paths.map(path => ({ path: join(plumbing, path), planned: hashFile(join(plumbing, path)), note: noted.get(path) })));
      expect(unshimmed(raw(plumbing, 'log', '-1', '--format=%B'))).toBe(unshimmed(raw(porcelain, 'log', '-1', '--format=%B')));
      const want = [
        ...(paths.includes('notes/a.md') ? ['gbrain-repair: invalid_fence deterministic high', 'gbrain-reason: notes/a.md: Fence fixed: status: done'] : []),
        ...(paths.includes('notes/b.md') ? ['gbrain-reason: notes/b.md: Client asked for the 30-day window.'] : []),
      ];
      for (const root of [porcelain, plumbing]) expect(parsed(root)).toEqual(want);
    }
  });

  test('a message over the argument bound goes through a message file and commits the same text', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `notes/p${String(i).padStart(2, '0')}.md`);
    const noted = new Map(paths.map(path => [path, withReasonNote(path, 'r'.repeat(480))] as const));
    const paragraphs = commitMessage(paths, noted);
    expect(Buffer.byteLength(paragraphs.join('\n\n'))).toBeGreaterThan(COMMIT_MESSAGE_ARG_BYTES);
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-reason-msg-')); roots.push(dir);
    expect(commitMessageArgs(paragraphs, dir)[0]).toBe('-F');
    expect(commitMessageArgs(['small'], dir)).toEqual(['-m', 'small']);
    const seed = Object.fromEntries(paths.map(path => [path, 'x\n']));
    const porcelain = repo(seed), plumbing = repo(seed);
    for (const root of [porcelain, plumbing]) for (const path of paths) put(root, path, 'y\n');
    await commitGitTargets(porcelain, paths, undefined, noted);
    await commitThroughDoor(plumbing, paths.map(path => ({ path: join(plumbing, path), planned: hashFile(join(plumbing, path)), note: noted.get(path) })));
    for (const root of [porcelain, plumbing]) expect(parsed(root)).toHaveLength(30);
    expect(unshimmed(raw(plumbing, 'log', '-1', '--format=%B'))).toBe(unshimmed(raw(porcelain, 'log', '-1', '--format=%B')));
  });
});

const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const page = (body: string, extra = '') => `---\ntype: note\ntitle: Policy\n${extra}---\n\n${body}\n`;
const SLUG = 'policies/policy-4a-example';
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(ctx, params) as Promise<Record<string, unknown>>;
const outcomeOf = (result: Record<string, unknown>) => (result.outcome ?? result) as Record<string, unknown>;
const revision = async (ctx: OperationContext, slug = SLUG) => String((await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`[${backend}] reasons reach Git`, () => {
    for (const strict of [false, true]) {
      test(`${strict ? 'strict' : 'non-strict'}: the commit carries the trailer, a reasonless write's message is unchanged`, () => managedBrain(async ({ engine, ctx, root }) => {
        if (strict) await strictSource(engine);
        await call(ctx, 'put_page', { slug: SLUG, content: page('Edition one.'), request_id: randomUUID() });
        await settleManagedGitEffects(engine);
        const plain = unshimmed(raw(root, 'log', '-1', '--format=%B'));
        await call(ctx, 'put_page', { slug: SLUG, content: page('Edition one, corrected.'), expected_revision: await revision(ctx), request_id: randomUUID() });
        await settleManagedGitEffects(engine);
        expect(unshimmed(raw(root, 'log', '-1', '--format=%B'))).toBe(plain);
        const result = outcomeOf(await call(ctx, 'put_page', { slug: SLUG, content: page('Edition two.'), expected_revision: await revision(ctx), request_id: randomUUID(), reason: 'Client asked for the 30-day window.' }));
        expect((result.reason_recorded as Record<string, unknown>).git).toBe(strict ? 'committed' : 'queued');
        await settleManagedGitEffects(engine);
        expect(parsed(root)).toEqual([`gbrain-reason: ${SLUG}.md: Client asked for the 30-day window.`]);
        expect(unshimmed(raw(root, 'log', '-1', '--format=%B')).split('\n')[0]).toBe(plain.split('\n')[0]);
      }, { databaseUrl, setup }), 120_000);

      test(`${strict ? 'strict' : 'non-strict'}: a private page's reason is in no commit message`, () => managedBrain(async ({ engine, ctx, root }) => {
        if (strict) await strictSource(engine);
        await call(ctx, 'put_pages', { request_id: randomUUID(), wait_ms: 30_000, pages: [
          { slug: 'notes/world-example', content: page('w1') }, { slug: 'notes/private-example', content: page('p1', 'visibility: private\n') }] });
        await settleManagedGitEffects(engine);
        await call(ctx, 'put_pages', { request_id: randomUUID(), wait_ms: 30_000, pages: [
          { slug: 'notes/world-example', content: page('w2'), expected_revision: await revision(ctx, 'notes/world-example'), reason: 'world reason' },
          { slug: 'notes/private-example', content: page('p2', 'visibility: private\n'), expected_revision: await revision(ctx, 'notes/private-example'), reason: 'private-only reason' }] });
        await settleManagedGitEffects(engine);
        await call(ctx, 'put_page', { slug: 'notes/world-example', content: page('w3', 'visibility: private\n'), expected_revision: await revision(ctx, 'notes/world-example'), request_id: randomUUID(), reason: 'turned private reason' });
        await settleManagedGitEffects(engine);
        const history = raw(root, 'log', '--all', '--format=%B');
        expect(history).toContain('gbrain-reason: notes/world-example.md: world reason');
        expect(history).not.toContain('private-only reason');
        expect(history).not.toContain('turned private reason');
        const versions = await call(ctx, 'get_versions', { slug: 'notes/private-example' }) as unknown as Array<Record<string, unknown>>;
        expect(versions[0]!.replaced_because).toBe('private-only reason');
      }, { databaseUrl, setup }), 120_000);

      // A put_pages batch publishes as one group (one strict door commit) on Postgres only; on PGLite its members publish one
      // at a time (persistence/consumer.ts executeOrGroup), so a strict member commits before the next one applies.
      test.skipIf(strict && backend === 'pglite')(`${strict ? 'strict' : 'non-strict'}: a group that makes an earlier member private commits that member without its reason`, () => managedBrain(async ({ engine, ctx, root }) => {
        if (strict) await strictSource(engine);
        const origin = 'notes/origin-example', derived = 'notes/derived-example';
        await call(ctx, 'put_pages', { request_id: randomUUID(), wait_ms: 30_000, pages: [
          { slug: origin, content: page('o1') }, { slug: derived, content: page('d1', `derived_from: ${origin}\n`) }] });
        await settleManagedGitEffects(engine);
        await call(ctx, 'put_pages', { request_id: randomUUID(), wait_ms: 30_000, pages: [
          { slug: derived, content: page('d2', `derived_from: ${origin}\n`), expected_revision: await revision(ctx, derived), reason: 'lineage-private reason' },
          { slug: origin, content: page('o2', 'visibility: private\n'), expected_revision: await revision(ctx, origin) }] });
        await settleManagedGitEffects(engine);
        expect(raw(root, 'show', `HEAD:${derived}.md`)).toContain('d2');
        expect(raw(root, 'log', '--all', '--format=%B')).not.toContain('lineage-private reason');
        const versions = await call(ctx, 'get_versions', { slug: derived }) as unknown as Array<Record<string, unknown>>;
        expect(versions[0]!.replaced_because).toBe('lineage-private reason');
      }, { databaseUrl, setup }), 120_000);
    }

    test('non-strict: a later write that makes a queued page private commits it without its reason', () => managedBrain(async ({ engine, ctx, root }) => {
      const origin = 'notes/origin-example', derived = 'notes/derived-example';
      await call(ctx, 'put_pages', { request_id: randomUUID(), wait_ms: 30_000, pages: [
        { slug: origin, content: page('o1') }, { slug: derived, content: page('d1', `derived_from: ${origin}\n`) }] });
      await settleManagedGitEffects(engine);
      await call(ctx, 'put_page', { slug: derived, content: page('d2', `derived_from: ${origin}\n`), expected_revision: await revision(ctx, derived), request_id: randomUUID(), reason: 'queued-then-private reason' });
      await call(ctx, 'put_page', { slug: origin, content: page('o2', 'visibility: private\n'), expected_revision: await revision(ctx, origin), request_id: randomUUID() });
      await settleManagedGitEffects(engine);
      expect(raw(root, 'show', `HEAD:${derived}.md`)).toContain('d2');
      expect(raw(root, 'log', '--all', '--format=%B')).not.toContain('queued-then-private reason');
    }, { databaseUrl, setup }), 120_000);

    test('non-strict: a page purge strips the page\'s reasons from every receipt and retained Git effect; the receipt checks both stores', () => managedBrain(async ({ engine, ctx }) => {
      const marker = 'purged-git-reason-marker';
      await call(ctx, 'put_page', { slug: SLUG, content: page('Edition one.'), request_id: randomUUID(), reason: `${marker} at creation` });
      await settleManagedGitEffects(engine);
      await call(ctx, 'put_page', { slug: SLUG, content: page('Edition two.'), expected_revision: await revision(ctx), request_id: randomUUID(), reason: `${marker} on the second edition` });
      await settleManagedGitEffects(engine);
      const carrying = async () => (await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE strpos(COALESCE(intent::text,'') || COALESCE(outcome::text,'') || COALESCE(error_detail::text,''), $1) > 0
        UNION ALL SELECT 1 FROM persistence_effects WHERE strpos(data::text || COALESCE(outcome::text,''), $1) > 0`, [marker])).length;
      expect(await engine.executeRaw(`SELECT 1 FROM persistence_effects WHERE kind = 'git' AND data->>'slug' = $1 AND strpos(data::text, $2) > 0`, [SLUG, marker])).not.toHaveLength(0);
      const done = await call(ctx, 'delete_page', { slug: SLUG, purge: true, expected_revision: await revision(ctx), request_id: randomUUID(), wait_ms: 30_000 });
      expect(await carrying()).toBe(0);
      const stores = (done.receipt as { stores: Array<{ store: string; status: string }> }).stores;
      expect(stores.filter(s => s.store === 'persistence_requests' || s.store === 'persistence_effects').map(s => s.status)).not.toContain('incomplete');

      // The receipt's checks find a reason left behind: a Git effect of the slug still carrying one is incomplete.
      const { declarePersistenceProtocol } = await import('../src/core/persistence/protocol.ts');
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_effects SET data = data || $1::text::jsonb WHERE id = (SELECT min(id) FROM persistence_effects WHERE kind = 'git')`,
          [JSON.stringify({ slug: SLUG, commit_line: `${SLUG}.md: ${marker} left behind` })]);
      });
      const { verifyPagePurge } = await import('../src/core/facts/purge-verify.ts');
      const recheck = await verifyPagePurge(engine, { sourceId: 'default', slug: SLUG, requestId: randomUUID(), removed: {}, blobsRemaining: [],
        context: { needles: [], reasons: [`${marker} left behind`], factIds: [], pageId: 0, paths: [], segmentShas: [] } }) as { stores: Array<{ store: string; status: string }> };
      expect(recheck.stores.find(s => s.store === 'persistence_effects')).toMatchObject({ status: 'incomplete' });
    }, { databaseUrl, setup }), 120_000);

    test('non-strict: a superseded Git effect never lends its reason to the newer commit; its receipt says so', () => managedBrain(async ({ engine, ctx, root }) => {
      await call(ctx, 'put_page', { slug: SLUG, content: page('Edition one.'), request_id: randomUUID() });
      await settleManagedGitEffects(engine);
      const first = randomUUID();
      await call(ctx, 'put_page', { slug: SLUG, content: page('Edition two.'), expected_revision: await revision(ctx), request_id: first, reason: 'first write reason' });
      await call(ctx, 'put_page', { slug: SLUG, content: page('Edition three.'), expected_revision: await revision(ctx), request_id: randomUUID() });
      await settleManagedGitEffects(engine);
      expect(raw(root, 'log', '--all', '--format=%B')).not.toContain('first write reason');
      const notices: Notice[] = [];
      const receipt = await operationsByName.get_write_request!.handler({ ...ctx, emitNotice: (n: Notice) => { notices.push(n); } } as OperationContext, { request_id: first }) as Record<string, unknown>;
      expect((receipt.outcome as Record<string, unknown>).reason_recorded).toMatchObject({ reason: 'first write reason', git: 'superseded' });
      expect(notices.map(n => n.code)).toContain('reason_not_committed');
      const versions = await call(ctx, 'get_versions', { slug: SLUG }) as unknown as Array<Record<string, unknown>>;
      expect(versions.map(v => v.replaced_because)).toEqual([null, 'first write reason']);
    }, { databaseUrl, setup }), 120_000);
  });
}
