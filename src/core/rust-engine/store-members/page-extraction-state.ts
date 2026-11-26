/**
 * The extraction watermark and partial-input receipt the Rust store keeps (engine-sql/page-extraction-state.ts;
 * extraction-watermark.ts owns the policy): the live page's watermark read (readPageExtractionWatermark), the commit of
 * a successful extraction (commitPageExtraction), the receipt read (readPageExtractionReceipt), the row delete
 * (clearPageExtractionState) and the receipt upsert (writePageExtractionReceipt). A hard page delete and a source delete
 * remove the rows, as PGLite's ON DELETE CASCADE does.
 *
 * What each member answers and why: rust/docs/store/page_extraction_state.md.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { PageExtractionCommit, PageExtractionPipeline, PageExtractionWatermarkRow } from '../../engine-sql/page-extraction-state.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readPageExtractionWatermark: StoreMember<[sourceId: string, slug: string, pipeline: PageExtractionPipeline], PageExtractionWatermarkRow | null> =
  async (brain, sourceId, slug, pipeline) =>
    await storeCall({ member: 'readPageExtractionWatermark', sourceId }, () => brain.readPageExtractionWatermark(sourceId, slug, pipeline)) as PageExtractionWatermarkRow | null;

export const commitPageExtraction: StoreMember<[commit: PageExtractionCommit], void> = async (brain, commit) => {
  await storeCall({ member: 'commitPageExtraction' }, () => brain.commitPageExtraction({ ...commit }));
};

export const readPageExtractionReceipt: StoreMember<[pageId: number, pipeline: PageExtractionPipeline], Record<string, unknown> | null> =
  async (brain, pageId, pipeline) =>
    await storeCall({ member: 'readPageExtractionReceipt' }, () => brain.readPageExtractionReceipt(pageId, pipeline)) as Record<string, unknown> | null;

export const clearPageExtractionState: StoreMember<[pageId: number, pipeline: PageExtractionPipeline], void> = async (brain, pageId, pipeline) => {
  await storeCall({ member: 'clearPageExtractionState' }, () => brain.clearPageExtractionState(pageId, pipeline));
};

export const writePageExtractionReceipt: StoreMember<[pageId: number, pipeline: PageExtractionPipeline, pipelineVersion: number, receipt: Record<string, unknown>], void> =
  async (brain, pageId, pipeline, pipelineVersion, receipt) => {
    await storeCall({ member: 'writePageExtractionReceipt' }, () => brain.writePageExtractionReceipt(pageId, pipeline, pipelineVersion, { ...receipt }));
  };
