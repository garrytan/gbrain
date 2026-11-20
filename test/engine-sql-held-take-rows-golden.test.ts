/**
 * The fence guard asks `listHeldTakeRows` which takes a takes reconcile may not retire. Both SQL engines send the same
 * statement, that statement is the one trust/fence-guard.ts `heldRows` sent through `executeRaw` before the member
 * existed, byte for byte, and it is pinned.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PGLite and Postgres send byte-identical SQL text and the same bound values for `listHeldTakeRows`; the
 *    text equals the old `heldRows` takes statement rebuilt here from its parts (the rank CASE of `x.trust_tier`, the
 *    named writer bound as `$2::text` or the declared-tier rank, and the open-contest test for `takes`), and matches
 *    test/fixtures/goldens/engine-sql/held-take-rows.json.
 *  - Regression: the move from `executeRaw` to an engine member changes the statement (a different bind order, a lost
 *    `FOR UPDATE`, a rank comparison or contest test that reads another table) without failing a behavior test.
 *  - Why existing coverage misses it: test/engine-sql-sql-text.test.ts pins only the W1 domains and classifies
 *    trust-fence out of scope; test/engine-parity/take-held-rows.test.ts checks answers, not the statement.
 *  - Seam: each engine's private `engineSql` executor is replaced on the instance by a recorder of `executeRaw` (the
 *    path the old statement took, and still takes). PGLite runs the statement; Postgres answers from a stub, no database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { WRITER_RANK_SQL } from '../src/core/engine-sql/trust-fence.ts';
import { trustRankSql } from '../src/core/trust/tier.ts';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';

interface Statement { text: string; params: unknown[] }

const NORMALIZER = defineNormalizer<Statement[]>('held-take-rows-v1', (statements) => statements);

/** The statement `heldRows` sent for takes before `listHeldTakeRows` existed, rebuilt from the same parts. */
function oldHeldTakesText(writer: boolean, pending: boolean): string {
  const contest = `EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'forget'
  AND tp.target_table = 'takes' AND tp.target_id = x.id)`;
  return `SELECT x.id, x.trust_tier FROM takes x WHERE x.id = ANY($1::bigint[])
      AND (${trustRankSql('x.trust_tier')} > ${writer ? trustRankSql('$2::text') : WRITER_RANK_SQL}${pending ? ` OR ${contest}` : ''}) ORDER BY x.id FOR UPDATE`;
}

/** Replace the engine's executor with one that records each statement; `answer` stubs it, else the real one runs. */
function record(engine: object, answer?: unknown[]): Statement[] {
  const seen: Statement[] = [];
  let proto = Object.getPrototypeOf(engine);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'engineSql')) proto = Object.getPrototypeOf(proto);
  const real = answer ? undefined : Object.getOwnPropertyDescriptor(proto, 'engineSql')?.get?.call(engine) as { executeRaw: (t: string, p?: unknown[]) => Promise<unknown[]> } | undefined;
  Object.defineProperty(engine, 'engineSql', {
    configurable: true,
    get: () => ({
      async executeRaw(text: string, params: unknown[] = []) {
        seen.push({ text, params });
        return answer ?? real!.executeRaw(text, params);
      },
    }),
  });
  return seen;
}

let pglite: PGLiteEngine;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
}, 120_000);

afterAll(async () => {
  await pglite.disconnect();
});

describe('listHeldTakeRows SQL text', () => {
  test('PGLite and Postgres send the old heldRows statement, pinned; an empty id list sends nothing', async () => {
    const pgliteEngine = Object.create(pglite) as PGLiteEngine;
    const pgliteSeen = record(pgliteEngine);
    expect(await pgliteEngine.listHeldTakeRows({ ids: [11, 12], writer: 'agent_written', pending: true })).toEqual([]);
    expect(await pgliteEngine.listHeldTakeRows({ ids: [11] })).toEqual([]);
    expect(await pgliteEngine.listHeldTakeRows({ ids: [] })).toEqual([]);

    const postgres = new PostgresEngine();
    const postgresSeen = record(postgres, []);
    await postgres.listHeldTakeRows({ ids: [11, 12], writer: 'agent_written', pending: true });
    await postgres.listHeldTakeRows({ ids: [11] });
    await postgres.listHeldTakeRows({ ids: [] });

    expect(pgliteSeen).toHaveLength(2);
    expect(postgresSeen).toEqual(pgliteSeen);
    expect(pgliteSeen).toEqual([
      { text: oldHeldTakesText(true, true), params: [[11, 12], 'agent_written'] },
      { text: oldHeldTakesText(false, false), params: [[11]] },
    ]);
    expectGolden('engine-sql/held-take-rows', pgliteSeen.map(s => ({ text: s.text, params: s.params.map(p => typeof p) })), NORMALIZER);
  });
});
