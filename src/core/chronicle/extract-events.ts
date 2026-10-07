// v0.42.x — Life Chronicle (#2390) event extractor (Phase A.3).
//
// Pipeline (mirrors facts/extract + facts/backstop, but emits EVENT pages +
// timeline projections instead of facts):
//   deterministic when/who  →  judge (LLM, injectable)  →  PARSE BARRIER
//   →  write event pages (content-addressed, idempotent)  →  project to timeline
//
// The judge is injectable so the deterministic write path is testable without a
// real gateway. The default judge calls the chat gateway and classifies every
// failure (no provider, provider error, refusal, truncation, unparseable
// output) so none is ever recorded as a genuine no_events answer.
import type { BrainEngine } from '../engine.ts';
import { matchingCloseBracket } from '../llm-json.ts';
import { maintenancePreflight } from '../persistence/prepared-maintenance.ts';
import { parseConversation } from '../conversation-parser/parse.ts';
import { chroniclePageDate } from './eligibility.ts';
import { buildChronicleEvent, pinDepth, publishChronicleGeneration, type BuiltChronicleEvent } from './publish.ts';

export interface ChronicleEventProposal {
  when: string;            // ISO datetime or YYYY-MM-DD
  who: string[];           // entity slugs / names
  what: string;            // one-clause summary
  where?: string | null;
  kind: string;            // meeting|call|commitment|decision|… (open vocab)
}
export interface ChronicleJudgeInput {
  slug: string;
  type: string;
  title: string;
  body: string;
  effectiveDate: string | null;   // depth page effective_date (deterministic when)
  attendees: string[];            // deterministic who from frontmatter
}
export interface ChronicleJudgeResult {
  events: ChronicleEventProposal[];
  /**
   * #2606 — distinct judge-failure signal so an unusable response is never
   * recorded as a legitimate `no_events`:
   *   - 'truncated': the model hit the output-token cap (stopReason 'length');
   *     the JSON array was cut mid-stream and must not be parsed as complete.
   *   - 'parse_failed': the model returned text but no valid JSON array.
   *   - 'chat_error': the provider call failed (#5876 E2: never `no_events`).
   *   - 'refused': refusal or content filter.
   * Only a parsed empty array is a genuine no-events answer.
   */
  failure?: 'truncated' | 'parse_failed' | 'llm_unavailable' | 'chat_error' | 'refused';
}
export type ChronicleJudge = (input: ChronicleJudgeInput) => Promise<ChronicleJudgeResult>;

/**
 * Proposals refused before publication, never written:
 *   - 'future_dated': dated after the depth page's own day (a plan, follow-up or scheduled item).
 *   - 'date_imprecise': the judge could not give the day ("back in 2024" → "2024").
 */
export type ChronicleDropReason = 'future_dated' | 'date_imprecise';
export type ChronicleDropCounts = Partial<Record<ChronicleDropReason, number>>;

export interface ChronicleExtractResult {
  slug: string;
  status: 'extracted' | 'no_events' | 'skipped';
  events_written: number;
  /** On `no_events`: the drop reason when the judge proposed events and every one was dropped. */
  reason?: string;
  /** Owned events of an earlier generation this run retired. */
  events_retired?: number;
  /** Proposals refused before publication, by reason. */
  events_dropped?: ChronicleDropCounts;
}

const KIND_VOCAB = new Set([
  'meeting', 'call', 'meal', 'solo', 'travel', 'work',
  'commitment', 'decision', 'intro', 'conflict', 'milestone', 'event',
]);

function normalizeKind(k: string): string {
  const n = (k || '').trim().toLowerCase();
  return KIND_VOCAB.has(n) ? n : 'event';
}

/** Resolve a when value to a stable YYYY-MM-DD at the pinned timezone. */
export function isoDay(when: string, tz: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(when)) return when;
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return when.slice(0, 10);
  if (tz === 'UTC') return d.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** PARSE BARRIER: a proposal must fully validate before ANY DB write. */
export function isValidProposal(e: unknown): e is ChronicleEventProposal {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.when === 'string' && o.when.length >= 4 &&
    // Must be a REAL parseable date — otherwise isoDay()/::date would write a
    // garbage event page and then throw on the projection cast (partial write).
    !Number.isNaN(new Date(o.when).getTime()) &&
    typeof o.what === 'string' && o.what.trim().length > 0 &&
    Array.isArray(o.who) && o.who.every((w) => typeof w === 'string') &&
    typeof o.kind === 'string'
  );
}

function collectAttendees(fm: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const key of ['attendees', 'people', 'who']) {
    const v = fm[key];
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) out.add(x.trim());
  }
  return [...out];
}

export interface ChronicleJudgeContext {
  input: ChronicleJudgeInput;
  effectiveDate: string | null;
  attendees: string[];
  /** The instants that date the page itself: its own date (eligibility's), a meeting's end, a conversation's last message. */
  pageDates: Date[];
}

/** A date-only value (YYYY-MM-DD, stored as midnight UTC) is its own day; an instant is its day in `tz`. */
function pageDay(d: Date, tz: string): string {
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : isoDay(iso, tz);
}

/**
 * The last day (YYYY-MM-DD in `tz`) an event extracted from this page may carry: the page's own
 * day (its latest dating instant, so the whole day counts) and never after today. An undated page
 * is bounded by today alone.
 */
export function chronicleEventCutoff(ctx: Pick<ChronicleJudgeContext, 'pageDates'>, tz: string, now: Date): string {
  const today = isoDay(now.toISOString(), tz);
  if (ctx.pageDates.length === 0) return today;
  const own = ctx.pageDates.map((d) => pageDay(d, tz)).reduce((a, b) => (b > a ? b : a));
  return own < today ? own : today;
}

const DAY_PRECISION = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/;

/**
 * CL-1/CL-2: refuse proposals the page cannot support before anything is written. A `when` without
 * a day (YYYY, YYYY-MM) is `date_imprecise`: the timeline stores days, so pinning it to the first of
 * the month or year would invent one. A day after the page's own day is `future_dated`.
 */
export function screenChronicleProposals(proposals: ChronicleEventProposal[], ctx: Pick<ChronicleJudgeContext, 'pageDates'>,
  tz: string, now: Date): { kept: ChronicleEventProposal[]; dropped: ChronicleDropCounts } {
  const cutoff = chronicleEventCutoff(ctx, tz, now);
  const kept: ChronicleEventProposal[] = [];
  const dropped: ChronicleDropCounts = {};
  for (const ev of proposals) {
    const reason: ChronicleDropReason | null = !DAY_PRECISION.test(ev.when.trim()) ? 'date_imprecise'
      : isoDay(ev.when.trim(), tz) > cutoff ? 'future_dated' : null;
    if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
    else kept.push(ev);
  }
  return { kept, dropped };
}

/** The drop reason a page records when the judge proposed events and every one was dropped. */
export function allDroppedReason(dropped: ChronicleDropCounts): ChronicleDropReason {
  return (dropped.date_imprecise ?? 0) > (dropped.future_dated ?? 0) ? 'date_imprecise' : 'future_dated';
}

/** The latest message timestamp of a chat-shaped body (multi-day conversations end on their last message). */
function lastMessageAt(body: string, fallbackDate: string | undefined): Date | null {
  const { messages } = parseConversation(body, { fallbackDate, noPolish: true, noFallback: true });
  let last: Date | null = null;
  for (const m of messages) {
    const d = new Date(m.timestamp);
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1970 && (!last || d > last)) last = d;
  }
  return last;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The judge input for one immutable depth snapshot (E5: the judge never re-reads the page). */
export function chronicleJudgeContext(page: { slug: string; type: string; title: string; compiled_truth?: string | null;
  effective_date?: unknown; effective_date_source?: string | null; frontmatter?: Record<string, unknown> | null }): ChronicleJudgeContext {
  const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
  const edRaw = page.effective_date as unknown;
  const effectiveDate: string | null =
    edRaw instanceof Date ? edRaw.toISOString()
    : typeof edRaw === 'string' && edRaw ? edRaw
    : typeof fm.date === 'string' ? fm.date
    : null;
  const attendees = collectAttendees(fm);
  const body = page.compiled_truth ?? '';
  const own = chroniclePageDate({ effectiveDate: page.effective_date as Date | string | null | undefined,
    effectiveDateSource: page.effective_date_source ?? null, frontmatter: fm });
  const pageDates = [own, asDate(fm.end), lastMessageAt(body, own?.toISOString().slice(0, 10))].filter((d): d is Date => d !== null);
  return {
    effectiveDate, attendees, pageDates,
    input: { slug: page.slug, type: page.type, title: page.title, body, effectiveDate, attendees },
  };
}

/** Proposals → event pages for one depth snapshot; proposals the page cannot support are dropped first. */
export function buildChronicleEvents(proposals: ChronicleEventProposal[], ctx: ChronicleJudgeContext,
  depth: { slug: string; visibility: 'private' | 'world'; contentHash: string }, opts: { tz: string; now: Date },
): { events: BuiltChronicleEvent[]; dropped: ChronicleDropCounts } {
  const { kept, dropped } = screenChronicleProposals(proposals, ctx, opts.tz, opts.now);
  const events = kept.map((ev) => buildChronicleEvent(ev, {
    depthSlug: depth.slug, attendees: ctx.attendees, effectiveDate: ctx.effectiveDate, tz: opts.tz,
    visibility: depth.visibility, depthHash: depth.contentHash, isoDay, normalizeKind,
  }));
  return { events, dropped };
}

/**
 * Run the chronicle extractor for one depth page. Idempotent: event slugs are
 * content-addressed (re-run upserts the same pages) and the projection upserts
 * on (event_page_id, date). A crash between writes re-runs to the same state.
 * The judge reads one snapshot; publication re-validates it and reconciles the
 * previous generation (publish.ts). Direct callers keep this result shape; the
 * `chronicle` phase classifies failures itself (cycle/chronicle.ts).
 */
export async function runChronicleExtract(
  engine: BrainEngine,
  opts: { slug: string; sourceId?: string; judge?: ChronicleJudge; tz?: string; signal?: AbortSignal },
): Promise<ChronicleExtractResult> {
  const sourceId = opts.sourceId ?? 'default';
  const tz = opts.tz ?? 'UTC';
  const snapshot = await engine.readPageSnapshot(opts.slug, { sourceId });
  if (!snapshot) return { slug: opts.slug, status: 'skipped', events_written: 0, reason: 'page_not_found' };
  const ctx = chronicleJudgeContext(snapshot.page);
  // #5523: a managed brain refuses the legacy putPage/projection writers.
  // Claim maintenance authority before judge spend; null when unmanaged.
  const maintenance = await maintenancePreflight(engine, sourceId);

  const judge = opts.judge ?? defaultJudge(engine);
  let result: ChronicleJudgeResult;
  try {
    result = await judge(ctx.input);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return { slug: opts.slug, status: 'skipped', events_written: 0, reason: 'judge_error' };
  }

  // #2606: a truncated or unparseable judge response is a FAILURE, not an
  // empty page. Record it as a distinct skipped reason so operators (and
  // retries) can tell it apart from a genuine no_events.
  if (result?.failure) {
    return { slug: opts.slug, status: 'skipped', events_written: 0, reason: `judge_${result.failure}` };
  }
  const proposals = Array.isArray(result?.events) ? result.events : [];
  // PARSE BARRIER — reject the WHOLE batch on any malformed proposal; no partial writes.
  if (!proposals.every(isValidProposal)) {
    return { slug: opts.slug, status: 'skipped', events_written: 0, reason: 'malformed_proposal' };
  }
  const pin = pinDepth(snapshot);
  const built = buildChronicleEvents(proposals, ctx, { slug: pin.slug, visibility: pin.visibility, contentHash: pin.contentHash },
    { tz, now: new Date() });
  const generation = await publishChronicleGeneration(engine, {
    sourceId, pin, maintenance, decisionRequestId: null, signal: opts.signal, events: built.events,
  });
  const dropped = Object.keys(built.dropped).length ? { events_dropped: built.dropped } : {};
  if (generation.superseded) {
    return { slug: opts.slug, status: 'skipped', events_written: generation.written.length, reason: generation.superseded,
      events_retired: generation.retired.length, ...dropped };
  }
  if (built.events.length === 0) {
    return { slug: opts.slug, status: 'no_events', events_written: 0, events_retired: generation.retired.length,
      ...(proposals.length ? { reason: allDroppedReason(built.dropped) } : {}), ...dropped };
  }
  return { slug: opts.slug, status: 'extracted', events_written: generation.written.length, events_retired: generation.retired.length, ...dropped };
}

const JUDGE_SYSTEM = `You segment a meeting, conversation or calendar page into the discrete timeline EVENTS it records as having HAPPENED by the end of the page's date.
Return ONLY a JSON array. Each element: {"when": YYYY-MM-DD or ISO datetime, "who": [entity slugs/names], "what": one-clause summary, "where": optional string, "kind": one of meeting|call|meal|solo|travel|work|commitment|decision|intro|conflict|milestone|event}.
Extract only what already happened: the meeting or conversation itself, what was decided, said, agreed or done in it, and earlier events the text dates. A commitment made in the meeting is an event on the meeting's day ("Amara agreed to send the deck"), never on its due date.
Never extract plans, intentions, follow-ups, deadlines, upcoming or scheduled meetings, or anything the text places after the page's date.
"when": the page's date for the meeting itself and for what happened in it. For an earlier event, use the day the text gives. If the text gives only a year or a month ("back in 2024", "last month"), write just that precision ("2024", "2026-03"); never invent a day such as the first of the month or year, and never move the event to the page's date.
Use the provided attendee slugs for "who" when the text does not name participants. No prose, no markdown — just the JSON array.`;

/**
 * #2606: default output-token cap for the judge. Raised from the original
 * 1500 (which event-dense pages overflowed, silently truncating the JSON
 * array). Override via `chronicle.judge_max_tokens`.
 */
const DEFAULT_JUDGE_MAX_TOKENS = 4000;
/** Page body characters the judge reads at most. */
export const JUDGE_BODY_CHARS = 12_000;
/** Judge input outside the body: the system prompt plus headroom for the wrapper, title, attendees and date rule. */
export const JUDGE_PROMPT_CHARS = JUDGE_SYSTEM.length + 2_000;

/** The judge's output-token cap: `chronicle.judge_max_tokens`, else the default. */
export async function chronicleJudgeMaxTokens(engine: BrainEngine): Promise<number> {
  const capRaw = await engine.getConfig('chronicle.judge_max_tokens').catch(() => null);
  const n = capRaw ? parseInt(capRaw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_JUDGE_MAX_TOKENS;
}

export function defaultJudge(engine: BrainEngine): ChronicleJudge {
  return async (input) => {
    const { isAvailable, chat } = await import('../ai/gateway.ts');
    // #2608: a missing chat provider used to return a bare `{events: []}` —
    // indistinguishable from "the judge read the page and found no events",
    // so keyless daemons reported clean no_events runs forever. Surface it as
    // a distinct failure (mapped to status 'skipped' / judge_llm_unavailable).
    if (!isAvailable('chat')) return { events: [], failure: 'llm_unavailable' };
    const body = (input.body || '').slice(0, JUDGE_BODY_CHARS);
    // #2606: configurable cap so event-dense pages have headroom.
    const maxTokens = await chronicleJudgeMaxTokens(engine);
    // extraction.date_grounding: the page date is the observation date; a
    // relative "last Tuesday" resolves against it, never against today.
    const { isConsumerDateGroundingOn } = await import('../facts/extract.ts');
    const grounded = await isConsumerDateGroundingOn(engine, 'chronicle');
    const { observationDateFrom, observationDateLine, observationDateRule } = await import('../ai/date-grounding.ts');
    const dateLine = grounded ? `${observationDateLine(observationDateFrom(input.effectiveDate))}\n` : '';
    let text: string;
    try {
      const res = await chat({
        system: grounded ? `${JUDGE_SYSTEM}\n${observationDateRule()}` : JUDGE_SYSTEM,
        messages: [{
          role: 'user',
          content:
            dateLine +
            `<page slug="${input.slug}" type="${input.type}" date="${input.effectiveDate ?? ''}">\n` +
            `${input.title}\n\n${body}\n</page>\n\n` +
            `Known attendees: ${input.attendees.slice(0, 10).join(', ') || '(none)'}.\nExtract the events.`,
        }],
        maxTokens,
      });
      if (res.stopReason === 'refusal' || res.stopReason === 'content_filter') return { events: [], failure: 'refused' };
      // #2606: output hit the token cap — the JSON array is cut mid-stream.
      // Do NOT feed it to the parser as if complete; surface the truncation.
      if (res.stopReason === 'length') return { events: [], failure: 'truncated' };
      text = res.text;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      // A budget refusal is the caller's to classify (no_pricing / cap), not a provider failure.
      if ((err as { tag?: string })?.tag === 'BUDGET_EXHAUSTED') throw err;
      return { events: [], failure: 'chat_error' };
    }
    const parsed = parseJudgeJson(text);
    // #2606: non-empty model text with no parseable JSON array is a parse
    // failure, distinct from the model legitimately answering `[]`.
    if (parsed === null) return { events: [], failure: 'parse_failed' };
    return { events: parsed };
  };
}

/**
 * Tolerant JSON-array extraction from a model response (mirrors facts parser).
 *
 * #2606: returns `null` on parse FAILURE (empty text, no `[...]` found,
 * JSON.parse throw, non-array result) so callers can distinguish "the model
 * said no events" (a legitimate `[]`) from "the response was unusable".
 * The slice ends at the array's own closing bracket (`matchingCloseBracket`),
 * not the last `]` in the reply, so a citation after it cannot widen it.
 */
export function parseJudgeJson(text: string): ChronicleEventProposal[] | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = matchingCloseBracket(s, start);
  if (end === -1) return null;
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}
