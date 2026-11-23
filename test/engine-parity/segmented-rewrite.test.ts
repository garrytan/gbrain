/**
 * BrainEngine parity — fence rewrites of a segmented body (`src/core/page-body/segment-rewrite.ts`): the live rewrite a
 * fact withdrawal, forget and purge run (`rewriteLiveSegmentedFences`), the rebuild of a retained generation a version
 * purge runs (`rewriteSegmentedGeneration`), and the streamed hash and needle scan beside them.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a segmented page with a facts fence, a live rewrite gives a new
 *    generation with the same body, chunks, page row, replaced-segment count and deleted-derivation count on every arm,
 *    keeps a soft-deleted page deleted, and a retained generation rebuilt under its own number gives the same version
 *    content hash and body on every arm (PGLite always; Postgres with DATABASE_URL; Rust with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that refuses one statement of the rewrite (the page read, the deleted_at restore, the
 *    generation lock, the three manifest-split statements, the publish of the rebuilt rows, the version hash or the
 *    derivation delete) stops the rewrite on that engine; the Rust engine has no SQL dialect, so each must be a typed
 *    member. A member that answers differently leaves a different body, chunks or version hash.
 *  - Why existing coverage misses it: test/large-pages/segment-rewrite*.test.ts run the rewrite on PGLite and Postgres
 *    only, through the whole withdrawal or purge, never compared across arms.
 *  - Seam: the rewrites are called directly inside `engine.transaction`; the callers around them (facts/forget.ts,
 *    facts/withdrawal.ts, facts/purge.ts) keep raw SQL of their own, so a whole forget or purge is not compared here.
 *    The page is written through the string import's staging (stageSegmentedImport, then its apply and seal), not
 *    importFromContent, whose fence withdrawal and purge overlay are raw SQL; its fence rows are private, because a
 *    world row sends the chunk staging through the fence chunk overlay (eligibility/fence-overlay.ts), raw SQL too.
 *    Page, occurrence and version ids are never compared.
 *  - The rewrite page read lists tags in byte order on every arm (Postgres sorts by "C", not the database collation),
 *    and a fence append's tier keep (trust/fence-append.ts withPageTierKept) puts the prior tier and origin back after
 *    a lowering and after a raising write through the typed restore, under the same write trust declaration.
 */
import { describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { sealSegmentedPage, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { readSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { rewriteLiveSegmentedFences, rewriteSegmentedGeneration, rewrittenContentHash, segmentedBodyContains,
  type FenceTransform } from '../../src/core/page-body/segment-rewrite.ts';
import { withWriteTrust } from '../../src/core/persistence/context.ts';
import { withPageTierKept } from '../../src/core/trust/fence-append.ts';
import type { TrustTier } from '../../src/core/trust/tier.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const utf8 = new TextDecoder();

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const row = (n: number, claim: string) => `| ${n} | ${claim} | preference | 1.0 | private | medium | 2026-01-01 |  | chat |  |`;
/** A conversation page with a facts fence between two long halves, so the fence sits in one segment of many. */
const fencedBody = (seed: number) => `${conversationBody(640 * 1024, { seed })}\n\n## Facts\n\n${fence([row(1, 'Prefers the aisle seat'), row(2, 'Walks to work')])}\n\n`
  + conversationBody(640 * 1024, { seed: seed + 1 });
/** Strike the second claim, as a withdrawal marks a fence row. */
const strike: FenceTransform = async (text) => text.replace('| Walks to work |', '| ~~Walks to work~~ |');

/**
 * Write `truth` as the segmented body of `slug` through the string import's staging (stageSegmentedImport), a version
 * of the old body first on a replace. A fenced import (importFromContent) also runs the facts withdrawal and purge
 * overlay, whose SQL the Rust store does not serve yet, so the fixture stages the body as that import does after it.
 */
async function fencedPage(engine: BrainEngine, slug: string, truth: string) {
  const existing = await engine.getPage(slug);
  const meta = { title: slug, type: 'note' as const, frontmatter: {}, page_kind: 'markdown' as const };
  const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing, policy: await readPageBodyPolicy(engine), baseRevision: null,
    page: { title: slug, type: 'note', compiled_truth: truth, timeline: '', frontmatter: {}, tags: [] }, chunking: { quarantined: false, corpusGeneration: null, tier: 'none' } });
  await engine.transaction(async tx => {
    if (existing) await tx.createVersion(slug, { sourceId: 'default' });
    const applied = await staged.apply(tx, meta, { mode: 'none', corpusGeneration: null });
    if (applied.complete) await sealSegmentedPage(tx, applied.pageId);
  });
  expect(await staged.afterCommit(engine)).toBe(true);
}

/** A segmented body as one hash per region, read segment by segment. */
async function bodyView(engine: BrainEngine, pageId: number, generation?: number) {
  const parts: Record<string, string[]> = { truth: [], timeline: [] };
  for await (const part of readSegmentedBody(engine, pageId, 'default', generation === undefined ? {} : { generation })) parts[part.region]!.push(utf8.decode(part.bytes));
  return { truth: sha(parts.truth!.join('')), timeline: sha(parts.timeline!.join('')) };
}

/** The page and its visible chunks as a reader sees them; ids are left out. */
async function pageView(engine: BrainEngine, slug: string) {
  const page = await engine.getPage(slug, { includeDeleted: true });
  const chunks = await engine.getChunks(slug);
  return {
    content_hash: page?.content_hash ?? null, deleted: page?.deleted_at != null,
    chunks: chunks.length, chunk_texts: sha(chunks.map(c => `${c.chunk_source}\0${c.chunk_text}`).join('\n')),
  };
}

describe('engine parity: segmented fence rewrites', () => {
  parityTest('a live fence rewrite flips a new generation that keeps the unchanged segments and leaves a soft-deleted page deleted',
    { methods: ['setConfig', 'getPage', 'getChunks', 'transaction', 'readSegmentedPageHead', 'readManifest', 'readSegmentTexts',
      'upsertSegmentDerivations', 'readSegmentDerivations', 'softDeletePage', 'readSegmentedRewritePage', 'restorePageDeletedAt',
      'deleteRewrittenSegmentDerivations'], timeout: 600_000 },
    async (engine) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await fencedPage(engine, 'notes/fenced', fencedBody(11));
      const page = (await engine.getPage('notes/fenced'))!;
      const before = { page: await pageView(engine, 'notes/fenced'), body: await bodyView(engine, page.id) };
      // A links and a mentions row on every live segment: the rewrite deletes those that may hold the replaced text.
      const live = await engine.readManifest(page.id);
      await engine.upsertSegmentDerivations(live.flatMap(row => (['links', 'mentions'] as const).map(kind => ({ pageId: page.id, kind,
        occurrenceId: Number(row.occurrenceId), version: 1, segmentSha256: row.sha256, contextHash: new Uint8Array(32), state: 'done' as const, output: {}, receipt: {} }))));
      const rewrite = await engine.transaction(tx => rewriteLiveSegmentedFences(tx, page.id, strike));
      const after = { page: await pageView(engine, 'notes/fenced'), body: await bodyView(engine, page.id),
        generation: Number((await engine.readSegmentedPageHead(page.id))!.body_generation) };
      expect(after.body.truth).not.toBe(before.body.truth);
      const kept = (await engine.readSegmentDerivations(page.id)).map(row => row.kind).sort();
      const unchanged = await engine.transaction(tx => rewriteLiveSegmentedFences(tx, page.id, async text => text));
      // A soft-deleted page keeps its deletion through a rewrite.
      await engine.softDeletePage('notes/fenced');
      const deletedRewrite = await engine.transaction(tx => rewriteLiveSegmentedFences(tx, page.id, async text => text.replace('| Prefers the aisle seat |', '| ~~Prefers the aisle seat~~ |')));
      const afterDeleted = await pageView(engine, 'notes/fenced');
      return { before, after, unchanged, afterDeleted, kept: { rows: kept.length, links: kept.filter(k => k === 'links').length, of: live.length },
        rewrite: rewrite && { replaced: rewrite.replaced.length, derivations: rewrite.derivations, sealed: rewrite.sealed },
        deletedRewrite: deletedRewrite && { replaced: deletedRewrite.replaced.length, derivations: deletedRewrite.derivations, sealed: deletedRewrite.sealed } };
    });

  parityTest('a retained generation rebuilds under its own number with the rewritten hash, and the needle scan follows it',
    { methods: ['setConfig', 'getPage', 'getVersions', 'transaction', 'readSegmentedPageHead', 'readManifest', 'readSegmentTexts', 'createVersion',
      'lockSegmentedGenerationPage', 'splitManifestGeneration', 'publishRebuiltGeneration', 'setSegmentedVersionHash'], timeout: 600_000 },
    async (engine) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await fencedPage(engine, 'notes/retained', fencedBody(21));
      const page = (await engine.getPage('notes/retained'))!;
      const old = Number((await engine.readSegmentedPageHead(page.id))!.body_generation);
      await fencedPage(engine, 'notes/retained', fencedBody(31));
      const versions = await engine.getVersions('notes/retained');
      const version = versions.find(v => v.body_generation === old)!;
      expect(version).toBeDefined();
      const meta = { title: version.title ?? '', type: version.type ?? 'note', frontmatter: version.frontmatter ?? {}, tags: [...(version.tags ?? [])] };
      const expected = await rewrittenContentHash(engine, page.id, 'default', old, strike, meta);
      const before = { body: await bodyView(engine, page.id, old), carries: await segmentedBodyContains(engine, page.id, 'default', ['| Walks to work |'], { generation: old }) };
      const replaced = await engine.transaction(tx => rewriteSegmentedGeneration(tx, page.id, old, strike, meta));
      const rebuilt = (await engine.getVersions('notes/retained')).find(v => v.body_generation === old)!;
      const after = { body: await bodyView(engine, page.id, old), carries: await segmentedBodyContains(engine, page.id, 'default', ['| Walks to work |'], { generation: old }),
        live: await bodyView(engine, page.id), content_hash: rebuilt.content_hash, matchesStream: rebuilt.content_hash === expected };
      expect(after.matchesStream).toBe(true);
      const live = Number((await engine.readSegmentedPageHead(page.id))!.body_generation);
      const refusal = await engine.transaction(tx => rewriteSegmentedGeneration(tx, page.id, live, strike, meta))
        .then(() => null, (e: Error) => e.message.replace(/page \S+;/, 'page <slug>;').replace(/generation \d+/, 'generation <n>'));
      return { before, after, replaced: replaced?.length ?? null, refusal };
    });

  parityTest('the rewrite page read lists mixed-case tags in byte order',
    { methods: ['putPage', 'addTag', 'readSegmentedRewritePage'] },
    async (engine) => {
      const page = await engine.putPage('notes/tagged', { title: 'Tagged', type: 'note', compiled_truth: 'Body.', timeline: '' });
      for (const tag of ['beta', 'Alpha', 'alpha', 'Zeta', '_under', 'Beta']) await engine.addTag('notes/tagged', tag);
      return (await engine.readSegmentedRewritePage(page.id))?.tags ?? null;
    });

  parityTest('a fence append keeps the page tier and origin through a lowering and a raising write',
    { methods: ['transaction', 'putPage', 'readPageTrustRows', 'restorePageTrust'] },
    async (engine) => {
      const write = (slug: string, tier: TrustTier, channel: string, truth: string, keep: boolean) => engine.transaction(tx =>
        withWriteTrust(tx, { tier, origin: { channel } }, async () => {
          const put = () => tx.putPage(slug, { title: slug, type: 'note', compiled_truth: truth, timeline: '' });
          await (keep ? withPageTierKept(tx, { sourceId: 'default', slug }, put) : put());
        }));
      const stamp = async (slug: string) => {
        const [row] = await engine.readPageTrustRows({ keys: [{ source_id: 'default', slug }] });
        return row && { trust_tier: row.trust_tier, write_origin: row.write_origin };
      };
      // An owner page appended to by an agent: the agent write lowers it, the restore raises it back.
      await write('notes/owner', 'operator_curated', 'owner', 'Owner body.', false);
      await write('notes/owner', 'agent_written', 'agent', 'Owner body.\n\nAgent row.', true);
      // An agent page appended to by the owner: the owner write raises it, the restore lowers it back.
      await write('notes/agent', 'agent_written', 'agent', 'Agent body.', false);
      await write('notes/agent', 'operator_curated', 'owner', 'Agent body.\n\nOwner row.', true);
      // Without the keep, the agent write lowers the owner page and stamps its own origin.
      await write('notes/lowered', 'operator_curated', 'owner', 'Owner body.', false);
      await write('notes/lowered', 'agent_written', 'agent', 'Owner body.\n\nAgent row.', false);
      return { owner: await stamp('notes/owner'), agent: await stamp('notes/agent'), lowered: await stamp('notes/lowered') };
    });
});
