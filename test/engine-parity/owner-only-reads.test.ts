/**
 * BrainEngine parity — owner-only sources under `excludePrivate` (src/core/access/owner-only.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a page read or fact read under `excludePrivate` is a non-owner read, so it drops what the owner-only
 *    conjunct of the page and fact policies (`ownerOnlyAllowedSql`, `ownerOnlyFactSql`) hides, before it limits, on
 *    every engine arm. Outside an engine scope the policy renders the fail-closed form: while the brain holds an
 *    owner-only source, every row is hidden. In an engine scope that recorded schema v320 or later it renders the
 *    lineage form: a page or fact in an owner-only source, and a concept or question with an input page there. The
 *    scoped case records the current schema version on every arm, as the CLI's connect gate (hasPendingMigrations) does
 *    on a current brain; the harness's reset brains do not keep the `version` config row.
 *  - Regression: the Rust page policy (`page_hidden`) and fact policy had no owner-only rule, so a Rust read served
 *    under `excludePrivate` showed other people's messages from an owner-only source to a non-owner caller.
 *  - Why existing coverage misses it: test/imessage-owner-only.test.ts runs the SQL engines only, and the parity
 *    privacy cases (private-page-reads, facts) create no owner-only source.
 *  - Seam: none for the first three cases. Real engines, typed methods only; the owner-only source is a harness
 *    fixture. The fourth case sends the lineage form under master's wire name: master's member
 *    (src/core/rust-engine/store-members/private-provenance.ts, `StoreOwnerOnly`) names it `lineage` where the trunk's
 *    names it `fn`. On the Rust arm only, it wraps the open store's native brain and renames `ownerOnly: 'fn'` to
 *    `'lineage'` in what the members send, so the store reads exactly what master's member sends it. The SQL arms run
 *    the same reads unwrapped. A store that knows only `fn` rejected `lineage` with `invalid_argument`, so every
 *    privacy-filtered page, fact, keyword and vector read failed on a brain served by master's members.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { basisEmbedding, createSource, parityArms, sorted, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { installChunks, chunk } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const OWN = 'own-texts';
const at = (iso: string) => new Date(iso);

/**
 * Pages in `default` and in the owner-only source `own-texts`, named so that by slug the owner-only page and the concept
 * synthesized from it sort first: a read that limits before it filters returns them.
 */
async function fixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, OWN, { owner_only: true });
  const put = (slug: string, type: string, sourceId = 'default', frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter }, { sourceId });
  await put('a/thread', 'note', OWN);
  await put('a/thread', 'note');
  await put('b/from-texts', 'concept');
  await put('b/question-from-texts', 'question', 'default', { visibility: 'world' });
  await put('c/open', 'note');
  await put('d/plain-concept', 'concept');
  await engine.addLink('b/from-texts', 'a/thread', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: OWN });
  await engine.addLink('b/question-from-texts', 'a/thread', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: OWN });
  await engine.insertFact({ fact: 'From the texts', entity_slug: null, source: 'mcp:remember', valid_from: at('2026-01-02T00:00:00Z') }, { source_id: OWN });
  await engine.insertFact({ fact: 'From the notes', entity_slug: null, source: 'mcp:remember', valid_from: at('2026-01-02T00:00:00Z') }, { source_id: 'default' });
}

const ids = (rows: Array<{ source_id: string; slug: string }>) => rows.map((r) => `${r.source_id}:${r.slug}`);

async function reads(engine: BrainEngine) {
  const since = at('2020-01-01T00:00:00Z');
  const facts = async (sourceId: string, excludePrivate: boolean) =>
    sorted((await engine.listFactsSince(sourceId, since, { limit: 50, excludePrivate })).map((f) => f.fact));
  return {
    open: ids(await engine.listPages({ sort: 'slug', sourceIds: ['default', OWN] })),
    hidden: ids(await engine.listPages({ sort: 'slug', sourceIds: ['default', OWN], excludePrivate: true })),
    limited: ids(await engine.listPages({ sort: 'slug', sourceIds: ['default', OWN], excludePrivate: true, limit: 2 })),
    ownFacts: await facts(OWN, true),
    defaultFacts: await facts('default', true),
    ownFactsOpen: await facts(OWN, false),
  };
}

type NativeBrain = Record<string, unknown>;

/** `value` with every `ownerOnly: 'fn'` renamed to master's `'lineage'`; `count` counts the renames. */
function toMasterWire(value: unknown, count: { renamed: number }): unknown {
  if (Array.isArray(value)) return value.map((v) => toMasterWire(v, count));
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'ownerOnly' && v === 'fn') {
      count.renamed += 1;
      out[k] = 'lineage';
    } else {
      out[k] = toMasterWire(v, count);
    }
  }
  return out;
}

/**
 * Runs `fn` with the Rust arm's store answering what master's member sends: each native call's arguments go through
 * `toMasterWire`. The SQL arms run `fn` as is. Returns the result and how many policies were renamed.
 */
async function withMasterWire<T>(engine: BrainEngine, backend: ParityBackend, fn: () => Promise<T>): Promise<{ result: T; renamed: number }> {
  const count = { renamed: 0 };
  if (backend !== 'rust') return { result: await fn(), renamed: count.renamed };
  const store = (engine as unknown as { openStore(member: string): { brain: NativeBrain } }).openStore('owner-only-reads');
  const native = store.brain;
  store.brain = new Proxy(native, {
    get(target, prop) {
      const member = Reflect.get(target, prop, target);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => (member as (...a: unknown[]) => unknown).apply(target, args.map((a) => toMasterWire(a, count)));
    },
  });
  try {
    return { result: await fn(), renamed: count.renamed };
  } finally {
    store.brain = native;
  }
}

/** Gives each fixture page one sealed chunk with the term `heliotrope` and an embedding, for the keyword and vector reads. */
async function chunkFixture(engine: BrainEngine): Promise<void> {
  const pages: Array<[string, string]> = [
    ['a/thread', OWN], ['a/thread', 'default'], ['b/from-texts', 'default'], ['b/question-from-texts', 'default'],
    ['c/open', 'default'], ['d/plain-concept', 'default'],
  ];
  for (const [slug, sourceId] of pages) {
    await installChunks(engine, slug, [chunk(0, `heliotrope ledger of ${slug}`, { embedding: basisEmbedding(3), token_count: 3 })], { sourceId });
  }
}

describe('engine parity: owner-only sources under excludePrivate', () => {
  parityTest(
    'outside an engine scope a non-owner page or fact read hides every row while the brain holds an owner-only source',
    { methods: ['putPage', 'addLink', 'insertFact', 'listPages', 'listFactsSince'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      const got = await reads(engine);
      expect(got.open).toEqual([
        'default:a/thread', `${OWN}:a/thread`, 'default:b/from-texts', 'default:b/question-from-texts', 'default:c/open', 'default:d/plain-concept',
      ]);
      expect(got.hidden).toEqual([]);
      expect(got.limited).toEqual([]);
      expect(got.ownFacts).toEqual([]);
      expect(got.defaultFacts).toEqual([]);
      expect(got.ownFactsOpen).toEqual(['From the texts']);
      return got;
    },
  );

  parityTest(
    'a page or fact read with no owner-only source in the brain keeps every row the rest of the policy keeps',
    { methods: ['putPage', 'insertFact', 'listPages', 'listFactsSince'] },
    async (engine) => {
      await engine.putPage('c/open', { type: 'note', title: 'c/open', compiled_truth: 'About c/open.', timeline: '' });
      await engine.insertFact({ fact: 'From the notes', entity_slug: null, source: 'mcp:remember', valid_from: at('2026-01-02T00:00:00Z') }, { source_id: 'default' });
      const hidden = ids(await engine.listPages({ sort: 'slug', excludePrivate: true }));
      const kept = (await engine.listFactsSince('default', at('2020-01-01T00:00:00Z'), { limit: 50, excludePrivate: true })).map((f) => f.fact);
      expect(hidden).toEqual(['default:c/open']);
      expect(kept).toEqual(['From the notes']);
      return { hidden, kept };
    },
  );

  parityTest(
    'in an engine scope a non-owner read hides the owner-only source\'s rows and concepts or questions synthesized from them, before the limit',
    { methods: ['putPage', 'addLink', 'insertFact', 'listPages', 'listFactsSince'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const got = await withEngineScope(engine, () => reads(engine));
      expect(got.hidden).toEqual(['default:a/thread', 'default:c/open', 'default:d/plain-concept']);
      expect(got.limited).toEqual(['default:a/thread', 'default:c/open']);
      expect(got.ownFacts).toEqual([]);
      expect(got.defaultFacts).toEqual(['From the notes']);
      return got;
    },
  );

  parityTest(
    'in an engine scope the lineage form as master\'s member names it hides the same page, fact, keyword and vector rows',
    { methods: ['putPage', 'addLink', 'insertFact', 'sealChunks', 'listPages', 'listFactsSince', 'searchKeyword', 'searchVector'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      await chunkFixture(engine);
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const scoped = <T>(fn: () => Promise<T>) => withMasterWire(engine, backend, () => withEngineScope(engine, fn));
      const hits = (rows: Array<{ source_id?: string; slug: string }>) => sorted([...new Set(rows.map((r) => `${r.source_id}:${r.slug}`))]);
      const page = await scoped(async () => ids(await engine.listPages({ sort: 'slug', sourceIds: ['default', OWN], excludePrivate: true })));
      const fact = await scoped(async () =>
        sorted((await engine.listFactsSince('default', at('2020-01-01T00:00:00Z'), { limit: 50, excludePrivate: true })).map((f) => f.fact)));
      const ownFact = await scoped(async () =>
        sorted((await engine.listFactsSince(OWN, at('2020-01-01T00:00:00Z'), { limit: 50, excludePrivate: true })).map((f) => f.fact)));
      const keyword = await scoped(async () => hits(await engine.searchKeyword('heliotrope', { limit: 50, excludePrivate: true })));
      const vector = await scoped(async () => hits(await engine.searchVector(basisEmbedding(3), { limit: 50, excludePrivate: true })));
      const visible = ['default:a/thread', 'default:c/open', 'default:d/plain-concept'];
      expect(page.result).toEqual(visible);
      expect(fact.result).toEqual(['From the notes']);
      expect(ownFact.result).toEqual([]);
      expect(keyword.result).toEqual(visible);
      expect(vector.result).toEqual(visible);
      // On the Rust arm each read sent master's `lineage`, so the case cannot pass on the trunk's `fn` alone.
      if (backend === 'rust') {
        for (const read of [page, fact, ownFact, keyword, vector]) expect(read.renamed).toBeGreaterThan(0);
      }
      return { page: page.result, fact: fact.result, ownFact: ownFact.result, keyword: keyword.result, vector: vector.result };
    },
  );
});
