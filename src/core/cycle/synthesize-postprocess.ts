import type { BrainEngine } from '../engine.ts';
import { throwIfAborted } from '../abort-check.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import type { Action } from '../agent-output.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { publicationHold } from '../persistence/accepted-pending.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import { digest } from '../persistence/digest.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { publishMaintenancePage, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { writeResponse } from '../persistence/service.ts';
import type { PhaseResult } from '../cycle.ts';
import type { DiscoveredTranscript } from './transcript-discovery.ts';
import { transcriptDerivation } from './dream-taint.ts';
import { declareDerivation, readDerivationDeclaration } from '../trust/taint.ts';
import { emptyQuoteVerifyStats, groundSource, isDreamOwnedPage, resolveVerifyPrior, verifyDreamPage, type GroundedSource, type GroundingPass } from './synthesize-verify.ts';

interface OutputRef { slug: string; source_id: string; raw_source?: string; seat?: string; first_write_at?: Date; }
interface RetainedOutput { job_id: number | bigint; job_key: string; request: WriteRequest; }

const writerStatusFix = (sourceId: string, why: string): Action => readFix(why, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

export async function postprocessManagedSynthesis(
  engine: BrainEngine,
  authority: MaintenanceAuthority,
  refs: OutputRef[],
  childIds: number[],
  jobRawSource: Map<number, string>,
  transcripts: DiscoveredTranscript[],
  opts: { cycleDate: string; quoteVerify: boolean; sinceByTranscript: Map<string, Date>; signal?: AbortSignal; grounding?: GroundingPass;
    /** #5575 I2: files under it are third-party speech; their outputs publish external_untrusted. */
    meetingTranscriptsDir?: string | null },
) {
  const stats = emptyQuoteVerifyStats();
  const writtenRefs: OutputRef[] = [];
  const finalizedRefs: OutputRef[] = [];
  let pending = 0;
  if (!refs.length) return { writtenRefs, finalizedRefs, stats, pending };
  const outputs = await engine.executeRaw<RetainedOutput>(
    `SELECT t.job_id,j.idempotency_key AS job_key,row_to_json(p) AS request
       FROM subagent_tool_executions t JOIN minion_jobs j ON j.id=t.job_id
       JOIN persistence_requests p ON p.request_id::text=t.input->>'request_id'
         AND p.source_id=$2 AND p.source_incarnation=$3 AND p.slug=t.input->>'slug'
         AND p.operation='put_page' AND p.state='committed'
         AND p.outcome->>'revision'=t.output->>'revision' AND t.output->>'state'='committed'
      WHERE t.job_id=ANY($1::int[]) AND t.tool_name='brain_put_page' AND t.status='complete'
      ORDER BY p.sequence DESC`, [childIds, authority.writer.sourceId, authority.writer.sourceIncarnation]);
  const byPath = new Map(transcripts.map(t => [t.filePath, t]));
  let grounded: GroundedSource | undefined;
  for (const ref of [...refs].sort((a, b) => (a.raw_source ?? '').localeCompare(b.raw_source ?? ''))) {
    throwIfAborted(opts.signal, '[dream] synthesis postprocessing');
    if (ref.source_id !== authority.writer.sourceId) {
      throw opError('source_changed', 'The synthesis output source changed.',
        `Synthesis output ${ref.slug} belongs to source ${ref.source_id}, not ${authority.writer.sourceId} that this dream cycle writes, so it was not postprocessed. Check source ${authority.writer.sourceId}'s writer status, then run gbrain dream --phase synthesize --source ${authority.writer.sourceId} again.`,
        { fix: writerStatusFix(authority.writer.sourceId, `Shows source ${authority.writer.sourceId}'s maintenance writer and requests in flight, read-only.`) });
    }
    const output = outputs.find(o => o.request.slug === ref.slug);
    const path = output && jobRawSource.get(Number(output.job_id));
    const transcript = path ? byPath.get(path) : undefined;
    const revision = output?.request.outcome?.revision;
    if (!output || !transcript || typeof revision !== 'string') {
      throw opError('recovery_required', 'The synthesis output has no retained transcript and committed revision.',
        `Synthesis output ${ref.slug} in source ${ref.source_id} has no retained transcript or committed put_page revision${output ? ` (child request ${output.request.request_id})` : ''}, so it cannot be verified. Inspect the writer status before running synthesis again; do not republish the page by hand.`,
        { fix: writerStatusFix(ref.source_id, `Shows source ${ref.source_id}'s committed and pending maintenance requests, read-only.`) });
    }
    const finalizedRef = { ...ref, raw_source: path };
    const key = digest({ kind: 'synthesis-postprocess-v1', source: authority.writer.sourceIncarnation,
      slug: ref.slug, job: output.job_key, output: output.request.id, revision, transcript: transcript.contentHash });
    const requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior) {
      await authorizeStoredRequest(engine, prior);
      if (prior.state === 'committed') { finalizedRefs.push(finalizedRef); continue; }
      if (['conflict', 'failed', 'cancelled'].includes(prior.state)) writeResponse(prior);
    }
    await authorizeStoredRequest(engine, output.request);
    let content: string;
    if (prior) {
      if (prior.intent?.kind !== 'managed_maintenance_page' || prior.intent.expected_revision !== revision || typeof prior.intent.content !== 'string') {
        throw opError('recovery_required', 'The retained synthesis postprocessing intent is unavailable.',
          `Postprocess request ${prior.request_id} for ${ref.slug} in source ${ref.source_id} exists, but its retained intent does not match revision ${revision}. Inspect it in writer status; do not resubmit under a new request.`,
          { fix: writerStatusFix(ref.source_id, `Shows request ${prior.request_id} and any recovery it holds, read-only.`) });
      }
      content = prior.intent.content;
    } else {
      const snapshot = await engine.readPageSnapshot(ref.slug, { sourceId: ref.source_id });
      if (!snapshot || snapshot.revision !== revision) {
        throw opError('revision_conflict', 'The synthesis output changed after the child committed.',
          `Page ${ref.slug} in source ${ref.source_id} changed after the synthesis child committed revision ${revision}, so postprocessing left it alone. Review the page; the next synthesis run processes fresh output.`,
          { fix: readFix(`Shows page ${ref.slug} as it is now, read-only.`, { argv: ['gbrain', 'get', '--source', ref.source_id, '--', ref.slug] }) });
      }
      const firstDate = snapshot.page.frontmatter.dream_created_cycle_date || snapshot.page.frontmatter.dream_cycle_date || opts.cycleDate;
      const since = ref.first_write_at ?? opts.sinceByTranscript.get(transcript.filePath);
      let page = isDreamOwnedPage(snapshot.page, since) ? { ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, dream_generated: true,
        dream_cycle_date: firstDate, dream_created_cycle_date: firstDate, raw_source: path, ...(transcript.seat ? { seat: transcript.seat } : {}) } } : snapshot.page;
      if (opts.quoteVerify) {
        const prior = since ? await resolveVerifyPrior(engine, snapshot.page, ref.source_id, since) : null;
        if (prior === 'unchanged') stats.skipped_unchanged++;
        else {
          if (prior) stats.preexisting_diffed++;
          const source = grounded?.path === transcript.filePath ? grounded : (grounded = groundSource(transcript.filePath, transcript.content));
          const mechanical = verifyDreamPage(page, [source], { prior, checkedAt: opts.cycleDate }, stats);
          const verified = opts.grounding ? await opts.grounding.apply(mechanical, [source], `page:${ref.source_id}:${ref.slug}`, opts.cycleDate) : mechanical;
          if (verified.changed) stats.pages_repaired++;
          page = { ...page, compiled_truth: verified.compiled_truth, timeline: verified.timeline, frontmatter: verified.frontmatter as typeof page.frontmatter };
        }
      }
      content = serializePageToMarkdown(page, snapshot.tags);
    }
    throwIfAborted(opts.signal, '[dream] synthesis postprocessing');
    // #5575 I2: the page publishes at its transcript's tier (lowered even when the content is unchanged), with its input edges.
    // A retained request replays the declaration it was admitted with (none for one admitted before tiers).
    const derivation = prior ? readDerivationDeclaration(prior.intent?.derivation) ?? undefined
      : await transcriptDerivation(engine, transcript, opts.meetingTranscriptsDir).then(d => declareDerivation(d.trust, d.inputs));
    try {
      await publishMaintenancePage(engine, authority, ref.slug, content, { requestId, expectedRevision: revision, derivation });
    } catch (error) {
      deferPublishOrThrow(error, `${ref.slug} (request ${requestId})`);
      pending++;
      continue;
    }
    writtenRefs.push(finalizedRef);
    finalizedRefs.push(finalizedRef);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { writtenRefs, finalizedRefs, stats, pending };
}

/**
 * A publish that is still pending after its wait (#5854) or whose admission
 * gave up on database contention without recording anything (#6051) is
 * deferred, never failed: the next cycle derives the same request id. Every
 * other error is rethrown. A contended publish writes one stderr line naming it.
 */
export function deferPublishOrThrow(error: unknown, what: string): void {
  const deferral = publicationHold(error);
  if (!deferral) throw error;
  if (deferral === 'contention') {
    process.stderr.write(`[dream] synthesize: ${what} deferred, write admission blocked by database contention; the next cycle admits it\n`);
  }
}

export const SYNTH_PUBLISH_DEFERRED = 'publish deferred (writer busy); finishes next cycle, no action needed';

/**
 * #5854/#6051: an output publish deferred by deferPublishOrThrow is never
 * counted as written: the phase warns, the cooldown stays unstamped, and the
 * next cycle resumes the same request id.
 */
export function withPublishPending(pending: number, result: PhaseResult): PhaseResult {
  if (!pending) return result;
  return { ...result, status: 'warn', summary: `${result.summary}; ${SYNTH_PUBLISH_DEFERRED}`,
    details: { ...result.details, publish_pending: pending, publish_deferred: SYNTH_PUBLISH_DEFERRED } };
}
