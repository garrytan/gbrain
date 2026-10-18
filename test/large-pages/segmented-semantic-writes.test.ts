/**
 * Wave B PR 2 fix lane L (decision #1, option d): semantic writes on pages stored in segments.
 *
 * 1. Protects: add_tag / remove_tag on a segmented page of any size flip the tag in page metadata (spec 6.4): no
 *    segment text, manifest row or chunk is written, the generation stays, content_hash and the version move as the
 *    inline tag write moves them, search and get_page see the tag, and a file-backed page's file gets the new
 *    frontmatter with its body bytes unchanged. add_timeline_entry, the takes_* writes, extract_facts' fence write,
 *    gbrain core add / remove / diff and sources reconcile read a segmented page just over 1 MiB back whole and give
 *    the result its inline twin gets (body bytes, frontmatter, tags, content_hash, timeline rows, takes, facts,
 *    canonical file, search hits); above 24 MiB they refuse with page_body_segmented, naming the 24 MiB limit, and
 *    change nothing. The page near 24 MiB is segmented-semantic-writes-near-ceiling.slow.test.ts.
 * 2. Fails when: a tag write on a segmented page refuses, rewrites or re-chunks its body, or leaves search or
 *    get_page without the tag; a fence or timeline write on a segmented page within 24 MiB refuses or differs from
 *    its inline twin; one above 24 MiB writes anything.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Cost assertions are row
 *    counts and work counters, never time. Each step calls both twins under one frozen clock reading, because takes
 *    rows carry the day they were added and resolved: a step that straddled midnight UTC stamped the twins a day apart.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSegmentedProjection } from '../../src/core/page-body/projection.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { segmentedTagWork } from '../../src/core/persistence/page-prepare.ts';
import { withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { runReconcilePreview } from '../../src/core/persistence/reconcile.ts';
import { runCore } from '../../src/commands/core.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { openTwinBrain, type TwinBrain } from '../helpers/segmented-twins.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const INLINE = 'people/ina-example';
/** Twin slugs have equal lengths, so outputs that print the slug compare equal once it is replaced. */
const SEGMENTED = 'people/sei-example';
const HUGE = 'people/hugo-example';

for (const kind of testBackends()) {
  describe(kind + ': semantic writes on pages stored in segments', () => {
    let brain: TwinBrain;
    const call = (name: string, params: Record<string, unknown>, target?: string) => brain.call(name, params, target);
    const view = (slug: string) => brain.view(slug);
    const hits = (term: string) => brain.hits(term);
    const storageOf = (slug: string) => brain.storageOf(slug);
    const setSwitch = (on: boolean) => brain.setSwitch(on);
    const env = () => brain.env();

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [INLINE], async seed => {
        await seed.setSwitch(false);
        await seed.put(INLINE, 1_100_000);
        await seed.setSwitch(true);
        await seed.put(SEGMENTED, 1_100_000);
        await seed.imported(HUGE, PAGE_MAX_BYTES + 512 * 1024);
      });
      const { engine, sourceId } = brain;
      await buildSegmentedProjection(engine, { sourceId: brain.sourceId, slug: HUGE });
      const storage = await brain.engine.executeRaw<{ slug: string; body_storage: string; body_bytes: string | null; sealed: boolean }>(
        'SELECT slug, body_storage, body_bytes::text AS body_bytes, text_projection_revision = knowledge_revision AS sealed FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]);
      expect(Object.fromEntries(storage.map(r => [r.slug, r.body_storage]))).toEqual({ [HUGE]: 'segmented', [INLINE]: 'inline', [SEGMENTED]: 'segmented' });
      expect(Number(storage.find(r => r.slug === HUGE)!.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
      expect(storage.every(r => r.sealed)).toBe(true);
    }, 600_000);

    afterAll(() => brain.close(), 120_000);

    test('each verb on a segmented page just over 1 MiB gives the inline twin\'s result', async () => {
      const steps: Array<[string, Record<string, unknown>]> = [
        ['add_tag', { tag: 'lane-l-probe' }],
        ['add_tag', { tag: 'lane-l-probe' }],
        ['add_timeline_entry', { date: '2026-10-03', summary: 'zebracorn timeline milestone' }],
        ['takes_add', { claim: 'Acme example ships quokkaware in May', kind: 'bet', holder: 'brain', weight: 0.6 }],
        ['takes_update', { row_num: 1, weight: 0.7 }],
        ['takes_add', { claim: 'Acme example hires in June', kind: 'bet', holder: 'brain', weight: 0.4 }],
        ['takes_supersede', { row_num: 2, claim: 'Acme example hires in July' }],
        ['takes_resolve', { row_num: 1, quality: 'correct' }],
        ['takes_remove', { row_num: 3 }],
        ['remove_tag', { tag: 'lane-l-probe' }],
        ['add_tag', { tag: 'lane-l-kept' }],
      ];
      for (const [verb, params] of steps) {
        setSystemTime(new Date());
        let inline, segmented;
        try {
          inline = await call(verb, { slug: INLINE, ...params });
          segmented = await call(verb, { slug: SEGMENTED, ...params });
        } finally { setSystemTime(); }
        expect({ verb, error: segmented.error, status: segmented.status }).toEqual({ verb, error: inline.error, status: inline.status });
        expect(segmented.state ?? segmented.write_request?.state ?? 'committed').not.toBe('failed');
        expect(await view(SEGMENTED)).toEqual(await view(INLINE));
      }
      brain.setChatReply(JSON.stringify({ facts: [{ fact: 'Twin Example adopted a narwhalbot', kind: 'fact', entity: INLINE, confidence: 1, notability: 'high' }] }));
      expect(await call('extract_facts', { turn_text: 'Synthetic meeting record. Twin Example adopted a narwhalbot.', visibility: 'world', valid_from: '2026-10-15T00:00:00Z' }, INLINE)).toMatchObject({ inserted: 1 });
      brain.setChatReply(JSON.stringify({ facts: [{ fact: 'Twin Example adopted a narwhalbot', kind: 'fact', entity: SEGMENTED, confidence: 1, notability: 'high' }] }));
      expect(await call('extract_facts', { turn_text: 'Synthetic meeting record. Twin Example adopted a narwhalbot.', visibility: 'world', valid_from: '2026-10-15T00:00:00Z' }, SEGMENTED)).toMatchObject({ inserted: 1 });
      const [a, b] = [await view(INLINE), await view(SEGMENTED)];
      expect(b.facts).toHaveLength(1);
      expect(b).toEqual(a);
      expect(await storageOf(SEGMENTED)).toBe('segmented');
      expect(await storageOf(INLINE)).toBe('inline');
      for (const term of ['zebracorn']) expect({ term, hits: await hits(term) }).toEqual({ term, hits: [SEGMENTED, INLINE].sort() });
      // Fence rows (takes, facts) reach search as their fences render them; either twin is a hit exactly when the other is.
      for (const term of ['quokkaware', 'narwhalbot']) { const found = await hits(term); expect({ term, segmented: found.includes(SEGMENTED) }).toEqual({ term, segmented: found.includes(INLINE) }); }
      expect((await brain.engine.listPages({ sourceId: brain.sourceId, tag: 'lane-l-kept' } as never)).map(p => p.slug).sort()).toEqual([SEGMENTED, INLINE].sort());
      const got = await call('get_page', { slug: SEGMENTED, body: 'none' });
      expect(got.tags).toEqual(['lane-l-kept']);
    }, 600_000);

    test('gbrain core add, diff and remove on a segmented page give the inline twin\'s result', async () => {
      const out: string[] = [];
      const log = console.log, err = console.error;
      console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
      console.error = (...a: unknown[]) => { out.push(a.join(' ')); };
      const core = async (slug: string, args: string[]) => {
        out.length = 0;
        await setSwitch(slug === SEGMENTED);
        await withEnv(env(), () => withVerifiedLocalRegistration(brain.engine, brain.cli, () => runCore(brain.engine, [...args, '--source', brain.sourceId, slug])));
        return out.join('\n').split(slug).join('<slug>');
      };
      const verdict = () => { const code = currentExitCode(); _resetCliExitVerdictForTests(); return code; };
      const exitCode = process.exitCode;
      try {
        for (const slug of [INLINE, SEGMENTED]) await brain.engine.executeRaw(
          "INSERT INTO core_edit_notices(source_id, slug, actor, base_text, revision) VALUES($1,$2,'agent','before','r1')", [brain.sourceId, slug]);
        // A page over 1 MiB never fits the core budget (at most 6000 chars), so core add refuses it on budget, as it refuses
        // the inline twin; before the segmented page was read back whole it refused page_body_segmented.
        const added = await core(SEGMENTED, ['add']);
        expect(verdict()).toBe(1);
        expect(added).toContain('over the 4000-char budget');
        expect(added).toBe(await core(INLINE, ['add']));
        expect(verdict()).toBe(1);
        expect(await view(SEGMENTED)).toEqual(await view(INLINE));
        const diff = async (slug: string) => { const { since, revision, ...rest } = JSON.parse(await core(slug, ['diff', '--json'])); return { ...rest, since: typeof since, revision: typeof revision }; };
        const diffed = await diff(SEGMENTED);
        expect(verdict()).toBe(0);
        expect(diffed).toMatchObject({ pending: true, before: 'before', revision: 'string' });
        expect(String(diffed.after)).toContain('Twin Example');
        expect(diffed).toEqual(await diff(INLINE));
        expect(verdict()).toBe(0);
        const removed = await core(SEGMENTED, ['remove']);
        expect(verdict()).toBe(0);
        expect(removed).toContain('Already out of core');
        expect(removed).toBe(await core(INLINE, ['remove']));
        expect(verdict()).toBe(0);
      } finally { console.log = log; console.error = err; _resetCliExitVerdictForTests(); process.exitCode = exitCode; }
    }, 600_000);

    test('sources reconcile previews a drifted segmented page as it previews the inline twin', async () => {
      const preview = async (slug: string) => {
        const path = join(brain.root, slug + '.md');
        const before = readFileSync(path, 'utf8');
        writeFileSync(path, before.replace('# Twin Example\n', '# Twin Example\n\nA line added in the file.\n'));
        try {
          const result = await withEnv(env(), () => withVerifiedLocalRegistration(brain.engine, brain.cli, () => runReconcilePreview(brain.engine, { source_id: brain.sourceId, slug })));
          return { status: result.status, conflict_paths: result.conflict_paths, protected_paths: result.protected_paths, formatting_only: result.formatting_only,
            result: JSON.stringify(result.preview.result).split(slug).join('<slug>').replace(/"ingested_at":"[^"]*"/, '"ingested_at":"<seeded>"') };
        } finally { writeFileSync(path, before); }
      };
      expect(await preview(SEGMENTED)).toEqual(await preview(INLINE));
    }, 600_000);

    describe('over 24 MiB', () => {
      const counts = async () => {
        const [row] = await brain.engine.executeRaw<Record<string, string>>(`SELECT p.body_generation::text AS generation, p.content_hash,
          (SELECT count(*) FROM page_body_manifest m WHERE m.page_id=p.id)::text AS manifest,
          (SELECT string_agg(m.occurrence_id::text || ':' || encode(m.sha256, 'hex'), ',' ORDER BY m.seq) FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL) AS live,
          (SELECT count(*) FROM page_segment_texts t WHERE t.source_id=p.source_id)::text AS texts,
          (SELECT count(*) FROM content_chunks c WHERE c.page_id=p.id)::text AS chunks
          FROM pages p WHERE p.source_id=$1 AND p.slug=$2`, [brain.sourceId, HUGE]);
        return row!;
      };
      const fileBody = () => { const file = readFileSync(join(brain.root, HUGE + '.md')); const end = file.indexOf('\n---\n', 4) + 5; return createHash('sha256').update(file.subarray(end)).digest('hex'); };

      test('add_tag and remove_tag flip the tag in metadata without writing a segment, manifest row or chunk', async () => {
        const before = await counts();
        const bodyBefore = fileBody();
        const work = { texts: 0, textBytes: 0, manifest: 0, chunks: 0 };
        const e = brain.engine as unknown as Record<string, (...args: any[]) => Promise<unknown>>;
        const originals = { texts: e.stageSegmentTexts, manifest: e.stageManifestRows, chunks: e.stageSegmentChunks };
        e.stageSegmentTexts = function (this: unknown, ...args: any[]) { work.texts++; work.textBytes += (args[1] as Array<{ body: Uint8Array }>).reduce((n, t) => n + t.body.length, 0); return originals.texts.apply(this, args); };
        e.stageManifestRows = function (this: unknown, ...args: any[]) { work.manifest++; return originals.manifest.apply(this, args); };
        e.stageSegmentChunks = function (this: unknown, ...args: any[]) { work.chunks++; return originals.chunks.apply(this, args); };
        const flips = segmentedTagWork.flips, streams = segmentedTagWork.hashStreams;
        try {
          const requestId = randomUUID();
          const added = await call('add_tag', { slug: HUGE, tag: 'lane-l-huge', request_id: requestId });
          expect(added).toMatchObject({ status: 'ok', tag: 'lane-l-huge' });
          // Idempotency as inline: the same request_id replays the committed receipt and flips nothing again.
          expect((await call('add_tag', { slug: HUGE, tag: 'lane-l-huge', request_id: requestId })).revision).toBe(added.revision);
          const after = await counts();
          expect({ ...after, content_hash: '' }).toEqual({ ...before, content_hash: '' });
          expect(after.content_hash).not.toBe(before.content_hash);
          expect((await brain.engine.readPageSnapshot(HUGE, { sourceId: brain.sourceId }))!.tags).toEqual(['lane-l-huge']);
          expect((await brain.engine.listPages({ sourceId: brain.sourceId, tag: 'lane-l-huge' } as never)).map(p => p.slug)).toEqual([HUGE]);
          expect((await call('get_page', { slug: HUGE, body: 'none' })).tags).toEqual(['lane-l-huge']);
          const file = readFileSync(join(brain.root, HUGE + '.md'), 'utf8').slice(0, 4096);
          expect(file).toContain('lane-l-huge');
          expect(fileBody()).toBe(bodyBefore);
          expect(await call('remove_tag', { slug: HUGE, tag: 'lane-l-huge' })).toMatchObject({ status: 'ok' });
          expect(await counts()).toEqual(before);
          expect(fileBody()).toBe(bodyBefore);
          expect(work).toEqual({ texts: 0, textBytes: 0, manifest: 0, chunks: 0 });
          expect(segmentedTagWork.flips - flips).toBe(2);
          expect(segmentedTagWork.hashStreams - streams).toBe(0);
          const versions = await brain.engine.executeRaw<{ body_storage: string; body_generation: string }>(
            "SELECT v.body_storage, v.body_generation::text AS body_generation FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2", [brain.sourceId, HUGE]);
          expect(versions.map(v => v).length).toBe(2);
          expect(versions.every(v => v.body_storage === 'segmented' && v.body_generation === before.generation)).toBe(true);
        } finally { Object.assign(e, { stageSegmentTexts: originals.texts, stageManifestRows: originals.manifest, stageSegmentChunks: originals.chunks }); }
      }, 600_000);

      test('timeline, takes and facts writes refuse page_body_segmented naming the 24 MiB limit and change nothing', async () => {
        const before = await counts();
        const fileBefore = fileBody();
        const refusals = [
          await call('add_timeline_entry', { slug: HUGE, date: '2026-10-05', summary: 'never written' }),
          await call('takes_add', { slug: HUGE, claim: 'Never written', kind: 'bet', holder: 'brain', weight: 0.5 }),
        ];
        brain.setChatReply(JSON.stringify({ facts: [{ fact: 'Hugo Example never gets this row', kind: 'fact', entity: HUGE, confidence: 1, notability: 'high' }] }));
        refusals.push(await call('extract_facts', { turn_text: 'Synthetic meeting record. Hugo Example never gets this row.', visibility: 'world' }, HUGE));
        for (const refusal of refusals) {
          expect(JSON.stringify(refusal)).toContain('page_body_segmented');
          expect(JSON.stringify(refusal)).toContain('24 MiB');
        }
        expect(await counts()).toEqual(before);
        expect(fileBody()).toBe(fileBefore);
        expect((await brain.engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [brain.sourceId, HUGE]))[0]!.n).toBe('0');
      }, 600_000);
    });
  });
}
