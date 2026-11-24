/**
 * BrainEngine parity — a page purge scrubs the purged page's names from the mention gazetteer
 * (`mention_gazetteer_entries`), and the purge verification probe sees the names the gazetteer holds.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), a hard page delete
 *    (`deletePages`) and a purge of soft-deleted pages (`purgeDeletedPages`) remove every gazetteer entry whose target
 *    is a purged slug, in its source, and keep the entries of other pages and other sources
 *    (persistence/purge-name-stores.ts `scrubPurgedNameStores`). The probe purge verification runs on the store
 *    (`countPurgeProbe` over `mention_gazetteer_entries.name_norm`, facts/purge-verify.ts) counts a held name before
 *    the purge and none after it, and so does the page purge receipt's `slug_key` probe of the gazetteer (both
 *    entries targeting the slug before, none after).
 *  - Regression: the Rust store kept the purged page's names in the gazetteer, and its purge probe reported the
 *    gazetteer as a store it keeps no rows of, so a Rust purge verified clean while the names stayed.
 *  - Why existing coverage misses it: the name-store scrub tests run on PGLite and Postgres only, and the mention-pass
 *    parity cases never purge a page.
 *  - Seam: none. Typed members only.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ParityBackend } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string) => ({ type: 'person' as const, title, compiled_truth: `${title} body.`, timeline: '' });
const entry = (source_id: string, name_norm: string, target_slug: string) => ({ source_id, name_norm, target_slug, case_sensitive: false });

async function seed(engine: BrainEngine, backend: ParityBackend) {
  await createSource(engine, backend, 'other');
  for (const slug of ['people/zed-example', 'people/amy-example']) await engine.putPage(slug, page(slug), { sourceId: 'default' });
  await engine.putPage('people/zed-example', page('people/zed-example'), { sourceId: 'other' });
  await engine.applyGazetteerEntryChanges('default', [], [entry('default', 'zed example', 'people/zed-example'),
    entry('default', 'zed', 'people/zed-example'), entry('default', 'amy example', 'people/amy-example')]);
  await engine.applyGazetteerEntryChanges('other', [], [entry('other', 'zed example', 'people/zed-example')]);
}

const entries = async (engine: BrainEngine, sourceId: string) =>
  (await engine.listGazetteerEntryKeys(sourceId)).map(e => `${e.name_norm}>${e.target_slug}`).sort();
const tableProbe = (engine: BrainEngine) =>
  engine.countPurgeProbe({ kind: 'table', table: 'mention_gazetteer_entries', sourceId: 'default', needles: ['zed example'], probe: ['name_norm'] }, 100);
/** The page purge receipt's probe of the gazetteer (engine-sql/purge-verify.ts `slug_key`): entries targeting the slug. */
const slugProbe = (engine: BrainEngine) =>
  engine.countPurgeProbe({ kind: 'slug_key', store: 'mention_gazetteer_entries', sourceId: 'default', slug: 'people/zed-example' }, 100);
const probe = async (engine: BrainEngine) => ({ table: await tableProbe(engine), slug: await slugProbe(engine) });

describe('engine parity: a page purge scrubs the mention gazetteer', () => {
  parityTest('deletePages removes the purged page\'s gazetteer entries and the purge probe agrees', {
    methods: ['putPage', 'applyGazetteerEntryChanges', 'listGazetteerEntryKeys', 'countPurgeProbe', 'deletePages'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const heldBefore = await probe(engine);
    const deleted = await engine.deletePages(['people/zed-example'], { sourceId: 'default' });
    const out = { heldBefore, deleted, heldAfter: await probe(engine), kept: await entries(engine, 'default'), other: await entries(engine, 'other') };
    expect(out).toEqual({ heldBefore: { table: 1, slug: 2 }, deleted: ['people/zed-example'], heldAfter: { table: 0, slug: 0 }, kept: ['amy example>people/amy-example'],
      other: ['zed example>people/zed-example'] });
    return out;
  });

  parityTest('purgeDeletedPages removes the purged page\'s gazetteer entries and keeps a soft-deleted page\'s', {
    methods: ['putPage', 'applyGazetteerEntryChanges', 'listGazetteerEntryKeys', 'countPurgeProbe', 'softDeletePage', 'purgeDeletedPages'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    await engine.softDeletePage('people/zed-example', { sourceId: 'default' });
    // A soft delete keeps the names: restore_page can bring the page back.
    const afterSoftDelete = await entries(engine, 'default');
    const purged = await engine.purgeDeletedPages(0);
    const out = { afterSoftDelete, purged: purged.slugs, heldAfter: await probe(engine), kept: await entries(engine, 'default'),
      other: await entries(engine, 'other') };
    expect(out).toEqual({ afterSoftDelete: ['amy example>people/amy-example', 'zed example>people/zed-example', 'zed>people/zed-example'],
      purged: ['people/zed-example'], heldAfter: { table: 0, slug: 0 }, kept: ['amy example>people/amy-example'], other: ['zed example>people/zed-example'] });
    return out;
  });
});
