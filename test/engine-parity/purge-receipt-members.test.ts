/**
 * BrainEngine parity — the two reads the page purge's receipt and verification make on the brain's own tables: whether a relation
 * exists (src/core/persistence/rebuildable-cache.ts relationExists, which decides whether the receipt names a missing query cache)
 * and the state of a request's derivation sweep (src/core/page-body/segment-derive.ts derivationPurgeState, which decides whether
 * the purge completes or stays incomplete).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: relationExists answers true for the brain's own tables and views (the query cache the receipt looks for among
 *    them), false for a name the brain has no relation of, and the same for a name qualified by the public schema and for the
 *    unquoted spelling in capitals; derivationPurgeState answers null for a request with no recorded sweep: each answers the same
 *    on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that cannot answer relationExists makes the receipt claim a missing query cache (or fail to name a
 *    really missing one), and one that cannot read the sweep state lets a purge report complete while a derivation sweep is still
 *    recorded. The Rust engine has no SQL, so each read has to exist as a typed member it can serve.
 *  - Why existing coverage misses it: both reads ran through `executeRaw`, which the parity cases cannot call (D18), so only the
 *    PGLite and Postgres purge suites (test/purge-missing-cache-6911.test.ts, the derivation purge cases) exercised them.
 *  - Seam: the exported helpers of the two files above, called with the arm's engine. A recorded sweep has no typed writer, so the
 *    sweep answer is null on every arm; the PGLite and Postgres derivation suites seed the stalled and pending records.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { relationExists } from '../../src/core/persistence/rebuildable-cache.ts';
import { derivationPurgeState } from '../../src/core/page-body/segment-derive.ts';

const { parityTest } = parityArms(testBackends());

const NO_REQUEST = '00000000-0000-4000-8000-000000000000';

describe('engine parity: the receipt reads of a page purge', () => {
  parityTest('relationExists answers true for the brain\'s tables and views, false for a name it has none of, and reads the schema-qualified and capitalised spellings the same', {
    methods: ['relationExists'],
  }, async (engine) => {
    const names = ['query_cache', 'pages', 'page_links', 'persistence_requests', 'public.pages', 'PAGES', 'no_such_table', 'public.no_such_table', ''];
    const answers: Record<string, boolean> = {};
    for (const name of names) answers[name] = await relationExists(engine, name);
    expect(answers.query_cache).toBe(true);
    expect(answers.no_such_table).toBe(false);
    return answers;
  });

  parityTest('derivationPurgeState answers null for a request with no recorded sweep', {
    methods: ['readDerivationPurgeState'],
  }, async (engine) => {
    const none = await derivationPurgeState(engine, NO_REQUEST);
    expect(none).toBeNull();
    return { none };
  });

  parityTest('the members answer directly: relationExists for a table, a view and an unknown name, readDerivationPurgeState for an unknown request', {
    methods: ['relationExists', 'readDerivationPurgeState'],
  }, async (engine) => {
    const answers = {
      table: await engine.relationExists('pages'),
      view: await engine.relationExists('page_links'),
      cache: await engine.relationExists('query_cache'),
      unknown: await engine.relationExists('no_such_table'),
      schema: await engine.relationExists('no_such_schema.pages'),
      sweep: await engine.readDerivationPurgeState(NO_REQUEST),
    };
    expect(answers.table).toBe(true);
    expect(answers.unknown).toBe(false);
    return answers;
  });
});
