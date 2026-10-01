/**
 * Unpacked logical decisions (S7 windows, S8 claim units): every question is
 * its own provider request, so an answer never depends on co-packed
 * neighbours. The requests share one deadline and one decision id, run at most
 * `decide.background_concurrency` at a time across the whole process (every
 * concurrent decision shares the background lane; one per decision after a
 * 429), and must all be
 * answered by the same resolved model. Unlike `runDecide`, a failed question
 * does not throw: it is listed in `failed` with its catalogued reason so the
 * slot can tell complete coverage from partial coverage.
 */
import { randomUUID } from 'node:crypto';
import { runDecide, type DecideContext } from './index.ts';
import { MIN_STAGE_MS } from './runtime.ts';
import { DecideError, type DecideAnswer, type DecideQuestion, type DecideRequest, type DecideResult, type EvidenceItem } from './types.ts';

/** Process-wide background lane: every unpacked request holds one slot while in flight. */
let laneInFlight = 0;
const laneWaiters: Array<() => void> = [];

async function acquireLane(limit: number, deadlineAt: number, now: () => number): Promise<boolean> {
  while (laneInFlight >= limit) {
    const left = deadlineAt - now();
    if (left < MIN_STAGE_MS) return false;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.min(left, 250));
      laneWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  laneInFlight++;
  return true;
}

function releaseLane(): void {
  laneInFlight--;
  laneWaiters.shift()?.();
}

export interface UnpackedResult extends DecideResult {
  /** Question ids with no usable answer from the slot's provider, with the reason. */
  failed: Record<string, string>;
}

export interface UnpackedOpts {
  /** Absolute epoch-ms deadline for the whole logical decision. */
  deadlineAt: number;
  concurrency: number;
  /** Stop starting new requests after the first failure (a slot that needs complete coverage). */
  stopOnFailure?: boolean;
}

export async function runDecideUnpacked(
  req: Omit<DecideRequest, 'questions' | 'deadlineMs'> & { questions: DecideQuestion[] },
  ctx: DecideContext,
  opts: UnpackedOpts,
): Promise<UnpackedResult> {
  const now = ctx.now ?? Date.now;
  const started = now();
  const answers: Record<string, DecideAnswer> = {};
  const refused: Record<string, string> = {};
  const failed: Record<string, string> = {};
  const fallbackAnswers: Record<string, DecideAnswer> = {};
  let fallbackMeta: DecideResult | undefined;
  const models = new Set<string>();
  let provider = req.provider ?? '';
  let alias = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let batches = 0;
  let lane = req.lane ?? 'background';
  let allowed = Math.max(1, Math.floor(opts.concurrency));
  let next = 0;
  let stop = false;
  let firstReason: string | undefined;
  const fail = (id: string, reason: string) => {
    failed[id] = reason;
    firstReason ??= reason;
    if (opts.stopOnFailure) stop = true;
  };
  const one = async (q: DecideQuestion): Promise<void> => {
    if (!await acquireLane(Math.max(1, Math.floor(opts.concurrency)), opts.deadlineAt, now)) { fail(q.id, 'late'); return; }
    const left = opts.deadlineAt - now();
    if (left < MIN_STAGE_MS) { releaseLane(); fail(q.id, 'late'); return; }
    try {
      const r = await runDecide({ ...req, questions: [q], deadlineMs: left }, ctx);
      provider = r.provider;
      alias = r.model_alias;
      lane = r.lane;
      inputTokens += r.usage.input_tokens;
      outputTokens += r.usage.output_tokens;
      cost += r.cost_usd;
      batches += r.batches;
      const answer = r.answers[q.id];
      if (answer) {
        models.add(r.model_resolved);
        answers[q.id] = answer;
        return;
      }
      const reason = r.refused[q.id] ?? 'malformed_response';
      refused[q.id] = reason;
      const fb = r.fallback?.answers[q.id];
      if (fb && r.fallback) {
        fallbackAnswers[q.id] = fb;
        fallbackMeta ??= r.fallback;
      }
      fail(q.id, reason);
    } catch (err) {
      const reason = err instanceof DecideError ? err.reason : 'provider_error';
      if (reason === 'rate_limited') allowed = 1;
      fail(q.id, reason);
    } finally {
      releaseLane();
    }
  };
  await Promise.all(Array.from({ length: Math.min(allowed, req.questions.length) }, async (_, worker) => {
    while (!stop && next < req.questions.length && worker < allowed) await one(req.questions[next++]!);
  }));
  for (const q of req.questions.slice(next)) failed[q.id] ??= firstReason ?? 'late';
  if (models.size > 1) {
    for (const id of Object.keys(answers)) failed[id] = 'mixed_model';
  }
  return {
    decision_id: randomUUID(), provider, model_alias: alias, model_resolved: models.size === 1 ? [...models][0]! : '',
    answers: models.size > 1 ? {} : answers, refused,
    ...(fallbackMeta ? { fallback: { ...fallbackMeta, answers: fallbackAnswers } } : {}),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }, cost_usd: cost, latency_ms: now() - started,
    batches, lane, failed,
  };
}

/** One empty shared state: unpacked slots carry their evidence in each question's inputs. */
export const EMPTY_STATE: Record<string, EvidenceItem> = Object.freeze({}) as Record<string, EvidenceItem>;
