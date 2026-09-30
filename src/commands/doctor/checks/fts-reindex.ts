/**
 * fts_reindex_incomplete doctor check (#4795).
 *
 * `gbrain reindex-search-vector` stamps `fts.reindex_in_progress` (= target
 * language) in the config table before it flips the trigger functions and
 * clears it only after both backfills return. While the marker is set, rows
 * written after the flip and rows not yet backfilled are tokenized under
 * different text-search configurations, so keyword search silently matches
 * only part of the corpus — a data-correctness fault, hence `fail`. Healthy
 * brains return null (the caller pushes nothing).
 *
 * Lives in the doctor module dir per the peeled-façade rule.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { FTS_REINDEX_MARKER_KEY } from '../../../core/fts-language.ts';

export async function ftsReindexIncompleteCheck(engine: BrainEngine): Promise<Check | null> {
  const lang = await engine.getConfig(FTS_REINDEX_MARKER_KEY);
  if (!lang) return null;
  return {
    name: 'fts_reindex_incomplete',
    status: 'fail',
    message:
      `FTS reindex to language='${lang}' started but did not finish; keyword search is split ` +
      `across two tokenizers. Fix: GBRAIN_FTS_LANGUAGE=${lang} gbrain reindex-search-vector --yes ` +
      `(resumes from the saved checkpoint).`,
  };
}
