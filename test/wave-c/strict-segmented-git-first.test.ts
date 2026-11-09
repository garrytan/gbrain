/**
 * Wave C 1H-a: a strict git-first write of a segmented page (over 1 MiB, up to 24 MiB, unsplit) commits through the door
 * and leaves its rows to the index step. In the door transaction nothing holds the page's bytes (payload probe at 2 MiB put,
 * 20 MiB and 24 MiB uploads, and an append_page or append-mode upload to a 6 MiB page, both engines); after it the request is `indexing`, the page has a pending head and an
 * `index-split-page` effect bound to the worktree, and the page's database rows are unchanged. Over 24 MiB a strict upload
 * keeps `file_too_large`; with no consumer registered (a standalone 1H tree) the same write takes today's path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { _resetGitFirstGateForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { payloadTables, probeAny } from './payload-probe.ts';
import { MiB, pageBody, write } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
for (const backend of testBackends()) describe(`[${backend}] git-first strict segmented writes (1H-a)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  for (const [bytes, how] of [[2 * MiB, 'put'], [20 * MiB, 'upload'], [24 * MiB - 4096, 'upload']] as const) {
    test(`a ${Math.round(bytes / MiB)} MiB ${how}: no page bytes before the door, then indexing with a pending head`, () => managedBrain(async ({ engine, ctx, root }) => {
      await strict(engine);
      const marker = `MARKER${randomUUID().replace(/-/g, '')}`;
      const slug = `notes/large-${how}`;
      const probe = probeAny(marker);
      const row = await write(engine, ctx, slug, pageBody(bytes, marker), how);
      probe.clear();
      expect(probe.seen()).toEqual({ probed: true, tables: [] });
      expect(row.state).toBe('indexing');
      expect((row.error as { code?: string })?.code).toBe('write_pending');
      expect(row.outcome?.persistence).toMatchObject({ git_state: 'committed' });
      expect(row.outcome?.index).toMatchObject({ state: 'pending', commit: row.outcome?.persistence.git_commit });
      expect(git(root, 'show', `${row.outcome?.persistence.git_commit}:${slug}.md`)).toContain(marker);
      const [head] = await engine.executeRaw<{ request_id: string; commit_oid: string; body_bytes: unknown }>(
        "SELECT request_id::text AS request_id, commit_oid, body_bytes FROM page_pending_heads WHERE source_id = 'default' AND slug = $1", [slug]);
      expect(head).toMatchObject({ request_id: row.id, commit_oid: row.outcome?.persistence.git_commit });
      const effects = await engine.executeRaw<{ kind: string; worktree_id: string | null }>("SELECT kind, worktree_id::text AS worktree_id FROM persistence_effects WHERE request_id = $1::uuid ORDER BY kind", [row.id]);
      expect(effects.map(effect => effect.kind)).toEqual(['git', 'index-split-page']);
      expect(effects.every(effect => effect.worktree_id !== null)).toBe(true);
      expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id = 'default' AND slug = $1", [slug])).toEqual([]);
      expect(await payloadTables(engine, marker, row.id)).toEqual(['page_pending_heads:1']);
    }, { databaseUrl, setup }), 300_000);
  }

  test('ceo-r3-native-2: a small put during a paused index commits in seconds; indexing holds no source sequence', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const large = await write(engine, ctx, 'notes/paused', pageBody(2 * MiB, 'MARKERPAUSED'), 'put');
    expect(large.state).toBe('indexing');
    const started = performance.now();
    const small = await write(engine, ctx, 'notes/small-after', pageBody(4 * 1024, 'MARKERSMALL'), 'put');
    expect(small.state).toBe('committed');
    expect(performance.now() - started).toBeLessThan(10_000);
    const [held] = await engine.executeRaw<{ recovery: unknown; state: string }>('SELECT recovery, state FROM persistence_requests WHERE id = $1::uuid', [large.id]);
    expect(held).toEqual({ recovery: null, state: 'indexing' });
  }, { databaseUrl, setup }), 120_000);

  test('over 24 MiB a strict upload keeps file_too_large', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const text = pageBody(24 * MiB + 1024, 'MARKEROVER');
    const begin = op('begin_page_upload').handler(ctx, { slug: 'notes/over', mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
    const refused = await begin.then(() => null, (error: { code?: string; canonical?: string }) => error);
    expect(refused?.canonical ?? refused?.code).toBe('file_too_large');
  }, { databaseUrl, setup }), 120_000);
});

for (const backend of testBackends()) describe(`[${backend}] without an index consumer (a standalone 1H tree)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a 2 MiB strict put commits as today: segmented rows written in the publication, no pending head, no spool', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const row = await write(engine, ctx, 'notes/today', pageBody(2 * MiB, 'MARKERTODAY'), 'put');
    expect(row.state).toBe('committed');
    expect(await engine.executeRaw("SELECT body_storage FROM pages WHERE source_id = 'default' AND slug = 'notes/today'")).toEqual([{ body_storage: 'segmented' }]);
    expect(await engine.executeRaw('SELECT 1 FROM page_pending_heads')).toEqual([]);
    expect(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE kind = 'index-split-page'")).toEqual([]);
  }, { databaseUrl, setup }), 120_000);

  test('a strict upload stages its parts in the database as today', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const text = pageBody(600 * 1024, 'MARKERSTAGED');
    const begun = await op('begin_page_upload').handler(ctx, { slug: 'notes/staged', mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() }) as { upload_id: string };
    await op('upload_page_part').handler(ctx, { upload_id: begun.upload_id, part: 0, text: text.slice(0, 300_000), part_sha256: hex(text.slice(0, 300_000)) });
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM page_body_staging_parts')).toEqual([{ n: 1 }]);
    expect(await engine.executeRaw('SELECT 1 FROM page_upload_spools')).toEqual([]);
  }, { databaseUrl, setup }), 120_000);
});

for (const backend of testBackends()) describe(`[${backend}] git-first stays off on a non-strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a 2 MiB put on a non-strict source commits as today', () => managedBrain(async ({ engine, ctx }) => {
    const row = await write(engine, ctx, 'notes/nonstrict', pageBody(2 * MiB, 'MARKERNONSTRICT'), 'put');
    expect(row.state).toBe('committed');
    expect(await engine.executeRaw('SELECT 1 FROM page_pending_heads')).toEqual([]);
  }, { databaseUrl, setup }), 120_000);

  test('a database-only (private) 2 MiB page on a strict source keeps its database path', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const text = pageBody(2 * MiB, 'MARKERPRIVATE').replace('type: note\n', 'type: note\nvisibility: private\n');
    const row = await write(engine, ctx, 'notes/private', text, 'put');
    expect(row.state).toBe('committed');
    expect(await engine.executeRaw('SELECT 1 FROM page_pending_heads')).toEqual([]);
    expect(await engine.executeRaw("SELECT body_storage FROM pages WHERE source_id = 'default' AND slug = 'notes/private'")).toEqual([{ body_storage: 'segmented' }]);
  }, { databaseUrl, setup }), 120_000);
});

for (const backend of testBackends()) describe('[' + backend + '] the 6 MiB append probe (eng-r3-outside-1)', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  /** A 6 MiB page written and indexed before the git-first path turned on (no consumer registered then). */
  const sixMiBPage = async (engine: BrainEngine, ctx: OperationContext, slug: string) => {
    _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests();
    await strict(engine);
    expect((await write(engine, ctx, slug, pageBody(6 * MiB, 'MARKERSIXBASE'), 'put')).state).toBe('committed');
    _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined });
  };
  /** The append's request once its publication settled (indexing or terminal). */
  const appended = async (engine: BrainEngine, slug: string) => {
    for (const deadline = performance.now() + 60_000; ;) {
      const [row] = await engine.executeRaw<{ id: string; state: string; outcome: Record<string, any> | null }>(
        "SELECT id::text AS id, state, outcome FROM persistence_requests WHERE slug = $1 AND operation = 'append_page' ORDER BY created_at DESC LIMIT 1", [slug]);
      if (row && !['queued', 'running'].includes(row.state) || performance.now() > deadline) return row!;
      await Bun.sleep(100);
    }
  };

  for (const how of ['append_page', 'upload'] as const) {
    test('a ' + how + ' to a 6 MiB page writes no page bytes before the door, then indexes from Git', () => managedBrain(async ({ engine, ctx, root }) => {
      const slug = 'notes/six-' + how.replace('_', '-');
      await sixMiBPage(engine, ctx, slug);
      const marker = 'MARKER' + randomUUID().replace(/-/g, '');
      const text = '\n' + marker + ' appended line about the launch plan.\n';
      const probe = probeAny(marker);
      try {
        if (how === 'append_page') await op('append_page').handler(ctx, { slug, text, request_id: randomUUID(), wait_ms: 3_000 });
        else {
          const begun = await op('begin_page_upload').handler(ctx, { slug, mode: 'append', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() }) as { upload_id: string };
          await op('upload_page_part').handler(ctx, { upload_id: begun.upload_id, part: 0, text, part_sha256: hex(text) });
          await op('commit_page_upload').handler(ctx, { upload_id: begun.upload_id, wait_ms: 3_000 });
        }
      } catch (error) { if ((error as { code?: string }).code !== 'write_pending') throw error; }
      const row = await appended(engine, slug);
      probe.clear();
      expect(probe.seen()).toEqual({ probed: true, tables: [] });
      expect(row.state).toBe('indexing');
      expect(git(root, 'show', 'HEAD:' + slug + '.md')).toContain(marker);
      expect(git(root, 'show', 'HEAD:' + slug + '.md')).toContain('MARKERSIXBASE');
      expect(await payloadTables(engine, marker, row.id)).toEqual([]);
    }, { databaseUrl, setup }), 300_000);
  }
});

