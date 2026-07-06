import type { BrainEngine } from '../engine.ts';
import type {
  MemoryCandidateEntry,
  MemoryMutationEvent,
  RetrievalTrace,
} from '../types.ts';

// Read-only contamination tracing over existing ledgers (N-6): when a memory is
// refuted after it reached canonical pages, answer "what did it contaminate?"
// by joining canonical handoffs, patch candidates, the mutation ledger, and
// retrieval traces. Deterministic, no LLM calls, no new write authority.

export const CONTAMINATION_TRACE_DEFAULT_LIMIT = 20;
export const CONTAMINATION_TRACE_MAX_LIMIT = 100;
const CONTAMINATION_SCAN_LIMIT = 500;
const CONTAMINATION_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const NEXT_ACTION_CAP = 10;

export class ContaminationTraceServiceError extends Error {
  constructor(
    public code: 'memory_candidate_not_found' | 'invalid_params',
    message: string,
  ) {
    super(message);
    this.name = 'ContaminationTraceServiceError';
  }
}

export interface ContaminationTraceInput {
  candidate_id?: string;
  slug?: string;
  scope_id?: string;
  since?: Date | string;
  until?: Date | string;
  limit?: number;
}

export type ContaminatedPageVia =
  | 'canonical_handoff'
  | 'patch_candidate'
  | 'mutation_event'
  | 'input_slug';

export interface ContaminatedPage {
  slug: string;
  via: ContaminatedPageVia[];
  refs: string[];
  first_written_at: string | null;
}

export interface ContaminationConsumingTrace {
  trace_id: string;
  created_at: string;
  task_id: string | null;
  route_kind: string | null;
  scenario: string | null;
  matched_slugs: string[];
}

export interface ContaminationDownstreamPage {
  slug: string;
  via: Array<'mutation_event' | 'patch_candidate'>;
  refs: string[];
  matched_source_refs: string[];
  occurred_at: string | null;
}

export interface ContaminationTraceResult {
  subject: {
    kind: 'candidate' | 'page';
    candidate_id: string | null;
    slug: string | null;
    verification_status: string | null;
    refuted: boolean;
  };
  window: { since: string; until: string };
  contaminated_pages: ContaminatedPage[];
  consuming_traces: ContaminationConsumingTrace[];
  downstream_pages: ContaminationDownstreamPage[];
  summary: {
    contaminated_page_count: number;
    consuming_trace_count: number;
    downstream_page_count: number;
    next_actions: string[];
    notes: string[];
  };
}

export async function traceMemoryContamination(
  engine: BrainEngine,
  input: ContaminationTraceInput,
): Promise<ContaminationTraceResult> {
  const candidateId = normalizeOptionalString(input.candidate_id, 'candidate_id');
  const slug = normalizeOptionalString(input.slug, 'slug');
  if (!candidateId && !slug) {
    throw new ContaminationTraceServiceError('invalid_params', 'candidate_id or slug is required');
  }
  if (candidateId && slug) {
    throw new ContaminationTraceServiceError('invalid_params', 'provide candidate_id or slug, not both');
  }
  const limit = normalizeLimit(input.limit);

  let candidate: MemoryCandidateEntry | null = null;
  let scopeId = normalizeOptionalString(input.scope_id, 'scope_id') ?? 'workspace:default';
  if (candidateId) {
    candidate = await engine.getMemoryCandidateEntry(candidateId);
    if (!candidate) {
      throw new ContaminationTraceServiceError(
        'memory_candidate_not_found',
        `Memory candidate not found: ${candidateId}`,
      );
    }
    scopeId = candidate.scope_id;
  }

  const notes: string[] = [];
  const scopedPatchCandidates = await listPagePatchCandidates(engine, scopeId);
  const pageMutationEvents = await listAppliedPageMutationEvents(engine);

  const contaminatedPages = candidate
    ? await collectContaminatedPagesForCandidate(engine, candidate, scopedPatchCandidates, pageMutationEvents)
    : [buildInputSlugPage(slug!)];
  const contaminatedSlugs = new Set(contaminatedPages.map((page) => page.slug));

  const until = parseDateInput(input.until, 'until') ?? new Date();
  const since = parseDateInput(input.since, 'since')
    ?? earliestWriteTime(contaminatedPages)
    ?? new Date(until.getTime() - CONTAMINATION_DEFAULT_WINDOW_MS);

  const consumingTraces = contaminatedPages.length > 0
    ? await collectConsumingTraces(engine, contaminatedPages, since, until, limit)
    : [];
  const consumingTraceIds = new Set(consumingTraces.map((trace) => trace.trace_id));

  const downstreamPages = collectDownstreamPages({
    candidate,
    contaminatedSlugs,
    consumingTraceIds,
    patchCandidates: scopedPatchCandidates,
    mutationEvents: pageMutationEvents,
    limit,
  });

  if (candidate && candidate.verification_status !== 'refuted') {
    notes.push(
      `candidate ${candidate.id} is not refuted (verification_status: ${candidate.verification_status}); this contamination analysis is informational`,
    );
  }
  if (candidate && contaminatedPages.length === 0) {
    notes.push(`no canonical page writes recorded for candidate ${candidate.id}; nothing to contaminate`);
  }

  return {
    subject: {
      kind: candidate ? 'candidate' : 'page',
      candidate_id: candidate?.id ?? null,
      slug: candidate ? null : slug!,
      verification_status: candidate?.verification_status ?? null,
      refuted: candidate?.verification_status === 'refuted',
    },
    window: { since: since.toISOString(), until: until.toISOString() },
    contaminated_pages: contaminatedPages,
    consuming_traces: consumingTraces,
    downstream_pages: downstreamPages,
    summary: {
      contaminated_page_count: contaminatedPages.length,
      consuming_trace_count: consumingTraces.length,
      downstream_page_count: downstreamPages.length,
      next_actions: buildNextActions(candidate, contaminatedPages, downstreamPages),
      notes,
    },
  };
}

// A trace/mutation source ref cites a page slug when it is the raw slug, a
// `page:<slug>` ref, or a selector-id style ref (`<kind>:<scope>:<slug>` with
// optional `:...` / `@...` suffixes for line spans, char ranges, and targets).
export function contaminationRefMatchesSlug(ref: string, slug: string): boolean {
  if (ref === slug || ref === `page:${slug}`) return true;
  const needle = `:${slug}`;
  let from = 0;
  for (;;) {
    const index = ref.indexOf(needle, from);
    if (index === -1) return false;
    const after = index + needle.length;
    if (after === ref.length || ref[after] === ':' || ref[after] === '@') return true;
    from = index + 1;
  }
}

function refMatchesTraceId(ref: string, traceId: string): boolean {
  return ref === traceId || ref === `trace:${traceId}` || ref.endsWith(`:${traceId}`);
}

async function collectContaminatedPagesForCandidate(
  engine: BrainEngine,
  candidate: MemoryCandidateEntry,
  patchCandidates: MemoryCandidateEntry[],
  mutationEvents: MemoryMutationEvent[],
): Promise<ContaminatedPage[]> {
  const candidateRef = `memory_candidate:${candidate.id}`;
  const bySlug = new Map<string, { via: Set<ContaminatedPageVia>; refs: Set<string>; writtenAt: Date | null }>();
  const record = (slug: string, via: ContaminatedPageVia, ref: string, writtenAt: Date | null) => {
    const existing = bySlug.get(slug) ?? { via: new Set<ContaminatedPageVia>(), refs: new Set<string>(), writtenAt: null };
    existing.via.add(via);
    existing.refs.add(ref);
    if (writtenAt && (!existing.writtenAt || writtenAt.getTime() < existing.writtenAt.getTime())) {
      existing.writtenAt = writtenAt;
    }
    bySlug.set(slug, existing);
  };

  const handoffs = await engine.listCanonicalHandoffEntries({
    scope_id: candidate.scope_id,
    candidate_id: candidate.id,
    target_object_type: 'curated_note',
    limit: CONTAMINATION_TRACE_MAX_LIMIT,
    offset: 0,
  });
  for (const handoff of handoffs) {
    record(
      handoff.target_object_id,
      'canonical_handoff',
      `canonical_handoff:${handoff.id}`,
      handoff.completed_at ?? handoff.created_at,
    );
  }

  for (const patch of patchCandidates) {
    if (!patch.patch_target_id || !patch.source_refs.includes(candidateRef)) continue;
    record(
      patch.patch_target_id,
      'patch_candidate',
      `memory_patch_candidate:${patch.id}`,
      patch.patch_operation_state === 'applied' ? patch.updated_at : null,
    );
  }

  for (const event of mutationEvents) {
    if (!event.source_refs.includes(candidateRef)) continue;
    record(
      event.target_id,
      'mutation_event',
      `ledger_event:${event.id}`,
      event.applied_at ?? event.created_at,
    );
  }

  return [...bySlug.entries()]
    .map(([slug, entry]) => ({
      slug,
      via: [...entry.via].sort(),
      refs: [...entry.refs].sort(),
      first_written_at: entry.writtenAt ? entry.writtenAt.toISOString() : null,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function buildInputSlugPage(slug: string): ContaminatedPage {
  return { slug, via: ['input_slug'], refs: [], first_written_at: null };
}

async function collectConsumingTraces(
  engine: BrainEngine,
  contaminatedPages: ContaminatedPage[],
  since: Date,
  until: Date,
  limit: number,
): Promise<ContaminationConsumingTrace[]> {
  if (typeof engine.listRetrievalTracesByWindow !== 'function') return [];
  const traces = await engine.listRetrievalTracesByWindow({
    since,
    until,
    limit: CONTAMINATION_SCAN_LIMIT,
  });
  const writtenAtBySlug = new Map(contaminatedPages.map((page) => [
    page.slug,
    page.first_written_at ? new Date(page.first_written_at).getTime() : null,
  ]));

  return traces
    .map((trace) => ({ trace, matched: matchedSlugsForTrace(trace, writtenAtBySlug) }))
    .filter((entry) => entry.matched.length > 0)
    .sort((a, b) =>
      b.trace.created_at.getTime() - a.trace.created_at.getTime()
      || a.trace.id.localeCompare(b.trace.id))
    .slice(0, limit)
    .map(({ trace, matched }) => ({
      trace_id: trace.id,
      created_at: trace.created_at.toISOString(),
      task_id: trace.task_id,
      route_kind: trace.route[0] ?? null,
      scenario: traceScenario(trace),
      matched_slugs: matched,
    }));
}

function matchedSlugsForTrace(
  trace: RetrievalTrace,
  writtenAtBySlug: Map<string, number | null>,
): string[] {
  const matched: string[] = [];
  for (const [slug, writtenAtMs] of writtenAtBySlug) {
    if (writtenAtMs !== null && trace.created_at.getTime() < writtenAtMs) continue;
    if (trace.source_refs.some((ref) => contaminationRefMatchesSlug(ref, slug))) {
      matched.push(slug);
    }
  }
  return matched.sort();
}

function traceScenario(trace: RetrievalTrace): string | null {
  const entry = trace.verification.find((item) => item.startsWith('scenario:'));
  return entry ? entry.slice('scenario:'.length) : null;
}

function collectDownstreamPages(input: {
  candidate: MemoryCandidateEntry | null;
  contaminatedSlugs: Set<string>;
  consumingTraceIds: Set<string>;
  patchCandidates: MemoryCandidateEntry[];
  mutationEvents: MemoryMutationEvent[];
  limit: number;
}): ContaminationDownstreamPage[] {
  const candidateRef = input.candidate ? `memory_candidate:${input.candidate.id}` : null;
  const bySlug = new Map<string, {
    via: Set<'mutation_event' | 'patch_candidate'>;
    refs: Set<string>;
    matched: Set<string>;
    occurredAt: Date | null;
  }>();
  const record = (
    slug: string,
    via: 'mutation_event' | 'patch_candidate',
    ref: string,
    matched: string[],
    occurredAt: Date | null,
  ) => {
    const existing = bySlug.get(slug)
      ?? { via: new Set<'mutation_event' | 'patch_candidate'>(), refs: new Set<string>(), matched: new Set<string>(), occurredAt: null };
    existing.via.add(via);
    existing.refs.add(ref);
    for (const item of matched) existing.matched.add(item);
    if (occurredAt && (!existing.occurredAt || occurredAt.getTime() < existing.occurredAt.getTime())) {
      existing.occurredAt = occurredAt;
    }
    bySlug.set(slug, existing);
  };

  const matchedRefs = (refs: string[]): string[] => refs.filter((ref) =>
    [...input.contaminatedSlugs].some((slug) => contaminationRefMatchesSlug(ref, slug))
    || [...input.consumingTraceIds].some((traceId) => refMatchesTraceId(ref, traceId)));

  for (const event of input.mutationEvents) {
    if (input.contaminatedSlugs.has(event.target_id)) continue;
    if (candidateRef && event.source_refs.includes(candidateRef)) continue;
    const matched = matchedRefs(event.source_refs);
    if (matched.length === 0) continue;
    record(event.target_id, 'mutation_event', `ledger_event:${event.id}`, matched, event.applied_at ?? event.created_at);
  }

  for (const patch of input.patchCandidates) {
    if (!patch.patch_target_id || input.contaminatedSlugs.has(patch.patch_target_id)) continue;
    if (candidateRef && patch.source_refs.includes(candidateRef)) continue;
    const matched = matchedRefs(patch.source_refs);
    if (matched.length === 0) continue;
    record(
      patch.patch_target_id,
      'patch_candidate',
      `memory_patch_candidate:${patch.id}`,
      matched,
      patch.patch_operation_state === 'applied' ? patch.updated_at : null,
    );
  }

  return [...bySlug.entries()]
    .map(([slug, entry]) => ({
      slug,
      via: [...entry.via].sort(),
      refs: [...entry.refs].sort(),
      matched_source_refs: [...entry.matched].sort(),
      occurred_at: entry.occurredAt ? entry.occurredAt.toISOString() : null,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, input.limit);
}

function buildNextActions(
  candidate: MemoryCandidateEntry | null,
  contaminatedPages: ContaminatedPage[],
  downstreamPages: ContaminationDownstreamPage[],
): string[] {
  const actions: string[] = [];
  for (const page of contaminatedPages) {
    if (page.via.length === 1 && page.via[0] === 'input_slug') {
      actions.push(`Re-verify page ${page.slug}: run reverify_code_claims against its consuming trace ids, then update or supersede stale claims.`);
      continue;
    }
    actions.push(`Re-verify page ${page.slug}: run reverify_code_claims against its consuming trace ids, then update or supersede the contaminated timeline lines (${page.refs.join(', ')}).`);
  }
  for (const page of downstreamPages) {
    actions.push(`Review downstream page ${page.slug}: it cites contaminated evidence (${page.matched_source_refs.join(', ')}); re-verify before reuse.`);
  }
  if (candidate && candidate.verification_status === 'refuted') {
    actions.push(`Supersede the refuted claim: supersede_memory_candidate_entry ${candidate.id} with a corrected replacement candidate, or reject derived patch candidates.`);
  }
  return actions.slice(0, NEXT_ACTION_CAP);
}

async function listPagePatchCandidates(
  engine: BrainEngine,
  scopeId: string,
): Promise<MemoryCandidateEntry[]> {
  const entries: MemoryCandidateEntry[] = [];
  for (let offset = 0; offset < CONTAMINATION_SCAN_LIMIT; offset += CONTAMINATION_TRACE_MAX_LIMIT) {
    const batch = await engine.listMemoryCandidateEntries({
      scope_id: scopeId,
      patch_target_kind: 'page',
      limit: CONTAMINATION_TRACE_MAX_LIMIT,
      offset,
    });
    entries.push(...batch);
    if (batch.length < CONTAMINATION_TRACE_MAX_LIMIT) break;
  }
  return entries;
}

async function listAppliedPageMutationEvents(engine: BrainEngine): Promise<MemoryMutationEvent[]> {
  const events = await engine.listMemoryMutationEvents({
    target_kind: 'page',
    limit: CONTAMINATION_SCAN_LIMIT,
  });
  return events.filter((event) => event.dry_run !== true && event.result === 'applied');
}

function earliestWriteTime(pages: ContaminatedPage[]): Date | null {
  const times = pages
    .map((page) => (page.first_written_at ? new Date(page.first_written_at).getTime() : null))
    .filter((time): time is number => time !== null && Number.isFinite(time));
  if (times.length === 0) return null;
  return new Date(Math.min(...times));
}

function normalizeOptionalString(value: string | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContaminationTraceServiceError('invalid_params', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || value === null) return CONTAMINATION_TRACE_DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ContaminationTraceServiceError('invalid_params', 'limit must be a positive number');
  }
  return Math.min(Math.floor(value), CONTAMINATION_TRACE_MAX_LIMIT);
}

function parseDateInput(value: Date | string | undefined, field: string): Date | null {
  if (value === undefined || value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ContaminationTraceServiceError('invalid_params', `${field} must be a valid date`);
  }
  return parsed;
}
