/**
 * The facts backstop effect's two extraction reads (BrainEngine hasPendingFactsExtraction,
 * hasCompletedFactsExtraction): whether a page still has a facts extraction waiting to run, and whether one finished
 * for it (engine-sql/facts-backstop.ts on the SQL engines; gbrain-store `jobs/facts_extraction.rs`). What each answers:
 * rust/docs/store/jobs.md ("Facts extraction reads").
 */
import { storeCall, type StoreMember } from './common.ts';

export const hasPendingFactsExtraction: StoreMember<[pageId: number | string, jobStates: readonly string[]], boolean> =
  async (brain, pageId, jobStates) => (await storeCall({ member: 'hasPendingFactsExtraction' }, () =>
    brain.hasPendingFactsExtraction(String(pageId), [...jobStates]))) === true;

export const hasCompletedFactsExtraction: StoreMember<[pageId: number | string], boolean> =
  async (brain, pageId) => (await storeCall({ member: 'hasCompletedFactsExtraction' }, () =>
    brain.hasCompletedFactsExtraction(String(pageId)))) === true;
