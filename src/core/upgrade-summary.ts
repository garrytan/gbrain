/**
 * The short "what changed for you" header shown by `gbrain post-upgrade` and
 * on stable release notes: the behavior changes between two releases, grouped
 * by the `kind:` each behavior-changes.d row declares (behavior-changes.d/README.md).
 * Rows from before kinds existed count as not yet classified.
 */
import { BEHAVIOR_CHANGES, compareReleases } from './behavior-change-notice.ts';

export interface SummaryRow { since: string; kind?: string; text: string }

const ENTRY_MAX = 240;
const DOCTOR = 'gbrain doctor --only behavior_changes';

function firstSentence(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s+(?=[A-Z`(])/)[0]!;
  return sentence.length > ENTRY_MAX ? `${sentence.slice(0, ENTRY_MAX - 1).trimEnd()}…` : sentence;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The header lines for rows released after `after`, up to and including `upTo`; null when none apply. */
export function changeSummary(rows: ReadonlyArray<SummaryRow>, after: string, upTo?: string): string[] | null {
  const inRange = rows.filter(r => compareReleases(r.since, after) > 0 && (!upTo || compareReleases(r.since, upTo) <= 0));
  if (inRange.length === 0) return null;
  const of = (...kinds: string[]) => inRange.filter(r => kinds.includes(r.kind ?? ''));
  const needsYou = of('breaking', 'action');
  const changed = of('default');
  const fixes = of('fix').length;
  const additions = of('add').length;
  const unclassified = inRange.filter(r => !r.kind).length;
  const lines = [`What changed since v${after}: ${plural(inRange.length, 'change', 'changes')}.`];
  const group = (title: string, list: SummaryRow[]) => {
    if (list.length === 0) return;
    lines.push('', `${title} (${list.length}):`, ...list.map(r => `- ${firstSentence(r.text)}`));
  };
  group('Needs you', needsYou);
  group('Behavior changes', changed);
  const tail: string[] = [];
  if (fixes + additions > 0) tail.push(`Plus ${plural(fixes, 'fix', 'fixes')} and ${plural(additions, 'addition', 'additions')}.`);
  if (unclassified > 0) tail.push(`${plural(unclassified, 'change is', 'changes are')} not classified yet.`);
  tail.push(`\`${DOCTOR}\` lists every change in full.`);
  lines.push('', tail.join(' '));
  return lines;
}

/** The header for this binary's own behavior table since release `from`. */
export function upgradeSummary(from: string, upTo?: string): string[] | null {
  const rows = BEHAVIOR_CHANGES.flatMap(c => {
    const text = typeof c.text === 'string' ? c.text : c.text(null, false);
    return text ? [{ since: c.since, kind: c.kind, text }] : [];
  });
  return changeSummary(rows, from, upTo);
}
