/**
 * GBRA-161 PR 5: single-item page generations, for the derived pages one writer rewrites in place under a fixed slug: the
 * dream summary (kind `dream_summary`, S-2), the `think` synthesis page (`think_synthesis`, S-10) and the drift report
 * (`drift_report`, S-11). One owner key per page (`page:<slug>`) and one item, the page itself.
 *
 * - Expected revision: the writer passes the page revision it read before composing (null: no page). It is the
 *   generation's input pin, rechecked under the page lock, so a writer whose page changed since is fenced
 *   (`generation_fenced`, `pin_moved`) and writes nothing.
 * - Version first: a live page the write changes is copied to `page_versions` (`gbrain restore`) and its bounded preimage
 *   is kept on the ledger (`gbrain repair generations --kind <kind> --mode restore`), in the same transaction.
 * - Trust: a derived page carries its derivation (the writer's tier and taint inputs), applied in that transaction.
 *
 * Managed brains keep their coordinated page request, which already binds the expected revision and versions first.
 */
import type { BrainEngine } from '../../engine.ts';
import type { PageType } from '../../types.ts';
import { retireDerivedPagesInTransaction } from '../../persistence/derived-retirement-hold.ts';
import { lowerToDerivedTier, recordTaintEdges } from '../../trust/taint.ts';
import type { TaintInput, WriteTrust } from '../../trust/tier.ts';
import type { GenerationAdapter, GenerationKey } from '../contract.ts';
import { publishGeneration, type PublishOutcome } from '../publish.ts';
import { pageIdentityHash, pageItemRow, preimageIdentity, readPageRows, type PageRowData } from './page.ts';

export const DREAM_SUMMARY_KIND = 'dream_summary';
export const THINK_SYNTHESIS_KIND = 'think_synthesis';
export const DRIFT_REPORT_KIND = 'drift_report';
export type SinglePageKind = typeof DREAM_SUMMARY_KIND | typeof THINK_SYNTHESIS_KIND | typeof DRIFT_REPORT_KIND;

export interface SinglePageContent {
  type: string; title: string; compiled_truth: string; timeline?: string; frontmatter: Record<string, unknown>; tags?: readonly string[];
}
export interface SinglePageDerivation { trust: WriteTrust; inputs: readonly TaintInput[] }
export interface SinglePageContext { page: SinglePageContent; derivation?: SinglePageDerivation }

export const singlePageOwnerKey = (slug: string) => `page:${slug}`;
const slugOf = (key: GenerationKey) => key.ownerKey.slice('page:'.length);

async function readRow(engine: BrainEngine, sourceId: string, slug: string): Promise<PageRowData | undefined> {
  return (await readPageRows(engine, sourceId, 'p.slug = $2', [slug]))[0];
}

/** Writes the page: the live page it changes goes to page_versions first; then the derivation's tier and input edges. */
async function writePage(tx: BrainEngine, sourceId: string, slug: string, page: SinglePageContent, identity: string, derivation?: SinglePageDerivation): Promise<void> {
  const prior = await readRow(tx, sourceId, slug);
  if (prior && !prior.deleted && !prior.segmented && pageIdentityHash(prior) !== identity) await tx.createVersion(slug, { sourceId });
  const written = await tx.putPage(slug, { type: page.type as PageType, title: page.title, compiled_truth: page.compiled_truth, timeline: page.timeline ?? '',
    frontmatter: page.frontmatter }, { sourceId });
  for (const tag of page.tags ?? []) await tx.addTag(slug, tag, { sourceId, tagSource: 'frontmatter' });
  if (!derivation) return;
  await lowerToDerivedTier(tx as never, 'pages', [Number(written.id)], derivation.trust);
  await recordTaintEdges(tx, { table: 'pages', id: Number(written.id), sourceId }, derivation.inputs);
}

function singlePageAdapter(kind: SinglePageKind): GenerationAdapter<SinglePageContext> {
  return {
    kind,
    retiredBy: 'generation-restore',
    modelProduced: false,
    lockKeys: key => [{ sourceId: key.sourceId, slug: slugOf(key) }],
    async readInput(engine, key) {
      const snapshot = await engine.readPageSnapshot(slugOf(key), { sourceId: key.sourceId, includeDeleted: true });
      return { pin: snapshot?.revision ?? 'absent', size: 0 };
    },
    async readItems(engine, key) {
      const row = await readRow(engine, key.sourceId, slugOf(key));
      return new Map(row ? [[row.slug, pageItemRow(row, true)]] : []);
    },
    legacyEvidence: async () => new Set<string>(),
    async publishItems(tx, key, items, context) {
      for (const item of items) await writePage(tx, key.sourceId, item.key, context!.page, item.identityHash, context!.derivation);
    },
    retireItems: (tx, key, itemKeys, retiredBy) => retireDerivedPagesInTransaction(tx, key.sourceId, itemKeys, retiredBy),
    async restoreItem(tx, key, itemKey, preimage) {
      const page: SinglePageContent = { type: String(preimage.type), title: String(preimage.title), compiled_truth: String(preimage.compiled_truth ?? ''),
        timeline: String(preimage.timeline ?? ''), frontmatter: (preimage.frontmatter as Record<string, unknown>) ?? {}, tags: (preimage.tags as string[]) ?? [] };
      await writePage(tx, key.sourceId, itemKey, page, preimageIdentity(preimage));
    },
    preimageIdentity,
  };
}

export const dreamSummaryAdapter = singlePageAdapter(DREAM_SUMMARY_KIND);
export const thinkSynthesisAdapter = singlePageAdapter(THINK_SYNTHESIS_KIND);
export const driftReportAdapter = singlePageAdapter(DRIFT_REPORT_KIND);
const ADAPTERS: Record<SinglePageKind, GenerationAdapter<SinglePageContext>> = {
  [DREAM_SUMMARY_KIND]: dreamSummaryAdapter, [THINK_SYNTHESIS_KIND]: thinkSynthesisAdapter, [DRIFT_REPORT_KIND]: driftReportAdapter,
};

export interface SinglePageRequest extends SinglePageContext {
  kind: SinglePageKind; sourceId: string; slug: string;
  /** The page revision the writer read before composing; null when there was no page. */
  expectedRevision: string | null;
  runId?: string;
}

/**
 * Publishes one single-item page generation (unmanaged). The tags the page already holds stay (a write never removes one),
 * so the item identity covers them. Throws `generation_fenced` when the page moved past `expectedRevision`; returns the
 * outcome and the page id.
 */
export async function publishSinglePage(engine: BrainEngine, request: SinglePageRequest): Promise<{ outcome: PublishOutcome; pageId: number | null }> {
  const { kind, sourceId, slug, page } = request;
  const current = await readRow(engine, sourceId, slug);
  const tags = [...new Set([...(current && !current.deleted ? current.tags : []), ...(page.tags ?? [])])];
  const identityHash = pageIdentityHash({ type: page.type, title: page.title, compiled_truth: page.compiled_truth, timeline: page.timeline ?? '',
    frontmatter: page.frontmatter, tags });
  const outcome = await publishGeneration(engine, ADAPTERS[kind], { key: { kind, sourceId, ownerKey: singlePageOwnerKey(slug) }, items: [{ key: slug, content: '', identityHash }],
    input: { pin: request.expectedRevision ?? 'absent', size: 0 }, context: { page, derivation: request.derivation }, runId: request.runId,
    ...(request.derivation ? { trust: request.derivation.trust } : {}) });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  return { outcome, pageId: row ? Number(row.id) : null };
}
