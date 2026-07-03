// v0.42.x — Life Chronicle (#2390) event extractor (Phase A.3).
//
// Pipeline (mirrors facts/extract + facts/backstop, but emits EVENT pages +
// timeline projections instead of facts):
//   deterministic when/who  →  judge (LLM, injectable)  →  PARSE BARRIER
//   →  write event pages (content-addressed, idempotent)  →  project to timeline
//
// The judge is injectable so the deterministic write path is testable without a
// real gateway. The default judge calls the chat gateway; when no gateway is
// configured it returns zero events (auto-emit is a no-op, never an error).
import type { BrainEngine } from '../engine.ts';
import { computeContentHash } from '../ingestion/types.ts';

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
export interface ChronicleJudgeResult { events: ChronicleEventProposal[] }
export type ChronicleJudge = (input: ChronicleJudgeInput) => Promise<ChronicleJudgeResult>;

export interface ChronicleExtractResult {
  slug: string;
  status: 'extracted' | 'no_events' | 'skipped';
  events_written: number;
  reason?: string;
}

const KIND_VOCAB = new Set([
  'meeting', 'call', 'meal', 'solo', 'travel', 'work',
  'commitment', 'decision', 'intro', 'conflict', 'milestone', 'event',
]);

function normalizeKind(k: string): string {
  const n = (k || '').trim().toLowerCase();
  return KIND_VOCAB.has(n) ? n : 'event';
}

/** Parse a when string to a Date, or null when unparseable (for effective_date). */
function safeDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
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

/**
 * Run the chronicle extractor for one depth page. Idempotent: event slugs are
 * content-addressed (re-run upserts the same pages) and the projection upserts
 * on (event_page_id, date). A crash between writes re-runs to the same state.
 */
export async function runChronicleExtract(
  engine: BrainEngine,
  opts: { slug: string; sourceId?: string; judge?: ChronicleJudge; tz?: string; signal?: AbortSignal },
): Promise<ChronicleExtractResult> {
  const sourceId = opts.sourceId ?? 'default';
  const tz = opts.tz ?? 'UTC';
  const page = await engine.getPage(opts.slug, { sourceId });
  if (!page) return { slug: opts.slug, status: 'skipped', events_written: 0, reason: 'page_not_found' };

  const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
  const edRaw = page.effective_date as unknown;
  const effectiveDate: string | null =
    edRaw instanceof Date ? edRaw.toISOString()
    : typeof edRaw === 'string' && edRaw ? edRaw
    : typeof fm.date === 'string' ? fm.date
    : null;
  const attendees = collectAttendees(fm);

  const judge = opts.judge ?? defaultJudge(engine);
  let result: ChronicleJudgeResult;
  try {
    result = await judge({
      slug: opts.slug, type: page.type, title: page.title,
      body: page.compiled_truth ?? '', effectiveDate, attendees,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return { slug: opts.slug, status: 'skipped', events_written: 0, reason: 'judge_error' };
  }

  const proposals = Array.isArray(result?.events) ? result.events : [];
  if (proposals.length === 0) return { slug: opts.slug, status: 'no_events', events_written: 0 };
  // PARSE BARRIER — reject the WHOLE batch on any malformed proposal; no partial writes.
  if (!proposals.every(isValidProposal)) {
    return { slug: opts.slug, status: 'skipped', events_written: 0, reason: 'malformed_proposal' };
  }

  let written = 0;
  for (const ev of proposals) {
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const who = ev.who.length ? ev.who : attendees;
    const when = ev.when || effectiveDate || isoDay(new Date(0).toISOString(), tz);
    const day = isoDay(when, tz);
    const hash = computeContentHash(`${who.join(',')}|${ev.what}|${opts.slug}`).slice(0, 8);
    const eventSlug = `life/events/${day}-${hash}`;
    await engine.putPage(eventSlug, {
      type: 'event',
      title: ev.what.slice(0, 120),
      compiled_truth: `${ev.what} — see [[${opts.slug}]].`,
      frontmatter: {
        type: 'event',
        event: {
          when, who, what: ev.what, where: ev.where ?? null,
          kind: normalizeKind(ev.kind), depth: opts.slug,
        },
        captured_via: 'life-chronicle:auto',
      },
      effective_date: safeDate(when),
    }, { sourceId });
    await engine.upsertEventProjection({
      depthSlug: opts.slug, eventSlug, date: day, summary: ev.what, sourceId,
    });
    written++;
  }
  return { slug: opts.slug, status: 'extracted', events_written: written };
}

const JUDGE_SYSTEM = `You segment a meeting/transcript page into discrete timeline EVENTS.
Return ONLY a JSON array. Each element: {"when": ISO datetime or YYYY-MM-DD, "who": [entity slugs/names], "what": one-clause summary, "where": optional string, "kind": one of meeting|call|meal|solo|travel|work|commitment|decision|intro|conflict|milestone|event}.
Prefer the page's known date for "when" when the text gives no explicit time. Use the provided attendee slugs for "who" when the text does not name participants. No prose, no markdown — just the JSON array.`;

function defaultJudge(engine: BrainEngine): ChronicleJudge {
  return async (input) => {
    const { isAvailable, chat } = await import('../ai/gateway.ts');
    if (!isAvailable('chat')) return { events: [] };
    const body = (input.body || '').slice(0, 12_000);
    let text: string;
    try {
      const res = await chat({
        system: JUDGE_SYSTEM,
        messages: [{
          role: 'user',
          content:
            `<page slug="${input.slug}" type="${input.type}" date="${input.effectiveDate ?? ''}">\n` +
            `${input.title}\n\n${body}\n</page>\n\n` +
            `Known attendees: ${input.attendees.slice(0, 10).join(', ') || '(none)'}.\nExtract the events.`,
        }],
        maxTokens: 1500,
      });
      if (res.stopReason === 'refusal' || res.stopReason === 'content_filter') return { events: [] };
      text = res.text;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      return { events: [] };
    }
    const parsed = parseJudgeJson(text);
    return { events: parsed };
  };
}

/** Tolerant JSON-array extraction from a model response (mirrors facts parser). */
export function parseJudgeJson(text: string): ChronicleEventProposal[] {
  if (!text) return [];
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
