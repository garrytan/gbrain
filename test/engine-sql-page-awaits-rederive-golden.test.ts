/**
 * get_page and fetch ask `pageAwaitsRederive` whether a purge hid a page until it is derived again. Both SQL engines
 * send the same statement, and that statement is pinned.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PGLite and Postgres send byte-identical SQL text and the same bound values for `pageAwaitsRederive`,
 *    and that text matches test/fixtures/goldens/engine-sql/page-awaits-rederive.json.
 *  - Regression: an engine that inlines its own copy of the purge check (the raw `executeRaw` get_page used to send
 *    from src/core/ops/get-page-projection.ts) drifts from the other engine, or from the eligibility predicate
 *    (`rederiveHiddenSql`), without failing a behavior test that seeds no `needs_rederive` row.
 *  - Why existing coverage misses it: test/engine-sql-sql-text.test.ts pins only the 12 W1 domains and classifies
 *    trust-tier-reads out of scope; test/engine-parity/trust-tier-reads.test.ts checks answers, not the statement.
 *  - Seam: a recording wrapper over each engine's own `executeRaw`; Postgres answers from a stub, no database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';

interface Statement { text: string; params: unknown[] }

const NORMALIZER = defineNormalizer<Statement[]>('page-awaits-rederive-v1', (statements) => statements);

function record(engine: { executeRaw: (text: string, params?: unknown[]) => Promise<unknown[]> }, answer?: unknown[]): Statement[] {
  const seen: Statement[] = [];
  const real = engine.executeRaw.bind(engine);
  engine.executeRaw = async (text: string, params: unknown[] = []) => {
    seen.push({ text, params });
    return answer ?? real(text, params);
  };
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

describe('pageAwaitsRederive SQL text', () => {
  test('PGLite and Postgres send the same pinned statement', async () => {
    const page = await pglite.putPage('notes/rederive-alice-example', { type: 'note', title: 'a', compiled_truth: 'x', frontmatter: {} });
    const pgliteSeen = record(pglite as never);
    expect(await pglite.pageAwaitsRederive(Number(page.id))).toBe(false);

    const postgres = new PostgresEngine();
    const postgresSeen = record(postgres as never, [{ n: 0 }]);
    expect(await postgres.pageAwaitsRederive(Number(page.id))).toBe(false);

    expect(pgliteSeen).toHaveLength(1);
    expect(postgresSeen).toEqual(pgliteSeen);
    expect(pgliteSeen[0]!.text).toContain('needs_rederive');
    expectGolden('engine-sql/page-awaits-rederive', pgliteSeen.map(s => ({ text: s.text, params: s.params.map(p => typeof p) })), NORMALIZER);
  });
});
