/**
 * Bulk settle of no-op embedding effects (embedding-noop-settle.ts).
 *
 * Protects: an import followed by `embed --stale` left ~47k queued page
 * embedding effects whose chunks were already embedded; the serve drain ran
 * each through a claim, a guard, a projection read and a completion, and the
 * first tool call waited for all of them. The bulk settle commits only true
 * no-ops and leaves the row exactly as the runner's own no-op completion
 * does; every effect with anything left to embed (or any doubt) still runs,
 * and a crash inside the settle leaves every row queued.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { embeddingCompletionModel, runPersistenceEffects, type EffectWorkerOptions } from '../src/core/persistence/effects.ts';
import { settleNoopEmbeddingEffects } from '../src/core/persistence/embedding-noop-settle.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, compactWriteReceipts, getWriteRequestProgress } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { installPageEmbeddings, installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const signature = 'test:model:1536';
const model = 'test:model';
const vector = () => new Float32Array(1536).fill(0.1);

for (const kind of testBackends()) {
  describe(`no-op embedding settle ${kind}`, () => {
    let engine: BrainEngine;
    let scratch: string;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-noop-settle-'));
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({ database_path: join(scratch, 'brain') }); await engine.initSchema();
      }
    }, 120_000);
    afterAll(async () => {
      await engine?.disconnect();
      if (close) await close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    afterEach(() => installFaultHook(undefined));
    const check = (name: string, fn: () => Promise<void>) => test(name, () => withEnv({ GBRAIN_HOME: scratch }, fn), 120_000);

    /** One published page with its sealed projection; `embedded` installs current vectors. Returns its embedding effect. */
    async function page(slug: string, embedded: boolean) {
      await registerLocalWriter(engine, 'cli');
      const sourceId = `noop-${randomUUID()}`;
      const [source] = await engine.executeRaw<{ incarnation: string }>('INSERT INTO sources(id,name) VALUES($1,$1) RETURNING incarnation', [sourceId]);
      const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
      const authority = await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, slug);
      await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
        sourceIncarnation: source.incarnation, slug, requestId: randomUUID(), callerIntent: { body: slug }, intent: { body: slug } });
      const row = (await claimNextWrite(engine, localHostId()))!;
      await publishMutation(engine, row, { observedRevision: null, apply: async tx => {
        await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}`, timeline: '', frontmatter: {} }, { sourceId }); return {};
      } }, localHostId());
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Body of ${slug}` }], { seal: true });
      if (embedded) {
        const sealed = (await readProjectionSnapshot(engine, slug, sourceId))!;
        expect(await installPageEmbeddings(engine, sealed, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Body of ${slug}`, embedding: vector(), model }], signature)).toBe(true);
      }
      // Only embedding effects are due; Git and other effects of these writes wait.
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'embedding'");
      const [effect] = await engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [row.id]);
      const [{ id: pageId }] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      return { sourceId, slug, effectId: effect.id, pageId, requestId: row.id };
    }
    const row = async (effectId: string) => (await engine.executeRaw<Record<string, unknown>>(
      `SELECT state, attempts, error_code, outcome, data, execution_token, claim_expires_at, recovery FROM persistence_effects WHERE id=$1`, [effectId]))[0]!;
    async function drainAll(embed: NonNullable<EffectWorkerOptions['embedding']>['embed']) {
      while (await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 20, embedding: { signature, model, embed } }) >= 20);
    }
    /** Settle every due no-op, then park whatever is left so the next case starts clean. */
    async function reset() {
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE state='queued'");
    }

    check('settles only true no-ops in a mixed queue; the rest still embed', async () => {
      await reset();
      const noop = [await page('mixed/noop-a', true), await page('mixed/noop-b', true)];
      const pending = await page('mixed/pending', false);
      const stale: Record<string, Awaited<ReturnType<typeof page>>> = {};
      for (const kind of ['null-vector', 'text-hash', 'model', 'signature', 'unsealed', 'attempted'] as const) {
        const p = stale[kind] = await page(`mixed/stale-${kind}`, true);
        if (kind === 'null-vector') await engine.executeRaw('UPDATE content_chunks SET embedding=NULL WHERE page_id=$1', [p.pageId]);
        else if (kind === 'text-hash') await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash='stale' WHERE page_id=$1", [p.pageId]);
        else if (kind === 'model') await engine.executeRaw("UPDATE content_chunks SET model='old:model' WHERE page_id=$1", [p.pageId]);
        else if (kind === 'signature') await engine.executeRaw("UPDATE pages SET embedding_signature='old' WHERE id=$1", [p.pageId]);
        else if (kind === 'unsealed') await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [p.pageId]);
        else await engine.executeRaw('UPDATE persistence_effects SET attempts=1 WHERE id=$1', [p.effectId]);
      }
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='embedding' AND state='queued' AND source_id LIKE 'noop-%' AND id=ANY($1::text[]::bigint[])",
        [[...noop, pending, ...Object.values(stale)].map(p => p.effectId)]);
      const gitBefore = await engine.executeRaw<{ id: string; state: string; attempts: number }>("SELECT id::text AS id,state,attempts FROM persistence_effects WHERE kind='git' ORDER BY id");

      expect((await settleNoopEmbeddingEffects(engine, localHostId(), signature)).settled).toBe(2);
      for (const p of noop) expect(await row(p.effectId)).toMatchObject({ state: 'committed', attempts: 1, outcome: {} });
      for (const p of [pending, ...Object.values(stale)]) expect((await row(p.effectId)).state).toBe('queued');
      // The settle never touches another kind.
      expect(await engine.executeRaw("SELECT id::text AS id,state,attempts FROM persistence_effects WHERE kind='git' ORDER BY id")).toEqual(gitBefore);

      // Everything left runs as before: the page without vectors and every stale one embed; the attempted no-op
      // completes through the runner without provider work; the unsealed one waits for its projection.
      const embedded: string[] = [];
      await drainAll(async texts => { embedded.push(...texts); return texts.map(() => vector()); });
      const reembedded = ['mixed/pending', 'mixed/stale-null-vector', 'mixed/stale-text-hash', 'mixed/stale-model', 'mixed/stale-signature'];
      expect(reembedded.filter(slug => !embedded.some(text => text.includes(`Body of ${slug}`)))).toEqual([]);
      expect(embedded.filter(text => /Body of mixed\/(noop-|stale-attempted)/.test(text))).toEqual([]);
      for (const p of [pending, ...Object.values(stale).filter(p => p.slug !== 'mixed/stale-unsealed')]) expect((await row(p.effectId)).state).toBe('committed');
    });

    check('a settled no-op ends with the same row the runner leaves for one', async () => {
      await reset();
      const bulk = await page('rows/bulk', true);
      const slow = await page('rows/slow', true);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now()+interval \'1 hour\' WHERE id=$1', [slow.effectId]);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [bulk.effectId]);
      expect((await settleNoopEmbeddingEffects(engine, localHostId(), signature)).settled).toBe(1);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [slow.effectId]);
      let calls = 0;
      await drainAll(async texts => { calls++; return texts.map(() => vector()); });
      expect(calls).toBe(0);
      const strip = (r: Record<string, unknown>) => ({ ...r, data: { ...(r.data as Record<string, unknown>), page_id: undefined, slug: undefined } });
      expect(strip(await row(bulk.effectId))).toEqual(strip(await row(slow.effectId)));
      const requests = await engine.executeRaw<Record<string, unknown>>(
        'SELECT state, outcome IS NOT NULL AS has_outcome, recovery FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY slug', [[bulk.requestId, slow.requestId]]);
      expect(requests[0]).toEqual(requests[1]);
    });

    check('a request whose only open effect is a no-op embedding finishes the same through either path', async () => {
      await reset();
      const bulk = await page('request/bulk', true);
      const slow = await page('request/slow', true);
      const ids = [bulk.requestId, slow.requestId];
      // Every other effect of both requests runs first, so the embedding effect is each request's only open one.
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=CASE WHEN kind='embedding' THEN now()+interval '1 hour' ELSE now() END WHERE request_id=ANY($1::uuid[])", [ids]);
      await drainAll(async texts => texts.map(() => vector()));
      expect(await engine.executeRaw("SELECT kind FROM persistence_effects WHERE request_id=ANY($1::uuid[]) AND state<>'committed' ORDER BY kind", [ids]))
        .toEqual([{ kind: 'embedding' }, { kind: 'embedding' }]);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [bulk.effectId]);
      expect((await settleNoopEmbeddingEffects(engine, localHostId(), signature)).settled).toBe(1);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [slow.effectId]);
      let calls = 0;
      await drainAll(async texts => { calls++; return texts.map(() => vector()); });
      expect(calls).toBe(0);

      const identity = ['id', 'request_id', 'idempotency_key', 'digest', 'slug', 'source_id', 'source_incarnation', 'sequence', 'principal', 'authority',
        'intent', 'caller_intent'];
      // Times and generated tokens differ between any two requests; every other value must match.
      const opaque = (v: unknown): unknown => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT|^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) ? '<opaque>'
        : Array.isArray(v) ? v.map(opaque) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, opaque(x)])) : v;
      const strip = (r: Record<string, unknown>) => opaque(Object.fromEntries(Object.entries(r).filter(([key]) => !identity.includes(key)))) as Record<string, unknown>;
      const request = async (id: string) => strip((await engine.executeRaw<Record<string, unknown>>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [id]))[0]!);
      const effects = async (id: string) => (await engine.executeRaw<Record<string, unknown>>(
        "SELECT * FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind", [id])).map(e => ({ ...strip(e), data: { ...(e.data as object), page_id: undefined, slug: undefined, relative_path: undefined, expected_hash: undefined } }));
      expect(await request(bulk.requestId)).toEqual(await request(slow.requestId));
      expect(await effects(bulk.requestId)).toEqual(await effects(slow.requestId));
      const progress = async (id: string) => { const p = await getWriteRequestProgress(engine, id); return p && strip(p as unknown as Record<string, unknown>); };
      expect(await progress(bulk.requestId)).toEqual(await progress(slow.requestId));
      // Receipt compaction waits for every effect of a request to commit; both receipts are now eligible.
      await compactWriteReceipts(engine, 0);
      expect(await engine.executeRaw<{ compacted: boolean }>('SELECT compacted FROM persistence_requests WHERE id=ANY($1::uuid[])', [ids]))
        .toEqual([{ compacted: true }, { compacted: true }]);
    });

    check('a backlog that cannot settle is considered once per process, and a new no-op past it still settles', async () => {
      await reset();
      const stale = [await page('cursor/stale-a', false), await page('cursor/stale-b', false)];
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=ANY($1::text[]::bigint[])', [stale.map(p => p.effectId)]);
      const second = await settleNoopEmbeddingEffects(engine, localHostId(), signature);
      expect(second).toMatchObject({ settled: 0, done: true });
      const [{ newest }] = await engine.executeRaw<{ newest: string }>('SELECT max(id)::text AS newest FROM persistence_effects');
      expect(second.cursor.through).toBe(newest);
      // The next drain finds nothing past the cursor and opens no transaction.
      const transaction = engine.transaction.bind(engine);
      let opened = 0;
      engine.transaction = ((fn: never) => { opened++; return transaction(fn); }) as typeof engine.transaction;
      try { expect(await settleNoopEmbeddingEffects(engine, localHostId(), signature, second.cursor)).toEqual({ settled: 0, cursor: second.cursor, done: true }); }
      finally { delete (engine as { transaction?: unknown }).transaction; }
      expect(opened).toBe(0);
      // A stale effect that becomes a no-op behind the cursor is the runner's; a new no-op past it settles here.
      const sealed = (await readProjectionSnapshot(engine, stale[0]!.slug, stale[0]!.sourceId))!;
      expect(await installPageEmbeddings(engine, sealed, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `Body of ${stale[0]!.slug}`, embedding: vector(), model }], signature)).toBe(true);
      const fresh = await page('cursor/fresh', true);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=ANY($1::text[]::bigint[])', [[stale[0]!.effectId, fresh.effectId]]);
      expect(await settleNoopEmbeddingEffects(engine, localHostId(), signature, second.cursor)).toMatchObject({ settled: 1, done: true });
      expect((await row(fresh.effectId)).state).toBe('committed');
      expect((await row(stale[0]!.effectId)).state).toBe('queued');
      // A different signature or write column starts over from the oldest effect.
      expect((await settleNoopEmbeddingEffects(engine, localHostId(), signature, { ...second.cursor, key: 'other' })).settled).toBe(1);
      expect((await row(stale[0]!.effectId)).state).toBe('committed');
    });

    check('a full pass moves the cursor to its last candidate and the next pass continues past it', async () => {
      await reset();
      // Sweep the earlier cases' effects (none due) so the cursor starts at the newest effect.
      let start = await settleNoopEmbeddingEffects(engine, localHostId(), signature);
      while (!start.done) start = await settleNoopEmbeddingEffects(engine, localHostId(), signature, start.cursor);
      expect(start.settled).toBe(0);
      const noops = [await page('paged/a', true), await page('paged/b', true), await page('paged/c', true)];
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=ANY($1::text[]::bigint[])', [noops.map(p => p.effectId)]);
      const first = await settleNoopEmbeddingEffects(engine, localHostId(), signature, start.cursor, 2);
      expect(first).toMatchObject({ settled: 2, done: false, cursor: { through: noops[1]!.effectId } });
      const next = await settleNoopEmbeddingEffects(engine, localHostId(), signature, first.cursor, 2);
      expect(next).toMatchObject({ settled: 1, done: true });
      for (const p of noops) expect((await row(p.effectId)).state).toBe('committed');
    });

    check('a sweep one effect at a time visits every unattempted embedding effect in numeric id order', async () => {
      await reset();
      // The next effect ids cross a power of ten, so a text ordering of ids would visit them out of order.
      await engine.executeRaw(`SELECT setval(pg_get_serial_sequence('persistence_effects','id'),
        (10::numeric ^ ceil(log(10, COALESCE(max(id),0)+20)))::bigint - 10) FROM persistence_effects`);
      for (let i = 0; i < 12; i++) await page(`sweep/n${i}`, false);
      const expected = (await engine.executeRaw<{ id: string }>(
        "SELECT e.id::text AS id FROM persistence_effects e WHERE e.kind='embedding' AND e.state='queued' AND e.attempts=0 AND e.recovery IS NULL ORDER BY e.id")).map(r => r.id);
      // Ids of different lengths: a text ordering would skip some of them.
      expect(new Set(expected.map(id => id.length)).size).toBeGreaterThan(1);
      const seen: string[] = [];
      let pass = await settleNoopEmbeddingEffects(engine, localHostId(), signature, undefined, 1);
      while (!pass.done) { seen.push(pass.cursor.through); pass = await settleNoopEmbeddingEffects(engine, localHostId(), signature, pass.cursor, 1); }
      expect(seen).toEqual(expected);
    });

    check('an effect the cursor passes (not yet due, or locked by another claimer) still commits through the runner', async () => {
      await reset();
      let start = await settleNoopEmbeddingEffects(engine, localHostId(), signature);
      while (!start.done) start = await settleNoopEmbeddingEffects(engine, localHostId(), signature, start.cursor);
      const later = await page('passed/not-due', true);
      const locked = await page('passed/locked', true);
      const settles = await page('passed/settles', true);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=ANY($1::text[]::bigint[])', [[locked.effectId, settles.effectId]]);
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE id=$1", [later.effectId]);
      let pass: Awaited<ReturnType<typeof settleNoopEmbeddingEffects>>;
      if (kind === 'postgres') {
        // Another claimer holds the row while the pass runs; SKIP LOCKED steps over it.
        let release!: () => void;
        let held!: () => void;
        const holding = new Promise<void>(resolve => { held = resolve; });
        const holder = engine.transaction(async tx => {
          await tx.executeRaw('SELECT id FROM persistence_effects WHERE id=$1 FOR UPDATE', [locked.effectId]);
          held();
          await new Promise<void>(resolve => { release = resolve; });
        });
        await holding;
        try { pass = await settleNoopEmbeddingEffects(engine, localHostId(), signature, start.cursor); }
        finally { release(); await holder; }
        expect((await row(locked.effectId)).state).toBe('queued');
      } else {
        // PGLite has one connection, so no second claimer can hold a lock; the not-due case covers the pass.
        await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE id=$1", [locked.effectId]);
        pass = await settleNoopEmbeddingEffects(engine, localHostId(), signature, start.cursor);
        expect((await row(locked.effectId)).state).toBe('queued');
      }
      expect(pass.done).toBe(true);
      expect(BigInt(pass.cursor.through)).toBeGreaterThanOrEqual(BigInt(later.effectId));
      expect((await row(settles.effectId)).state).toBe('committed');
      expect((await row(later.effectId)).state).toBe('queued');
      // Behind the cursor now, both reach the runner and commit there without provider work.
      expect((await settleNoopEmbeddingEffects(engine, localHostId(), signature, pass.cursor)).settled).toBe(0);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=ANY($1::text[]::bigint[])', [[later.effectId, locked.effectId]]);
      let calls = 0;
      await drainAll(async texts => { calls++; return texts.map(() => vector()); });
      expect(calls).toBe(0);
      for (const p of [later, locked]) expect(await row(p.effectId)).toMatchObject({ state: 'committed', attempts: 1, outcome: {} });
    });

    check('the completion model matches the runner for the legacy column and a named column, model names with colons included', async () => {
      expect(embeddingCompletionModel({ name: 'embedding', embeddingModel: undefined } as never, 'acme:embed:v2:1536')).toBe('acme:embed:v2');
      expect(embeddingCompletionModel({ name: 'embedding_voyage', embeddingModel: 'voyage:voyage-3' } as never, 'acme:embed:v2:1536')).toBe('voyage:voyage-3');
      expect(embeddingCompletionModel({ name: 'embedding', embeddingModel: undefined } as never, 'acme:embed:v2:1536', 'explicit:model')).toBe('explicit:model');
    });

    check('a crash inside the settle leaves every row queued and unattempted', async () => {
      await reset();
      const a = await page('crash/a', true);
      const b = await page('crash/b', true);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=ANY($1::text[]::bigint[])', [[a.effectId, b.effectId]]);
      installFaultHook(point => { if (point === 'effect:embedding:settle') throw new Error('crash inside the settle'); });
      await expect(settleNoopEmbeddingEffects(engine, localHostId(), signature)).rejects.toThrow('crash inside the settle');
      installFaultHook(undefined);
      for (const p of [a, b]) expect(await row(p.effectId)).toMatchObject({ state: 'queued', attempts: 0, outcome: null, execution_token: null });
      expect((await settleNoopEmbeddingEffects(engine, localHostId(), signature)).settled).toBe(2);
    });

    check('an archived or replaced source and a deleted page are left for the runner', async () => {
      await reset();
      const archived = await page('guard/archived', true);
      const deleted = await page('guard/deleted', true);
      await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [archived.sourceId]);
      await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE id=$1', [deleted.pageId]);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=ANY($1::text[]::bigint[])', [[archived.effectId, deleted.effectId]]);
      expect((await settleNoopEmbeddingEffects(engine, localHostId(), signature)).settled).toBe(0);
      for (const p of [archived, deleted]) expect((await row(p.effectId)).state).toBe('queued');
    });
  });
}
