/**
 * BrainEngine parity: the typed reads of stamped trust tiers that page history and the quoting reads made through
 * `executeRaw` (src/core/engine-sql/trust-tier-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listPageRefsByIds names each listed page (its type included) by id, deleted pages included, for the GST-687 quoting
 *    reads; listVersionTrustTiers and listVersionReasonWriters are compared with master's statements on the same rows
 *    in test/n3-sql-move-parity.test.ts. The Rust arm (GBRAIN_TEST_RUST_ARM=1) holds these members as raw_sql: each
 *    case ends on the typed refusal.
 *  - Regression: the quoting reads call these members; an engine that drops deleted pages or other sources quotes a
 *    row as the wrong type.
 *  - Why existing coverage misses it: the reads were raw SQL inside their callers, so no engine arm ran them as members.
 *  - Seam: none. Rows are written through typed members. Ids differ between arms, so rows are compared by name.
 *  - The reads that carry a visibility filter (core memory, the trust scan, belief history, re-derivation) stay at their
 *    call sites in this slice.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pageTypesById } from '../../src/core/search/transcript-quote.ts';
import { quoteTimelineRows } from '../../src/core/ops/timeline-quote.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: typed trust tier reads', () => {
  // GST-687 quoting: get_timeline, the chronicle reads and get_chunks look up each row's page type by page id. Ids differ between arms, so answers are keyed by slug.
  parityTest('listPageRefsByIds, pageTypesById and quoteTimelineRows read each page by id: deleted pages and other sources included, unknown ids absent', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'listPageRefsByIds'],
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
    const refs = (await engine.listPageRefsByIds([ids.elsewhere, ids.gone, ids.note, ids.chat, ids.note, missing])).map(({ id, ...ref }) => ref);
    expect(refs).toEqual([
      { source_id: 'default', slug: 'quote/chat', type: 'chat' },
      { source_id: 'default', slug: 'quote/note', type: 'note' },
      { source_id: 'default', slug: 'quote/gone', type: 'transcript' },
      { source_id: 'other', slug: 'quote/elsewhere', type: 'person' },
    ]);
    expect(await engine.listPageRefsByIds([])).toEqual([]);
    const rows = [
      { page_id: ids.chat, summary: 'said a thing', trust_tier: 'operator_curated' },
      { page_id: ids.note, summary: 'wrote a thing', trust_tier: 'operator_curated' },
    ];
    const quoted = await quoteTimelineRows({ engine, remote: true }, 'quote/chat', rows);
    expect(quoted.map(r => ('quoted' in r ? r.quoted : null))).toEqual(['transcript', null]);
    return { byName, refs, quoted: quoted.map(r => ({ quoted: 'quoted' in r ? r.quoted : null, summary: r.summary })) };
  });

});
