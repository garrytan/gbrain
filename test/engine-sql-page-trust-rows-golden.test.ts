/**
 * `readPageTrustRows` is the read the trust stamp, belief history and the proactive labels (`gbrain delta`, the turn
 * context, the retrieval reflex: eligibility/activation.ts pageActivationVerdicts) make for a page's tier, origin,
 * activation flag and guest flag. Both SQL engines send the same statements, and those statements are pinned.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PGLite and Postgres send byte-identical SQL text and the same bound value types for `readPageTrustRows`
 *    by id, by live key, by key with deleted pages, and on a brain with no guest_sources table (the config-only retry),
 *    and that text matches test/fixtures/goldens/engine-sql/page-trust-rows.json.
 *  - Regression: an engine that inlines its own copy of the page trust read (the raw `executeRaw` pageActivationVerdicts
 *    used to send) drifts from the other engine or from the activation predicate (`activationSuppressedSql`) without a
 *    behavior test noticing, because the answers on a fixture can still agree.
 *  - Why existing coverage misses it: test/engine-sql-sql-text.test.ts pins only the W1 domains and classifies
 *    cli-import-reads out of scope; test/engine-parity/cli-reads-import.test.ts checks answers, not the statements.
 *  - Seam: each engine's private `engineSql` executor is replaced on the instance by a recorder. PGLite runs the
 *    statements; Postgres answers from a stub, no database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { PageTrustLookup } from '../src/core/engine.ts';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';

interface Statement { text: string; params: string[] }

const NORMALIZER = defineNormalizer<Record<string, Statement[]>>('page-trust-rows-v1', (cases) => cases);

const MISSING_GUEST_SOURCES = Object.assign(new Error('relation "guest_sources" does not exist'), { code: '42P01' });

/** Replace the engine's executor with one that records each statement; `answer` stubs it, else the real one runs. */
function record(engine: object, opts: { answer?: unknown[]; noGuestTable?: boolean } = {}): Statement[] {
  const seen: Statement[] = [];
  let proto = Object.getPrototypeOf(engine);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'engineSql')) proto = Object.getPrototypeOf(proto);
  const real = opts.answer ? undefined : Object.getOwnPropertyDescriptor(proto, 'engineSql')?.get?.call(engine) as { executeRaw: (t: string, p?: unknown[]) => Promise<unknown[]> } | undefined;
  Object.defineProperty(engine, 'engineSql', {
    configurable: true,
    get: () => ({
      async executeRaw(text: string, params: unknown[] = []) {
        seen.push({ text, params: params.map(p => (Array.isArray(p) ? `${typeof p[0]}[]` : typeof p)) });
        if (opts.noGuestTable && text.includes('guest_sources')) throw MISSING_GUEST_SOURCES;
        return opts.answer ?? real!.executeRaw(text, params);
      },
    }),
  });
  return seen;
}

const LOOKUPS: Record<string, PageTrustLookup> = {
  byId: { ids: [1] },
  byLiveKey: { keys: [{ source_id: 'default', slug: 'notes/trust-alice-example' }] },
  byKeyWithDeleted: { keys: [{ source_id: 'default', slug: 'notes/trust-alice-example' }], includeDeleted: true },
  byIdAndKey: { ids: [1], keys: [{ source_id: 'default', slug: 'notes/trust-alice-example' }] },
};

let pglite: PGLiteEngine;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  await pglite.putPage('notes/trust-alice-example', { type: 'note', title: 'a', compiled_truth: 'x', frontmatter: {} });
}, 120_000);

afterAll(async () => {
  await pglite.disconnect();
});

async function capture(make: () => object, answer: boolean): Promise<Record<string, Statement[]>> {
  const out: Record<string, Statement[]> = {};
  for (const [name, lookup] of Object.entries(LOOKUPS)) {
    const engine = make();
    const seen = record(engine, answer ? { answer: [] } : {});
    await (engine as PGLiteEngine).readPageTrustRows(lookup);
    out[name] = seen;
  }
  const engine = make();
  const seen = record(engine, { answer: answer ? [] : undefined, noGuestTable: true });
  await (engine as PGLiteEngine).readPageTrustRows(LOOKUPS.byLiveKey!);
  out.byLiveKeyWithoutGuestTable = seen;
  return out;
}

describe('readPageTrustRows SQL text', () => {
  test('PGLite and Postgres send the same pinned statements', async () => {
    const pgliteSeen = await capture(() => Object.create(pglite), false);
    const postgresSeen = await capture(() => new PostgresEngine(), true);

    expect(Object.fromEntries(Object.entries(pgliteSeen).map(([k, v]) => [k, v.length]))).toEqual({
      byId: 1, byLiveKey: 1, byKeyWithDeleted: 1, byIdAndKey: 2, byLiveKeyWithoutGuestTable: 2,
    });
    expect(postgresSeen).toEqual(pgliteSeen);
    expect(pgliteSeen.byLiveKey![0]!.text).toContain('pages.deleted_at IS NULL');
    expect(pgliteSeen.byKeyWithDeleted![0]!.text).not.toContain('deleted_at IS NULL');
    expect(pgliteSeen.byLiveKeyWithoutGuestTable![1]!.text).not.toContain('guest_sources');
    expectGolden('engine-sql/page-trust-rows', pgliteSeen, NORMALIZER);
  });
});
