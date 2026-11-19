/**
 * Extraction settings: which LLM extraction prompts resolve relative dates
 * against the source's observation date.
 *
 * Informational (status ok): it reports state and the next step.
 */

import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { getExtractorVariant, isConsumerDateGroundingOn } from '../../../core/facts/extract.ts';

/** Prompts grounded by default with fact extraction, and the ones that need the setting set on explicitly. */
const DEFAULT_CONSUMERS = 'fact extraction, dream synthesis, extract_atoms and propose_takes';
const OPT_IN_LABEL = 'life chronicle events';

async function runExtractionDateGrounding(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  const [variant, optIn] = await Promise.all([getExtractorVariant(engine), isConsumerDateGroundingOn(engine, 'chronicle')]);
  const reextract = 'Facts extracted before this was on keep their original wording; re-extract a source only with the user\'s consent (foresights extract-conversation-facts --source-id <id> --dry-run previews it).';
  checks.push({
    name: 'extraction_date_grounding',
    status: 'ok',
    message: !variant.dateGrounding
      ? 'extraction.date_grounding is off: extraction prompts keep relative dates ("last week") as written. Dated pages still store their facts at the page date.'
      : optIn
        ? `Relative dates resolve against each source's observation date in ${DEFAULT_CONSUMERS}, and in ${OPT_IN_LABEL} (set on explicitly). ${reextract}`
        : `Relative dates resolve against each source's observation date in ${DEFAULT_CONSUMERS} (the default). ${OPT_IN_LABEL} keep their current prompt unless extraction.date_grounding is set to true. ${reextract}`,
  });
  return checks;
}

export const extractionDateGroundingEntry: DoctorEntry = {
  name: 'extraction_date_grounding',
  emits: ['extraction_date_grounding'],
  run: runExtractionDateGrounding,
};
