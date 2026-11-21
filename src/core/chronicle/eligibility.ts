// v0.42.x — Life Chronicle (#2390) chronicle-extract eligibility.
// Mirrors src/core/facts/eligibility.ts. A page is chronicle-eligible (auto-
// emits timeline events) when it is conversation-shape, NOT dream-generated,
// and NOT a diary/event page. Diary interiority is NEVER mined into events
// (privacy/consent — plan D5.4); event pages are already the output (anti-loop).
//
// #5876: the one eligibility function. The write decision, the `chronicle`
// phase and `chronicle-backfill` all call it; time rules (recency, invite
// end, settle window) apply only when the caller passes the policy for them.
import type { PageType } from '../types.ts';
import { parseDateLoose } from '../effective-date.ts';

export type ChronicleEligibility =
  | { ok: true }
  | { ok: false; reason: string }
  /** Transient: the same content becomes eligible at `until` without an edit. */
  | { ok: false; reason: 'not_yet_happened' | 'settling'; wait: true; until: Date };

const ELIGIBLE_TYPES: PageType[] = ['meeting', 'conversation', 'calendar-event'];
// Directory rescue: a meetings/… page that frontmatter-typed itself 'note' is
// still conversation-shape. life/diary excluded explicitly below.
export const RESCUE_SLUG_PREFIXES = ['meetings/', 'conversations/', 'cal/', 'calendar/'] as const;
export const CHRONICLE_TYPES: readonly PageType[] = ELIGIBLE_TYPES;
const MIN_BODY_CHARS = 80;
/** Effective-date sources that are not authored: an undated import's stable anchor. */
const UNAUTHORED_DATE_SOURCES = new Set(['fallback']);

export interface ChronicleEligibilityInput {
  type: PageType;
  slug: string;
  body?: string;
  dreamGenerated?: boolean;
  /** pages.effective_date and pages.effective_date_source (E11: only an authored source dates the page). */
  effectiveDate?: Date | string | null;
  effectiveDateSource?: string | null;
  /** Page frontmatter: `date`, `start` and `end` date the page when effective_date does not. */
  frontmatter?: Record<string, unknown> | null;
  /** When the content was decided or last changed (settle window). */
  changedAt?: Date | string | null;
}

export interface ChronicleTimePolicy {
  now: Date;
  /** C14: pages dated before now - recentDays skip `history`. null = no recency rule (backfill). */
  recentDays: number | null;
  /** D4: content changed less than this many seconds ago waits. null = no settle rule. */
  settleSeconds?: number | null;
}

/** A meeting, conversation or calendar page by type or directory; the only pages a receipt or ledger row mentions. */
export function isChronicleShaped(type: string, slug: string): boolean {
  if (type === 'diary' || slug.startsWith('life/diary/') || type === 'event' || slug.startsWith('life/events/')
    || slug.startsWith('wiki/agents/')) return false;
  return (ELIGIBLE_TYPES as string[]).includes(type) || RESCUE_SLUG_PREFIXES.some((p) => slug.startsWith(p));
}

/** pages-03: frontmatter keeps a timestamp as its text, read the way the YAML parser read it (an offset-less time as UTC). */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  return parseDateLoose(value);
}

/** The page's own date: an authored effective_date, else frontmatter `date`/`start`. null = undated. */
export function chroniclePageDate(input: Pick<ChronicleEligibilityInput, 'effectiveDate' | 'effectiveDateSource' | 'frontmatter'>): Date | null {
  const authored = input.effectiveDateSource != null && !UNAUTHORED_DATE_SOURCES.has(input.effectiveDateSource);
  if (authored) {
    const d = toDate(input.effectiveDate);
    if (d) return d;
  }
  const fm = input.frontmatter ?? {};
  return toDate(fm.date) ?? toDate(fm.start);
}

/** C13: the meeting's end (else start) when the page declares one. */
function meetingEnd(fm: Record<string, unknown> | null | undefined): Date | null {
  if (!fm) return null;
  return toDate(fm.end) ?? toDate(fm.start);
}

export function isChronicleEligible(input: ChronicleEligibilityInput, policy?: ChronicleTimePolicy): ChronicleEligibility {
  const { type, slug } = input;
  if (input.dreamGenerated === true) return { ok: false, reason: 'dream_generated' };
  // Diary: never extract events from private interiority. Event: anti-loop.
  if (type === 'diary' || slug.startsWith('life/diary/')) return { ok: false, reason: 'diary_excluded' };
  if (type === 'event' || slug.startsWith('life/events/')) return { ok: false, reason: 'event_self' };
  if (slug.startsWith('wiki/agents/')) return { ok: false, reason: 'subagent_scratch' };
  const bodyOk = (input.body?.length ?? MIN_BODY_CHARS) >= MIN_BODY_CHARS;
  if (!bodyOk) return { ok: false, reason: 'too_short' };
  const typeOk = ELIGIBLE_TYPES.includes(type);
  const slugOk = RESCUE_SLUG_PREFIXES.some((p) => slug.startsWith(p));
  if (!typeOk && !slugOk) return { ok: false, reason: `kind:${type}` };
  if (!policy) return { ok: true };
  const end = meetingEnd(input.frontmatter);
  if (end && end.getTime() > policy.now.getTime()) return { ok: false, reason: 'not_yet_happened', wait: true, until: end };
  if (policy.recentDays !== null) {
    const dated = chroniclePageDate(input);
    if (dated && dated.getTime() < policy.now.getTime() - policy.recentDays * 86_400_000) return { ok: false, reason: 'history' };
  }
  if (policy.settleSeconds != null && policy.settleSeconds > 0) {
    const changed = toDate(input.changedAt);
    if (changed && policy.now.getTime() - changed.getTime() < policy.settleSeconds * 1000) {
      return { ok: false, reason: 'settling', wait: true, until: new Date(changed.getTime() + policy.settleSeconds * 1000) };
    }
  }
  return { ok: true };
}
