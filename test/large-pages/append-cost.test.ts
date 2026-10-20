/**
 * Wave B PR 3 (spec 6.1): append_page on a segmented page costs the text added plus one tail segment.
 *
 * 1. Protects: a 10 KB append to a 4 MB and to a 16 MB segmented page segments exactly the old tail segment plus the
 *    text, reads only that segment (page-body/splice.ts spliceWork), loads the same manifest rows at either size, writes manifest rows for the tail and
 *    the new segments only, gives the body, content_hash and segment cuts a fresh import of the whole result gives,
 *    and the embedder sees only new chunk text after it.
 * 2. Fails when: an append restages or rescans the whole body (the forced probe sets appendProbe.fullRewrite and shows
 *    the same bound failing), resumes the content hash or the segmenter from the wrong state, or re-embeds chunks whose
 *    text it did not change.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). Work is counted, never timed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { spliceWork } from '../../src/core/page-body/splice.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { appendProbe } from '../../src/core/persistence/page-append.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';

const SMALL = 'notes/append-cost-small';
const BIG = 'notes/append-cost-big';
const TWIN = 'notes/append-cost-twin';
/** About 10 KB of conversation turns, without a trailing newline (a fresh import trims one). */
const TEXT = conversationBody(10_000, { seed: 99 });
const BOUND = SEGMENT_MAX_BYTES + Buffer.byteLength(TEXT) + 1;

for (const kind of testBackends()) {
  describe(`append_page cost (${kind})`, () => {
    let brain: AppendBrain;
    const pageRow = async (slug: string) => (await brain.engine.executeRaw<{ id: number; body_generation: string; content_hash: string }>(
      "SELECT id, body_generation::text AS body_generation, content_hash FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
    const cuts = async (slug: string) => {
      const page = await pageRow(slug);
      return (await brain.engine.readManifest(Number(page.id))).map(r => [r.region, Number(r.byteStart), r.byteLen, Buffer.from(r.sha256).toString('hex')]);
    };
    /** One append with its work counters and the manifest rows it wrote. */
    const measured = async (slug: string) => {
      const before = await pageRow(slug);
      const tail = (await brain.engine.readManifest(Number(before.id), { lastN: 1 }))[0]!.byteLen;
      Object.assign(spliceWork, { segmented: 0, read: 0, rows: 0 });
      const res = await brain.call('append_page', { slug, text: TEXT, request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false });
      const work = { ...spliceWork };
      const [written] = await brain.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1 AND gen_from=$2',
        [before.id, Number(before.body_generation) + 1]);
      return { res: res.body, work, tail, written: Number(written!.n) };
    };

    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      await brain.seed(SMALL, conversationPage(4_000_000, { seed: 1 }));
      await brain.seed(BIG, conversationPage(16_000_000, { seed: 2 }));
      expect((await brain.body(SMALL)).storage).toBe('segmented');
      expect((await brain.body(BIG)).storage).toBe('segmented');
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('a 10 KB append does the same bounded work at 4 MB and 16 MB, and equals a fresh import of the result', async () => {
      const original = await brain.body(SMALL);
      const small = await measured(SMALL);
      const big = await measured(BIG);
      // Exactly the old tail segment and the text, at either size: nothing before the tail is segmented or read.
      for (const { work, tail } of [small, big]) {
        expect(work.segmented).toBe(tail + Buffer.byteLength(TEXT) + 1);
        expect(work.read).toBe(tail);
        expect(work.segmented).toBeLessThanOrEqual(BOUND);
        expect(work.rows).toBeLessThanOrEqual(16);
      }
      expect(big.work.rows).toBe(small.work.rows);
      expect(big.written).toBeLessThanOrEqual(small.written + 1);
      expect(small.written).toBeLessThanOrEqual(3);
      expect(small.res).toMatchObject({ slug: SMALL, appended_bytes: Buffer.byteLength(TEXT) + 1, body_bytes: Buffer.byteLength(original.truth) + Buffer.byteLength(TEXT) + 1 });
      expect(small.res.rescanned).toBeUndefined();

      const after = await brain.body(SMALL);
      expect(after.truth === original.truth + '\n' + TEXT).toBe(true);
      await brain.seed(TWIN, `---\ntitle: Conversation log\ntype: note\ntrust_tier: agent_written\n---\n\n${after.truth}\n`);
      expect((await pageRow(SMALL)).content_hash).toBe((await pageRow(TWIN)).content_hash);
      expect(await cuts(SMALL)).toEqual(await cuts(TWIN));
    }, 600_000);

    test('the embedder sees only chunk text the append changed', async () => {
      await runEmbedCore(brain.engine, { stale: true, quiet: true } as never);
      const page = await pageRow(BIG);
      const old = new Set((await brain.engine.executeRaw<{ chunk_text: string }>('SELECT chunk_text FROM content_chunks WHERE page_id=$1', [page.id])).map(r => r.chunk_text));
      expect(old.size).toBeGreaterThan(100);
      brain.embedded.length = 0;
      await measured(BIG);
      await runEmbedCore(brain.engine, { stale: true, quiet: true } as never);
      expect(brain.embedded.length).toBeGreaterThan(0);
      expect(brain.embedded.length).toBeLessThanOrEqual(8);
      expect(brain.embedded.filter(text => old.has(text))).toEqual([]);
      expect(brain.embedded.some(text => text.includes(TEXT.slice(-40)))).toBe(true);
    }, 600_000);

    test('forced probe: an append that restages the whole body fails the bound', async () => {
      const before = await brain.body(SMALL);
      appendProbe.fullRewrite = true;
      let probe;
      try { probe = await measured(SMALL); } finally { appendProbe.fullRewrite = false; }
      expect(probe.res.rescanned).toBe(true);
      expect(probe.work.segmented).toBeGreaterThan(BOUND);
      expect(probe.work.segmented).not.toBe(probe.tail + Buffer.byteLength(TEXT) + 1);
      expect((await brain.body(SMALL)).truth === before.truth + '\n' + TEXT).toBe(true);
    }, 600_000);
  });
}
