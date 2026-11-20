/**
 * BrainEngine parity: the typed reads of stamped trust tiers that core memory, the trust scan, belief history, page
 * history and the quoting reads made through `executeRaw` (src/core/engine-sql/trust-tier-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listCorePageRows lists the live `always_load` pages by source then slug under the source, exclude and
 *    privacy options, hiding the pages of an owner-only source from a non-owner caller on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL); listTrustScanRows and countUnscannedTrustRows read the rows of a table at a
 *    listed stored tier above a cursor; pageAwaitsRederive says whether a purge hid the page for re-derivation;
 *    listPageTypesByIds names each listed page's type by id, deleted pages included, for the GST-687 quoting reads.
 *    The Rust arm (GBRAIN_TEST_RUST_ARM=1) holds these members as raw_sql: each case ends on the typed refusal.
 *  - Regression: core memory, `gbrain doctor`'s trust scan and the quoting reads call these members; an engine that
 *    drops an option shows a page the reader may not see or a row the scan should skip.
 *  - Why existing coverage misses it: the reads were raw SQL inside their callers, so no engine arm ran them as members.
 *  - Seam: none. Rows are written through typed members. Ids differ between arms, so rows are compared by slug.
 *    test/n3-sql-move-parity.test.ts compares each member with master's statement on the same rows.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { pageTypesById } from '../../src/core/search/transcript-quote.ts';
import { quoteTimelineRows } from '../../src/core/ops/timeline-quote.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: typed trust tier reads', () => {
  parityTest(
    'listCorePageRows under excludePrivate drops the pages of an owner-only source: every page while one exists with no schema version, only that source\'s and its concept lineage under the function form',
    { methods: ['putPage', 'addLink', 'listCorePageRows'] },
    async (engine, backend) => {
      const core = (slug: string, type: 'note' | 'concept', sourceId: string) =>
        engine.putPage(slug, { type, title: `T ${slug}`, compiled_truth: `body ${slug}`, timeline: '', frontmatter: { always_load: true } }, { sourceId });
      const reads = async () => {
        const slugs = async (spec: Parameters<BrainEngine['listCorePageRows']>[0]) =>
          (await engine.listCorePageRows(spec)).map(r => `${r.source_id}:${r.slug}`);
        return {
          floor: await slugs({ excludePrivate: true }),
          caller: await slugs({ excludePrivate: true, forCaller: true }),
          unfiltered: await slugs({}),
        };
      };
      await createSource(engine, backend, 'work');
      await core('core/open', 'note', 'default');
      await core('core/from-chat', 'concept', 'default');
      await core('core/work', 'note', 'work');
      // Before any owner-only source exists every page is listed: the case is not vacuous.
      const before = await reads();
      const all = ['default:core/from-chat', 'default:core/open', 'work:core/work'];
      expect(before).toEqual({ floor: all, caller: all, unfiltered: all });

      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await createSource(engine, backend, 'vault', { owner_only: true });
      await core('core/chat', 'note', 'chat');
      await core('core/vault', 'note', 'vault');
      await engine.addLink('core/from-chat', 'core/chat', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'chat' });

      // No schema version in context: while an owner-only source exists the non-owner policy hides every page.
      const closed = await reads();
      expect(closed).toEqual({
        floor: [], caller: [],
        unfiltered: ['chat:core/chat', ...all.slice(0, 2), 'vault:core/vault', 'work:core/work'],
      });

      // Schema version 320 or later: only the owner-only sources' pages, and the concept synthesized from one, are hidden.
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const fn = await withEngineScope(engine, reads);
      const open = ['default:core/open', 'work:core/work'];
      expect(fn).toEqual({ floor: open, caller: open, unfiltered: closed.unfiltered });
      return { before, closed, fn };
    },
  );

  parityTest(
    'listTrustScanRows and countUnscannedTrustRows read the takes and timeline entries at a listed stored tier',
    { methods: ['putPage', 'listTrustScanRows', 'countUnscannedTrustRows'] },
    async (engine) => {
      await engine.putPage('scan/holder', { type: 'note', title: 'Holder', compiled_truth: 'h', timeline: '' });
      const tiers = ['agent_written', 'unknown'];
      const takes = await engine.listTrustScanRows({ table: 'takes', afterId: 0, limit: 10, tiers });
      const timeline = await engine.listTrustScanRows({ table: 'timeline_entries', afterId: 0, limit: 10, tiers });
      const counts = [await engine.countUnscannedTrustRows({ table: 'takes', afterId: 0, until: null, tiers }),
        await engine.countUnscannedTrustRows({ table: 'timeline_entries', afterId: 0, until: 5, tiers })];
      expect({ takes, timeline, counts }).toEqual({ takes: [], timeline: [], counts: [0, 0] });
      return { takes, timeline, counts };
    },
  );

  // A purge marks a page in needs_rederive through raw SQL, which the Rust engine refuses, so only the SQL arms can
  // mark one; the store keeps no such queue and answers false. Unmarked and missing pages answer false on every arm.
  parityTest('pageAwaitsRederive is true only for a page a needs_rederive row names', {
    methods: ['putPage', 'pageAwaitsRederive'],
  }, async (engine, backend) => {
    const live = await engine.putPage('rederive/live', { type: 'note', title: 'Live', compiled_truth: 'live body' });
    const marked = await engine.putPage('rederive/marked', { type: 'note', title: 'Marked', compiled_truth: 'marked body' });
    if (backend !== 'rust') {
      await engine.executeRaw(`INSERT INTO needs_rederive (derived_table, derived_id, reason) VALUES ('pages', $1, 'purge')`, [String(marked.id)]);
      expect(await engine.pageAwaitsRederive(Number(marked.id))).toBe(true);
    } else {
      expect(await engine.pageAwaitsRederive(Number(marked.id))).toBe(false);
    }
    return { live: await engine.pageAwaitsRederive(Number(live.id)), missing: await engine.pageAwaitsRederive(Number(live.id) + 100000) };
  });

  // GST-687 quoting: get_timeline, the chronicle reads and get_chunks look up each row's page type by page id. Ids differ between arms, so answers are keyed by slug.
  parityTest('listPageTypesByIds, pageTypesById and quoteTimelineRows read each page\'s type by id: deleted pages and other sources included, unknown ids absent', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'listPageTypesByIds'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('quote/chat', { type: 'chat' as never, title: 'Chat', compiled_truth: 'chat body', timeline: '' });
    await engine.putPage('quote/note', { type: 'note', title: 'Note', compiled_truth: 'note body', timeline: '' });
    await engine.putPage('quote/gone', { type: 'transcript' as never, title: 'Gone', compiled_truth: 'gone body', timeline: '' });
    await engine.putPage('quote/elsewhere', { type: 'person', title: 'Elsewhere', compiled_truth: 'other body', timeline: '' }, { sourceId: 'other' });
    const idOf = async (slug: string, sourceId = 'default') => Number((await engine.getPage(slug, { sourceId }))!.id);
    const ids = { chat: await idOf('quote/chat'), note: await idOf('quote/note'), gone: await idOf('quote/gone'), elsewhere: await idOf('quote/elsewhere', 'other') };
    await engine.softDeletePage('quote/gone', { sourceId: 'default' });
    const missing = Math.max(...Object.values(ids)) + 100_000;
    const types = await pageTypesById(engine, [ids.chat, ids.note, ids.gone, ids.elsewhere, ids.chat, missing]);
    const byName = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, types.get(id) ?? null]));
    expect(byName).toEqual({ chat: 'chat', note: 'note', gone: 'transcript', elsewhere: 'person' });
    expect({ size: types.size, missing: types.has(missing), empty: (await pageTypesById(engine, [])).size }).toEqual({ size: 4, missing: false, empty: 0 });
    const asked = await engine.listPageTypesByIds([ids.elsewhere, ids.gone, ids.note, ids.chat, ids.note, missing]);
    const refs = asked.map(r => ({ name: Object.entries(ids).find(([, id]) => id === r.id)![0], type: r.type }));
    expect(refs).toEqual([{ name: 'chat', type: 'chat' }, { name: 'note', type: 'note' }, { name: 'gone', type: 'transcript' }, { name: 'elsewhere', type: 'person' }]
      .sort((a, b) => ids[a.name as keyof typeof ids] - ids[b.name as keyof typeof ids]));
    expect(await engine.listPageTypesByIds([])).toEqual([]);
    const rows = [
      { page_id: ids.chat, summary: 'said a thing', trust_tier: 'operator_curated' },
      { page_id: ids.note, summary: 'wrote a thing', trust_tier: 'operator_curated' },
    ];
    const quoted = await quoteTimelineRows({ engine, remote: true }, 'quote/chat', rows);
    expect(quoted.map(r => ('quoted' in r ? r.quoted : null))).toEqual(['transcript', null]);
    return { byName, refs, quoted: quoted.map(r => ({ quoted: 'quoted' in r ? r.quoted : null, summary: r.summary })) };
  });
});
