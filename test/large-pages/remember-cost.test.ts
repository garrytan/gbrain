/**
 * #10589 Part 2: `remember` on a segmented person page whose facts fence is longer than a segment.
 *
 * 1. Protects: a fact appended to a facts fence a forced cut splits, on a managed file-backed source whose withdrawal
 *    ledger applies, is published as a splice of the segments the new row touches (page-body/splice.ts), not a
 *    whole-body rewrite: the splice segments at most the segments from the last clean entry point before the row to the
 *    fence's end, plus the row. The canonical file's drift check compares the file with the stored bytes before it
 *    overlays either copy, so a file holding the stored bytes is not overlaid at all. The result is the one the
 *    whole-body path gives (stored body, canonical file and facts rows of a twin written that way, `fenceAppendProbe`),
 *    and the page still reads whole with `gbrain get`. On a source with no withdrawals, a fence the splice opens is
 *    stored and written as that path writes it (trimmed regions), so the next save passes the file's drift check.
 * 2. Fails when: remember restages the whole page (no splice: spliceWork.segmented stays 0), or the drift check overlays
 *    the fence on a file that holds the stored bytes (bodyDigestWork.largestHeld), or the splice gives another body, file
 *    or facts row than the whole-body path.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Work is counted, never timed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bodyDigestWork } from '../../src/core/page-body/body-digests.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { openSegmentedBody } from '../../src/core/page-body/read-range.ts';
import { ledgerApplies } from '../../src/core/page-body/segment-ledger.ts';
import { spliceWork } from '../../src/core/page-body/splice.ts';
import { fenceAppendProbe } from '../../src/core/facts/fence-fact-append.ts';
import { markdownHead, segmentedMarkdownDocument } from '../../src/core/page-window/segmented.ts';
import { openTwinBrain, type TwinBrain } from '../helpers/segmented-twins.ts';
import { fileOf } from '../helpers/segmented-withdrawal.ts';
import { testBackends } from '../helpers/test-backends.ts';

const OWNER = 'people/owner-example';
const TWIN = 'people/twin-example';
const WITHDRAWN = 'Routine note number 100 about the weekly planning meeting with acme-example';
const factRow = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
/** A person page whose one facts fence (about 1.6 MB, 8,600 rows) runs across a forced cut. */
const personPage = (name: string) => {
  const rows = Array.from({ length: 8_600 }, (_, i) => factRow(i + 1, `Routine note number ${i} about the weekly planning meeting with acme-example`));
  return `---\ntype: person\ntitle: ${name}\n---\n\n# ${name}\n\nThe owner of this brain.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n`
    + '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
    + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n' + rows.join('\n') + '\n<!--- gbrain:facts:end -->\n\nClosing notes.\n';
};

for (const kind of testBackends()) {
  describe(`remember on a segmented page whose facts fence crosses a forced cut (${kind})`, () => {
    let brain: TwinBrain;
    const pageId = async (slug: string) => Number((await brain.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug]))[0]!.id);
    const remember = (slug: string, fact: string) => brain.call('remember', { fact, entity: slug, provenance: 'chat 2026-11-27' }, slug);
    /** Everything the write changes, with the twins' names made neutral. */
    const result = async (slug: string) => {
      const neutral = (text: string) => text.replaceAll(slug, '<slug>').replaceAll('Owner Example', '<name>').replaceAll('Twin Example', '<name>');
      const body = await materializeSegmentedBody(brain.engine, await pageId(slug), brain.sourceId);
      const facts = await brain.engine.executeRaw<Record<string, unknown>>(`SELECT fact, kind, visibility, notability, row_num, valid_from::text AS valid_from, valid_until
        FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num DESC LIMIT 3`, [brain.sourceId, slug]);
      return { body: neutral(body.compiled_truth + '\n' + body.timeline), file: neutral(readFileSync(fileOf(brain, slug), 'utf8')), facts };
    };

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => { await seed.setSwitch(true); });
      for (const [slug, name] of [[OWNER, 'Owner Example'], [TWIN, 'Twin Example']] as const) {
        expect(await brain.call('put_page', { slug, content: personPage(name) })).toMatchObject({ state: 'committed' });
        expect(await brain.storageOf(slug)).toBe('segmented');
      }
      // The source has withdrawals, so the ledger applies to every page of it (one of them names a row of both fences).
      for (const claim of [WITHDRAWN, 'An unrelated claim withdrawn elsewhere']) {
        await brain.engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ($1, 'world', '*', gbrain_fact_fingerprint($2))
          ON CONFLICT DO NOTHING`, [brain.sourceId, claim]);
      }
    }, 600_000);

    afterAll(() => { fenceAppendProbe.wholeBody = false; return brain.close(); }, 120_000);

    test('the fence crosses a forced cut and the ledger applies', async () => {
      const id = await pageId(OWNER);
      const [split] = await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest m, jsonb_array_elements(m.facts_slots) s
        WHERE m.page_id=$1 AND m.gen_to IS NULL AND s ? 'open_start'`, [id]);
      expect(split!.n).toBeGreaterThan(1);
      expect(ledgerApplies((await openSegmentedBody(brain.engine, { pageId: id, expect: { slug: OWNER, sourceId: brain.sourceId } })).ledger)).toBe(true);
    }, 60_000);

    test('one fact splices the segments its row touches, and the drift check never overlays the fence', async () => {
      Object.assign(spliceWork, { segmented: 0, read: 0, rows: 0, matches: 0 });
      Object.assign(bodyDigestWork, { fileBytes: 0, segmentBytes: 0, largestPiece: 0, largestHeld: 0 });
      const r = await remember(OWNER, 'Owner Example prefers window seats');
      expect(r).toMatchObject({ status: 'inserted', entity_slug: OWNER });
      expect(spliceWork.segmented).toBeGreaterThan(0);
      expect(spliceWork.segmented).toBeLessThanOrEqual(2 * SEGMENT_MAX_BYTES);
      expect(bodyDigestWork.largestHeld).toBe(0);
      const after = await result(OWNER);
      expect(after.body).toContain('Owner Example prefers window seats'.replace('Owner Example', '<name>'));
      expect(after.file).toContain('<name> prefers window seats');
      expect(after.facts[0]).toMatchObject({ fact: 'Owner Example prefers window seats', row_num: 8_601 });
    }, 300_000);

    test('the splice gives the body, file and facts rows the whole-body path gives', async () => {
      fenceAppendProbe.wholeBody = true;
      Object.assign(spliceWork, { segmented: 0, read: 0, rows: 0, matches: 0 });
      try {
        expect(await remember(TWIN, 'Twin Example prefers window seats')).toMatchObject({ status: 'inserted', entity_slug: TWIN });
      } finally { fenceAppendProbe.wholeBody = false; }
      expect(spliceWork.segmented).toBe(0);
      const [owner, twin] = [await result(OWNER), await result(TWIN)];
      expect(owner.body === twin.body).toBe(true);
      // The whole-body path re-screens the page, so the frontmatter's size assessment is newer there; the body is the same.
      expect(owner.file.slice(owner.file.indexOf('\n---\n')) === twin.file.slice(twin.file.indexOf('\n---\n'))).toBe(true);
      expect(owner.facts.map(({ fact, ...rest }) => ({ fact: String(fact).replace('Owner Example', '<name>'), ...rest })))
        .toEqual(twin.facts.map(({ fact, ...rest }) => ({ fact: String(fact).replace('Twin Example', '<name>'), ...rest })));
    }, 300_000);

    test('later saves keep splicing, and the page still reads whole', async () => {
      for (const fact of ['Owner Example moved the offsite to May', 'Owner Example likes chess']) {
        Object.assign(spliceWork, { segmented: 0, read: 0, rows: 0, matches: 0 });
        expect(await remember(OWNER, fact)).toMatchObject({ status: 'inserted', entity_slug: OWNER });
        expect(spliceWork.segmented).toBeGreaterThan(0);
      }
      const id = await pageId(OWNER);
      const snapshot = (await brain.engine.readPageSnapshot(OWNER, { sourceId: brain.sourceId }))!;
      const body = await openSegmentedBody(brain.engine, { pageId: id, expect: { slug: OWNER, sourceId: brain.sourceId } });
      const doc = await segmentedMarkdownDocument(brain.engine, body, markdownHead(snapshot.page, snapshot.tags), 'trusted');
      const parts: string[] = [];
      for await (const bytes of doc.stream()) parts.push(bytes.toString('utf8'));
      const printed = parts.join('');
      expect(printed).toContain('Owner Example likes chess');
      expect(printed).toContain(`~~${WITHDRAWN}~~`);
    }, 300_000);
  });

  describe(`remember opening a facts fence on a segmented page whose source has no withdrawals (${kind})`, () => {
    let brain: TwinBrain;
    const pageId = async (slug: string) => Number((await brain.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug]))[0]!.id);
    const remember = (slug: string, fact: string) => brain.call('remember', { fact, entity: slug, provenance: 'chat 2026-11-27' }, slug);
    const proseOf = (name: string) => `---\ntype: person\ntitle: ${name}\n---\n\n# ${name}\n\n`
      + Array.from({ length: 16_000 }, (_, i) => `Line ${i} of a long note kept on this page so it is stored in segments.`).join('\n') + '\n';

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => { await seed.setSwitch(true); });
      for (const [slug, name] of [[OWNER, 'Owner Example'], [TWIN, 'Twin Example']] as const) {
        expect(await brain.call('put_page', { slug, content: proseOf(name) })).toMatchObject({ state: 'committed' });
        expect(await brain.storageOf(slug)).toBe('segmented');
      }
    }, 600_000);

    afterAll(() => { fenceAppendProbe.wholeBody = false; return brain.close(); }, 120_000);

    test('the splice stores and writes what the whole-body path does, and the next save passes the file check', async () => {
      expect(ledgerApplies((await openSegmentedBody(brain.engine, { pageId: await pageId(OWNER), expect: { slug: OWNER, sourceId: brain.sourceId } })).ledger)).toBe(false);
      Object.assign(spliceWork, { segmented: 0, read: 0, rows: 0, matches: 0 });
      expect(await remember(OWNER, 'Owner Example prefers window seats')).toMatchObject({ status: 'inserted', entity_slug: OWNER });
      expect(spliceWork.segmented).toBeGreaterThan(0);
      fenceAppendProbe.wholeBody = true;
      try {
        expect(await remember(TWIN, 'Twin Example prefers window seats')).toMatchObject({ status: 'inserted', entity_slug: TWIN });
      } finally { fenceAppendProbe.wholeBody = false; }
      const neutral = (slug: string, text: string) => text.replaceAll(slug, '<slug>').replaceAll('Owner Example', '<name>').replaceAll('Twin Example', '<name>');
      const body = async (slug: string) => { const b = await materializeSegmentedBody(brain.engine, await pageId(slug), brain.sourceId); return neutral(slug, b.compiled_truth + '\n' + b.timeline); };
      const file = (slug: string) => { const f = neutral(slug, readFileSync(fileOf(brain, slug), 'utf8')); return f.slice(f.indexOf('\n---\n')); };
      expect(await body(OWNER) === await body(TWIN)).toBe(true);
      expect(file(OWNER) === file(TWIN)).toBe(true);
      expect(await remember(OWNER, 'Owner Example likes chess')).toMatchObject({ status: 'inserted', entity_slug: OWNER });
    }, 300_000);

    test('a row that differs from the row before it inside a UTF-8 character stores what the whole-body path stores', async () => {
      const [a, b] = ['people/alice-example', 'people/bob-example'];
      for (const [slug, name] of [[a, 'Alice Example'], [b, 'Bob Example']] as const) {
        expect(await brain.call('put_page', { slug, content: proseOf(name) })).toMatchObject({ state: 'committed' });
      }
      // 'é' is C3 A9 and '©' is C2 A9: the second row differs from the first inside a character, one byte before its end.
      const saves = ['The page owner wrote a résumé', 'The page owner holds the ©'];
      for (const fact of saves) expect(await remember(a, fact)).toMatchObject({ status: 'inserted', entity_slug: a });
      fenceAppendProbe.wholeBody = true;
      try {
        for (const fact of saves) expect(await remember(b, fact)).toMatchObject({ status: 'inserted', entity_slug: b });
      } finally { fenceAppendProbe.wholeBody = false; }
      const body = async (slug: string) => {
        const read = await materializeSegmentedBody(brain.engine, await pageId(slug), brain.sourceId);
        return (read.compiled_truth + '\n' + read.timeline).replaceAll(slug, '<slug>').replaceAll(/Alice Example|Bob Example/g, '<name>');
      };
      const spliced = await body(a);
      expect(spliced).toContain('The page owner holds the ©');
      expect(spliced === await body(b)).toBe(true);
    }, 300_000);

    test('the splice declines where the whole-body import decides otherwise: a household subject, a new oversized verdict', async () => {
      const save = async (slug: string, head: string, before: () => Promise<void> = async () => {}) => {
        expect(await brain.call('put_page', { slug, content: proseOf('Page Example').replace('type: person\n', head) })).toMatchObject({ state: 'committed' });
        await before();
        Object.assign(spliceWork, { segmented: 0, read: 0, rows: 0, matches: 0 });
        expect(await remember(slug, 'The page owner prefers tea')).toMatchObject({ status: 'inserted', entity_slug: slug });
        expect(spliceWork.segmented).toBe(0);
        return (await brain.engine.readPageSnapshot(slug, { sourceId: brain.sourceId }))!.page;
      };
      await save('people/carol-example', 'type: person\nhousehold_role: adult\n');
      try {
        const page = await save('people/dan-example', 'type: person\n', () => brain.engine.setConfig('content_sanity.bytes_block', '1000000'));
        expect((page.frontmatter as Record<string, any>).embed_skip?.reason).toBe('oversized');
      } finally { await brain.engine.unsetConfig('content_sanity.bytes_block'); }
    }, 300_000);
  });
}
