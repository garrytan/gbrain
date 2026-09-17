import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { getWriteRequest } from '../src/core/persistence/journal.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
const sourceId = 'withdrawal-retry-example';
const home = mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-retry-'));
let closePostgres: (() => Promise<void>) | undefined;
const context = (engine: BrainEngine): OperationContext => ({ engine, sourceId, remote: false, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } });
beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await registerLocalWriter(engine, 'cli');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
}), 120_000);
afterAll(async () => {
  await engines[0]?.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
async function seed(engine: BrainEngine, slug: string) {
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    const page = await tx.putPage(slug, { type: 'note', title: 'Example', compiled_truth: 'Canonical example', timeline: '', frontmatter: {} }, { sourceId });
    const fact = await tx.insertFact({ fact: `Withdraw ${slug}`, source: 'test', entity_slug: slug, visibility: 'world' }, { source_id: sourceId });
    return { page, fact };
  }));
}

for (const boundary of ['admission-counter', 'completed-withdrawal'] as const) {
  test(`${boundary}: retry releases the whole transaction and commits one withdrawal, quota reservation and receipt`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const { page, fact } = await seed(engine, `notes/${boundary}`);
      const local = await registerLocalWriter(engine, 'cli');
      const principal = { kind: 'local_cli' as const, id: local.id };
      const params = { id: String(fact.id), reason: 'Explicit correction', request_id: randomUUID() };
      const [before] = await engine.executeRaw<{ lifetime_ids: string }>("SELECT lifetime_ids::text FROM persistence_counters WHERE key='brain'");
      let injected = false, sourceTransactions = 0, rollbacks = 0;
      const proxy = new Proxy(engine, { get(target, property) {
        if (property === 'transaction') return (run: (tx: BrainEngine) => Promise<any>) => {
          let withdrawal = false;
          const wrap = (tx: BrainEngine): BrainEngine => new Proxy(tx, { get(nested, key) {
            if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<any>) => nested.transaction(child => fn(wrap(child)));
            if (key === 'executeRaw') return async (sql: string, args?: unknown[]) => {
              if (sql === 'SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE') { withdrawal = true; sourceTransactions++; }
              if (!injected && boundary === 'admission-counter' && sql === 'SELECT * FROM persistence_counters WHERE key=$1 FOR UPDATE') {
                injected = true;
                throw Object.assign(new Error('confirmed counter statement abort'), { code: '55P03' });
              }
              return nested.executeRaw(sql, args);
            };
            const value = Reflect.get(nested, key); return typeof value === 'function' ? value.bind(nested) : value;
          } });
          return target.transaction(async tx => {
            const result = await run(wrap(tx));
            if (!injected && boundary === 'completed-withdrawal' && result?.operation === 'forget') {
              injected = true;
              throw Object.assign(new Error('confirmed abort after withdrawal and receipt writes'), { code: '40001' });
            }
            return result;
          }).catch(async error => {
            if (withdrawal && ['55P03', '40001'].includes(error.code)) {
              rollbacks++;
              // This new transaction cannot acquire the source NOWAIT if a
              // failed attempt retained its source guard through retry backoff.
              await target.transaction(async tx => {
                await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE NOWAIT', [sourceId]);
                expect((await tx.readPageSnapshot(page.slug, { sourceId }))!.revision).toBe(page.knowledge_revision!);
                expect((await tx.executeRaw<{ expired_at: Date | null }>('SELECT expired_at FROM facts WHERE id=$1', [fact.id]))[0].expired_at).toBeNull();
                expect(await getWriteRequest(tx, principal, params.request_id)).toBeNull();
              });
            }
            throw error;
          });
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const result = await submitForgetMutation(context(proxy), 'forget', params);
      expect(result).toMatchObject({ state: 'committed', expired: true, request_id: params.request_id });
      expect(sourceTransactions).toBe(2); expect(rollbacks).toBe(1);
      const after = (await engine.readPageSnapshot(page.slug, { sourceId }))!;
      expect(after.revision).not.toBe(page.knowledge_revision!);
      expect(await engine.executeRaw('SELECT fact_hash FROM fact_withdrawals WHERE source_id=$1 AND fact_hash=gbrain_fact_fingerprint($2)', [sourceId, `Withdraw ${page.slug}`])).toHaveLength(1);
      const row = (await getWriteRequest(engine, principal, params.request_id))!;
      expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE request_id=$1::uuid', [row.id])).toHaveLength(3);
      const [counter] = await engine.executeRaw<{ lifetime_ids: string; outstanding_count: string }>("SELECT lifetime_ids::text,outstanding_count::text FROM persistence_counters WHERE key='brain'");
      expect(Number(counter.lifetime_ids)).toBe(Number(before?.lifetime_ids ?? 0) + 1);
      expect(Number(counter.outstanding_count)).toBe(0);
      expect(await submitForgetMutation(context(engine), 'forget', params)).toEqual(result);
      expect((await engine.readPageSnapshot(page.slug, { sourceId }))!.revision).toBe(after.revision);
    }
  }), 120_000);
}

test('Postgres withdrawal retries a real source lock timeout with its original request ID', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const engine = engines.find(candidate => candidate.kind === 'postgres'); if (!engine) return;
  const { fact } = await seed(engine, 'notes/source-contention');
  let held!: () => void;
  const ready = new Promise<void>(resolve => { held = resolve; });
  const blocker = engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]); held();
    await new Promise(resolve => setTimeout(resolve, 1400));
  });
  await ready;
  const params = { id: String(fact.id), request_id: randomUUID() };
  try {
    const result = await submitForgetMutation(context(engine), 'forget', params);
    expect(result).toMatchObject({ state: 'committed', request_id: params.request_id, expired: true });
    expect(await submitForgetMutation(context(engine), 'forget', params)).toEqual(result);
  } finally { await blocker; }
}), 120_000);
