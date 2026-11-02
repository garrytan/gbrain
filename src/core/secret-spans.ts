/**
 * Span-level secret redaction of stored text, the pure half of `gbrain repair
 * secret-spans` (repair/secret-spans.ts). Every field of one page is planned
 * with the secret scanner (`planRedaction`, the rules the operator selects)
 * against one shared echo dictionary, so a value the scanner claimed in one
 * field is also replaced where it reappears bare in another, as the corpus
 * writer does. A claim whose text is only redaction markers is dropped, so an
 * already-redacted field is a fixed point.
 *
 * The proof: the span list is computed here, independently of
 * `applyRedaction`; the new text is the old text with `<REDACTED:rule>`
 * spliced over exactly those spans, and `applyRedaction` over the same
 * filtered plan must return byte-identical text. A field whose two results
 * differ, or whose spans are not sorted, disjoint and inside the text, is not
 * proven, and the caller refuses its page.
 */
import { createHash } from 'node:crypto';
import { opError } from './ops/contract.ts';
import { applyRedaction, NAMED_SECRET_RULES, planRedaction, type EchoDictionary, type RedactionPlan, type ScanOpts } from './secret-scan.ts';

/** The opt-in heuristics: selectable by name, never part of the default rule set. */
export const BROAD_SECRET_RULES: readonly string[] = ['high_entropy_assignment', 'labeled_credential'];

const MARKER_ONLY = /^(?:<REDACTED:[^<>\s]+>)+$/;

export interface SecretRuleSet { rules: string[]; scan: ScanOpts }

/** The selected rules, sorted (default: every named rule), and the scan options they need; unknown names refuse. */
export function resolveSecretRules(names?: readonly string[]): SecretRuleSet {
  const known = [...NAMED_SECRET_RULES, ...BROAD_SECRET_RULES];
  const picked = names?.length ? [...new Set(names.map(name => name.trim()))].sort() : [...NAMED_SECRET_RULES];
  const unknown = picked.filter(name => !known.includes(name));
  if (unknown.length) {
    throw opError('invalid_params', `Unknown secret rule${unknown.length > 1 ? 's' : ''}: ${unknown.map(name => JSON.stringify(name)).join(', ')}; nothing was scanned.`,
      `--rules takes a comma-separated list of: ${known.join(', ')}. Leave it out to apply every named rule (the opt-in ${BROAD_SECRET_RULES.join(' and ')} heuristics only run when named).`);
  }
  return { rules: picked, scan: { highEntropy: picked.includes('high_entropy_assignment'), labeledCredentials: picked.includes('labeled_credential') } };
}

export interface SecretSpan { start: number; end: number; rule: string; echo: boolean }

export interface FieldRedaction {
  key: string;
  /** The text with every span replaced by its marker (the old text when there are no spans). */
  next: string;
  spans: SecretSpan[];
  old_sha256: string;
  new_sha256: string;
  /** SHA-256 over the span list (offsets, rule, echo flag), never over a value. */
  spans_sha256: string;
  /** False when the independent splice and `applyRedaction` disagree, or a span is malformed. */
  proven: boolean;
}

export const sha256Text = (text: string): string => createHash('sha256').update(text).digest('hex');
const markerOf = (rule: string) => `<REDACTED:${rule}>`;

/**
 * The spans `applyRedaction` replaces for these claims and this dictionary: each claim (an overlap's uncovered tail as
 * its own span) and, inside the gaps between claims, every dictionary occurrence leftmost then longest.
 */
function spansOf(text: string, claimed: RedactionPlan['claimed'], echo: EchoDictionary): SecretSpan[] {
  const values = [...echo].sort((a, b) => b[0].length - a[0].length);
  const next = values.map(([value]) => text.indexOf(value));
  const out: SecretSpan[] = [];
  const gap = (from: number, to: number) => {
    let at = from;
    while (at < to) {
      let best = -1, bestPos = to;
      for (let k = 0; k < values.length; k++) {
        let p = next[k]!;
        if (p === -1) continue;
        if (p < at) { p = text.indexOf(values[k]![0], at); next[k] = p; if (p === -1) continue; }
        if (p >= bestPos || p + values[k]![0].length > to) continue;
        best = k; bestPos = p;
      }
      if (best === -1) return;
      out.push({ start: bestPos, end: bestPos + values[best]![0].length, rule: values[best]![1], echo: true });
      at = bestPos + values[best]![0].length;
    }
  };
  let cur = 0;
  for (const c of claimed) {
    if (c.end <= cur) continue;
    if (c.abs > cur) gap(cur, c.abs);
    out.push({ start: Math.max(c.abs, cur), end: c.end, rule: c.pattern, echo: false });
    cur = c.end;
  }
  gap(cur, text.length);
  return out;
}

function splice(text: string, spans: readonly SecretSpan[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const span of spans) { parts.push(text.slice(at, span.start), markerOf(span.rule)); at = span.end; }
  parts.push(text.slice(at));
  return parts.join('');
}

const wellFormed = (text: string, spans: readonly SecretSpan[]) =>
  spans.every((span, i) => span.start < span.end && span.end <= text.length && (i === 0 || spans[i - 1]!.end <= span.start)
    && !MARKER_ONLY.test(text.slice(span.start, span.end)));

/**
 * Plans every field of one page, in the given order, against one shared echo dictionary restricted to the selected
 * rules. Returns one result per field, changed or not.
 */
export function redactFields(fields: ReadonlyArray<{ key: string; text: string }>, rules: SecretRuleSet): FieldRedaction[] {
  const shared: EchoDictionary = new Map();
  const plans = fields.map(field => planRedaction(field.text, { ...rules.scan, echoValues: shared }));
  const selected = new Set(rules.rules);
  const echo: EchoDictionary = new Map([...shared].filter(([value, rule]) => selected.has(rule) && !MARKER_ONLY.test(value)));
  return fields.map((field, i) => {
    const plan = plans[i]!;
    const claimed = plan.claimed.filter(c => selected.has(c.pattern) && !MARKER_ONLY.test(field.text.slice(c.abs, c.end)));
    const spans = spansOf(field.text, claimed, echo);
    const next = spans.length ? splice(field.text, spans) : field.text;
    const proven = wellFormed(field.text, spans) && applyRedaction({ ...plan, claimed, echoValues: echo }) === next;
    return { key: field.key, next, spans, old_sha256: sha256Text(field.text), new_sha256: sha256Text(next), proven,
      spans_sha256: sha256Text(JSON.stringify(spans.map(span => [span.start, span.end, span.rule, span.echo ? 1 : 0]))) };
  });
}

/** Matches of the selected rules a fresh scan still finds in `text`, by rule (marker-only claims excluded). */
export function residualMatches(text: string, rules: SecretRuleSet): Record<string, number> {
  const selected = new Set(rules.rules);
  const out: Record<string, number> = {};
  for (const c of planRedaction(text, rules.scan).claimed) {
    if (!selected.has(c.pattern) || MARKER_ONLY.test(text.slice(c.abs, c.end))) continue;
    out[c.pattern] = (out[c.pattern] ?? 0) + 1;
  }
  return out;
}

/** Spans by rule, and how many of them are echoes. */
export function spanCounts(spans: Iterable<SecretSpan>): { rules: Record<string, number>; echo: number } {
  const rules: Record<string, number> = {};
  let echo = 0;
  for (const span of spans) { rules[span.rule] = (rules[span.rule] ?? 0) + 1; if (span.echo) echo++; }
  return { rules, echo };
}
