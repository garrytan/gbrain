import { createHash, randomUUID } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import { retrieveContext } from './retrieve-context-service.ts';
import type {
  RetrievalSelector,
  ScopeGateScope,
  WatchedQuestion,
  WatchedQuestionReadSnapshot,
  WatchedQuestionRun,
} from '../types.ts';

export interface WatchedQuestionProbeInput {
  scope_id: string;
  now?: string;
  limit?: number;
}

export interface WatchedQuestionProbeSummary {
  probed: number;
  changed: number;
  initialized: number;
  skipped: number;
  runs: WatchedQuestionRun[];
}

export async function runWatchedQuestionProbes(
  engine: BrainEngine,
  input: WatchedQuestionProbeInput,
): Promise<WatchedQuestionProbeSummary> {
  if (typeof engine.listWatchedQuestions !== 'function') {
    return { probed: 0, changed: 0, initialized: 0, skipped: 0, runs: [] };
  }
  const now = input.now ?? new Date().toISOString();
  const questions = await engine.listWatchedQuestions({
    scope_id: input.scope_id,
    enabled: true,
    limit: input.limit ?? 100,
  });
  const runs: WatchedQuestionRun[] = [];
  let changed = 0;
  let initialized = 0;
  let skipped = 0;

  for (const question of questions) {
    try {
      const result = await retrieveContext(engine, {
        query: question.question,
        requested_scope: retrievalRequestedScope(question.requested_scope),
        limit: 3,
        include_orientation: false,
        persist_trace: false,
      });
      const currentReads = snapshotRequiredReads(result.required_reads);
      const currentFingerprint = fingerprintWatchedQuestionReads(currentReads);
      const hadBaseline = question.latest_fingerprint !== null;
      const didChange = hadBaseline && question.latest_fingerprint !== currentFingerprint;
      if (didChange) changed++;
      if (!hadBaseline) initialized++;

      const run = await engine.recordWatchedQuestionRun({
        id: randomUUID(),
        question_id: question.id,
        scope_id: question.scope_id,
        question: question.question,
        changed: didChange,
        previous_fingerprint: question.latest_fingerprint,
        current_fingerprint: currentFingerprint,
        previous_required_reads: question.latest_required_reads,
        current_required_reads: currentReads,
        created_at: now,
      });
      await engine.updateWatchedQuestionSnapshot(question.id, {
        latest_fingerprint: currentFingerprint,
        latest_required_reads: currentReads,
        latest_probe_at: now,
        updated_at: now,
      });
      runs.push(run);
    } catch {
      skipped++;
    }
  }

  return {
    probed: runs.length,
    changed,
    initialized,
    skipped,
    runs,
  };
}

export function fingerprintWatchedQuestionReads(reads: WatchedQuestionReadSnapshot[]): string {
  const normalized = [...reads]
    .map((read) => ({
      selector_id: read.selector_id ?? '',
      slug: read.slug,
      content_hash: read.content_hash,
      line_start: read.line_start ?? null,
      line_end: read.line_end ?? null,
    }))
    .sort((left, right) =>
      left.slug.localeCompare(right.slug)
      || left.content_hash.localeCompare(right.content_hash)
      || left.selector_id.localeCompare(right.selector_id)
    );
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function snapshotRequiredReads(selectors: RetrievalSelector[]): WatchedQuestionReadSnapshot[] {
  return selectors
    .map((selector) => snapshotRequiredRead(selector))
    .filter((snapshot): snapshot is WatchedQuestionReadSnapshot => snapshot !== null);
}

function snapshotRequiredRead(selector: RetrievalSelector): WatchedQuestionReadSnapshot | null {
  const slug = selector.slug ?? selector.object_id ?? selector.path ?? selector.section_id ?? selector.selector_id;
  if (!slug) return null;
  return {
    ...(selector.selector_id ? { selector_id: selector.selector_id } : {}),
    slug,
    content_hash: selector.content_hash ?? '',
    ...(typeof selector.line_start === 'number' ? { line_start: selector.line_start } : {}),
    ...(typeof selector.line_end === 'number' ? { line_end: selector.line_end } : {}),
  };
}

function retrievalRequestedScope(scope: ScopeGateScope | null): 'work' | 'personal' | 'mixed' | undefined {
  return scope === 'work' || scope === 'personal' || scope === 'mixed' ? scope : undefined;
}

export function normalizeWatchedQuestionScope(value: unknown): ScopeGateScope | null {
  return value === 'work' || value === 'personal' || value === 'mixed' ? value : null;
}

export function watchedQuestionFromInput(input: {
  id?: string;
  scope_id: string;
  question: string;
  requested_scope?: ScopeGateScope | null;
  enabled?: boolean;
  now?: Date | string | null;
}): Omit<WatchedQuestion, 'created_at' | 'updated_at'> & { created_at?: Date; updated_at?: Date } {
  const question = input.question.trim();
  if (!question) throw new Error('watched question must not be empty');
  return {
    id: input.id ?? randomUUID(),
    scope_id: input.scope_id,
    question,
    requested_scope: input.requested_scope ?? null,
    enabled: input.enabled ?? true,
    latest_fingerprint: null,
    latest_required_reads: [],
    latest_probe_at: null,
  };
}
