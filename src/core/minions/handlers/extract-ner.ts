/**
 * `extract-ner` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * v0.41.18.0 (A10, T7): extract-ner handler for the gbrain onboard
 * remediation pipeline. Wraps extractNerLinks; emits typed_ner kind
 * alongside the by-mention 'plain' kind. NOT in PROTECTED_JOB_NAMES
 * (regex-only, no LLM spend).
 */
export function makeExtractNerHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { extractNerLinks } = await import('../../extract-ner.ts');
    const data = (job.data ?? {}) as { sourceId?: string };
    return await extractNerLinks(engine, {
      sourceIdFilter: data.sourceId,
    });
  };
}
