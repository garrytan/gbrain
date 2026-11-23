/**
 * BrainEngine parity — the reads withdrawal discovery makes (discoverWithdrawalTargets, src/core/facts/withdrawal-discovery.ts)
 * to find every page that carries a withdrawn claim, which ran through `executeRaw` before they had one member,
 * `readWithdrawalDiscovery` (src/core/engine-sql/withdrawal-discovery.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `claim_keys` keys each claim with its subject ('*' for none) and normalized text (its own, else a source
 *    fact's of its visibility by fingerprint, then v1 fingerprint, else null); `claim_matches` the candidates a key
 *    matches by visibility, subject and either fingerprint; `split_fence_slots` the open slots grouped by page,
 *    region and open start with their bytes; `target_pages` and `sample_slugs` the slug, id and revision of given
 *    page ids. The provenance, inline-fence and segment-fence shortlists carry the page-visibility filter and stay
 *    at their call site in this slice.
 *  - Regression: `gbrain forget` withdraws a claim from every page that carries it; an engine that drops a clause
 *    leaves a stale copy on a page, or rewrites a page the claim never reached.
 *  - Why existing coverage misses it: the reads were raw SQL inside withdrawal-discovery.ts, so no engine arm ran them.
 *  - Seam: none. Sources come from the harness fixture, rows from typed members. Ids differ between arms, so pages are
 *    named by their slug and occurrences by their ordinal; a revision is checked as a UUID string.
 */
import { describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { WithdrawalDiscoveryKey } from '../../src/core/engine-sql/withdrawal-discovery.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { flipInput, manifestRow, pageMeta, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const note = (title: string, compiled_truth = 'x', timeline = '') => ({ type: 'note' as const, title, compiled_truth, timeline, frontmatter: {} });
const fence = (claim: string, visibility: 'world' | 'private' = 'world') =>
  renderFactsTable([{ rowNum: 1, claim, visibility, kind: 'fact', confidence: 1, notability: 'medium', active: true }]);
const tokens = (norm: string) => norm.split(' ').filter(Boolean).map(t => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
const key = (norm: string | null, subject = '*', visibility = 'world'): WithdrawalDiscoveryKey =>
  ({ visibility, fact_hash: sha(norm ?? ''), subject, norm, patterns: norm ? tokens(norm) : [] });

/** Insert facts in a transaction whose write trust settings declare the operator tier. */
async function insert(engine: BrainEngine, rows: Array<{ fact: string; entity: string | null; page: string | null; visibility?: 'world' | 'private' }>, sourceId = 'default') {
  await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
    await tx.insertFacts(rows.map((r, i) => ({
      fact: r.fact, entity_slug: r.entity, source_markdown_slug: r.page, row_num: i + 1, kind: 'fact',
      visibility: r.visibility ?? 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1)),
    })) as never, { source_id: sourceId });
  });
}

/** A segmented page published at generation 1 whose segments carry the given facts slots. */
async function segmented(engine: BrainEngine, slug: string, segments: Array<{ text: string; slots: unknown[]; region?: 'truth' | 'timeline' }>) {
  const { id: pageId } = await engine.createSegmentedPageShell(slug, pageMeta(slug), { sourceId: 'default' });
  const texts = segments.map(s => segmentText(s.text));
  const occurrences = await engine.allocateBodyOccurrenceIds(texts.length);
  const staging = stagingInput({ slug, pageId, mode: 'create' });
  await engine.transaction(async (tx) => {
    await tx.openBodyStaging(staging);
    await tx.stageSegmentTexts('default', texts, { stagingId: staging.id });
    let byteStart = 0;
    await tx.stageManifestRows(texts.map((text, seq) => {
      const row = { ...manifestRow({ pageId, occurrenceId: occurrences[seq]!, genFrom: 1, seq, text, byteStart, stagingId: staging.id,
        region: segments[seq]!.region }), factsSlots: segments[seq]!.slots };
      byteStart += text.body.byteLength;
      return row;
    }));
  });
  await engine.transaction(async (tx) => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staging.id, texts));
    await tx.setBodyStagingState(staging.id, 'committed');
  });
  return { pageId, occurrences };
}

describe('engine parity: withdrawal discovery reads', () => {
  parityTest('claim_keys keys each claim with its subject and normalized text, from the claim or from a source fact by fingerprint',
    { methods: ['transaction', 'applyTransactionSettings', 'insertFacts', 'readWithdrawalDiscovery'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await insert(engine, [
        { fact: 'Alice keeps bees!', entity: null, page: 'notes/open' },
        { fact: 'Alice keeps bees', entity: 'people/e-example', page: null },
        { fact: 'Alice keeps bees', entity: 'people/e-example', page: 'notes/second', visibility: 'private' },
        { fact: 'Alice keeps bees', entity: 'people/z-example', page: 'memory/members/alice-example' },
        { fact: 'Bob bakes bread', entity: 'people/e-example', page: 'notes/never-written' },
      ]);
      await insert(engine, [{ fact: 'Alice keeps bees', entity: null, page: 'notes/other' }], 'other');
      const keys = await engine.readWithdrawalDiscovery({ kind: 'claim_keys', sourceId: 'default', claims: [
        { visibility: 'world', fact_hash: sha('alice keeps bees'), subject: '*', claim: '  ALICE, keeps   bees. ' },
        { visibility: 'world', fact_hash: sha('alice keeps bees'), subject: 'people/e-example', claim: null },
        { visibility: 'world', fact_hash: sha('alice keeps bees!'), subject: null as never, claim: null },
        { visibility: 'private', fact_hash: sha('alice keeps bees'), subject: '*', claim: null },
        { visibility: 'world', fact_hash: sha('nobody'), subject: '*', claim: null },
      ] });
      expect(keys).toEqual([
        { visibility: 'world', fact_hash: sha('alice keeps bees'), subject: '*', norm: 'alice keeps bees' },
        { visibility: 'world', fact_hash: sha('alice keeps bees'), subject: 'people/e-example', norm: 'alice keeps bees' },
        { visibility: 'world', fact_hash: sha('alice keeps bees!'), subject: '*', norm: 'alice keeps bees' },
        { visibility: 'private', fact_hash: sha('alice keeps bees'), subject: '*', norm: 'alice keeps bees' },
        { visibility: 'world', fact_hash: sha('nobody'), subject: '*', norm: null },
      ]);
      return { keys };
    });

  parityTest('claim_matches answers the candidates a key matches by visibility, subject and either fingerprint',
    { methods: ['readWithdrawalDiscovery'] },
    async (engine) => {
      const incoming = [
        { id: 1, slug: 'notes/a', claim: 'Alice keeps bees', visibility: 'world', ambiguous: false },
        { id: 2, slug: 'notes/b', claim: 'ALICE keeps bees!', visibility: null, ambiguous: true },
        { id: 3, slug: 'notes/c', claim: 'Alice keeps bees', visibility: 'private', ambiguous: false },
        { id: 1, slug: 'notes/a', claim: 'alice  keeps bees', visibility: 'world', ambiguous: false },
        { id: 4, slug: 'notes/d', claim: 'Alice keeps wasps', visibility: 'world', ambiguous: false },
        { id: 5, slug: 'notes/e', claim: 'alice keeps bees!', visibility: 'world', ambiguous: false },
      ];
      const matches = async (keys: WithdrawalDiscoveryKey[]) => (await engine.readWithdrawalDiscovery({ kind: 'claim_matches', incoming, keys }))
        .map(r => `${r.id}:${r.ambiguous}`).sort();
      const out = {
        any: await matches([key('alice keeps bees')]),
        subject: await matches([key('alice keeps bees', 'notes/b')]),
        v1: await matches([{ ...key('alice keeps bees'), fact_hash: sha('alice keeps bees!') }]),
        private: await matches([key('alice keeps bees', '*', 'private')]),
        none: await engine.readWithdrawalDiscovery({ kind: 'claim_matches', incoming: [], keys: [key('alice keeps bees')] }),
      };
      expect(out).toEqual({
        any: ['1:false', '2:true', '5:false'],
        subject: ['2:true'],
        v1: ['2:true', '5:false'],
        private: ['2:true', '3:false'],
        none: [],
      });
      return out;
    });

  parityTest('split_fence_slots scans the open facts slots of live segmented rows, grouped by page, region and open start',
    { methods: ['transaction', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts',
      'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'readWithdrawalDiscovery'] },
    async (engine) => {
      const lead = 'Intro line\n';
      const bees = fence('Alice keeps bees');
      const bread = fence('Bob bakes bread');
      const a = await segmented(engine, 'notes/seg-a', [
        { text: `${lead}${bees}`, slots: [{ start: Buffer.byteLength(lead), end: Buffer.byteLength(lead + bees) }] },
        { text: 'no fence here\n', slots: [] },
        { text: `${bread}tail\n`, slots: [{ start: 0, end: Buffer.byteLength(bread) }, { start: 0, end: 10, open_start: 4 }] },
        { text: 'more of the split fence\n', slots: [{ start: 0, end: 7, open_start: 4 }], region: 'timeline' },
      ]);
      const b = await segmented(engine, 'notes/seg-b', [
        { text: `${bees}`, slots: [{ start: 0, end: Buffer.byteLength(bees) }, { start: 2, end: 5, open_start: 0 }] },
      ]);
      const split = async (opts: { after?: [number, string, number]; limit?: number; subjects?: string[] | null } = {}) =>
        (await engine.readWithdrawalDiscovery({ kind: 'split_fence_slots', sourceId: 'default', subjects: opts.subjects ?? null,
          after: opts.after ?? [0, '', -1], limit: opts.limit ?? 128 }))
          .map(r => ({ page: r.page_id === a.pageId ? 'a' : 'b', slug: r.slug, region: r.region, open_start: r.open_start, bytes: r.bytes }));
      const out = {
        splitAll: await split(),
        splitAfter: await split({ after: [a.pageId, 'timeline', 4] }),
        splitLimited: await split({ limit: 1 }),
        splitSubjects: await split({ subjects: ['notes/seg-b'] }),
      };
      expect(out.splitAll).toEqual([
        { page: 'a', slug: 'notes/seg-a', region: 'timeline', open_start: '4', bytes: '7' },
        { page: 'a', slug: 'notes/seg-a', region: 'truth', open_start: '4', bytes: '10' },
        { page: 'b', slug: 'notes/seg-b', region: 'truth', open_start: '0', bytes: '3' },
      ]);
      expect(out.splitAfter).toEqual(out.splitAll.slice(1));
      expect(out.splitLimited).toEqual(out.splitAll.slice(0, 1));
      expect(out.splitSubjects).toEqual(out.splitAll.slice(2));
      return out;
    });

  parityTest('target_pages and sample_slugs answer the slug, id and revision of the matched pages',
    { methods: ['putPage', 'getPage', 'readWithdrawalDiscovery'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      for (const slug of ['notes/b', 'notes/a', 'notes/c']) await engine.putPage(slug, note(slug));
      await engine.putPage('notes/elsewhere', note('elsewhere'), { sourceId: 'other' });
      const ids = new Map<string, number>();
      for (const slug of ['notes/a', 'notes/b', 'notes/c']) ids.set(slug, Number((await engine.getPage(slug))!.id));
      const other = Number((await engine.getPage('notes/elsewhere', { sourceId: 'other' }))!.id);
      const all = [ids.get('notes/c')!, ids.get('notes/a')!, ids.get('notes/b')!, other, 999_999];
      const targets = await engine.readWithdrawalDiscovery({ kind: 'target_pages', sourceId: 'default', ids: all });
      const out = {
        targets: targets.map(t => ({ slug: t.slug, id: t.page_id === ids.get(t.slug), revision: typeof t.revision === 'string' && t.revision.length === 36 })).sort((x, y) => x.slug < y.slug ? -1 : 1),
        sample: (await engine.readWithdrawalDiscovery({ kind: 'sample_slugs', sourceId: 'default', ids: all })).map(r => r.slug),
        sampleOther: (await engine.readWithdrawalDiscovery({ kind: 'sample_slugs', sourceId: 'other', ids: all })).map(r => r.slug),
        none: await engine.readWithdrawalDiscovery({ kind: 'target_pages', sourceId: 'default', ids: [] }),
      };
      expect(out).toEqual({
        targets: [{ slug: 'notes/a', id: true, revision: true }, { slug: 'notes/b', id: true, revision: true }, { slug: 'notes/c', id: true, revision: true }],
        sample: ['notes/a', 'notes/b', 'notes/c'],
        sampleOther: ['notes/elsewhere'],
        none: [],
      });
      return out;
    });
});
