import type { BrainEngine } from '../engine.ts';
import { throwIfAborted } from '../abort-check.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import { digest } from '../persistence/digest.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { publishMaintenancePage, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { writeResponse } from '../persistence/service.ts';
import type { DiscoveredTranscript } from './transcript-discovery.ts';
import { emptyQuoteVerifyStats, groundSource, isDreamOwnedPage, resolveVerifyPrior, verifyDreamPage, type GroundedSource, type GroundingPass } from './synthesize-verify.ts';

interface OutputRef { slug: string; source_id: string; raw_source?: string; first_write_at?: Date; }
interface RetainedOutput { job_id: number | bigint; job_key: string; request: WriteRequest; }

export async function postprocessManagedSynthesis(
  engine: BrainEngine,
  authority: MaintenanceAuthority,
  refs: OutputRef[],
  childIds: number[],
  jobRawSource: Map<number, string>,
  transcripts: DiscoveredTranscript[],
  opts: { cycleDate: string; quoteVerify: boolean; sinceByTranscript: Map<string, Date>; signal?: AbortSignal; grounding?: GroundingPass },
) {
  const stats = emptyQuoteVerifyStats();
  const writtenRefs: OutputRef[] = [];
  const finalizedRefs: OutputRef[] = [];
  if (!refs.length) return { writtenRefs, finalizedRefs, stats };
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
    if (ref.source_id !== authority.writer.sourceId) throw new OperationError('source_changed', 'The synthesis output source changed.');
    const output = outputs.find(o => o.request.slug === ref.slug);
    const path = output && jobRawSource.get(Number(output.job_id));
    const transcript = path ? byPath.get(path) : undefined;
    const revision = output?.request.outcome?.revision;
    if (!output || !transcript || typeof revision !== 'string') {
      throw new OperationError('recovery_required', 'The synthesis output has no retained transcript and committed revision.');
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
        throw new OperationError('recovery_required', 'The retained synthesis postprocessing intent is unavailable.');
      }
      content = prior.intent.content;
    } else {
      const snapshot = await engine.readPageSnapshot(ref.slug, { sourceId: ref.source_id });
      if (!snapshot || snapshot.revision !== revision) {
        throw new OperationError('revision_conflict', 'The synthesis output changed after the child committed.');
      }
      const firstDate = snapshot.page.frontmatter.dream_created_cycle_date || snapshot.page.frontmatter.dream_cycle_date || opts.cycleDate;
      const since = ref.first_write_at ?? opts.sinceByTranscript.get(transcript.filePath);
      let page = isDreamOwnedPage(snapshot.page, since) ? { ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, dream_generated: true,
        dream_cycle_date: firstDate, dream_created_cycle_date: firstDate, raw_source: path } } : snapshot.page;
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
    await publishMaintenancePage(engine, authority, ref.slug, content, { requestId, expectedRevision: revision });
    writtenRefs.push(finalizedRef);
    finalizedRefs.push(finalizedRef);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { writtenRefs, finalizedRefs, stats };
}
