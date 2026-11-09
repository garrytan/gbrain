/**
 * Wave C 1I-a, eng-r3-outside-1 for mixed groups (GBRA-108 ruling): a strict publication group with a removal or a
 * database-only member (an atom generation: creates, its activation, retirements) keeps G2's order. Its rows are written
 * inside the publication transaction before the door commit, so they must be neither visible nor durable before Git has
 * the content:
 *   - another session reads none of the group's rows while the door commit is in flight;
 *   - a door commit that fails leaves no row of the group behind;
 *   - a door commit that lands before the transaction fails (a forced failure, or the connection dying as a crash does)
 *     keeps Git's content, and the next sync derives the pages from Git with no hold and nothing lost;
 *   - the door inside the transaction is bounded: a door that stalls past the bound refuses with git_door_timeout,
 *     commits nothing and releases the worktree; a generic timeout thrown by a door step is wrapped like any other
 *     untyped failure (git_unavailable), never passed through as the door's own refusal.
 * Both engines. Synthetic content only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { configureGateway, resetGateway, type ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { exitCodeForCode } from '../../src/core/error-catalogue.ts';
import { OperationError, opError, type OperationContext } from '../../src/core/ops/contract.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { commitThroughDoor, doorSeams } from '../../src/core/persistence/git-door.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { readGitHoldListing } from '../../src/core/persistence/sync-holds.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from '../helpers/managed-brain.ts';
import { strictSource } from '../helpers/strict-door-audit.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const ORIGIN = 'notes/source-a';
const FIRST = ['Measure progress weekly', 'Ship small changes'];
const SECOND = ['Pilot before launch', 'Keep the checklist short'];
const interruption = (code: string) => Object.assign(new Error('database interruption ' + code), { code });
const chatReturning = (titles: string[]) => async (): Promise<ChatResult> => ({
  text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: 'Body for ' + title + ', from the Acme Example review.' }))), blocks: [], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });

/** Rewrites the origin page, then runs one atom generation over it (the second run is a mixed group: creates, activation, retirements). */
async function generation(engine: BrainEngine, ctx: OperationContext, body: string, titles: string[], arm?: () => void | Promise<void>) {
  const current = await engine.readPageSnapshot(ORIGIN, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: ORIGIN, request_id: randomUUID(),
    content: '---\ntype: source\ntitle: Source A\n---\n\n' + body.repeat(40) + '\n', ...(current ? { expected_revision: current.revision } : {}) } });
  await settleManagedGitEffects(engine);
  const page = (await engine.getPage(ORIGIN, { sourceId: 'default' }))!;
  await arm?.();
  try {
    return await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }],
      _chat: chatReturning(titles) });
  } finally { delete doorSeams.beforeUpdateRef; installFaultHook(undefined); }
}
const liveAtoms = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND type='atom' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const atomRows = async (engine: BrainEngine, word: string) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND slug LIKE $1", ['atoms/%' + word + '%'])).map(row => row.slug);
const trackedAtoms = (root: string) => git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'atoms').split('\n').filter(Boolean).sort();
const groupKinds = "intent->>'kind' IN ('managed_atom_page','managed_atom_delete','managed_generation_activate')";

beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
afterAll(() => resetGateway());
afterEach(() => { delete doorSeams.beforeUpdateRef; installFaultHook(undefined); });

describe('the door bound refuses with git_door_timeout; a generic timeout from a door step is wrapped', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const repo = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-bound-')));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(root, 'seed.md'), 'seed\n'); git(root, 'add', 'seed.md'); git(root, 'commit', '-qm', 'seed');
    writeFileSync(join(root, 'page.md'), 'page body\n');
    return root;
  };
  const refusal = (work: Promise<unknown>) => work.then(() => null, (error: OperationError) => error);
  const file = (root: string) => [{ path: join(root, 'page.md'), planned: sha256('page body\n') }];

  test('a deadline already past refuses git_door_timeout before the turn; one passing before update-ref refuses it there', async () => {
    const root = repo();
    const head = git(root, 'rev-parse', 'HEAD').trim();
    expect((await refusal(commitThroughDoor(root, file(root), undefined, undefined, Date.now() - 1)))?.code).toBe('git_door_timeout');
    doorSeams.beforeUpdateRef = async () => { await Bun.sleep(300); };
    expect((await refusal(commitThroughDoor(root, file(root), undefined, undefined, Date.now() + 100)))?.code).toBe('git_door_timeout');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(exitCodeForCode('git_door_timeout')).toBe(1);
  });

  test('a door step throwing a generic timeout comes out wrapped as git_unavailable, not as a typed refusal', async () => {
    const root = repo();
    const head = git(root, 'rev-parse', 'HEAD').trim();
    doorSeams.beforeUpdateRef = async () => { throw opError('timeout', 'A step timed out.', 'Fixture.'); };
    const error = await refusal(commitThroughDoor(root, file(root)));
    expect(error?.code).toBe('git_unavailable');
    expect(error?.suggestion).toContain('A step timed out.');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
  });
});

for (const backend of testBackends()) describe('[' + backend + '] mixed strict groups: rows before the door are neither visible nor durable', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('another session reads none of the group\'s rows while its door commit is in flight', () => managedBrain(async ({ engine, ctx, root }) => {
    await strictSource(engine);
    expect((await generation(engine, ctx, 'Alice Example reviewed the Acme Example plan. ', FIRST)).status).toBe('ok');
    const first = await liveAtoms(engine);
    expect(first).toHaveLength(2);
    let seen: { atoms: string[] } | 'blocked' | undefined;
    let read: Promise<string[]> | undefined;
    const result = await generation(engine, ctx, 'Alice Example revised the Acme Example plan. ', SECOND, () => {
      doorSeams.beforeUpdateRef = async () => {
        // The group's door call carries the retirements, whose files are already gone from the working tree.
        if (read || first.every(slug => existsSync(join(root, slug + '.md')))) return;
        read = liveAtoms(engine);
        seen = await Promise.race([read.then(atoms => ({ atoms })), Bun.sleep(500).then(() => 'blocked' as const)]);
      };
    });
    expect(result.status).toBe('ok');
    const second = await liveAtoms(engine);
    expect(second).toHaveLength(2);
    expect(second.some(slug => first.includes(slug))).toBe(false);
    // Postgres: a concurrent session reads the committed state (the first generation). PGLite: its one connection is held
    // by the publication transaction, so a read outside it waits for the transaction to end.
    if (backend === 'postgres') expect(seen).toEqual({ atoms: first });
    else expect(seen).toBe('blocked');
    await read;
    const published = await engine.executeRaw<{ published: string }>('SELECT DISTINCT published_at::text AS published FROM persistence_requests WHERE ' + groupKinds + " AND intent->>'activationId' = (SELECT intent->>'activationId' FROM persistence_requests WHERE intent->>'kind'='managed_generation_activate' ORDER BY sequence DESC LIMIT 1)");
    // Both engines publish the generation as one group (consumer.ts groups a generation on PGLite too).
    expect(published).toHaveLength(1);
  }, { databaseUrl, setup }), 240_000);

  test('a door commit that fails leaves no row of the group behind', () => managedBrain(async ({ engine, ctx, root }) => {
    await strictSource(engine);
    expect((await generation(engine, ctx, 'Alice Example reviewed the Acme Example plan. ', FIRST)).status).toBe('ok');
    const first = await liveAtoms(engine);
    let head = '', failures = 0, after = '0';
    await generation(engine, ctx, 'Alice Example revised the Acme Example plan. ', SECOND, async () => {
      head = git(root, 'rev-parse', 'HEAD').trim();
      after = (await engine.executeRaw<{ s: string }>('SELECT COALESCE(max(sequence),0)::text AS s FROM persistence_requests'))[0]!.s;
      doorSeams.beforeUpdateRef = async () => { failures++; throw new Error('forced door failure'); };
    }).catch(() => undefined);
    expect(failures).toBeGreaterThan(0);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(await liveAtoms(engine)).toEqual(first);
    expect(await atomRows(engine, 'pilot-before-launch')).toEqual([]);
    expect(await atomRows(engine, 'keep-the-checklist-short')).toEqual([]);
    expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE " + groupKinds + " AND state='committed' AND sequence > $1::bigint", [after])).toEqual([]);
    for (const slug of first) expect(existsSync(join(root, slug + '.md'))).toBe(true);
    expect(trackedAtoms(root)).toEqual(first.map(slug => slug + '.md').sort());
  }, { databaseUrl, setup }), 240_000);

  for (const [form, failure] of [['a forced failure', () => new OperationError('internal_error', 'Forced failure after the door commit.', 'Fixture.')],
    ['a crash (the connection dies)', () => interruption('CONNECTION_CLOSED')]] as const) {
    test('the door commit lands, then the transaction fails (' + form + '): Git wins and the next sync derives the pages with no hold', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      expect((await generation(engine, ctx, 'Alice Example reviewed the Acme Example plan. ', FIRST)).status).toBe('ok');
      const first = await liveAtoms(engine);
      let landed: string | undefined;
      await generation(engine, ctx, 'Alice Example revised the Acme Example plan. ', SECOND, () => {
        installFaultHook(async (point, detail) => {
          if (point !== 'publication:before_commit' || landed || detail.operation !== 'submit_job') return;
          landed = git(root, 'rev-parse', 'HEAD');
          throw failure();
        });
      }).catch(() => undefined);
      expect(landed).toBeDefined();
      const committed = trackedAtoms(root);
      expect(committed.some(path => path.includes('pilot-before-launch'))).toBe(true);
      await settleManagedGitEffects(engine);
      await performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, concurrency: 1 });
      expect(await readGitHoldListing(engine, ['default'], 10)).toEqual([]);
      const live = await liveAtoms(engine);
      expect(live.map(slug => slug + '.md').sort()).toEqual(trackedAtoms(root));
      for (const slug of live) {
        const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
        expect(git(root, 'show', 'HEAD:' + slug + '.md')).toContain(page.compiled_truth.trim());
      }
    }, { databaseUrl, setup }), 240_000);
  }
  test('a door that stalls past the publication\'s door bound refuses with git_door_timeout, commits nothing and releases the worktree (single path)', () => managedBrain(async ({ engine, ctx, root }) => {
    await strictSource(engine);
    const first = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/bounded', request_id: randomUUID(), content: '---\ntype: note\ntitle: Bounded\n---\n\nFirst revision.\n' } }) as { revision: string };
    await settleManagedGitEffects(engine);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    let stalls = 0;
    doorSeams.beforeUpdateRef = async () => { if (!stalls++) await Bun.sleep(1_500); };
    const requestId = randomUUID();
    const started = performance.now();
    await withEnv({ GBRAIN_PUBLICATION_DOOR_BOUND_MS: '500' }, () => submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/bounded', request_id: requestId,
      content: '---\ntype: note\ntitle: Bounded\n---\n\nSecond revision.\n', expected_revision: first.revision, wait_ms: 30_000 } }).catch(error => error));
    delete doorSeams.beforeUpdateRef;
    const [row] = await engine.executeRaw<{ state: string; error_code: string | null }>('SELECT state, error_code FROM persistence_requests WHERE request_id = $1::uuid', [requestId]);
    expect(stalls).toBe(1);
    expect(row).toMatchObject({ state: 'failed', error_code: 'git_door_timeout' });
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(root, 'show', 'HEAD:notes/bounded.md')).toContain('First revision.');
    expect((await engine.getPage('notes/bounded', { sourceId: 'default' }))!.compiled_truth).toContain('First revision.');
    expect(performance.now() - started).toBeLessThan(30_000);
    // The worktree and the page locks were released: the next write publishes at once.
    const next = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/bounded', request_id: randomUUID(),
      content: '---\ntype: note\ntitle: Bounded\n---\n\nThird revision.\n', expected_revision: first.revision, wait_ms: 30_000 } }) as { state: string };
    expect(next.state).toBe('committed');
    expect(git(root, 'show', 'HEAD:notes/bounded.md')).toContain('Third revision.');
  }, { databaseUrl, setup }), 240_000);

  test('a mixed group whose door stalls past the bound ends with git_door_timeout and commits nothing; Git and the rows stay in step', () => managedBrain(async ({ engine, ctx, root }) => {
    await strictSource(engine);
    expect((await generation(engine, ctx, 'Alice Example reviewed the Acme Example plan. ', FIRST)).status).toBe('ok');
    const first = await liveAtoms(engine);
    let head = '', after = '0', stalled = false, next: string | undefined;
    await withEnv({ GBRAIN_PUBLICATION_DOOR_BOUND_MS: '500' }, () => generation(engine, ctx, 'Alice Example revised the Acme Example plan. ', SECOND, async () => {
      head = git(root, 'rev-parse', 'HEAD').trim();
      after = (await engine.executeRaw<{ s: string }>('SELECT COALESCE(max(sequence),0)::text AS s FROM persistence_requests'))[0]!.s;
      doorSeams.beforeUpdateRef = async () => {
        // The next door call after the refusal sees the branch where the refused call found it.
        if (stalled) { next ??= git(root, 'rev-parse', 'HEAD').trim(); return; }
        if (first.every(slug => existsSync(join(root, slug + '.md')))) return;
        stalled = true;
        await Bun.sleep(1_500);
      };
    }).catch(error => error));
    expect(stalled).toBe(true);
    if (next !== undefined) expect(next).toBe(head);
    const rows = await engine.executeRaw<{ slug: string; state: string; error_code: string | null }>('SELECT slug, state, error_code FROM persistence_requests WHERE ' + groupKinds + ' AND sequence > $1::bigint ORDER BY sequence', [after]);
    expect(rows.some(row => row.state === 'failed' && row.error_code === 'git_door_timeout')).toBe(true);
    // The whole generation committed nothing, not just the member whose door stalled: no member request committed,
    // HEAD is where the group found it, and the first generation's atoms are still the live ones.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter(row => row.state === 'committed')).toEqual([]);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(await liveAtoms(engine)).toEqual(first);
    expect(await atomRows(engine, 'pilot-before-launch')).toEqual([]);
    expect(await atomRows(engine, 'keep-the-checklist-short')).toEqual([]);
    expect(await readGitHoldListing(engine, ['default'], 10)).toEqual([]);
    const live = await liveAtoms(engine);
    expect(live.map(slug => slug + '.md').sort()).toEqual(trackedAtoms(root));
  }, { databaseUrl, setup }), 240_000);
});
