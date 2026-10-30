/**
 * G6 (GBRA-60): publication groups for managed maintenance writers (journal.ts publicationGroupKey, group-publish.ts).
 *
 *   - GROUP_KEY_SQL (the claim's SQL) and publicationGroupKey agree on every group kind, the G6 kinds included.
 *   - Census (Postgres, where the owner groups them): a maintenance batch, an atom generation (create and retire members
 *     with their activation) and an extract_entities batch (put_page and add_timeline_entry) each publish in one
 *     transaction: one shared published_at (now() is the transaction start) and one commit.
 *   - Failure semantics: every G6 group is independent. One member forced to fail never cancels the others.
 *   - Distinct targets: the batch writers refuse a batch naming a page twice. A claimed group whose member writes a page or
 *     file an earlier member writes ends before it: the prefix publishes as one group, and that member and the rest go
 *     back to the queue and are prepared again, so every member settles as it would ungrouped.
 *   - Contiguity: a single write interleaved in a batch splits it into two groups, still fewer commits than members.
 * Runs on PGLite, and on Postgres through test/e2e/git-door-g6-publication-groups-postgres.test.ts. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { enrichEntities } from '../src/core/enrichment-service.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { GROUP_KEY_SQL, publicationGroupKey } from '../src/core/persistence/journal.ts';
import { firstSharedTarget } from '../src/core/persistence/group-publish.ts';
import type { PreparedMutation } from '../src/core/persistence/coordinator.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { maintenancePreflight, publishMaintenancePages } from '../src/core/persistence/prepared-maintenance.ts';
import { MaintenanceWriteWait } from '../src/core/persistence/maintenance-wait.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitPageMutations } from '../src/core/persistence/page-batch.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, waitForWrites } from '../src/core/persistence/service.ts';
import { declareDurablePersistence } from '../src/core/persistence/protocol.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { auditDoor, headCommit, strictSource } from './helpers/strict-door-audit.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, slug: string, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } });
const note = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const NOTES = [0, 1, 2, 3].map(i => `notes/acme-example-${i}`);

interface Published { slug: string; operation: string; kind: string | null; state: string; error_code: string | null; published: string | null; grp: string | null }
/** The requests on `slugs` admitted after `after` (a sequence), with their publication transaction's start and group key. */
async function published(engine: BrainEngine, after: string, where = 'TRUE'): Promise<Published[]> {
  return engine.executeRaw<Published>(`SELECT slug,operation,intent->>'kind' AS kind,state,error_code,published_at::text AS published,${GROUP_KEY_SQL} AS grp
    FROM persistence_requests WHERE sequence>$1::bigint AND ${where} ORDER BY sequence`, [after]);
}
const lastSequence = async (engine: BrainEngine) => String((await engine.executeRaw<{ s: string | null }>('SELECT max(sequence)::text AS s FROM persistence_requests'))[0]?.s ?? '0');

async function seedNotes(ctx: OperationContext): Promise<void> {
  for (const [i, slug] of NOTES.entries()) await put(ctx, slug, note(`Note ${i}`, `Alice Example wrote note ${i} for source-a.`));
  await settleManagedGitEffects(ctx.engine);
}
/** One maintenance rewrite per page, at its current revision. */
async function rewrites(engine: BrainEngine, slugs: string[], tag: string) {
  return Promise.all(slugs.map(async (slug, i) => {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    return { slug, content: note(`Note ${NOTES.indexOf(slug)}`, `Alice Example rewrote note ${i} (${tag}) for source-a.`), expectedRevision: snapshot.revision };
  }));
}

const ORIGIN = 'notes/source-a';
const chatReturning = (titles: string[]) => async (): Promise<ChatResult> => ({
  text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `Body for ${title}, from the Acme Example review.` }))), blocks: [], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
async function extract(engine: BrainEngine, ctx: OperationContext, body: string, titles: string[]) {
  const current = await engine.readPageSnapshot(ORIGIN, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: ORIGIN, request_id: randomUUID(),
    content: `---\ntype: source\ntitle: Source A\n---\n\n${body.repeat(40)}\n`, ...(current ? { expected_revision: current.revision } : {}) } });
  await settleManagedGitEffects(engine);
  const page = (await engine.getPage(ORIGIN, { sourceId: 'default' }))!;
  const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }],
    _chat: chatReturning(titles) });
  await settleManagedGitEffects(engine);
  return result;
}
const liveAtoms = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND type='atom' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);

/** Commits since `since` that touch any of `paths`. */
async function commitsTouching(engine: BrainEngine, root: string, since: string, slugs: string[]) {
  const audit = await auditDoor(engine, root, { since, slugs: [] });
  const paths = new Set(slugs.map(slug => `${slug}.md`));
  return audit.commits.filter(commit => commit.paths.some(path => paths.has(path))).length;
}

beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
afterAll(() => { installFaultHook(undefined); resetGateway(); });

describe('G6 publication groups: shared targets never share a transaction', () => {
  const row = (slug: string, kind?: string) => ({ slug, intent: kind ? { kind } : null }) as WriteRequest;
  const file = (path: string) => ({ file: { path } }) as unknown as PreparedMutation;
  const none = {} as PreparedMutation;
  test('the first member on a page or file an earlier member writes (in any spelling) is found; distinct pages and files share none', () => {
    expect(firstSharedTarget([row('atoms/a'), row('atoms/b')], [file('/r/atoms/a.md'), file('/r/atoms/b.md')])).toBeNull();
    expect(firstSharedTarget([row('atoms/a'), row('atoms/b'), row('Atoms/A'), row('atoms/b')], [none, none, none, none])).toBe(2);
    expect(firstSharedTarget([row('atoms/a'), row('atoms/b')], [file('/r/atoms/a.md'), file('/r/Atoms/A.md')])).toBe(1);
    expect(firstSharedTarget([row('atoms/a'), row('atoms/b')], [undefined, none])).toBeNull();
    // The activation journals under a pseudo slug and writes no page: two of them share no page target.
    const activate = row('__generation_activate__', 'managed_generation_activate');
    expect(firstSharedTarget([activate, row('atoms/a'), activate], [none, file('/r/atoms/a.md'), none])).toBeNull();
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const postgres = backend === 'postgres';
  describe(`[${backend}] G6 publication groups`, () => {
    test('GROUP_KEY_SQL equals publicationGroupKey for every group kind, the G6 kinds included', () => managedBrain(async ({ engine }) => {
      const atomKey = { kind: 'atom', sourceId: 'default', ownerKey: 'page:notes/source-a' };
      const rows: Array<Pick<WriteRequest, 'operation' | 'intent'> & { want: string | null }> = [
        { operation: 'submit_job', intent: { kind: 'managed_maintenance_page', maintenance_batch: 'b1', content: 'x' }, want: 'maintenance:b1' },
        { operation: 'submit_job', intent: { kind: 'managed_maintenance_page', content: 'x' }, want: null },
        { operation: 'submit_job', intent: { kind: 'managed_maintenance_page', maintenance_batch: 7 }, want: null },
        { operation: 'put_page', intent: { kind: 'managed_maintenance_page', maintenance_batch: 'b1' }, want: null },
        { operation: 'submit_job', intent: { kind: 'managed_atom_page', activationId: 'a1', phase: 'create' }, want: 'generation:a1' },
        { operation: 'submit_job', intent: { kind: 'managed_atom_page', activationId: 'a1', phase: 'overwrite' }, want: 'generation:a1' },
        { operation: 'submit_job', intent: { kind: 'managed_atom_delete', activationId: 'a1' }, want: 'generation:a1' },
        { operation: 'submit_job', intent: { kind: 'managed_generation_activate', activationId: 'a1', key: atomKey }, want: 'generation:a1' },
        { operation: 'submit_job', intent: { kind: 'managed_generation_activate', activationId: 'a1', key: { ...atomKey, kind: 'synthesis' } }, want: null },
        { operation: 'submit_job', intent: { kind: 'managed_atom_complete', activationId: 'a1' }, want: null },
        { operation: 'submit_job', intent: { kind: 'managed_atom_page', runKey: 'r1' }, want: null },
        { operation: 'add_timeline_entry', intent: { page_batch: { id: 'p1', index: 0, size: 2 }, date: '2026-01-01' }, want: 'batch:p1' },
        { operation: 'add_timeline_entry', intent: { date: '2026-01-01' }, want: null },
        { operation: 'put_page', intent: { page_batch: { id: 'p1', index: 1, size: 2 }, content: 'x' }, want: 'batch:p1' },
        { operation: 'put_page', intent: { kind: 'managed_file_repair', page_batch: { id: 'p1' } }, want: null },
        { operation: 'delete_page', intent: { page_batch: { id: 'p1' } }, want: null },
        { operation: 'put_page', intent: { kind: 'managed_file_import', import_batch: 'i1' }, want: 'import:i1' },
        { operation: 'submit_job', intent: { kind: 'managed_sync_import', group: 'g1' }, want: 'sync:g1' },
        { operation: 'put_page', intent: null, want: null },
      ];
      for (const { want, ...row } of rows) {
        const [sql] = await engine.executeRaw<{ key: string | null }>(`SELECT ${GROUP_KEY_SQL} AS key FROM (SELECT $1::text AS operation, $2::text::jsonb AS intent) r`,
          [row.operation, row.intent === null ? null : JSON.stringify(row.intent)]);
        expect({ row, ts: publicationGroupKey(row), sql: sql!.key }).toEqual({ row, ts: want, sql: want });
      }
    }), 60_000);

    test('the batch writers refuse a batch that names a page twice', () => managedBrain(async ({ engine, ctx, root }) => {
      await seedNotes(ctx);
      const maintenance = (await maintenancePreflight(engine, 'default', root))!;
      const [page] = await rewrites(engine, [NOTES[0]!], 'twice');
      await expect(publishMaintenancePages(engine, maintenance, [page!, page!])).rejects.toThrow('each page once');
      await expect(submitPageMutations(ctx, [{ operation: 'add_timeline_entry', params: { slug: NOTES[0], date: '2026-01-02', summary: 'one' } },
        { operation: 'add_timeline_entry', params: { slug: NOTES[0], date: '2026-01-03', summary: 'two' } }])).rejects.toThrow('each page once');
    }, { databaseUrl, setup }), 120_000);

    test('extract_entities naming one entity twice writes its page once, then plans the second mention against it', () => managedBrain(async ({ engine, ctx }) => {
      await strictSource(engine);
      await put(ctx, 'meetings/source-a', note('Source A', 'Met people.'));
      const results = await enrichEntities(engine, [
        { entityName: 'Dana Example', entityType: 'person', context: 'first mention at the review', sourceSlug: 'meetings/source-a' },
        { entityName: 'Dana Example', entityType: 'person', context: 'second mention at the launch', sourceSlug: 'meetings/source-a' },
      ], { ctx, sourceId: 'default', throttle: false });
      expect(results.map(r => [r.slug, r.action, r.timelineAdded])).toEqual([['people/dana-example', 'created', true], ['people/dana-example', 'updated', true]]);
      const rows = await engine.executeRaw<{ summary: string }>(`SELECT te.summary FROM timeline_entries te JOIN pages p ON p.id=te.page_id
        WHERE p.source_id='default' AND p.slug='people/dana-example' ORDER BY te.summary`);
      expect(rows.map(row => row.summary.replace(/.* — /, ''))).toEqual(['first mention at the review', 'second mention at the launch']);
    }, { databaseUrl, setup }), 120_000);

    if (!postgres) return;

    test('census: a maintenance batch publishes in one transaction and one commit', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await seedNotes(ctx);
      const maintenance = (await maintenancePreflight(engine, 'default', root))!;
      const [after, since] = [await lastSequence(engine), await headCommit(root)];
      const outcomes = await publishMaintenancePages(engine, maintenance, await rewrites(engine, NOTES.slice(0, 3), 'census'));
      expect(outcomes.every(outcome => 'receipt' in outcome)).toBe(true);
      await settleManagedGitEffects(engine);
      const rows = await published(engine, after);
      expect(rows.map(row => [row.slug, row.kind, row.state])).toEqual(NOTES.slice(0, 3).map(slug => [slug, 'managed_maintenance_page', 'committed']));
      expect(new Set(rows.map(row => row.grp)).size).toBe(1);
      expect(rows[0]!.grp).toStartWith('maintenance:');
      expect(new Set(rows.map(row => row.published)).size).toBe(1);
      expect(await commitsTouching(engine, root, since, NOTES.slice(0, 3))).toBe(1);
    }, { databaseUrl, setup }), 120_000);

    test('census: an atom generation (creates, its activation, retirements) publishes in one transaction and one commit', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      expect((await extract(engine, ctx, 'Alice Example reviewed the Acme Example plan. ', ['Measure progress weekly', 'Ship small changes'])).status).toBe('ok');
      const first = await liveAtoms(engine);
      const [after, since] = [await lastSequence(engine), await headCommit(root)];
      expect((await extract(engine, ctx, 'Alice Example revised the Acme Example plan. ', ['Pilot before launch', 'Keep the checklist short'])).status).toBe('ok');
      const second = await liveAtoms(engine);
      const rows = await published(engine, after, "intent->>'kind' IN ('managed_atom_page','managed_atom_delete','managed_generation_activate')");
      expect(rows.map(row => [row.kind, row.state])).toEqual([['managed_atom_page', 'committed'], ['managed_atom_page', 'committed'],
        ['managed_generation_activate', 'committed'], ['managed_atom_delete', 'committed'], ['managed_atom_delete', 'committed']]);
      expect(new Set(rows.map(row => row.grp)).size).toBe(1);
      expect(rows[0]!.grp).toStartWith('generation:');
      expect(new Set(rows.map(row => row.published)).size).toBe(1);
      expect(await commitsTouching(engine, root, since, [...first, ...second])).toBe(1);
    }, { databaseUrl, setup }), 240_000);

    test('census: an extract_entities batch (a new stub and timeline bullets) publishes in one transaction and one commit', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await put(ctx, 'meetings/source-a', note('Source A', 'Met people.'));
      await put(ctx, 'people/alice-example', '---\ntype: person\ntitle: Alice Example\n---\n\nA person.\n');
      await put(ctx, 'people/carol-example', '---\ntype: person\ntitle: Carol Example\n---\n\nA person.\n');
      await settleManagedGitEffects(engine);
      const [after, since] = [await lastSequence(engine), await headCommit(root)];
      const op = operations.find(o => o.name === 'extract_entities')!;
      await op.handler(ctx, { text: 'lunch with Alice Example, then a call with Carol Example and a visit to Acme Example Labs.', source_slug: 'meetings/source-a' });
      await settleManagedGitEffects(engine);
      const rows = await published(engine, after, "operation IN ('put_page','add_timeline_entry')");
      expect(rows.map(row => [row.slug, row.operation, row.state]).sort()).toEqual([['companies/acme-example-labs', 'put_page', 'committed'],
        ['people/alice-example', 'add_timeline_entry', 'committed'], ['people/carol-example', 'add_timeline_entry', 'committed']]);
      expect(new Set(rows.map(row => row.grp)).size).toBe(1);
      expect(rows[0]!.grp).toStartWith('batch:');
      expect(new Set(rows.map(row => row.published)).size).toBe(1);
      expect(await commitsTouching(engine, root, since, rows.map(row => row.slug))).toBe(1);
    }, { databaseUrl, setup }), 120_000);

    test('independent: a maintenance batch member forced to fail cancels no other member', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await seedNotes(ctx);
      const maintenance = (await maintenancePreflight(engine, 'default', root))!;
      const after = await lastSequence(engine);
      const target = (await rewrites(engine, [NOTES[1]!], 'fail'))[0]!;
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:preparing') return;
        const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE id=$1::uuid', [detail.writeId]);
        if (row?.slug === target.slug) throw new OperationError('revision_conflict', 'Forced member failure.', 'Fixture.');
      });
      let outcomes;
      try { outcomes = await publishMaintenancePages(engine, maintenance, await rewrites(engine, NOTES.slice(0, 3), 'fail')); }
      finally { installFaultHook(undefined); }
      expect(outcomes.map(outcome => 'receipt' in outcome)).toEqual([true, false, true]);
      await settleManagedGitEffects(engine);
      const rows = await published(engine, after);
      expect(rows.map(row => [row.slug, row.state, row.error_code])).toEqual([[NOTES[0], 'committed', null], [NOTES[1], 'conflict', 'revision_conflict'], [NOTES[2], 'committed', null]]);
      // The two that committed still published together.
      expect(rows[0]!.published).toBe(rows[2]!.published);
      expect((await engine.readPageSnapshot(NOTES[1]!, { sourceId: 'default' }))!.page.compiled_truth).toContain('wrote note 1');
    }, { databaseUrl, setup }), 120_000);

    test('independent: a retirement forced to fail cancels no other member of its generation; the next run resumes it', () => managedBrain(async ({ engine, ctx }) => {
      await strictSource(engine);
      expect((await extract(engine, ctx, 'Alice Example reviewed the Acme Example plan. ', ['Measure progress weekly', 'Ship small changes'])).status).toBe('ok');
      const first = await liveAtoms(engine);
      const after = await lastSequence(engine);
      let failed: string | null = null;
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:preparing') return;
        const [row] = await engine.executeRaw<{ slug: string; kind: string }>("SELECT slug,intent->>'kind' AS kind FROM persistence_requests WHERE id=$1::uuid", [detail.writeId]);
        // Members prepare concurrently: only the first retirement to get here fails.
        if (row?.kind !== 'managed_atom_delete' || failed) return;
        failed = row.slug;
        throw new OperationError('revision_conflict', 'Forced member failure.', 'Fixture.');
      });
      try { await extract(engine, ctx, 'Alice Example revised the Acme Example plan. ', ['Pilot before launch', 'Keep the checklist short']).catch(() => undefined); }
      finally { installFaultHook(undefined); }
      expect(failed).not.toBeNull();
      const retired = failed!;
      expect(first).toContain(retired);
      const rows = await published(engine, after, "intent->>'kind' IN ('managed_atom_page','managed_atom_delete','managed_generation_activate')");
      expect(rows.map(row => [row.kind, row.slug === failed ? 'failed member' : row.state])).toEqual([['managed_atom_page', 'committed'], ['managed_atom_page', 'committed'],
        ['managed_generation_activate', 'committed'], ...first.map(slug => ['managed_atom_delete', slug === failed ? 'failed member' : 'committed'])]);
      expect(rows.find(row => row.slug === failed)).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
      expect(new Set(rows.filter(row => row.slug !== failed).map(row => row.published)).size).toBe(1);
      // The failed retirement left its atom live and pending on the activated generation; the next run retires it.
      expect(await liveAtoms(engine)).toContain(retired);
      await extract(engine, ctx, 'Alice Example revised the Acme Example plan. ', ['Pilot before launch', 'Keep the checklist short']);
      expect(await liveAtoms(engine)).not.toContain(retired);
    }, { databaseUrl, setup }), 240_000);

    test('shared target: a member writing a page an earlier group member wrote is prepared again after it, and settles as it would ungrouped', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await seedNotes(ctx);
      const [after, since] = [await lastSequence(engine), await headCommit(root)];
      const [A, B, C] = ['notes/new-a', 'notes/new-b', 'notes/new-c'];
      const create = (slug: string, tag: string) => ({ operation: 'put_page' as const, params: { slug, request_id: randomUUID(),
        content: note(slug, `Alice Example wrote it (${tag}) for source-a.`) } });
      // Hold the worktree so both batches queue before anything publishes.
      const holder = await acquireWorktree((await getWorktreeBinding(engine, 'default'))!, 5000);
      expect(holder).not.toBeNull();
      try {
        await submitPageMutations({ ...ctx, writeWaitMs: 0 }, [create(A, 'first'), create(B, 'first')]).catch(() => undefined);
        await submitPageMutations({ ...ctx, writeWaitMs: 0 }, [create(A, 'second'), create(C, 'second')]).catch(() => undefined);
        await disposePersistenceConsumer(engine);
      } finally { await holder!.release(); }
      await engine.executeRaw("UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,blocked_reason=NULL WHERE state='running' AND recovery IS NULL");
      // One batch id for all four, so one claim takes page A twice: A, B, A again, C. Every member prepares while A has no page.
      await engine.transaction(async tx => {
        await declareDurablePersistence(tx);
        await tx.executeRaw(`UPDATE persistence_requests SET intent=jsonb_set(intent,'{page_batch,id}',(SELECT intent->'page_batch'->'id' FROM persistence_requests
          WHERE sequence>$1::bigint ORDER BY sequence LIMIT 1)) WHERE sequence>$1::bigint`, [after]);
      });
      const queued = await published(engine, after);
      expect(queued.map(row => [row.slug, row.state, row.error_code])).toEqual([A, B, A, C].map(slug => [slug, 'queued', null]));
      expect(new Set(queued.map(row => row.grp)).size).toBe(1);
      const rows = await waitForWrites(engine, await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE sequence>$1::bigint ORDER BY sequence', [after]),
        { engine: engine.kind }, 30_000);
      // As ungrouped: the second create of A finds A written and refuses an overwrite without a revision; A keeps the first write.
      expect(rows.map(row => [row.slug, row.state, row.error_code ?? null])).toEqual([[A, 'committed', null], [B, 'committed', null],
        [A, 'conflict', 'revision_required'], [C, 'committed', null]]);
      expect((await engine.readPageSnapshot(A!, { sourceId: 'default' }))!.page.compiled_truth).toContain('(first)');
      await settleManagedGitEffects(engine);
      expect(readFileSync(join(root, `${A}.md`), 'utf8')).toContain('(first)');
      const done = await published(engine, after);
      expect(done.filter(row => ['queued', 'running'].includes(row.state))).toEqual([]);
      // A and B published as one group; C, claimed again with the second A, published after them.
      expect(done[0]!.published).toBe(done[1]!.published);
      expect(done[3]!.published).not.toBe(done[0]!.published);
      expect(await commitsTouching(engine, root, since, [A!, B!, C!])).toBe(2);
    }, { databaseUrl, setup }), 120_000);

    test('contiguity: a single write interleaved in a batch splits it into two groups, still fewer commits than writes', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await seedNotes(ctx);
      const maintenance = (await maintenancePreflight(engine, 'default', root))!;
      const [after, since] = [await lastSequence(engine), await headCommit(root)];
      // Hold the worktree so nothing publishes while the batch and another writer's single write are queued.
      const holder = await acquireWorktree((await getWorktreeBinding(engine, 'default'))!, 5000);
      expect(holder).not.toBeNull();
      try {
        maintenance.wait = new MaintenanceWriteWait(Date.now());
        await publishMaintenancePages(engine, maintenance, await rewrites(engine, NOTES, 'interleaved'));
        await submitPageMutation({ ...ctx, writeWaitMs: 0 }, { operation: 'put_page', params: { slug: 'notes/other-writer', request_id: randomUUID(),
          content: note('Other', 'Another writer for acme-example.') } }).catch(() => undefined);
        await disposePersistenceConsumer(engine);
      } finally { await holder!.release(); }
      await engine.executeRaw("UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,blocked_reason=NULL WHERE state='running' AND recovery IS NULL");
      // Move the batch's last two members behind the single write: batch, batch, single, batch, batch.
      const queued = await published(engine, after);
      expect(queued.map(row => row.slug)).toEqual([...NOTES, 'notes/other-writer']);
      await engine.transaction(async tx => {
        await declareDurablePersistence(tx);
        await tx.executeRaw('UPDATE persistence_requests SET sequence=sequence+1000000 WHERE sequence>$1::bigint AND slug=ANY($2::text[])', [after, NOTES.slice(2)]);
      });
      const rows = await waitForWrites(engine, await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE sequence>$1::bigint ORDER BY sequence', [after]),
        { engine: engine.kind }, 30_000);
      expect(rows.map(row => [row.slug, row.state])).toEqual([[NOTES[0], 'committed'], [NOTES[1], 'committed'], ['notes/other-writer', 'committed'],
        [NOTES[2], 'committed'], [NOTES[3], 'committed']]);
      await settleManagedGitEffects(engine);
      const done = await published(engine, after);
      const at = Object.fromEntries(done.map(row => [row.slug, row.published]));
      expect(at[NOTES[0]!]).toBe(at[NOTES[1]!]);
      expect(at[NOTES[2]!]).toBe(at[NOTES[3]!]);
      expect(at[NOTES[0]!]).not.toBe(at[NOTES[2]!]);
      expect(await commitsTouching(engine, root, since, [...NOTES, 'notes/other-writer'])).toBe(3);
    }, { databaseUrl, setup }), 120_000);
  });
}
