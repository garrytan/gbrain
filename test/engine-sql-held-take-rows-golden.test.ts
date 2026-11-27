/**
 * The fence guard asks `listHeldRows` (table `takes`) which takes a takes reconcile may not retire. Both SQL engines send
 * the same statement, rebuilt here from its parts (the page-scoped form of the statement trust/fence-guard.ts `heldRows`
 * once sent through `executeRaw`), and it is pinned.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PGLite and Postgres send byte-identical SQL text and the same bound values for `listHeldRows` on `takes`;
 *    the text equals the `heldRows` takes statement rebuilt here from its parts (the page scope `x.page_id`, the rank CASE
 *    of `x.trust_tier`, the named writer bound once as `$1::text` and ranked as `w.writer` or the declared-tier rank, the
 *    open-contest test for `takes`, and `FOR UPDATE OF x`), and matches
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
import { renderFragment, type SqlFragment } from '../src/core/engine-sql/fragment.ts';
import { OPEN_CONTEST_SQL, WRITER_RANK_SQL } from '../src/core/engine-sql/trust-fence.ts';
import { trustRankSql } from '../src/core/trust/tier.ts';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';

interface Statement { text: string; params: unknown[] }

const NORMALIZER = defineNormalizer<Statement[]>('held-take-rows-v1', (statements) => statements);

/** The statement `listHeldRows` sends for takes, rebuilt from its parts. */
function heldTakesText(writer: boolean, pending: boolean): string {
  const rank = trustRankSql('x.trust_tier');
  const bar = writer ? trustRankSql('w.writer') : WRITER_RANK_SQL;
  const from = writer ? ' CROSS JOIN (SELECT $1::text AS writer) w' : '';
  const page = writer ? 2 : 1;
  return `SELECT x.id, x.trust_tier FROM takes x${from}
      WHERE x.page_id = $${page} AND x.id = ANY($${page + 1}::bigint[]) AND (${rank} > ${bar}${pending ? ` OR ${OPEN_CONTEST_SQL('takes')}` : ''}) ORDER BY x.id FOR UPDATE OF x`;
}

type FragmentRun = (fragment: SqlFragment) => Promise<{ rows: unknown[] }>;

/** Replace the engine's executor with one that records each rendered fragment; `answer` stubs it, else the real one runs. */
function record(engine: object, answer?: unknown[]): Statement[] {
  const seen: Statement[] = [];
  let proto = Object.getPrototypeOf(engine);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'engineSql')) proto = Object.getPrototypeOf(proto);
  const real = answer ? undefined : Object.getOwnPropertyDescriptor(proto, 'engineSql')?.get?.call(engine) as { run: FragmentRun } | undefined;
  Object.defineProperty(engine, 'engineSql', {
    configurable: true,
    get: () => ({
      async run(fragment: SqlFragment) {
        seen.push(renderFragment(fragment));
        return answer ? { rows: answer } : real!.run(fragment);
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

describe('listHeldRows SQL text (takes)', () => {
  test('PGLite and Postgres send the heldRows statement, pinned; an empty id list sends nothing', async () => {
    const pgliteEngine = Object.create(pglite) as PGLiteEngine;
    const pgliteSeen = record(pgliteEngine);
    expect(await pgliteEngine.listHeldRows({ table: 'takes', pageId: 7, ids: [11, 12], writer: 'agent_written', pending: true })).toEqual([]);
    expect(await pgliteEngine.listHeldRows({ table: 'takes', pageId: 7, ids: [11] })).toEqual([]);
    expect(await pgliteEngine.listHeldRows({ table: 'takes', pageId: 7, ids: [] })).toEqual([]);

    const postgres = new PostgresEngine();
    const postgresSeen = record(postgres, []);
    await postgres.listHeldRows({ table: 'takes', pageId: 7, ids: [11, 12], writer: 'agent_written', pending: true });
    await postgres.listHeldRows({ table: 'takes', pageId: 7, ids: [11] });
    await postgres.listHeldRows({ table: 'takes', pageId: 7, ids: [] });

    expect(pgliteSeen).toHaveLength(2);
    expect(postgresSeen).toEqual(pgliteSeen);
    expect(pgliteSeen).toEqual([
      { text: heldTakesText(true, true), params: ['agent_written', 7, [11, 12]] },
      { text: heldTakesText(false, false), params: [7, [11]] },
    ]);
    expectGolden('engine-sql/held-take-rows', pgliteSeen.map(s => ({ text: s.text, params: s.params.map(p => typeof p) })), NORMALIZER);
  });
});
