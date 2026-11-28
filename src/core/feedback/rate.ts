/**
 * `rate_answer`: turn an agent's rating of an answer into bounded weight
 * updates on the pages (and relational edges) that answer used.
 *
 * Whole-answer ratings apply to the cited pages of a think/synthesize answer
 * (all gathered pages when nothing was cited) or to every returned page of a
 * search-shaped answer, plus the recorded path edges into those pages.
 * Targeted ratings (`pages: [{ ref, rating }]`) touch only the named pages.
 * A rating never edits stored facts; it only changes how evidence ranks.
 */
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { loadFeedbackSettings } from './settings.ts';
import {
  ANSWER_ID_RE, PENDING_GRACE_MS, answerIdTime, canTeachSource, feedbackClientId, isAnswerPending, wasAnswerLost,
} from './record.ts';
import {
  applyRatings, countRecentRatingCalls, currentPageHashes, getRetrievalEvent,
  type AppliedRating, type EventPage, type RatingTarget,
} from './store.ts';

const DOCS = 'docs/guides/retrieval-feedback.md';

export type SkipReason = 'already_rated' | 'stale_revision' | 'unverifiable_revision' | 'not_authorized_source';

export interface RateReceipt {
  answer_id: string;
  applied: Array<{ kind: 'page' | 'link'; ref: string; rating: number; weight_before: number; weight_after: number; multiplier: number }>;
  skipped: Array<{ kind: 'page' | 'link'; ref: string; reason: SkipReason; rating?: number }>;
  influence: number;
  next: string;
}

export interface RateInput {
  answer_id: unknown;
  rating?: unknown;
  pages?: unknown;
}

function parseRating(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) {
    throw opError('invalid_rating', `${where} must be an integer from 1 to 5 (got ${JSON.stringify(v)}).`,
      'Use 1 (wrong or useless evidence) to 5 (exactly the evidence needed).', { docs: `${DOCS}#invalid_rating` });
  }
  return v;
}

function resolveRef(ref: unknown, pages: EventPage[]): EventPage {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw opError('invalid_params', 'Each pages[] entry needs a ref ("source_id:slug" or a slug).',
      'Pass refs exactly as the answer listed them, e.g. "default:people/alice-example".');
  }
  const r = ref.trim();
  const exact = pages.filter(p => `${p.source_id}:${p.slug}` === r);
  if (exact.length === 1) return exact[0]!;
  const bySlug = pages.filter(p => p.slug === r);
  if (bySlug.length === 1) return bySlug[0]!;
  const choices = pages.map(p => `${p.source_id}:${p.slug}`);
  if (bySlug.length > 1) {
    throw opError('ambiguous_ref', `"${r}" matches pages in ${bySlug.length} sources in this answer.`,
      `Use one of: ${bySlug.map(p => `${p.source_id}:${p.slug}`).join(', ')}.`, { docs: `${DOCS}#ambiguous_ref` });
  }
  throw opError('ref_not_in_answer', `"${r}" is not one of the pages this answer used.`,
    `Rate only pages the answer returned: ${choices.slice(0, 20).join(', ')}${choices.length > 20 ? ', …' : ''}.`,
    { docs: `${DOCS}#ref_not_in_answer` });
}

function multiplier(weight: number, influence: number): number {
  return Math.round((1 + influence * 2 * (weight - 0.5)) * 10_000) / 10_000;
}

export async function rateAnswer(ctx: OperationContext, input: RateInput): Promise<RateReceipt> {
  const settings = await loadFeedbackSettings(ctx.engine);
  if (!settings.enabled || !settings.learn) {
    throw opError('feedback_disabled',
      `Retrieval feedback is ${settings.enabled ? 'not learning (feedback.learn=false)' : 'off (feedback.enabled=false)'} on this brain, so ratings are not recorded.`,
      'Tell the user ratings are off. Only the brain owner can turn them on, on the brain host.',
      {
        docs: `${DOCS}#feedback_disabled`,
        fix: { argv: ['gbrain', 'config', 'set', settings.enabled ? 'feedback.learn' : 'feedback.enabled', 'true'], consent: [], actor: 'user', why: 'Turns rating-driven ranking on for this brain.', requires_exclusive: false },
      });
  }
  const answerId = typeof input.answer_id === 'string' ? input.answer_id.trim() : '';
  if (!ANSWER_ID_RE.test(answerId)) {
    throw opError('invalid_params', 'answer_id must be the "ans_…" id from an answer\'s feedback meta.',
      'Copy answer_id from the query/search/think/synthesize/recall response you are rating.');
  }
  const clientId = feedbackClientId(ctx);
  const event = await getRetrievalEvent(ctx.engine, answerId);
  if (!event) {
    if (wasAnswerLost(answerId)) {
      throw opError('answer_unavailable', `Answer ${answerId} was never stored: this server lost it before it was written.`,
        'Run the query again and rate the new answer_id.', { reason: 'event_lost', retryable: false, docs: `${DOCS}#answer_unavailable` });
    }
    const minted = answerIdTime(answerId) ?? 0;
    if (isAnswerPending(answerId) || Date.now() - minted < PENDING_GRACE_MS) {
      throw opError('answer_pending', `Answer ${answerId} is still being recorded.`,
        'Retry the same rate_answer call in about 2 seconds.', { docs: `${DOCS}#answer_pending` });
    }
    throw opError('answer_unavailable',
      `Answer ${answerId} is not recorded: it is unknown, was dropped, or is older than the ${settings.eventRetentionDays}-day retention window.`,
      'Run the query again and rate the new answer_id.', { docs: `${DOCS}#answer_unavailable` });
  }
  if (event.client_id !== clientId) {
    throw opError('answer_not_yours', `Answer ${answerId} was made for a different client.`,
      'Rate only answers returned to this connection.', { docs: `${DOCS}#answer_not_yours` });
  }
  const recentCalls = await countRecentRatingCalls(ctx.engine, clientId);
  if (recentCalls >= settings.maxRatingsPerHour) {
    throw opError('rate_limited', `This client already rated ${recentCalls} answers in the last hour (cap ${settings.maxRatingsPerHour}).`,
      'Wait an hour before rating more answers; the cap is feedback.max_ratings_per_hour.');
  }

  type Wanted = { page: EventPage; rating: number; withEdges: boolean };
  const wanted: Wanted[] = [];
  if (input.pages !== undefined) {
    if (!Array.isArray(input.pages) || input.pages.length === 0) {
      throw opError('invalid_params', 'pages must be a non-empty array of { ref, rating }.',
        'Example: pages: [{ ref: "default:people/alice-example", rating: 5 }].');
    }
    for (const entry of input.pages as Array<Record<string, unknown>>) {
      const page = resolveRef(entry?.ref, event.pages);
      wanted.push({ page, rating: parseRating(entry?.rating, `rating for ${page.source_id}:${page.slug}`), withEdges: false });
    }
  } else {
    const rating = parseRating(input.rating, 'rating');
    const thinkLike = event.op === 'think' || event.op === 'synthesize';
    const cited = event.pages.filter(p => p.cited);
    const chosen = thinkLike && cited.length > 0 ? cited : event.pages;
    for (const page of chosen) wanted.push({ page, rating, withEdges: true });
  }

  const skipped: RateReceipt['skipped'] = [];
  const current = await currentPageHashes(ctx.engine, wanted.map(w => w.page));
  const targets: RatingTarget[] = [];
  const pageTargets = new Set<string>();
  for (const w of wanted) {
    const ref = `${w.page.source_id}:${w.page.slug}`;
    if (!canTeachSource(ctx, w.page.source_id)) { skipped.push({ kind: 'page', ref, reason: 'not_authorized_source' }); continue; }
    if (!w.page.content_hash) { skipped.push({ kind: 'page', ref, reason: 'unverifiable_revision' }); continue; }
    if (current.get(ref) !== w.page.content_hash) { skipped.push({ kind: 'page', ref, reason: 'stale_revision' }); continue; }
    targets.push({ kind: 'page', source_id: w.page.source_id, key: w.page.slug, rating: w.rating, content_hash: w.page.content_hash });
    if (w.withEdges) pageTargets.add(ref);
  }
  if (targets.length === 0 && skipped.length > 0 && skipped.every(sk => sk.reason === 'not_authorized_source')) {
    throw opError('feedback_not_authorized',
      'This connection may not change the shared ranking of the sources this answer used.',
      'Ask the brain owner for an unrestricted write grant on that source (no slug fence), then run the query again and rate the new answer.',
      { docs: `${DOCS}#feedback_not_authorized` });
  }
  for (const link of event.links) {
    const to = `${link.source_id}:${link.to_slug}`;
    if (!pageTargets.has(to)) continue;
    const rating = wanted.find(w => `${w.page.source_id}:${w.page.slug}` === to)!.rating;
    targets.push({ kind: 'link', source_id: link.source_id, key: link.edge_key, rating, content_hash: null });
  }

  const results: AppliedRating[] = await applyRatings(ctx.engine, {
    eventId: event.id, clientId, signal: 'explicit', alpha: settings.alpha, targets,
  });
  const influence = settings.influence;
  const applied: RateReceipt['applied'] = [];
  for (const r of results) {
    const ref = `${r.source_id}:${r.key}`;
    if (!r.newly_applied && !wanted.some(w => `${w.page.source_id}:${w.page.slug}` === ref && w.rating === r.rating)) {
      skipped.push({ kind: r.kind, ref, reason: 'already_rated', rating: r.rating });
      continue;
    }
    applied.push({
      kind: r.kind, ref, rating: r.rating,
      weight_before: round4(r.weight_before), weight_after: round4(r.weight_after),
      multiplier: multiplier(r.weight_after, influence),
    });
  }
  return {
    answer_id: event.id,
    applied,
    skipped,
    influence,
    next: applied.length > 0
      ? 'Run the same search with --explain (or explain: true) to see feedback_boost on these pages.'
      : 'Nothing changed. See skipped[].reason; re-run the query and rate the new answer if pages were edited.',
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
