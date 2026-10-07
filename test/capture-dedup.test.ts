/**
 * #5888 — automatic capture must not store a second copy of a claim the agent
 * just saved, must never drop a correction, and hot memory injects one line
 * per duplicate group.
 *
 * Protects (each case runs on the unmanaged writer and through the real
 * managed coordinator, PGLite): the reproduced `remember` + writeback pair on
 * two entities ends with one active row; a lagging corpus sweep of the same
 * conversation dedups across lanes; negation and changed-number pairs at an
 * injected cosine of 0.97 both survive; a 0.93 paraphrase is kept and counted
 * in shadow mode only; subject-relative claims for two people stay two
 * facts; the 15-minute window, the visibility rule and fail-open hold.
 * Fails when: dedup stays per entity (2d8801b4), a capture lane drops by
 * cosine, or the dedup read error aborts the write.
 * Existing coverage: none at this boundary (dedup tests were per entity).
 * Seams: chat + embedding transports only. Synthetic names only.
 * Backends: PGLite here; with a safe DATABASE_URL also Postgres
 * (test/e2e/capture-dedup-postgres.test.ts). The managed arm runs on a source
 * with a claimed worktree, so every write goes through the coordinator.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding, MANAGED_WRITER_PROBE_WAIT_MS } from '../src/core/persistence/ownership.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runFactsPipeline, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer, persistenceConsumerStatus } from '../src/core/persistence/service.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { readHeartbeatTail } from '../src/core/context/hook-heartbeat.ts';
import { buildMemoryWritebackCheck } from '../src/commands/doctor/checks/memory-writeback.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { assembleDeltaContext } from '../src/core/context/turn-context.ts';

const DIM = 1536;
const MODEL = 'openai:text-embedding-3-large';
const ENTITIES = [['people/alice-example', 'Alice Example', 'person'], ['people/bob-example', 'Bob Example', 'person'],
  ['companies/acme-example', 'Acme Example', 'company']] as const;
let engine: BrainEngine;
let sourceId: string;
let home: string;
const vectors = new Map<string, number[]>();
let nextAxis = 2;

/** Unit vector at the given cosine to the shared base axis; unknown texts get their own axis. */
function at(cosine: number): number[] {
  const v = Array(DIM).fill(0);
  v[0] = cosine;
  v[nextAxis++] = Math.sqrt(1 - cosine * cosine);
  return v;
}
function embedding(text: string): number[] {
  if (!vectors.has(text)) { const v = Array(DIM).fill(0); v[nextAxis++] = 1; vectors.set(text, v); }
  return vectors.get(text)!;
}
function extracts(facts: Array<{ fact: string; entity: string | null }>) {
  __setChatTransportForTests(async () => ({
    text: JSON.stringify({ facts: facts.map(f => ({ ...f, kind: 'fact', confidence: 1, notability: 'high' })) }),
    blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
  }));
}
/**
 * Waits until this engine's persistence consumer has finished every claimed
 * publication: a receipt reads committed before the publishing task releases
 * the worktree lock, so the next step must not race that tail.
 */
async function settled() {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 10))) {
    const s = persistenceConsumerStatus(engine);
    if (s.active_preparations === 0 && s.active_worktrees === 0) return;
  }
  throw new Error('persistence consumer did not settle');
}
async function capture(source: FactsBackstopCtx['source'], sessionId: string | null, extra: Partial<FactsBackstopCtx> = {}) {
  const r = await runFactsPipeline(`A synthetic turn ${Math.random()}`, { engine, sourceId, sessionId, source, mode: 'inline', remote: false, ...extra });
  await settled();
  return r;
}
async function remember(fact: string, entity: string) {
  const r = await dispatchToolCall(engine, 'remember', { fact, entity, provenance: 'user told me' }, { remote: false, sourceId });
  expect(r.isError).toBeFalsy();
  await settled();
}
async function active() {
  return engine.executeRaw<{ id: number; fact: string; entity_slug: string | null; visibility: string; source: string }>(
    'SELECT id::int AS id,fact,entity_slug,visibility,source FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY id', [sourceId]);
}
async function withGuardPaused(edit: () => Promise<unknown>) {
  const [{ enabled }] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (enabled) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
  try { await edit(); } finally { if (enabled) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
/** Backdates a fixture row; a managed brain's writer guard is paused for the edit, as the connector fixture does. */
async function age(fact: string, minutes: number) {
  await withGuardPaused(() => engine.executeRaw(`UPDATE facts SET created_at=now()-($3::int * interval '1 minute') WHERE source_id=$1 AND fact=$2`,
    [sourceId, fact, minutes]));
  await settled();
}
async function hotFacts() {
  __resetHotMemoryCacheForTests();
  const meta = await getBrainHotMemoryMeta('search', { engine, remote: false, sourceId } as OperationContext);
  return ((meta?.brain_hot_memory as { facts: Array<{ fact: string; entity_slug: string | null; entity_slugs?: string[] }> } | undefined)?.facts) ?? [];
}
/** A fresh source with the three synthetic entity pages; `managed` claims a worktree so writes go through the coordinator. */
async function freshSource(mode: 'unmanaged' | 'managed') {
  sourceId = `cd-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(join(home, 'root-'));
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, mode === 'managed' ? root : null]);
  if (mode === 'managed') {
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
  for (const [slug, title, type] of ENTITIES) {
    const body = `${title} is a synthetic entity.`;
    if (mode === 'unmanaged') { await engine.putPage(slug, { type, title, compiled_truth: body }, { sourceId }); continue; }
    const r = await dispatchToolCall(engine, 'put_page', { slug, content: `---\ntitle: ${title}\ntype: ${type}\n---\n\n${body}\n` }, { remote: false, sourceId });
    expect(r.isError).toBeFalsy();
  }
  await settled();
}

for (const backend of testBackends()) describe(`capture dedup on ${backend}`, () => {
let close: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIM));
  // #6091: capture-lane facts are admitted only while memory.auto_writeback allows the lane.
  await engine.setConfig('memory.auto_writeback', 'all');
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-capture-dedup-'));
  vectors.clear();
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIM, env: { OPENAI_API_KEY: 'synthetic-only' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ values, warnings: [], usage: { tokens: 1 },
    embeddings: values.map(embedding) })) as never);
});
afterEach(async () => {
  __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  rmSync(home, { recursive: true, force: true });
});

for (const mode of ['unmanaged', 'managed'] as const) {
  describe(`capture dedup (${mode})`, () => {
    const run = (fn: () => Promise<void>) => withEnv({ GBRAIN_HOME: home }, async () => { await freshSource(mode); await fn(); });

    if (mode === 'managed') {
      // The preflight waits up to MANAGED_WRITER_PROBE_WAIT_MS for the worktree
      // lock: a writer finishing its previous publication is not a conflict.
      const holdLock = async (ms: number) => {
        const lock = await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 0, undefined, engine);
        expect(lock).not.toBeNull();
        return { released: new Promise<void>(resolve => setTimeout(() => { void lock!.release().then(resolve); }, ms)) };
      };
      test('the fact preflight waits out a writer that releases within the bound', () => run(async () => {
        const { released } = await holdLock(200);
        extracts([{ fact: 'Bob Example owns the Acme Example launch checklist', entity: 'people/bob-example' }]);
        expect(await capture('hook:writeback', 'sess-lock')).toMatchObject({ inserted: 1 });
        await released;
      }), 60_000);
      test('a writer busy past the bound still refuses with writer_lock_unavailable', () => run(async () => {
        const { released } = await holdLock(MANAGED_WRITER_PROBE_WAIT_MS + 1500);
        extracts([{ fact: 'Bob Example owns the Acme Example budget review', entity: 'people/bob-example' }]);
        await expect(capture('hook:writeback', 'sess-lock-2')).rejects.toMatchObject({ code: 'writer_lock_unavailable' });
        await released;
      }), 60_000);
    }

    test('remember then a writeback of the same claim on another entity ends with one active row and one hot fact', () => run(async () => {
      const claim = 'Alice Example will lead the Acme Example renewal in November';
      await remember(claim, 'people/alice-example');
      extracts([{ fact: claim, entity: 'companies/acme-example' }]);
      const r = await capture('hook:writeback', 'sess-1');
      expect(r).toMatchObject({ inserted: 0, duplicate: 1 });
      expect((await active()).map(f => [f.entity_slug, f.visibility])).toEqual([['people/alice-example', 'world']]);
      expect((await hotFacts()).map(f => f.entity_slug)).toEqual(['people/alice-example']);
      expect((await readHeartbeatTail(50)).filter(e => e.event === 'writeback_dedup').map(e => [e.reason, e.duplicate]))
        .toEqual([['hook:writeback', 1]]);
      const check = await buildMemoryWritebackCheck(engine);
      expect(check.details).toMatchObject({ cross_lane_duplicates_7d: 1, near_duplicates_shadow_7d: 0 });
    }), 60_000);

    test('the turn time anchors the window: a late sweep of a turn written next to remember still dedups', () => run(async () => {
      const claim = 'Alice Example signed the Acme Example contract';
      await remember(claim, 'people/alice-example');
      await age(claim, 120);
      extracts([{ fact: claim, entity: 'companies/acme-example' }]);
      expect(await capture('hook:writeback', 'sess-2', { turnAt: new Date(Date.now() - 115 * 60_000) })).toMatchObject({ inserted: 0, duplicate: 1 });
      expect(await capture('hook:writeback', 'sess-2')).toMatchObject({ inserted: 1, duplicate: 0 });
    }), 60_000);

    test('a corpus sweep two hours after writeback of the same conversation dedups across lanes; another conversation does not', () => run(async () => {
      const claim = 'Alice Example joined the Acme Example board';
      extracts([{ fact: claim, entity: 'people/alice-example' }]);
      expect(await capture('hook:writeback', 'sess-9')).toMatchObject({ inserted: 1 });
      await age(claim, 120);
      extracts([{ fact: claim, entity: 'companies/acme-example' }]);
      expect(await capture('sweep:corpus', 'sweep:corpus:sess-9.txt')).toMatchObject({ inserted: 0, duplicate: 1 });
      expect(await capture('sweep:corpus', 'sweep:corpus:sess-other.txt')).toMatchObject({ inserted: 1, duplicate: 0 });
      expect((await active()).length).toBe(2);
    }), 60_000);

    test('negation and changed-number pairs at cosine 0.97 on one entity both survive', () => run(async () => {
      const pairs = [['Alice Example is moving to NYC', 'Alice Example is not moving to NYC'], ['Acme Example MRR is $50k', 'Acme Example MRR is $60k']];
      for (const [first, second] of pairs) {
        vectors.set(first, at(1));
        vectors.set(second, at(0.97));
        extracts([{ fact: first, entity: 'companies/acme-example' }]);
        expect(await capture('hook:writeback', 'sess-3')).toMatchObject({ inserted: 1 });
        extracts([{ fact: second, entity: 'companies/acme-example' }]);
        expect(await capture('hook:writeback', 'sess-3')).toMatchObject({ inserted: 1, duplicate: 0 });
      }
      expect((await active()).map(f => f.fact)).toEqual(pairs.flat());
      if (mode === 'managed') {
        const published = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1
          AND operation='extract_facts' AND state='committed' AND intent->>'kind'='managed_facts_entity'`, [sourceId]);
        expect(published[0].n).toBe(4);
      }
      expect((await readHeartbeatTail(50)).filter(e => e.event === 'writeback_dedup')).toEqual([]);
    }), 60_000);

    test('a same-entity paraphrase at cosine 0.93 is kept and counted in shadow mode only', () => run(async () => {
      vectors.set('Alice Example prefers async updates', at(1));
      vectors.set('Alice Example likes asynchronous updates', at(0.93));
      extracts([{ fact: 'Alice Example prefers async updates', entity: 'people/alice-example' }]);
      await capture('hook:compact', 'sess-4');
      extracts([{ fact: 'Alice Example likes asynchronous updates', entity: 'people/alice-example' }]);
      expect(await capture('hook:compact', 'sess-4')).toMatchObject({ inserted: 1, duplicate: 0 });
      expect((await active()).length).toBe(2);
      expect((await readHeartbeatTail(50)).filter(e => e.event === 'writeback_dedup').map(e => [e.reason, e.duplicate, e.near_duplicate]))
        .toEqual([['hook:compact', 0, 1]]);
      expect((await buildMemoryWritebackCheck(engine)).details).toMatchObject({ cross_lane_duplicates_7d: 0, near_duplicates_shadow_7d: 1 });
    }), 60_000);

    test('a subject-relative claim for two people in one session stays two facts', () => run(async () => {
      extracts([{ fact: 'Prefers email', entity: 'people/alice-example' }, { fact: 'Prefers email', entity: 'people/bob-example' }]);
      expect(await capture('hook:writeback', 'sess-5')).toMatchObject({ inserted: 2, duplicate: 0 });
      extracts([{ fact: 'Prefers email', entity: 'people/bob-example' }]);
      expect(await capture('hook:writeback', 'sess-5')).toMatchObject({ inserted: 0, duplicate: 1 });
      expect((await active()).map(f => f.entity_slug)).toEqual(['people/alice-example', 'people/bob-example']);
      expect((await hotFacts()).length).toBe(2);
    }), 60_000);

    test('visibility and time bounds: world candidates ignore private facts; a different session 16 minutes later is kept', () => run(async () => {
      const claim = 'Bob Example runs the Acme Example offsite';
      extracts([{ fact: claim, entity: 'people/bob-example' }]);
      expect(await capture('hook:writeback', 'sess-6')).toMatchObject({ inserted: 1 });
      expect(await capture('hook:writeback', 'sess-7', { visibility: 'world' })).toMatchObject({ inserted: 1, duplicate: 0 });
      const later = 'Bob Example owns the Acme Example budget';
      await remember(later, 'people/bob-example');
      await age(later, 16);
      extracts([{ fact: later, entity: 'people/bob-example' }]);
      expect(await capture('hook:writeback', 'sess-8')).toMatchObject({ inserted: 1, duplicate: 0 });
      expect((await active()).map(f => [f.fact === claim, f.visibility])).toEqual([[true, 'private'], [true, 'world'], [false, 'world'], [false, 'private']]);
    }), 60_000);

    test('a dedup read failure inserts the candidate and warns with the lane', () => run(async () => {
      const claim = 'Alice Example reviews the Acme Example budget';
      await remember(claim, 'people/alice-example');
      extracts([{ fact: claim, entity: 'companies/acme-example' }]);
      // Transaction handles inherit from the engine, so the wrapper keeps `this`.
      const original = Object.getPrototypeOf(engine).executeRaw as BrainEngine['executeRaw'];
      const warnings: string[] = [];
      const warn = console.warn;
      engine.executeRaw = function (this: BrainEngine, sql: string, ...rest: unknown[]) {
        if (sql.includes('gbrain_fact_fingerprint($3) AND expired_at IS NULL')) return Promise.reject(new Error('forced read failure'));
        return (original as (...args: unknown[]) => Promise<unknown>).call(this, sql, ...rest);
      } as typeof engine.executeRaw;
      console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
      try {
        expect(await capture('hook:writeback', 'sess-10')).toMatchObject({ inserted: 1, duplicate: 0 });
      } finally {
        delete (engine as { executeRaw?: unknown }).executeRaw;
        console.warn = warn;
      }
      expect(warnings.some(w => w.includes('capture dedup read failed: lane=hook:writeback'))).toBe(true);
      expect((await active()).length).toBe(2);
    }), 60_000);

    test('explicit remember is never dropped; hot memory collapses the identical pair (accepted residual S2)', () => run(async () => {
      const claim = 'Alice Example chairs the Acme Example review';
      extracts([{ fact: claim, entity: 'people/alice-example' }]);
      await capture('hook:writeback', 'sess-11');
      await remember(claim, 'people/alice-example');
      expect((await active()).map(f => f.visibility)).toEqual(['private', 'world']);
      const hot = await hotFacts();
      expect(hot.map(f => [f.fact, f.entity_slug])).toEqual([[claim, 'people/alice-example']]);
    }), 60_000);
  });
}

describe('hot memory collapse (V2)', () => {
  const insert = (fact: string, entity_slug: string) => engine.insertFact({ fact, entity_slug, source: 'fixture', visibility: 'world' }, { source_id: sourceId });

  test('an identical claim on two entities that names one of them injects once with both labels; distinct facts still fill topK', () => withEnv({ GBRAIN_HOME: home }, async () => {
    await freshSource('unmanaged');
    const claim = 'Alice Example will lead the Acme Example renewal in November';
    await insert(claim, 'people/alice-example');
    const newest = await insert(claim, 'companies/acme-example');
    await insert('Prefers email', 'people/alice-example');
    await insert('Prefers email', 'people/bob-example');
    for (let i = 1; i <= 3; i++) await insert(`Distinct synthetic fact number ${i}`, 'people/bob-example');
    __resetHotMemoryCacheForTests();
    const meta = await getBrainHotMemoryMeta('search', { engine, remote: true, sourceId } as OperationContext, { topK: 6 });
    const facts = (meta!.brain_hot_memory as { facts: Array<{ id: number; fact: string; entity_slug: string; entity_slugs?: string[] }> }).facts;
    expect(facts.length).toBe(6);
    const renewal = facts.filter(f => f.fact === claim);
    expect(renewal).toEqual([expect.objectContaining({ id: newest.id, entity_slug: 'companies/acme-example', entity_slugs: ['companies/acme-example', 'people/alice-example'] })]);
    expect(facts.filter(f => f.fact === 'Prefers email').map(f => [f.entity_slug, f.entity_slugs])).toEqual([['people/bob-example', undefined], ['people/alice-example', undefined]]);
    const delta = await assembleDeltaContext(engine, { sourceId, since: new Date(Date.now() - 60_000).toISOString() } as never);
    expect(delta.facts!.filter(f => f.fact === claim).map(f => f.entity_slugs)).toEqual([['companies/acme-example', 'people/alice-example']]);
  }), 60_000);
});
});
