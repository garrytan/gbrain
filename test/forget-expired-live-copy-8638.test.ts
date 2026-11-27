/** #8638: the withdrawal result must describe live copies it actually expires, not only the named row. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe(`#8638 expired forget (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({}); await pglite.initSchema();
        engine = pglite; close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close(); });
    const call = (id: number, reason = 'Outdated claim') => dispatchToolCall(engine, 'forget_fact', { id, reason }, { remote: true, sourceId: 'default' });
    const insert = (fact: string, visibility: 'world' | 'private' = 'world') => engine.insertFact({ fact, kind: 'fact', source: 'test', visibility, context: 'Original context' }, { source_id: 'default' });
    const stored = async (id: number) => (await engine.executeRaw<{ expired_at: unknown; context: string }>('SELECT expired_at, context FROM facts WHERE id=$1', [id]))[0]!;

    test('expired id that withdraws a live same-claim copy reports success; its replay stays an expired-only failure without growing context', async () => {
      const claim = 'Prefers jasmine tea expiredcopy8638';
      const old = await insert(claim);
      await engine.expireFact(old.id);
      const live = await insert(claim);
      const hidden = await insert(claim, 'private');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', ['other-8638']);
      const otherSource = await engine.insertFact({ fact: claim, visibility: 'world', source: 'test' }, { source_id: 'other-8638' });
      expect(live.id).not.toBe(old.id);
      expect((await stored(live.id)).expired_at).toBeNull();
      const response = await call(old.id);
      expect((await stored(live.id)).expired_at).not.toBeNull();
      expect((await stored(hidden.id)).expired_at).toBeNull();
      expect((await stored(otherSource.id)).expired_at).toBeNull();
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text)).toMatchObject({ state: 'committed' });
      const original = (await stored(old.id)).context;
      for (let i = 0; i < 2; i++) {
        const replay = await call(old.id, `Repeated reason ${i}`);
        expect(replay.isError).toBe(true);
        expect(JSON.parse(replay.content[0].text).error).toBe('fact_already_expired');
      }
      expect((await stored(old.id)).context).toBe(original);
    }, 60_000);

    test('a live target succeeds once and keeps its first annotation on later expired-only calls', async () => {
      const fact = await insert('Collects vintage postcards live8638');
      const response = await call(fact.id, 'No longer accurate');
      expect(response.isError).not.toBe(true);
      expect((await stored(fact.id)).context).toBe('Original context | forgotten: No longer accurate');
      const replay = await call(fact.id, 'Retry annotation must not be appended');
      expect(replay.isError).toBe(true);
      expect((await stored(fact.id)).context).toBe('Original context | forgotten: No longer accurate');
    }, 60_000);

    test('expired-only refusals still record withdrawal but never append a reason to the expired fact', async () => {
      const claim = 'Keeps paper maps expiredonly8638';
      const old = await insert(claim);
      await engine.expireFact(old.id);
      for (let i = 0; i < 2; i++) {
        const response = await call(old.id);
        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toBe('fact_already_expired');
      }
      expect((await stored(old.id)).context).toBe('Original context');
      expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1 AND fact_hash=gbrain_fact_fingerprint($2)', ['default', claim])).toHaveLength(1);
    }, 60_000);
  });
}
