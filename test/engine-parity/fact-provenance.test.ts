/**
 * BrainEngine parity: the stored provenance (`facts.source`) that context_pack and delta attach to each fact they
 * deliver (ops/facts.ts `withProvenance`), which used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) reads the same `source` for the named facts of one source: a repeated id answers
 *    once, an id of another source or with no row answers nothing, and the pack/delta step (`withProvenance`) gives
 *    each delivered fact the provenance its write stored.
 *  - Regression: an engine that cannot serve the read leaves `provenance` null on every delivered fact (the read is
 *    fail-soft), so a Rust brain's delta and context_pack drop what `remember --provenance` wrote without an error.
 *  - Why existing coverage misses it: test/context-pack-fact-traceability.test.ts runs on PGLite only, and the Rust
 *    arm's refusal of the raw read is swallowed by the fail-soft catch, so no case saw it.
 *  - Seam: the member on the engine handle and `withProvenance`, the step context_pack and delta both call. The whole
 *    delta operation is not the seam: on a Rust brain it reaches page and fact list reads this file does not cover.
 *    Fact ids are named by fact text.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withProvenance } from '../../src/core/ops/facts.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms, sorted } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';

async function seed(engine: BrainEngine) {
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'Alice.', timeline: '' });
  const rows = [
    { fact: 'Alice leads platform', source: 'fence' },
    { fact: 'Alice moved to Lisbon', source: 'mcp:remember' },
    { fact: 'Alice prefers mornings', source: 'notes from a call' },
  ];
  await engine.insertFacts(rows.map((r, i) => ({
    ...r, row_num: i + 1, kind: 'fact', visibility: 'world', entity_slug: 'people/alice-example',
    source_markdown_slug: 'people/alice-example', valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
  })) as never, { source_id: SRC });
  const facts = await engine.listFactsByEntity(SRC, 'people/alice-example');
  return new Map(facts.map((f) => [Number(f.id), f.fact]));
}

describe('engine parity: fact provenance', () => {
  parityTest(
    'listFactProvenance reads the stored source of the named facts of one source',
    { methods: ['insertFacts', 'listFactsByEntity', 'listFactProvenance'] },
    async (engine) => {
      const names = await seed(engine);
      const ids = [...names.keys()];
      const name = (id: number) => names.get(id) ?? '<unknown-id>';
      // The member answers `id` as a number or a numeric string (a bigint) and `source` as null when the fact has none; compare by number.
      const view = (rows: Array<{ id: number | string; source: string | null }>) => sorted(rows.map((r) => ({ fact: name(Number(r.id)), source: r.source })), (r) => r.fact);
      const all = await engine.listFactProvenance(SRC, [...ids, ids[0]!, Math.max(...ids) + 1000]);
      expect(all.length).toBe(3);
      expect(all.every((r) => Number.isSafeInteger(Number(r.id)))).toBe(true);
      return {
        all: view(all),
        one: view(await engine.listFactProvenance(SRC, [ids[1]!])),
        otherSource: await engine.listFactProvenance('other', ids),
        none: await engine.listFactProvenance(SRC, []),
      };
    },
  );

  parityTest(
    'withProvenance gives each delivered fact the provenance its write stored',
    { methods: ['insertFacts', 'listFactsByEntity', 'listFactProvenance'] },
    async (engine) => {
      const names = await seed(engine);
      const delivered = [...names].map(([id, fact]) => ({ id, fact }));
      const missing = { id: Math.max(...names.keys()) + 1000, fact: '<no row>' };
      const res = await withProvenance(engine, SRC, [...delivered, missing]);
      const facts = sorted(res.map((f) => ({ fact: f.fact, provenance: f.provenance })), (f) => f.fact);
      expect(facts.map((f) => f.provenance).sort()).toEqual(['fence', 'mcp:remember', 'notes from a call', null]);
      return { facts, empty: await withProvenance(engine, SRC, []) };
    },
  );
});
