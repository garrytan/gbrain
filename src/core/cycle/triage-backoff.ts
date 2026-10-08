/**
 * Backoff for unreliable significance-judge verdicts (#6069).
 *
 * A truncated, refused or unparseable judge response is never cached as a
 * verdict, but without a record the next cycle pays to judge the same
 * transcript again, every cycle. runTriagePass instead upserts a marker row
 * into `dream_verdicts` (score NULL, content_type `triage_unreliable`), so
 * `isTriageCacheValid` and every other score reader see a miss, and skips
 * re-judging that (file, content hash) under the same model and
 * TRIAGE_VERSION until the backoff for its attempt count has passed:
 * 24h × 2^(attempt−1), capped at 7 days. `force` (dream retriage --force),
 * a model change or a content change re-judges at once.
 *
 * Logs carry the stop reason, response length and a sha256 prefix of the
 * response, never the response text: it is model output about a transcript
 * and can echo transcript content.
 */
import { createHash } from 'node:crypto';
import type { Action } from '../agent-output.ts';
import type { BrainEngine, DreamVerdict, DreamVerdictInput } from '../engine.ts';

export const TRIAGE_UNRELIABLE_CONTENT_TYPE = 'triage_unreliable';
export const TRIAGE_UNRELIABLE_BACKOFF = 'triage_unreliable_backoff';

const HOUR_MS = 3_600_000;
const MAX_BACKOFF_MS = 7 * 24 * HOUR_MS;

export type UnreliableKind = 'truncated' | 'refusal' | 'unparseable';

/** What a log line may say about an unreliable judge response. */
export interface TriageDiagnostic {
  stop_reason: string;
  response_chars: number;
  sha256: string;
}

export function responseDiagnostic(stopReason: string | null | undefined, text: string): TriageDiagnostic {
  return {
    stop_reason: stopReason ?? 'none',
    response_chars: text.length,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12),
  };
}

export function triageBackoffMs(attempt: number): number {
  return Math.min(24 * HOUR_MS * 2 ** (Math.max(1, attempt) - 1), MAX_BACKOFF_MS);
}

type MarkerFields = Pick<DreamVerdict, 'score' | 'content_type' | 'reasons' | 'model' | 'triage_version' | 'judged_at'>;

/** Attempt count of a backoff marker for this model and version; 0 when the row is not one. */
export function markerAttempt(row: MarkerFields | null, model: string, triageVersion: number): number {
  if (!row || row.score !== null || row.content_type !== TRIAGE_UNRELIABLE_CONTENT_TYPE) return 0;
  if (row.model !== model || row.triage_version !== triageVersion) return 0;
  const n = Number(row.reasons.find(r => r.startsWith('attempt:'))?.slice('attempt:'.length));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** ISO instant the row's backoff ends, or null when it does not defer judging now. */
export function backoffUntil(row: MarkerFields | null, model: string, triageVersion: number, nowMs = Date.now()): string | null {
  const attempt = markerAttempt(row, model, triageVersion);
  if (attempt === 0) return null;
  const until = Date.parse(row!.judged_at) + triageBackoffMs(attempt);
  return Number.isFinite(until) && until > nowMs ? new Date(until).toISOString() : null;
}

export function backoffMarker(kind: UnreliableKind, attempt: number, model: string, triageVersion: number): DreamVerdictInput {
  return {
    worth_processing: false,
    reasons: [`unreliable:${kind}`, `attempt:${attempt}`],
    score: null,
    content_type: TRIAGE_UNRELIABLE_CONTENT_TYPE,
    segments: [],
    entities: [],
    model,
    triage_version: triageVersion,
  };
}

/**
 * Record an unreliable verdict: upsert the next backoff marker (unless the row
 * holds a valid verdict for this model, which stays, or the run was cancelled)
 * and write the one diagnostic stderr line.
 */
export async function recordUnreliableTriage(
  engine: BrainEngine,
  t: { filePath: string; contentHash: string; basename: string },
  kind: UnreliableKind,
  diagnostic: TriageDiagnostic | undefined,
  opts: { existing: DreamVerdict | null; keepExisting: boolean; model: string; triageVersion: number; aborted: boolean },
): Promise<void> {
  const attempt = markerAttempt(opts.existing, opts.model, opts.triageVersion) + 1;
  let outcome = opts.keepExisting
    ? 'kept the existing verdict'
    : `backoff attempt ${attempt}: not re-judged for ${triageBackoffMs(attempt) / HOUR_MS}h (gbrain dream retriage --force re-judges now)`;
  if (!opts.keepExisting && !opts.aborted) {
    try {
      await engine.putDreamVerdict(t.filePath, t.contentHash, backoffMarker(kind, attempt, opts.model, opts.triageVersion));
    } catch (e) {
      outcome = `backoff marker write failed (${e instanceof Error ? e.name : 'error'}); next cycle re-judges`;
    }
  }
  const diag = diagnostic
    ? `stop_reason=${diagnostic.stop_reason}, response_chars=${diagnostic.response_chars}, sha256=${diagnostic.sha256}`
    : 'no response diagnostic';
  process.stderr.write(`[dream] triage for ${t.basename} was ${kind} (${diag}); not caching in dream_verdicts — ${outcome}\n`);
}

export const TRIAGE_BACKOFF_WHY =
  'The judge returned a truncated, refused or unparseable verdict for this transcript, so it is not judged again until its backoff ends (24h, doubling per repeat, at most 7 days); that keeps an input the model cannot score from being paid for every cycle.';

export const TRIAGE_BACKOFF_FIX: Action = {
  argv: ['gbrain', 'dream', 'retriage', '--force'],
  consent: ['paid'],
  actor: 'agent',
  why: 'Re-judges every transcript now, ignoring cached verdicts and backoff markers; it pays for one judge call per file, so ask the user first (the preview lists the files without a judge call). A different models.dream.triage model also re-judges.',
  preview_argv: ['gbrain', 'dream', 'retriage', '--dry-run', '--json'],
  requires_exclusive: false,
};

/** `details.triage.unreliable_backoff` when any file was held by a backoff marker. */
export function triageBackoffDetails(files: number): { unreliable_backoff?: { files: number; code: string; why: string; fix: Action } } {
  return files > 0 ? { unreliable_backoff: { files, code: TRIAGE_UNRELIABLE_BACKOFF, why: TRIAGE_BACKOFF_WHY, fix: TRIAGE_BACKOFF_FIX } } : {};
}
