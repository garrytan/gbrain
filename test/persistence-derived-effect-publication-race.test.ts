/**
 * GST-1644: a links or facts-backstop effect runs without the worktree lock, so on PostgreSQL another writer's
 * publication can record its recovery between the effect's claim and its guard. That record is the publication in
 * flight, not a crash: the effect waits for it as `writer_busy` with the short busy backoff. Only a recovery whose
 * publisher's claim lapsed (or a request in `recovering`) stays `recovery_required`. Either way the effect stays
 * queued and the next pass after it is due derives the links.
 *
 * The interleaving is forced by wrapping the engine's transaction (no production seam): the first transaction after the
 * effect is claimed is its guard, and before it runs a real put_page publication is driven to a boundary.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { PublicationHooks } from '../src/core/persistence/coordinator.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { due } from './pathological/effects-fixture.ts';
import { pathologicalArms } from './pathological/harness.ts';

const TARGET = 'notes/target-example';
const PAGE = 'notes/page-example';
const OTHER = 'notes/other-example';
const doc = (slug: string, body: string) => `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n`;
const put = (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: doc(slug, body) } });

type Row = { kind: string; state: string; error_code: string | null; delay_ms: number; links: string | null };
const derived = (engine: BrainEngine) => engine.executeRaw<Row>(`SELECT e.kind,e.state,e.error_code,e.outcome->>'links' AS links,
  GREATEST(0,EXTRACT(EPOCH FROM (e.next_attempt_at-now()))*1000)::int AS delay_ms
  FROM persistence_effects e WHERE e.kind IN ('links','facts-backstop') ORDER BY e.kind`);
const mentions = (engine: BrainEngine) => engine.executeRaw<{ slug: string }>(`SELECT t.slug FROM links l JOIN pages f ON f.id=l.from_page_id
  JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='default' AND f.slug=$1 ORDER BY t.slug`, [PAGE]);

/** PAGE mentions TARGET; its request gets a links and then a facts-backstop effect (the shapes a remote put_page queues), and every seed effect settles. */
async function seed(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  await put(ctx, TARGET, 'The target.');
  await put(ctx, PAGE, `See [[${TARGET}]].`);
  await disposePersistenceConsumer(engine);
  await due(engine);
  await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 20 });
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`DELETE FROM links l USING pages f WHERE f.id=l.from_page_id AND f.slug=$1`, [PAGE]);
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
      SELECT e.request_id,k.kind,e.revision,e.data,e.source_id,e.source_incarnation,e.worktree_id FROM persistence_effects e
      JOIN persistence_requests r ON r.id=e.request_id CROSS JOIN (VALUES ('links'),('facts-backstop')) AS k(kind)
      WHERE e.kind='embedding' AND r.slug=$1`, [PAGE]);
  });
}

/** Another writer's put_page, claimed and prepared, publishing until `release` resolves; its publication pauses at `at`. */
async function otherWriter(engine: BrainEngine, ctx: OperationContext, at: Parameters<NonNullable<PublicationHooks['boundary']>>[0]) {
  const binding = (await getWorktreeBinding(engine, 'default', localHostId()))!;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, OTHER);
  const intent = { content: doc(OTHER, 'Another writer.') };
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
    slug: OTHER, pageId: null, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, localHostId()))!;
  expect(row.slug).toBe(OTHER);
  let reached!: () => void; let release!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { row, paused, release, start: async (): Promise<WriteRequest> => publishMutation(engine, row, await preparePageMutation(engine, row, ctx.config), localHostId(),
    { boundary: async name => { if (name === at) { reached(); await gate; } } }) };
}

/** Runs one effect pass; before the guard of the first claimed derived effect, `interleave` runs. */
async function racedPass(engine: BrainEngine, ctx: OperationContext, interleave: () => Promise<void>): Promise<void> {
  const original = engine.transaction;
  let armed = true;
  engine.transaction = (async function (this: BrainEngine, fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) {
    if (armed && this === engine) {
      const [claimed] = await engine.executeRaw(`SELECT 1 FROM persistence_effects WHERE kind IN ('links','facts-backstop') AND state='running'`);
      if (claimed) { armed = false; await interleave(); }
    }
    return original.call(this, fn, opts as never);
  }) as BrainEngine['transaction'];
  try {
    await due(engine);
    await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 20 });
  } finally { engine.transaction = original; }
  expect(armed).toBe(false);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GST-1644 derived effects behind a concurrent publication (${backend})`, () => {
    for (const at of ['prepared', 'after_commit'] as const) {
      test(`a publication in flight (${at}) holds them as writer_busy with the short backoff; the next pass links`, async () => {
        await managedBrain(async ({ engine, ctx }) => {
          await seed(engine, ctx);
          const other = await otherWriter(engine, ctx, at);
          let publication: Promise<WriteRequest> | undefined;
          await racedPass(engine, ctx, async () => { publication = other.start(); await other.paused; });
          const held = await derived(engine);
          // The links effect was claimed first; once the record exists the claim skips the worktree, so facts-backstop waits unclaimed.
          expect(held.map(row => ({ kind: row.kind, state: row.state, error_code: row.error_code }))).toEqual([
            { kind: 'facts-backstop', state: 'queued', error_code: null }, { kind: 'links', state: 'queued', error_code: 'writer_busy' }]);
          expect(held.find(row => row.kind === 'links')!.delay_ms).toBeLessThan(5_000);
          other.release();
          expect((await publication!).state).toBe('committed');
          await due(engine);
          await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 20 });
          expect((await derived(engine)).map(row => ({ kind: row.kind, state: row.state }))).toEqual([
            { kind: 'facts-backstop', state: 'committed' }, { kind: 'links', state: 'committed' }]);
          expect(await mentions(engine)).toEqual([{ slug: TARGET }]);
        }, { databaseUrl });
      }, 120_000);
    }

    test('a recovery whose publisher\'s claim lapsed still holds them as recovery_required; once it settles the next pass links', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await seed(engine, ctx);
        const other = await otherWriter(engine, ctx, 'prepared');
        let publication: Promise<WriteRequest> | undefined;
        await racedPass(engine, ctx, async () => {
          publication = other.start();
          await other.paused;
          await engine.transaction(async tx => {
            await declarePersistenceProtocol(tx);
            await tx.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE id=$1::uuid", [other.row.id]);
          });
        });
        const held = await derived(engine);
        expect(held.map(row => ({ kind: row.kind, state: row.state, error_code: row.error_code }))).toEqual([
          { kind: 'facts-backstop', state: 'queued', error_code: null }, { kind: 'links', state: 'queued', error_code: 'recovery_required' }]);
        other.release();
        await publication!.catch(() => undefined);
        await due(engine);
        await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 20 });
        expect((await derived(engine)).map(row => ({ kind: row.kind, state: row.state }))).toEqual([
          { kind: 'facts-backstop', state: 'committed' }, { kind: 'links', state: 'committed' }]);
        expect(await mentions(engine)).toEqual([{ slug: TARGET }]);
      }, { databaseUrl });
    }, 120_000);
  });
}
