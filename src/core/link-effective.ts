/**
 * Validity ranges written on typed relation lines become dated transitions.
 *
 *   - works_at @effective[2021-03,2024-06) [[companies/acme-example]]
 *
 * reads as "started 2021-03-01, ended 2024-06-01" on the works_at
 * relationship this page states with that line (producer 'inline', owned by
 * the page and replaced with its derived links). Only a relationship the
 * page's derived links assert with the line's type gets a range, so a
 * missing target, a gated type or a disabled grammar dates nothing. Bounds
 * are already exact days (line-grammar.ts resolves `[ ]` / `( )`), so the
 * precision is 'day'. Grammar: docs/guides/line-grammar.md.
 */
import { parseLineGrammar } from './line-grammar.ts';
import { lineHash, normalizeLinkTarget, refersTo, type DerivedTransition, type OwnedRow, type TemporalEvidence } from './link-temporal-evidence.ts';
import { relationSemantics } from './link-validity.ts';

export type InlineTransition = Omit<DerivedTransition, 'producer'> & { producer: 'inline' };

const LINK_RE = /\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]|\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

export function inlineTransitions(slug: string, content: string, rows: readonly OwnedRow[]): {
  transitions: InlineTransition[]; unmatched: TemporalEvidence['unmatched'];
} {
  const transitions: InlineTransition[] = [];
  const unmatched: TemporalEvidence['unmatched'] = [];
  for (const relation of parseLineGrammar(content).relations) {
    if (!relation.effective) continue;
    const line = content.slice(relation.start, relation.end).trim();
    const semantics = relationSemantics(relation.type);
    if (semantics === 'reference') { unmatched.push({ line, reason: 'not_temporal' }); continue; }
    const link = LINK_RE.exec(line);
    const target = link ? normalizeLinkTarget(link[1] ?? link[2]) : '';
    const row = target ? rows.find(r => r.from_slug === slug && r.link_type === relation.type && refersTo(target, r.to_slug)) : undefined;
    if (!row) { unmatched.push({ line, reason: 'no_target' }); continue; }
    const base = { from_slug: row.from_slug, to_slug: row.to_slug, link_type: relation.type, date_precision: 'day' as const,
      producer: 'inline' as const, line_hash: lineHash(line) };
    const { from, until } = relation.effective;
    if (from) transitions.push({ ...base, kind: 'start', occurred_on: from });
    if (until && semantics === 'event') unmatched.push({ line, reason: 'event_cannot_end' });
    else if (until) transitions.push({ ...base, kind: 'end', occurred_on: until });
  }
  return { transitions, unmatched };
}
