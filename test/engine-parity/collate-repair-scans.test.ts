/**
 * Repair scans list their items by byte order of source id and slug on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the `gbrain repair` scans return their candidates in byte order of their text keys on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), as PGLite sorts: the
 *    orphaned-alias counts (ORPHANED_ALIAS_COUNTS_SQL) and plan items (aliasesRepair.plan), duplicate-fact groups
 *    (findDuplicateFacts), page-less entities (classifyPagelessEntities), and closed consolidation ties
 *    (findClosedTies).
 *  - Regression: an en_US Postgres sorted source ids and slugs by its locale, which skips `-` and `/` (`a0, ab, a-z`
 *    instead of `a-z, a0, ab`), so a repair preview listed its items, and its item cursors pointed, in another order
 *    than on a PGLite brain.
 *  - Why existing coverage misses it: the repair tests seed one source and slugs that sort the same in every locale,
 *    and CI's Postgres runs in C.UTF-8. Every case here uses keys that differ by byte and by en_US; run it against an
 *    en_US Postgres to see it fail.
 *  - Seam: source rows come from the createSource fixture; alias rows from putPage, updateSlug and deletePage (a redirect
 *    whose page row is gone); fact rows from the typed insertFacts and consolidateFact. Every scan is a typed member, so
 *    the Rust arm runs each case to the end.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { aliasesRepair } from '../../src/core/repair/aliases.ts';
import { findDuplicateFacts } from '../../src/core/repair/duplicate-facts.ts';
import { classifyPagelessEntities } from '../../src/core/repair/facts-rehome.ts';
import { findClosedTies } from '../../src/core/repair/consolidate-ties.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { byteOrder, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, digits and `-` only): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const MIXED_SOURCES = ['ab', 'a0', 'a-z'];
const BYTE_SOURCES = byteOrder(MIXED_SOURCES);
/** Every (source, slug) pair, sources first, each part by byte. */
const BYTE_PAIRS = BYTE_SOURCES.flatMap(source => byteOrder(MIXED_SLUGS).map(slug => [source, slug]));

async function sources(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  for (const id of MIXED_SOURCES) await createSource(engine, backend, id);
}

/** One fact through the typed insertFacts (no dedup), filed on `notes/seed` with no fence row; `extra` adds NewFact fields. Returns its id. */
async function fact(engine: BrainEngine, sourceId: string, entity: string, text: string, extra: Record<string, unknown> = {}): Promise<number> {
  const out = await engine.insertFacts([{ fact: text, kind: 'fact', entity_slug: entity, visibility: 'world', source: 'test', row_num: null,
    source_markdown_slug: 'notes/seed', ...extra }] as never, { source_id: sourceId });
  return Number(out.ids[0]);
}

/** An alias row whose page row is gone, through public members: write `old/<slug>`, rename it to `slug` (the redirect), then delete `slug`. */
async function orphanedAlias(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  await engine.putPage(`old/${slug}`, { type: 'note', title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: {} }, { sourceId });
  await engine.updateSlug(`old/${slug}`, slug, { sourceId });
  await engine.deletePage(slug, { sourceId });
}

describe('repair scans list their items by byte', () => {
  parityTest('orphaned-alias counts and the aliases plan list sources, then slugs, by byte', { methods: ['putPage', 'updateSlug', 'deletePage', 'listOrphanedAliasCounts'] }, async (engine, backend) => {
    await sources(engine, backend);
    for (const source of MIXED_SOURCES) for (const slug of MIXED_SLUGS) await orphanedAlias(engine, source, slug);
    const counts = await engine.listOrphanedAliasCounts();
    expect(counts.map(r => r.source_id).filter(id => MIXED_SOURCES.includes(id))).toEqual(BYTE_SOURCES);
    const plan = await aliasesRepair.plan(engine, { brain_id: 'host', source_ids: MIXED_SOURCES }, null);
    expect(plan.items.map(i => [i.source_id, i.slug])).toEqual(BYTE_PAIRS);
  });

  parityTest('findDuplicateFacts lists its groups by source id by byte', { methods: ['insertFacts', 'listDuplicateFactRows'] }, async (engine, backend) => {
    await sources(engine, backend);
    for (const source of MIXED_SOURCES) for (let i = 0; i < 2; i++) await fact(engine, source, 'people/alice-example', 'Alice runs the example team');
    const groups = await findDuplicateFacts(engine, MIXED_SOURCES);
    expect(groups.map(g => g.source_id)).toEqual(BYTE_SOURCES);
  });

  parityTest('classifyPagelessEntities lists sources, then entity slugs, by byte', { methods: ['insertFacts', 'listPagelessEntityFacts'] }, async (engine, backend) => {
    await sources(engine, backend);
    for (const source of MIXED_SOURCES) for (const slug of MIXED_SLUGS) await fact(engine, source, slug, `A fact about ${slug}`);
    const rows = await classifyPagelessEntities(engine, MIXED_SOURCES);
    expect(rows.map(r => [r.source_id, r.slug])).toEqual(BYTE_PAIRS);
  });

  parityTest('findClosedTies lists its ties by source id by byte', { methods: ['insertFacts', 'consolidateFact', 'listClosedConsolidationTies'] }, async (engine, backend) => {
    await sources(engine, backend);
    const at = new Date('2026-01-01T00:00:00Z');
    const tie = { claim_metric: 'mrr', valid_from: at, valid_until: at };
    for (const source of MIXED_SOURCES) for (const n of [1, 2]) await engine.consolidateFact(await fact(engine, source, 'companies/acme-example', `MRR reading ${n}`, tie), 1);
    const ties = await findClosedTies(engine, MIXED_SOURCES);
    expect([...new Set(ties.map(t => t.source_id))]).toEqual(BYTE_SOURCES);
  });

});
