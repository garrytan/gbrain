/**
 * #6792/#6807 on a page stored in segments: the owner accepts a held take
 * removal and, separately, a held timeline removal through `gbrain trust
 * confirm tp<id>` (previewOwnerAction + applyOwnerAction, the CLI's path).
 * Shared by the PGLite arm (test/large-pages/held-removal-segmented.test.ts)
 * and the Postgres arm (test/e2e/held-removal-segmented-postgres.test.ts).
 *
 * 1. Protects: the agent publish that dropped the two confirmed rows already
 *    left their text out of the body; the held rows keep it until the owner
 *    decides. Each accept succeeds on a segmented page over 1 MiB and deletes
 *    its row; afterwards the removed take claim and timeline summary are in no
 *    segment text of the page's current generation (read through the
 *    manifest), in no live chunk (chunkGenerationFilter), and neither keyword
 *    search nor the chunk keyword path returns the page for a token only they
 *    carried, while a token of kept text still finds it. The kept rows, their
 *    text and the far end of the body stay.
 * 2. Fails when: the accept refuses a segmented page (the pre-#6807
 *    `page_body_segmented` refusal), leaves a held row in place, re-projects
 *    the removed text into the live generation, a live chunk or a search hit,
 *    or loses a kept row or text.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../../src/core/persistence/context.ts';
import { listTrustProposals } from '../../src/core/trust/proposals.ts';
import { applyOwnerAction, previewOwnerAction } from '../../src/core/trust/owner-actions.ts';
import { chunkGenerationFilter } from '../../src/core/search/safe-chunks.ts';
import { withEnv } from './with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './write-attribution.ts';

const REMOVED_TAKE = 'Kai will lead the zorblaxian offsite';
const REMOVED_EVENT = 'Kai joined quillfeather labs';
const KEPT_TAKE = 'Kai ships the agenda';
const KEPT_EVENT = 'Kai moved to Seoul for vexillology';
const quiet = { info() {}, warn() {}, error() {} };

interface Brain { engine: BrainEngine; sourceId: string; local: OperationContext }

async function managedBrain(engine: BrainEngine): Promise<Brain> {
  const sourceId = `held-seg-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await readLocalWriter(engine, 'cli');
  return { engine, sourceId, local: { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet, remote: false } as OperationContext };
}

const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const page = (body: string) => `---\ntype: person\ntitle: Kai\n---\n${body}\n`;

async function pageRow(b: Brain, slug: string) {
  const [row] = await b.engine.executeRaw<{ id: number; body_storage: string; body_generation: number }>(
    'SELECT id::int AS id, body_storage, body_generation::int AS body_generation FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, slug]);
  return row!;
}

/** Segment texts of the page's current generation, read through the manifest (never a whole-body string). */
async function liveSegmentsHolding(b: Brain, pageId: number, needle: string): Promise<number> {
  const [row] = await b.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest m
      JOIN pages p ON p.id=m.page_id JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
    WHERE m.page_id=$1 AND m.staging_id IS NULL AND m.gen_from<=p.body_generation AND (m.gen_to IS NULL OR m.gen_to>p.body_generation)
      AND position(convert_to($2::text,'UTF8') in t.body)>0`, [pageId, needle]);
  return Number(row!.n);
}

async function liveChunksHolding(b: Brain, pageId: number, needle: string): Promise<number> {
  const [row] = await b.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id
    WHERE c.page_id=$1 AND ${chunkGenerationFilter('p', 'c')} AND strpos(c.chunk_text,$2)>0`, [pageId, needle]);
  return Number(row!.n);
}

async function searchHits(b: Brain, slug: string, token: string): Promise<{ keyword: boolean; chunks: boolean }> {
  const keyword = (await b.engine.searchKeyword(token, { sourceId: b.sourceId, limit: 50 })).some(hit => hit.slug === slug);
  const chunks = (await b.engine.searchKeywordChunks(token, { sourceId: b.sourceId, limit: 50 })).some(hit => hit.slug === slug);
  return { keyword, chunks };
}

/** What `gbrain trust confirm tp<id>` does once the owner types the token: preview, then apply bound to it. */
async function ownerConfirm(engine: BrainEngine, proposalId: number) {
  const input = { action: 'confirm' as const, ref: `tp${proposalId}` };
  const preview = await previewOwnerAction(engine, input);
  return applyOwnerAction(engine, input, { binding: preview.binding, confirmation: { via: 'tty' } });
}

export function defineHeldRemovalSegmentedCases(opts: { getEngine: () => BrainEngine; home: string }): void {
  test('the owner accept of a held take removal and a held timeline removal on a segmented page deletes the rows; their text stays out of the live segments, chunks and search', async () => withEnv({ GBRAIN_HOME: opts.home }, async () => {
    const b = await managedBrain(opts.getEngine());
    const { engine } = b;
    await engine.setConfig('pages.segmented_storage', 'on');
    try {
      const slug = 'people/kai-example';
      await run(b.local, 'put_page', { slug, content: page(`Kai.\n\n## Timeline\n\n- **2026-01-05** | note — ${REMOVED_EVENT}\n- **2026-02-07** | note — ${KEPT_EVENT}`) });
      // takes_* verbs refuse a segmented page, so the takes are added inline and a publish over 1 MiB promotes the page.
      for (const claim of [REMOVED_TAKE, KEPT_TAKE]) await run(b.local, 'takes_add', { slug, claim, kind: 'bet', holder: 'world', weight: 0.6 });
      const small = await run(b.local, 'get_page', { slug, include_content: true });
      const filler = Array.from({ length: 20_000 }, (_, i) => `Kai note line ${i} about the acme-example offsite and its agenda.`).join('\n');
      const big = String(small.content).replace('Kai.\n', `Kai.\n\n${filler}\n`);
      await run(b.local, 'put_page', { slug, content: big, expected_revision: small.revision });
      expect((await pageRow(b, slug)).body_storage).toBe('segmented');

      const pageId = (await pageRow(b, slug)).id;
      const takes = await engine.executeRaw<{ id: number; claim: string }>('SELECT id::int AS id, claim FROM takes WHERE page_id=$1 ORDER BY row_num', [pageId]);
      const timeline = await engine.executeRaw<{ id: number; summary: string }>('SELECT id::int AS id, summary FROM timeline_entries WHERE page_id=$1 ORDER BY date', [pageId]);
      const removedTake = takes.find(t => t.claim === REMOVED_TAKE)!;
      const removedEvent = timeline.find(t => t.summary === REMOVED_EVENT)!;
      const confirmRow = (table: 'takes' | 'timeline_entries', id: number) => engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId],
        () => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE ${table} SET trust_tier='user_confirmed' WHERE id=$1`, [id])), TEST_WRITE_ATTRIBUTION));
      await confirmRow('takes', removedTake.id);
      await confirmRow('timeline_entries', removedEvent.id);

      // A local agent publish drops the confirmed take and the confirmed timeline row: both are held, each with a forget proposal.
      const current = await run(b.local, 'get_page', { slug, body: 'none' });
      const edited = big.split('\n').filter(line => !line.includes(REMOVED_TAKE) && !line.includes(REMOVED_EVENT)).join('\n');
      const put = await run(b.local, 'put_page', { slug, content: edited, expected_revision: current.revision });
      expect(put.contested?.proposal_refs).toHaveLength(2);
      expect((await pageRow(b, slug)).body_storage).toBe('segmented');
      const pending = (await listTrustProposals(engine, { sourceId: b.sourceId })).filter(p => p.status === 'pending');
      const takeProposal = pending.find(p => p.target_table === 'takes' && p.target_id === removedTake.id)!;
      const eventProposal = pending.find(p => p.target_table === 'timeline_entries' && p.target_id === removedEvent.id)!;
      expect([takeProposal?.action, eventProposal?.action]).toEqual(['forget', 'forget']);
      // The publish already left the removed text out of the body; the held rows still carry it until the owner decides.
      expect(await engine.executeRaw('SELECT 1 FROM takes WHERE id=$1', [removedTake.id])).toHaveLength(1);
      expect(await engine.executeRaw('SELECT 1 FROM timeline_entries WHERE id=$1', [removedEvent.id])).toHaveLength(1);

      expect(await ownerConfirm(engine, takeProposal.id)).toMatchObject({ ref: `tp${takeProposal.id}`, status: 'accepted' });
      expect(await ownerConfirm(engine, eventProposal.id)).toMatchObject({ ref: `tp${eventProposal.id}`, status: 'accepted' });
      expect((await listTrustProposals(engine, { sourceId: b.sourceId })).filter(p => p.status === 'pending')).toEqual([]);

      expect((await pageRow(b, slug)).body_storage).toBe('segmented');
      expect(await engine.executeRaw('SELECT 1 FROM takes WHERE id=$1', [removedTake.id])).toHaveLength(0);
      expect(await engine.executeRaw('SELECT 1 FROM timeline_entries WHERE id=$1', [removedEvent.id])).toHaveLength(0);
      for (const gone of [REMOVED_TAKE, REMOVED_EVENT]) {
        expect({ gone, segments: await liveSegmentsHolding(b, pageId, gone), chunks: await liveChunksHolding(b, pageId, gone) }).toEqual({ gone, segments: 0, chunks: 0 });
      }
      // Nothing else is lost: the kept rows, their text and the far end of the body stay.
      expect((await engine.executeRaw<{ claim: string }>('SELECT claim FROM takes WHERE page_id=$1', [pageId])).map(t => t.claim)).toEqual([KEPT_TAKE]);
      expect((await engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries WHERE page_id=$1', [pageId])).map(t => t.summary)).toEqual([KEPT_EVENT]);
      for (const kept of [KEPT_TAKE, KEPT_EVENT, 'Kai note line 19999 ']) expect(await liveSegmentsHolding(b, pageId, kept)).toBeGreaterThan(0);
      for (const token of ['zorblaxian', 'quillfeather']) expect({ token, ...await searchHits(b, slug, token) }).toEqual({ token, keyword: false, chunks: false });
      expect({ token: 'vexillology', ...await searchHits(b, slug, 'vexillology') }).toEqual({ token: 'vexillology', keyword: true, chunks: true });
    } finally {
      await engine.setConfig('pages.segmented_storage', 'off');
    }
  }), 300_000);
}
