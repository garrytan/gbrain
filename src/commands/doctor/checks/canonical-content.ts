import type { BrainEngine } from '../../../core/engine.ts';
import { ownedContentFreshness } from '../../../core/shared-skills/content-freshness.ts';
import type { Check } from '../../doctor.ts';

export async function checkCanonicalContentWrites(engine: BrainEngine, sourceIds?: string[]): Promise<Check | null> {
  try {
    const sources = await ownedContentFreshness(engine, sourceIds);
    if (!sources.length) return null;
    const pending = sources.reduce((sum, source) => sum + source.pending, 0);
    const recovering = sources.reduce((sum, source) => sum + source.recovering, 0);
    return { name: 'canonical_content_writes', status: recovering ? 'fail' : pending ? 'warn' : 'ok',
      message: recovering ? `${recovering} canonical content write(s) need recovery. Inspect sources writer status on the designated owner; preserve the durable requests.`
        : pending ? `${pending} canonical content write(s) are pending. Inspect sources writer status on the designated owner; upstream sync is not the publication mechanism.`
          : `${sources.length} writer-owned content source(s); no pending canonical publication or recovery.`,
      details: { writer_owned_count: sources.length, pending_count: pending, recovering_count: recovering } };
  } catch (error) {
    if (/does not exist|no such table/i.test(String(error))) return null;
    return { name: 'canonical_content_writes', status: 'warn', message: 'Canonical content publication status could not be verified; inspect sources writer status on the designated owner.' };
  }
}
