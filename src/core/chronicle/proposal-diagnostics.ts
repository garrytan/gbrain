/**
 * #7234: bounded diagnostics for a `malformed_proposal` refusal.
 *
 * The parse barrier (`isValidProposal`) rejects a judge response whose events
 * fail validation, and the refusal alone does not say which check failed.
 * `diagnoseMalformedProposals` names it with a fixed reason code, the required
 * field it concerns (from the proposal schema, never a key read from the
 * input) and the JSON type found there, plus counts. It never copies a value,
 * a key the judge invented, the prompt or the raw response, so the result is
 * safe to log and to return.
 *
 * Inspection is bounded and flat: at most MAX_INSPECTED_PROPOSALS proposals,
 * MAX_INSPECTED_WHO_ITEMS `who` entries each, and strings are read only up to
 * MAX_INSPECTED_CHARS; nested values are typed, never walked. A check past a
 * bound is skipped rather than guessed, so every reported defect is one the
 * barrier also rejects; a proposal whose defect lies past every bound is left
 * out of `invalid`, and when no defect is found at all the code is
 * `beyond_bounds`.
 */

export const MAX_INSPECTED_PROPOSALS = 50;
export const MAX_INSPECTED_WHO_ITEMS = 50;
export const MAX_INSPECTED_CHARS = 256;

export type MalformedProposalCode =
  | 'not_object'
  | 'missing_field'
  | 'wrong_type'
  | 'when_too_short'
  | 'when_unparseable'
  | 'what_blank'
  | 'who_item_not_string'
  | 'beyond_bounds';

export type ProposalField = 'when' | 'what' | 'who' | 'kind';
export type ValueShape = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'other';

interface Defect { code: Exclude<MalformedProposalCode, 'beyond_bounds'>; field?: ProposalField; shape?: ValueShape }

export interface MalformedProposalDiagnostics {
  /** The first defect found, or `beyond_bounds` when none was found within the bounds. */
  code: MalformedProposalCode;
  field?: ProposalField;
  /** The JSON type found at `field` (for `not_object`, the proposal's; for `who_item_not_string`, the entry's). */
  shape?: ValueShape;
  /** Zero-based position of the first defective proposal; absent with `beyond_bounds`. */
  index?: number;
  /** Proposals in the response. */
  events: number;
  /** Proposals inspected (at most MAX_INSPECTED_PROPOSALS). */
  inspected: number;
  /** Inspected proposals with a defect found. */
  invalid: number;
  /** Defects found, by code. */
  codes: Partial<Record<MalformedProposalCode, number>>;
}

function shapeOf(v: unknown): ValueShape {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'object' ? t : 'other';
}

function stringField(o: Record<string, unknown>, field: ProposalField): Defect | string {
  const v = o[field];
  if (v === undefined) return { code: 'missing_field', field };
  if (typeof v !== 'string') return { code: 'wrong_type', field, shape: shapeOf(v) };
  return v;
}

/** The first failing check of `isValidProposal`, in its order, within the bounds; null when none was found. */
function proposalDefect(e: unknown): Defect | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { code: 'not_object', shape: shapeOf(e) };
  const o = e as Record<string, unknown>;
  const when = stringField(o, 'when');
  if (typeof when !== 'string') return when;
  if (when.length < 4) return { code: 'when_too_short', field: 'when' };
  if (when.length <= MAX_INSPECTED_CHARS && Number.isNaN(new Date(when).getTime())) return { code: 'when_unparseable', field: 'when' };
  const what = stringField(o, 'what');
  if (typeof what !== 'string') return what;
  if (what.length <= MAX_INSPECTED_CHARS && what.trim().length === 0) return { code: 'what_blank', field: 'what' };
  const who = o.who;
  if (who === undefined) return { code: 'missing_field', field: 'who' };
  if (!Array.isArray(who)) return { code: 'wrong_type', field: 'who', shape: shapeOf(who) };
  const items = Math.min(who.length, MAX_INSPECTED_WHO_ITEMS);
  for (let i = 0; i < items; i++) {
    if (typeof who[i] !== 'string') return { code: 'who_item_not_string', field: 'who', shape: shapeOf(who[i]) };
  }
  const kind = stringField(o, 'kind');
  return typeof kind === 'string' ? null : kind;
}

export function diagnoseMalformedProposals(events: readonly unknown[]): MalformedProposalDiagnostics {
  const inspected = Math.min(events.length, MAX_INSPECTED_PROPOSALS);
  const codes: MalformedProposalDiagnostics['codes'] = {};
  let first: (Defect & { index: number }) | null = null;
  let invalid = 0;
  for (let i = 0; i < inspected; i++) {
    const defect = proposalDefect(events[i]);
    if (!defect) continue;
    invalid++;
    codes[defect.code] = (codes[defect.code] ?? 0) + 1;
    first ??= { ...defect, index: i };
  }
  if (!first) return { code: 'beyond_bounds', events: events.length, inspected, invalid, codes };
  return {
    code: first.code,
    ...(first.field ? { field: first.field } : {}),
    ...(first.shape ? { shape: first.shape } : {}),
    index: first.index, events: events.length, inspected, invalid, codes,
  };
}

/** One log clause built only from the fixed vocabulary and counts above. */
export function describeMalformedProposals(d: MalformedProposalDiagnostics): string {
  const where = d.index === undefined ? 'no defect within the inspection bounds' : `proposal ${d.index + 1} of ${d.events}`;
  const field = d.field ? ` field=${d.field}` : '';
  const shape = d.shape ? ` shape=${d.shape}` : '';
  return `code=${d.code}${field}${shape}; ${where}; ${d.invalid} of ${d.inspected} inspected invalid`;
}
