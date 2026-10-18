/**
 * Wave B PR 2 fix lane R, gap 1: purge_fact versions a segmented page before rewriting it, as it versions the inline twin.
 *
 * 1. Protects: master's preimage rule (docs/designs/BELIEF_LEDGER.md section 14 item 8, "purge_fact saves each rewritten
 *    page as a version first") on a page stored in segments. After purge_fact of a claim in a facts fence, the segmented
 *    page has the inline twin's version and ledger artifacts: one more version, holding the revision the purge moved the
 *    page off (so page-at-time resolves it), whose body is the pre-purge body with the purged row dropped (version
 *    redaction ran on it too; it never holds the claim), the same belief events, and the same receipt counts. The
 *    segmented version is a reference to a generation, never a copy of the body as one string.
 * 2. Fails when: the segmented purge publishes a new generation without a version of the revision it moved off, or the
 *    version keeps the purged row.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). pages.segmented_storage is forced
 *    on for the segmented twin's writes and off for the inline twin's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { enableBeliefLedger } from '../../src/core/belief/coverage.ts';
import { readSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { openTwinBrain, type TwinBrain } from '../helpers/segmented-twins.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const INLINE = 'people/ina-example';
const SEGMENTED = 'people/sei-example';
/** Each twin's claim has its own fingerprint, so one twin's purge never reaches the other's rows, events or requests. */
const CLAIMS: Record<string, string> = { [INLINE]: 'Twin Example door code is 4417', [SEGMENTED]: 'Twin Example door code is 5528' };
const KEPT = 'Twin Example adopted a narwhalbot';
const utf8 = new TextDecoder();

for (const kind of testBackends()) {
  describe(kind + ': purge_fact versions a segmented page before rewriting it', () => {
    let brain: TwinBrain;

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [INLINE], async seed => {
        await seed.setSwitch(false);
        await seed.put(INLINE, 1_100_000);
        await seed.setSwitch(true);
        await seed.put(SEGMENTED, 1_100_000);
      });
      await withEnv(brain.env(), () => enableBeliefLedger(brain.engine, brain.sourceId));
      for (const slug of [INLINE, SEGMENTED]) {
        brain.setChatReply(JSON.stringify({ facts: [CLAIMS[slug]!, KEPT].map(fact => ({ fact, kind: 'fact', entity: slug, confidence: 1, notability: 'high' })) }));
        expect(await brain.call('extract_facts', { turn_text: 'Synthetic meeting record. ' + CLAIMS[slug] + '. ' + KEPT + '.', visibility: 'world', valid_from: '2026-10-15T00:00:00Z' }, slug))
          .toMatchObject({ inserted: 2 });
      }
      expect([await brain.storageOf(INLINE), await brain.storageOf(SEGMENTED)]).toEqual(['inline', 'segmented']);
    }, 600_000);

    afterAll(() => brain.close(), 120_000);

    /** A page's versions (body as stored, read by generation for a segmented one) and belief events, slug-neutral. */
    const artifacts = async (slug: string) => {
      const { engine, sourceId } = brain;
      const [page] = await engine.executeRaw<{ id: number; revision: string }>('SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      const pageId = Number(page!.id);
      const rows = await engine.executeRaw<{ id: number; body_storage: string; body_generation: number | null; revision: string; compiled_truth: string | null; timeline: string | null;
        title: string; type: string; tags: unknown; is_deleted: boolean }>(`SELECT id, body_storage, body_generation, knowledge_revision::text AS revision, compiled_truth, timeline,
        title, type, tags, is_deleted FROM page_versions WHERE page_id=$1 ORDER BY id`, [pageId]);
      const versions = [];
      for (const v of rows) {
        let body = (v.compiled_truth ?? '') + '\u0000' + (v.timeline ?? '');
        if (v.body_storage === 'segmented') {
          const parts: Record<string, string[]> = { truth: [], timeline: [] };
          for await (const part of readSegmentedBody(engine, pageId, sourceId, { generation: Number(v.body_generation) })) parts[part.region]!.push(utf8.decode(part.bytes));
          body = parts.truth!.join('') + '\u0000' + parts.timeline!.join('');
        }
        versions.push({ revision: v.revision, title: v.title, type: v.type, tags: v.tags, is_deleted: v.is_deleted, body: body.split(slug).join('<slug>'),
          claim: body.toLowerCase().includes(CLAIMS[slug]!.toLowerCase()), kept: body.includes(KEPT) });
      }
      const events = (await engine.executeRaw<{ event_type: string; subject_kind: string; purged: boolean; cause: unknown; value: unknown }>(
        'SELECT event_type, subject_kind, purged, cause, value FROM belief_events WHERE source_id=$1 AND slug=$2 ORDER BY id', [sourceId, slug]))
        .map(e => {
          const cause = (typeof e.cause === 'string' ? JSON.parse(e.cause) : e.cause) as Record<string, unknown> | null;
          const value = (typeof e.value === 'string' ? JSON.parse(e.value) : e.value) as Record<string, unknown> | null;
          const before = value?.revision_before as string | undefined, after = value?.revision_after as string | undefined;
          return { event_type: e.event_type, subject_kind: e.subject_kind, purged: e.purged, op: cause?.op ?? null,
            moved: !!before && before !== after, preimage: before ? rows.some(v => v.revision === before) : null };
        });
      return { revision: page!.revision, versions, events };
    };

    const purge = async (slug: string) => {
      const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [brain.sourceId, slug, CLAIMS[slug]]);
      const dry = await brain.call('purge_fact', { id: Number(fact!.id), dry_run: true }, slug);
      expect(dry.confirm_token).toBeString();
      const done = await brain.call('purge_fact', { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision }, slug);
      expect(done.state).toBe('committed');
      return done;
    };

    test('the segmented twin gets the inline twin\'s preimage version, events and receipt', async () => {
      const before = { inline: await artifacts(INLINE), segmented: await artifacts(SEGMENTED) };
      expect(before.segmented.versions.map(v => v.claim)).toEqual(before.inline.versions.map(v => v.claim));
      const receipts = { inline: await purge(INLINE), segmented: await purge(SEGMENTED) };
      const after = { inline: await artifacts(INLINE), segmented: await artifacts(SEGMENTED) };

      // The inline twin, as master writes it: one more version, holding the revision the purge moved off, without the claim.
      expect(after.inline.versions).toHaveLength(before.inline.versions.length + 1);
      const inlinePreimage = after.inline.versions.at(-1)!;
      expect(inlinePreimage.revision).toBe(before.inline.revision);
      expect({ claim: inlinePreimage.claim, kept: inlinePreimage.kept }).toEqual({ claim: false, kept: true });

      // The segmented twin: the same, as a reference to the generation it moved off (rebuilt without the purged row).
      expect(after.segmented.versions).toHaveLength(before.segmented.versions.length + 1);
      const segmentedPreimage = after.segmented.versions.at(-1)!;
      expect(segmentedPreimage.revision).toBe(before.segmented.revision);
      const [stored] = await brain.engine.executeRaw<{ body_storage: string; compiled_truth: string | null }>(`SELECT v.body_storage, v.compiled_truth FROM page_versions v
        JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY v.id DESC LIMIT 1`, [brain.sourceId, SEGMENTED]);
      expect(stored).toEqual({ body_storage: 'segmented', compiled_truth: null });

      // Page events compare in order; one extraction's fact events are ordered by fingerprint, so they compare as a set.
      const strip = (a: Awaited<ReturnType<typeof artifacts>>) => ({ versions: a.versions.map(({ revision, ...v }) => v),
        pages: a.events.filter(e => e.subject_kind === 'page'), others: a.events.filter(e => e.subject_kind !== 'page').map(e => JSON.stringify(e)).sort() });
      expect(strip(after.segmented)).toEqual(strip(after.inline));
      expect(after.segmented.events.filter(e => e.moved).every(e => e.preimage === true)).toBe(true);
      expect(after.segmented.versions.some(v => v.claim)).toBe(false);
      // The canonical file is left out: this test does not wait for the purge's withdrawal-mirror effect, which rewrites
      // it (test/large-pages/segmented-withdrawal-mirror.test.ts).
      const view = async (slug: string) => { const { file, ...rest } = await brain.view(slug); return rest; };
      expect(await view(SEGMENTED)).toEqual(await view(INLINE));
      expect(JSON.stringify(await view(SEGMENTED))).not.toContain(CLAIMS[SEGMENTED]);

      // Chunk and segment-text counts differ by storage: the inline rewrite rebuilds every chunk, the segmented one only the rewritten segments'.
      const receipt = (r: Record<string, any>) => ({ removed: { ...r.purge.removed, chunks: undefined, page_segment_texts: undefined }, ledger: r.purge.ledger,
        stores: r.stores.filter((s: any) => ['pages', 'page_versions', 'facts', 'belief_events'].includes(s.store)), residuals: r.residuals.filter((x: any) => x.reason === 'source_prose') });
      expect(receipt(receipts.segmented)).toEqual(receipt(receipts.inline));
      expect(receipts.segmented.purge.ledger.purged_events).toBeGreaterThan(0);
      expect(receipts.segmented.residuals.filter((x: any) => x.reason === 'source_prose')).toEqual([]);
      expect(JSON.stringify(receipts.segmented)).not.toContain(CLAIMS[SEGMENTED]);
    }, 600_000);
  });
}
