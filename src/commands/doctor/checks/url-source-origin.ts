import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';

/**
 * Active URL sources in the default clone directory with no record of who added them (`url-source-origin.ts`).
 * Read-only. gbrain cannot tell a remote caller's add from the local operator's for these, so the fix asks the user
 * and points at `gbrain sources record-origin`, whose preview changes nothing.
 */
export async function urlSourceOriginCheck(engine: BrainEngine): Promise<Check> {
  const { urlSourcesWithoutOrigin, recordOriginArgv, RECORD_ORIGIN_DOCS } = await import('../../../core/url-source-origin.ts');
  try {
    const sources = await urlSourcesWithoutOrigin(engine);
    const ids = sources.map(source => source.id);
    const details = { count: sources.length, sources, docs: RECORD_ORIGIN_DOCS };
    if (!sources.length) return { name: 'url_source_origin', status: 'ok', message: 'Every URL source clone records who added it, or was cloned where only the local CLI can clone.', details };
    return { name: 'url_source_origin', status: 'warn', details,
      message: `${sources.length} URL source(s) have no record of who added them: ${ids.join(', ')}. gbrain cannot tell whether a remote caller or the local operator added each one, `
        + `so their reclones use the clone settings of a local add. Ask the user which ones a remote caller added, preview with ${recordOriginArgv(['<id>...'], 'remote').join(' ')} `
        + '(or --local for the rest), then add --apply.',
      fix: { ask_user: true, argv: recordOriginArgv(ids, 'remote'), consent: [], actor: 'agent', requires_exclusive: false, docs: RECORD_ORIGIN_DOCS, verify: doctorVerify('url_source_origin'),
        why: 'Previews recording these sources as added by a remote caller and changes nothing; drop the ids the user says were added locally and record those with --local.',
        user_message: `gbrain cannot tell who added these URL sources: ${ids.join(', ')}. Which of them did a remote caller (an MCP client) add? Those get the clone settings sources added by remote callers get today; the rest are recorded as yours.` } };
  } catch (error) {
    return { name: 'url_source_origin', status: 'warn', fix_unavailable_reason: 'check_errored', details: { count: 'unknown' },
      message: `URL source origins could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
