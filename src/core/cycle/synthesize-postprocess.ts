import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { throwIfAborted } from '../abort-check.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import type { Action } from '../agent-output.ts';
import { opError } from '../ops/contract.ts';
import { ItemRun } from '../item-failure.ts';
import { readFix } from '../ops/op-fix.ts';
import { publicationHold } from '../persistence/accepted-pending.ts';
import { isWriteCapacityWait, outstandingCapacityOf } from '../persistence/admission-retry.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import { digest } from '../persistence/digest.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { parseWriteRequestId } from '../persistence/preconditions.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { maintenancePreflight, publishMaintenancePage, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import type { PhaseResult } from '../cycle.ts';
import type { DiscoveredTranscript } from './transcript-discovery.ts';
import { transcriptDerivation } from './dream-taint.ts';
import { declareDerivation, readDerivationDeclaration } from '../trust/taint.ts';
import { emptyQuoteVerifyStats, groundSource, isDreamOwnedPage, resolveVerifyPrior, verifyDreamPage, type GroundedSource, type GroundingPass } from './synthesize-verify.ts';
import { attributionChecksEnabled } from './attribution-checks.ts';
import { resolveGroundingDecide } from './grounding-decide.ts';
import { resolveCycleDate } from './cycle-date.ts';
import { DEFERRED_READ_LABEL, isPostprocessReadTimeout, pendingOutputsFor, readPostprocessDeferrals, recordPostprocessPass,
  type DeferredRead, type PendingOutput, type PostprocessDeferral } from './synthesize-postprocess-deferral.ts';

interface OutputRef { slug: string; source_id: string; raw_source?: string; seat?: string; first_write_at?: Date; }
export interface RetainedOutput { job_id: number | bigint; job_key: string; input_slug: string; request: WriteRequest; }
/**
 * An output postprocessing leaves alone for good and reports once (GBRA-130 A-4): a later non-maintenance write
 * moved its page (#6360, revision_conflict), its postprocess request ended without committing (the request's
 * error_code), or its retained request or carried provenance cannot be finished (recovery_required).
 */
export interface PostprocessConflict { slug: string; source_id: string; request_id: string; code: string; message: string; fix: Action; }

export const POSTPROCESS_CONFLICTS_KEY = 'dream.synthesize.postprocess_conflicts';
const CONFLICT_MEMORY_MS = 30 * 86_400_000;

const sameBody = (content: unknown, page: { compiled_truth: string; timeline?: string | null }, slug: string) => {
  if (typeof content !== 'string') return false;
  const child = parseMarkdown(content, slug);
  return child.compiled_truth.trim() === page.compiled_truth.trim() && (child.timeline ?? '').trim() === (page.timeline ?? '').trim();
};

/** Committed-or-pending requests on the output page after the child's put_page, oldest first. */
async function laterRequests(engine: BrainEngine, output: WriteRequest): Promise<WriteRequest[]> {
  return engine.executeRaw<WriteRequest>(
    `SELECT * FROM persistence_requests
      WHERE source_id=$1 AND source_incarnation=$2 AND slug=$3 AND sequence > $4
        AND state IN ('queued','running','recovering','committed')
      ORDER BY sequence`, [output.source_id, output.source_incarnation, output.slug, output.sequence]);
}

const localMaintenance = (r: WriteRequest) => r.operation === 'submit_job' && r.intent?.kind === 'managed_maintenance_page' && r.authority?.remote === false;

const writerStatusFix = (sourceId: string, why: string): Action => readFix(why, { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
const receiptFix = (requestId: string): Action => readFix(`Reads postprocess request ${requestId}'s durable receipt: its state, recorded error and retained intent, read-only.`,
  { argv: ['gbrain', 'write-request', '--', requestId] });

/** The slug submitPageMutation journals for a client slug: it lowercases it (page-mutations.ts). */
export const journaledPageSlug = (slug: string): string => slug.toLowerCase();

/**
 * #6616: each child's completed `brain_put_page` call joined to the committed
 * journal row it produced. The retained tool input holds what the child sent;
 * the journal holds the canonical forms (`parseWriteRequestId`: a printable
 * client id becomes its UUIDv5, a UUID is lowercased; the slug is lowercased),
 * so both are canonicalized here before matching on request id, source,
 * incarnation, committed put_page, slug and revision. Newest first. Shared by
 * slug discovery and postprocessing so the two cannot disagree.
 */
export async function loadCommittedSynthesisOutputs(engine: BrainEngine, authority: MaintenanceAuthority, childIds: number[]): Promise<RetainedOutput[]> {
  return committedRequestsFor(engine, authority, await retainedPutPageCalls(engine, childIds));
}

interface RetainedCall { job_id: number | bigint; job_key: string; input_slug: string; slug: string; requestId: string; revision: string; started_at?: string }

async function retainedPutPageCalls(engine: BrainEngine, childIds: number[]): Promise<RetainedCall[]> {
  if (!childIds.length) return [];
  const tools = await engine.executeRaw<{ job_id: number | bigint; job_key: string; input: Record<string, unknown> | null; output: Record<string, unknown> | null; started_at: Date | string | null }>(
    `SELECT t.job_id,j.idempotency_key AS job_key,t.input,t.output,t.started_at
       FROM subagent_tool_executions t JOIN minion_jobs j ON j.id=t.job_id
      WHERE t.job_id=ANY($1::int[]) AND t.tool_name='brain_put_page' AND t.status='complete' AND t.output->>'state'='committed'`, [childIds]);
  return tools.flatMap(t => {
    const inputSlug = t.input?.slug;
    const revision = t.output?.revision;
    let requestId: string | undefined;
    try { requestId = parseWriteRequestId(t.input?.request_id); } catch { return []; }
    const startedAt = t.started_at ? new Date(t.started_at) : null;
    return requestId && typeof inputSlug === 'string' && typeof revision === 'string'
      ? [{ job_id: t.job_id, job_key: t.job_key, input_slug: inputSlug, slug: journaledPageSlug(inputSlug), requestId, revision,
        ...(startedAt && !Number.isNaN(startedAt.getTime()) ? { started_at: startedAt.toISOString() } : {}) }] : [];
  });
}

/**
 * #6757: the committed journal row of each retained call, looked up by request id (a uuid, as the column is) within
 * the cycle's source, which `persistence_requests_request_id` serves; a text cast of the column defeats every index.
 */
export const COMMITTED_OUTPUT_REQUESTS_SQL = `SELECT row_to_json(p) AS request FROM persistence_requests p
      WHERE p.source_id=$2 AND p.request_id=ANY($1::uuid[]) AND p.source_incarnation=$3
        AND p.operation='put_page' AND p.state='committed'
      ORDER BY p.sequence DESC`;

async function committedRequestsFor(engine: BrainEngine, authority: MaintenanceAuthority, calls: RetainedCall[]): Promise<RetainedOutput[]> {
  if (!calls.length) return [];
  const requests = await engine.executeRaw<{ request: WriteRequest }>(COMMITTED_OUTPUT_REQUESTS_SQL,
    [[...new Set(calls.map(c => c.requestId))], authority.writer.sourceId, authority.writer.sourceIncarnation]);
  return requests.flatMap(({ request }) => calls
    .filter(c => c.requestId === String(request.request_id) && c.slug === request.slug && c.revision === request.outcome?.revision)
    .map(c => ({ job_id: c.job_id, job_key: c.job_key, input_slug: c.input_slug, request })));
}

/** Child outputs for postprocessing, or the outputs to carry when the committed-outputs read hit the statement timeout (#6757). */
export interface CommittedOutputs { outputs: RetainedOutput[]; deferred?: { read: DeferredRead; elapsed_ms: number; pending: PendingOutput[] } }

/**
 * #6757: `loadCommittedSynthesisOutputs` for the phase. A statement timeout on the journal join defers the pass:
 * every retained call becomes a pending output with its transcript path and content hash, so a later pass finishes it
 * without the job rows or the transcript's current hash. Any other error, and a cancelled cycle, propagates.
 */
export async function loadCommittedOutputsOrDefer(engine: BrainEngine, authority: MaintenanceAuthority, childIds: number[],
  ctx: { jobRawSource: Map<number, string>; transcripts: Array<{ filePath: string; contentHash: string; seat?: string }>; signal?: AbortSignal }): Promise<CommittedOutputs> {
  const calls = await retainedPutPageCalls(engine, childIds);
  const started = Date.now();
  try {
    return { outputs: await committedRequestsFor(engine, authority, calls) };
  } catch (error) {
    if (!isPostprocessReadTimeout(error, ctx.signal)) throw error;
    const byPath = new Map(ctx.transcripts.map(t => [t.filePath, t]));
    const pending = calls.flatMap(c => {
      const transcript = byPath.get(ctx.jobRawSource.get(Number(c.job_id)) ?? '');
      return transcript ? [{ request_id: c.requestId, slug: c.slug, input_slug: c.input_slug, revision: c.revision, job_key: c.job_key,
        raw_source: transcript.filePath, transcript_hash: transcript.contentHash, ...(transcript.seat ? { seat: transcript.seat } : {}),
        ...(c.started_at ? { first_write_at: c.started_at } : {}) }] : [];
    });
    return { outputs: [], deferred: { read: 'committed_outputs', elapsed_ms: Date.now() - started, pending } };
  }
}

/** A transcript as postprocessing reads it: the discovered one, or a carried output's file read again (#6757). */
type TranscriptInput = Pick<DiscoveredTranscript, 'filePath' | 'contentHash' | 'content' | 'seat'>;
interface Item { ref: OutputRef; output?: RetainedOutput; path?: string; transcript?: TranscriptInput; hash?: string }

const pendingOf = (item: Item): PendingOutput[] => item.output && item.path && item.hash && typeof item.output.request.outcome?.revision === 'string'
  ? [{ request_id: String(item.output.request.request_id), slug: item.output.request.slug, input_slug: item.output.input_slug,
    revision: item.output.request.outcome.revision, job_key: item.output.job_key, raw_source: item.path, transcript_hash: item.hash,
    ...(item.transcript?.seat ? { seat: item.transcript.seat } : {}), ...(item.ref.first_write_at ? { first_write_at: item.ref.first_write_at.toISOString() } : {}) }] : [];

/** A carried output's transcript: the one discovered this pass at its path, else its file; null for one no longer readable. */
function carriedTranscript(p: PendingOutput, byPath: Map<string, DiscoveredTranscript>): TranscriptInput | null | undefined {
  const found = byPath.get(p.raw_source);
  if (found) return found;
  // A conversation page is discovered from the database, never read here; it stays pending until a pass discovers it.
  if (!p.raw_source.startsWith('/')) return undefined;
  try { return { filePath: p.raw_source, contentHash: p.transcript_hash, content: readFileSync(p.raw_source, 'utf8'), ...(p.seat ? { seat: p.seat } : {}) }; }
  catch { return null; }
}

export async function postprocessManagedSynthesis(
  engine: BrainEngine,
  authority: MaintenanceAuthority,
  refs: OutputRef[],
  childIds: number[],
  jobRawSource: Map<number, string>,
  transcripts: DiscoveredTranscript[],
  opts: { cycleDate: string; quoteVerify: boolean; sinceByTranscript: Map<string, Date>; signal?: AbortSignal; grounding?: GroundingPass;
    /** The child outputs slug discovery already loaded (loadCommittedOutputsOrDefer). */
    committedOutputs?: CommittedOutputs;
    /** #5575 I2: files under it are third-party speech; their outputs publish external_untrusted. */
    meetingTranscriptsDir?: string | null },
) {
  const stats = emptyQuoteVerifyStats();
  const writtenRefs: OutputRef[] = [];
  const finalizedRefs: OutputRef[] = [];
  const conflicts: PostprocessConflict[] = [];
  let pending = 0;
  const { sourceId, sourceIncarnation } = authority.writer;
  // #6757: outputs an earlier pass deferred are finished here, whether or not their child is in this pass.
  const carried = await pendingOutputsFor(engine, sourceId, sourceIncarnation);
  const settled: string[] = [], carry: PendingOutput[] = [];
  let deferred: CommittedOutputs['deferred'];
  if (opts.committedOutputs?.deferred) {
    const deferral = await recordPostprocessPass(engine, sourceId, sourceIncarnation, { settled, deferred: opts.committedOutputs.deferred });
    return { writtenRefs, finalizedRefs, stats, pending: deferral?.outputs ?? 0, conflicts, deferral };
  }
  if (!refs.length && !carried.length) return { writtenRefs, finalizedRefs, stats, pending, conflicts, deferral: null };
  const reported = await readReportedConflicts(engine);
  const supersession = opts.quoteVerify ? await attributionChecksEnabled(engine) : false; // #5425 [UC4], default off
  const outputs = opts.committedOutputs?.outputs ?? await loadCommittedSynthesisOutputs(engine, authority, childIds);
  const byPath = new Map(transcripts.map(t => [t.filePath, t]));
  const items: Item[] = [...refs].sort((a, b) => (a.raw_source ?? '').localeCompare(b.raw_source ?? '')).map(ref => {
    const output = outputs.find(o => o.request.slug === ref.slug);
    const path = output && jobRawSource.get(Number(output.job_id));
    const transcript = path ? byPath.get(path) : undefined;
    return { ref, output, path, transcript, hash: transcript?.contentHash };
  });
  const open = carried.filter(p => !outputs.some(o => String(o.request.request_id) === p.request_id));
  if (open.length) {
    const started = Date.now();
    let found: RetainedOutput[] | null = null;
    try {
      found = await committedRequestsFor(engine, authority, open.map(p => ({ job_id: 0, job_key: p.job_key, input_slug: p.input_slug, slug: p.slug, requestId: p.request_id, revision: p.revision })));
    } catch (error) {
      if (!isPostprocessReadTimeout(error, opts.signal)) throw error;
      deferred = { read: 'committed_outputs', elapsed_ms: Date.now() - started, pending: [] };
      pending += open.length;
    }
    for (const p of found ? open : []) {
      const output = found!.find(o => String(o.request.request_id) === p.request_id);
      const transcript = carriedTranscript(p, byPath);
      if (transcript === undefined) { carry.push(p); pending++; continue; }
      if (!output || !transcript) {
        settled.push(p.request_id);
        if (!reported.has(p.request_id)) conflicts.push({ slug: p.slug, source_id: sourceId, request_id: p.request_id, code: 'recovery_required',
          message: `Deferred synthesis output ${p.slug} in source ${sourceId} ${output ? `lost its transcript ${p.raw_source}` : `has no committed journal row for child request ${p.request_id}`}, so postprocessing left it alone and did not verify or stamp it. Review the page; this output is not retried.`,
          fix: writerStatusFix(sourceId, `Shows source ${sourceId}'s committed and pending maintenance requests, read-only.`) });
        continue;
      }
      items.push({ ref: { slug: output.request.slug, source_id: sourceId, raw_source: p.raw_source, ...(p.seat ? { seat: p.seat } : {}),
        ...(p.first_write_at ? { first_write_at: new Date(p.first_write_at) } : {}) }, output, path: p.raw_source, transcript, hash: p.transcript_hash });
    }
  }
  // #6757: a statement timeout on this request's own read defers it and every output after it.
  let readsFrom = 0;
  const readPrior = async (index: number, requestId: string): Promise<WriteRequest | null | undefined> => {
    const started = Date.now();
    try { return await getWriteRequest(engine, authority.writer.principal, requestId); } catch (error) {
      if (!isPostprocessReadTimeout(error, opts.signal)) throw error;
      deferred = { read: 'postprocess_request', elapsed_ms: Date.now() - started, pending: items.slice(index).flatMap(pendingOf) };
      readsFrom = index;
      return undefined;
    }
  };
  let grounded: GroundedSource | undefined;
  const run = new ItemRun('synthesize.postprocess');
  let itemError: unknown;
  const postprocessOne = async (index: number, { ref, output, path, transcript, hash }: Item): Promise<'stop' | void> => {
    if (ref.source_id !== authority.writer.sourceId) {
      throw opError('source_changed', 'The synthesis output source changed.',
        `Synthesis output ${ref.slug} belongs to source ${ref.source_id}, not ${authority.writer.sourceId} that this dream cycle writes, so it was not postprocessed. Check source ${authority.writer.sourceId}'s writer status, then run gbrain dream --phase synthesize --source ${authority.writer.sourceId} again.`,
        { fix: writerStatusFix(authority.writer.sourceId, `Shows source ${authority.writer.sourceId}'s maintenance writer and requests in flight, read-only.`) });
    }
    const revision = output?.request.outcome?.revision;
    if (!output || !transcript || typeof revision !== 'string') {
      throw opError('recovery_required', 'The synthesis output has no retained transcript and committed revision.',
        `Synthesis output ${ref.slug} in source ${ref.source_id} has no retained transcript or committed put_page revision${output ? ` (child request ${output.request.request_id})` : ''}, so it cannot be verified. Inspect the writer status before running synthesis again; do not republish the page by hand.`,
        { fix: writerStatusFix(ref.source_id, `Shows source ${ref.source_id}'s committed and pending maintenance requests, read-only.`) });
    }
    const outputRequestId = String(output.request.request_id);
    const finalizedRef = { ...ref, raw_source: path };
    // #6360: a postprocess adopted onto a maintenance-only drift binds its base revision too.
    const postprocessId = (base: string) => {
      const key = digest({ kind: 'synthesis-postprocess-v1', source: authority.writer.sourceIncarnation,
        slug: ref.slug, job: output.job_key, output: output.request.id, revision, transcript: hash, ...(base === revision ? {} : { base }) });
      return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
    };
    let base = revision;
    let requestId = postprocessId(base);
    let prior = await readPrior(index, requestId);
    if (prior === undefined) return 'stop';
    let snapshot: Awaited<ReturnType<BrainEngine['readPageSnapshot']>> = null;
    if (!prior) {
      snapshot = await engine.readPageSnapshot(ref.slug, { sourceId: ref.source_id });
      if (!snapshot || snapshot.revision !== revision) {
        const later = await laterRequests(engine, output.request);
        const ours = later.find(r => localMaintenance(r) && typeof r.intent?.expected_revision === 'string'
          && r.request_id === postprocessId(r.intent.expected_revision as string));
        if (ours) {
          base = ours.intent!.expected_revision as string;
          requestId = ours.request_id;
          prior = await readPrior(index, requestId);
          if (prior === undefined) return 'stop';
        } else if (snapshot && later.filter(r => r.state === 'committed').every(localMaintenance) && sameBody(output.request.intent?.content, snapshot.page, ref.slug)) {
          base = snapshot.revision;
          requestId = postprocessId(base);
        } else {
          settled.push(outputRequestId);
          if (!reported.has(requestId)) conflicts.push({ slug: ref.slug, source_id: ref.source_id, request_id: requestId, code: 'revision_conflict',
            message: `Page ${ref.slug} in source ${ref.source_id} changed after the synthesis child committed revision ${revision}, so postprocessing left it alone and did not verify or stamp it. Review the page; this output is not retried.`,
            fix: readFix(`Shows page ${ref.slug} as it is now, read-only.`, { argv: ['gbrain', 'get', '--source', ref.source_id, '--', ref.slug] }) });
          return;
        }
      }
    }
    if (prior) {
      await authorizeStoredRequest(engine, prior);
      if (prior.state === 'committed') { settled.push(outputRequestId); finalizedRefs.push(finalizedRef); return; }
      if (['conflict', 'failed', 'cancelled'].includes(prior.state)) {
        settled.push(outputRequestId);
        const code = prior.error_code ?? prior.state;
        if (!reported.has(prior.request_id)) conflicts.push({ slug: ref.slug, source_id: ref.source_id, request_id: prior.request_id, code,
          message: `Postprocess request ${prior.request_id} for page ${ref.slug} in source ${ref.source_id} ended ${prior.state} (${code}) without committing, so postprocessing left the page alone and did not verify or stamp it. Read the request's receipt for the cause; this output is not retried.`,
          fix: receiptFix(prior.request_id) });
        return;
      }
    }
    await authorizeStoredRequest(engine, output.request);
    let content: string;
    if (prior) {
      if (prior.intent?.kind !== 'managed_maintenance_page' || prior.intent.expected_revision !== base || typeof prior.intent.content !== 'string') {
        settled.push(outputRequestId);
        if (!reported.has(prior.request_id)) conflicts.push({ slug: ref.slug, source_id: ref.source_id, request_id: prior.request_id, code: 'recovery_required',
          message: `Postprocess request ${prior.request_id} for page ${ref.slug} in source ${ref.source_id} exists, but its retained intent does not match revision ${base}, so postprocessing left the page alone and did not verify or stamp it. Read the request's receipt; do not resubmit it under a new request. This output is not retried.`,
          fix: receiptFix(prior.request_id) });
        return;
      }
      content = prior.intent.content;
    } else {
      if (!snapshot) throw new Error(`synthesis postprocess: no snapshot for ${ref.slug}`);
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
          const mechanical = verifyDreamPage(page, [source], { prior, checkedAt: opts.cycleDate, supersession }, stats);
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
      await publishMaintenancePage(engine, authority, ref.slug, content, { requestId, expectedRevision: base, derivation });
    } catch (error) {
      deferPublishOrThrow(error, `${ref.slug} (request ${requestId})`);
      // #6757: carried too, so the same request finishes even after the transcript grows or the child's rows are pruned.
      carry.push(...pendingOf(items[index]!));
      pending++;
      return;
    }
    settled.push(outputRequestId);
    writtenRefs.push(finalizedRef);
    finalizedRefs.push(finalizedRef);
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  for (const [index, item] of items.entries()) {
    throwIfAborted(opts.signal, '[dream] synthesis postprocessing');
    try {
      if (await postprocessOne(index, item) === 'stop') break;
      run.succeed();
    } catch (error) {
      throwIfAborted(opts.signal, '[dream] synthesis postprocessing');
      run.fail(item.ref.slug, error);
      itemError ??= error;
    }
  }
  if (deferred?.read === 'postprocess_request') pending += items.length - readsFrom;
  if (conflicts.length) await rememberConflicts(engine, reported, conflicts);
  const deferral = await recordPostprocessPass(engine, sourceId, sourceIncarnation, { settled, carry, deferred });
  if (itemError) throw itemError;
  return { writtenRefs, finalizedRefs, stats, pending, conflicts, deferral };
}

async function readReportedConflicts(engine: BrainEngine): Promise<Map<string, string>> {
  try {
    const parsed = JSON.parse(await engine.getConfig(POSTPROCESS_CONFLICTS_KEY) ?? '{}') as Record<string, unknown>;
    const cutoff = Date.now() - CONFLICT_MEMORY_MS;
    return new Map(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && Date.parse(e[1]) > cutoff));
  } catch { return new Map(); }
}

async function rememberConflicts(engine: BrainEngine, reported: Map<string, string>, conflicts: PostprocessConflict[]): Promise<void> {
  const at = new Date().toISOString();
  for (const c of conflicts) reported.set(c.request_id, at);
  await engine.setConfig(POSTPROCESS_CONFLICTS_KEY, JSON.stringify(Object.fromEntries(reported)));
}

/**
 * #6360, GBRA-130 A-4: postprocess conflicts are terminal (retrying cannot
 * help), so the phase warns once per output, naming each page and its code,
 * instead of failing every cycle, and the cooldown still stamps.
 */
export function withPostprocessConflicts(conflicts: PostprocessConflict[], result: PhaseResult): PhaseResult {
  if (!conflicts.length) return result;
  return { ...result, status: result.status === 'fail' ? 'fail' : 'warn',
    summary: `${result.summary}; ${conflicts.length} output page(s) left alone, not verified or stamped: ${conflicts.map(c => `${c.slug} (${c.code})`).join(', ')}`,
    details: { ...result.details, postprocess_conflicts: conflicts } };
}

/**
 * A publish that is still pending after its wait (#5854) or whose admission
 * gave up on database contention without recording anything (#6051) is
 * deferred, never failed: the next cycle derives the same request id. So is
 * an unadmitted publish refused by a known positive outstanding-request cap
 * (`queue_capacity` with outstanding/limit counts, a principal or brain scope
 * and no write receipt): it waits for other writes to settle. A zero cap,
 * cumulative quotas, unknown capacity and a refusal carrying a receipt are
 * rethrown with every other error. A contended or capacity-blocked publish
 * writes one stderr line naming it.
 */
export function deferPublishOrThrow(error: unknown, what: string): void {
  const capacity = isWriteCapacityWait(error) && error.writeRequest == null ? outstandingCapacityOf(error) : null;
  if (capacity?.scope && capacity.limit !== null && capacity.limit > 0) {
    process.stderr.write(`[dream] synthesize: ${what} deferred, ${capacity.scope} outstanding write capacity is full (${capacity.outstanding}/${capacity.limit}); the next cycle admits it\n`);
    return;
  }
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
 * next cycle resumes the same request id. #6757: so is an output whose
 * postprocess read hit the statement timeout (`deferral`); the phase names the
 * read, how long it ran and how many passes in a row deferred.
 */
export function withPublishPending(pending: number, result: PhaseResult, deferral?: PostprocessDeferral | null): PhaseResult {
  if (!pending && !deferral) return result;
  const read = deferral && `postprocessing deferred: ${DEFERRED_READ_LABEL[deferral.read]} hit the statement timeout after ${deferral.elapsed_ms} ms `
    + `(${deferral.consecutive} pass(es) in a row); ${deferral.outputs} output(s) finish next cycle without another synthesis call`;
  return { ...result, status: 'warn', summary: [result.summary, read, deferral && pending <= deferral.outputs ? null : SYNTH_PUBLISH_DEFERRED].filter(Boolean).join('; '),
    details: { ...result.details, publish_pending: pending, ...(deferral && pending <= deferral.outputs ? {} : { publish_deferred: SYNTH_PUBLISH_DEFERRED }),
      ...(deferral ? { postprocess_deferred: { ...deferral, doctor: 'gbrain doctor --only persistence_request_indexes --json' } } : {}) } };
}

/**
 * #6757: a pass that returned before postprocessing (nothing new to synthesize) still finishes the outputs an earlier
 * pass deferred; a pass that postprocessed already did. Runs after the phase body, on a real (not dry) run that did
 * not fail or skip, only when this source has pending outputs no postprocess attempted since `startedAt`.
 */
export async function finishDeferredPostprocess(engine: BrainEngine,
  opts: { dryRun: boolean; sourceId?: string; brainDir: string; deadlineAtMs?: number | null; signal?: AbortSignal; date?: string; cycleDate?: string; now?: () => Date },
  startedAt: number, result: PhaseResult, loadConfig: (engine: BrainEngine) => Promise<{ quoteVerify: boolean; meetingTranscriptsDir: string | null }>): Promise<PhaseResult> {
  if (opts.dryRun || result.status === 'fail' || result.status === 'skipped') return result;
  const sourceId = opts.sourceId ?? 'default';
  const entry = (await readPostprocessDeferrals(engine))[sourceId];
  if (!entry?.pending?.length || Date.parse(entry.last_attempt_at) >= startedAt) return result;
  const authority = await maintenancePreflight(engine, sourceId, opts.brainDir, { deadlineAtMs: opts.deadlineAtMs });
  if (!authority) return result;
  const config = await loadConfig(engine);
  const processed = await postprocessManagedSynthesis(engine, authority, [], [], new Map(), [], {
    cycleDate: await resolveCycleDate(engine, { explicitDate: opts.date ?? opts.cycleDate, now: opts.now }), quoteVerify: config.quoteVerify,
    sinceByTranscript: new Map(), signal: opts.signal, grounding: config.quoteVerify ? await resolveGroundingDecide(engine) : undefined,
    meetingTranscriptsDir: config.meetingTranscriptsDir });
  const written = processed.writtenRefs.map(r => r.slug);
  const resumed = written.length ? { ...result, summary: `${result.summary}; ${written.length} deferred output page(s) postprocessed`,
    details: { ...result.details, pages_written: Number(result.details?.pages_written ?? 0) + written.length,
      written_slugs: [...(Array.isArray(result.details?.written_slugs) ? result.details.written_slugs as string[] : []), ...written], postprocess_resumed: written } } : result;
  return withPostprocessConflicts(processed.conflicts, withPublishPending(processed.pending, resumed, processed.deferral));
}
