/**
 * The human form of the value card (gbrain value without --json): one line per row, each status in words.
 * Core: core/value/card.ts. A row with no number never prints one.
 */
import type { ValueCard, ValueRow } from './card.ts';

const plural = (count: number, one: string, many = one + 's') => count + ' ' + (count === 1 ? one : many);

function measuredText(row: ValueRow): string {
  const v = (row.value ?? {}) as Record<string, number | boolean | Record<string, number>>;
  switch (row.id) {
    case 'conversations_archived': return plural(v.conversations as number, 'conversation') + ' over ' + plural(v.days as number, 'day');
    case 'pages': {
      const kinds = Object.entries(v.by_kind as Record<string, number>).sort(([, a], [, b]) => b - a).map(([k, c]) => k + ' ' + c);
      return String(v.total) + (kinds.length ? ' (' + kinds.join(', ') + ')' : '');
    }
    case 'links': return String(v.total);
    case 'facts': return v.active + ' active, ' + v.superseded + ' superseded, ' + v.withdrawn + ' withdrawn';
    case 'lookups_served': return v.total + ' (' + plural(v.searches as number, 'search', 'searches') + ', ' + plural(v.recalls as number, 'recall') + ')';
    case 'pages_brought_up':
    case 'pages_later_retrieved': return String(v.pages);
    case 'nightly_items': return (v.at_least ? 'at least ' : '') + v.items;
    case 'brain_score': return v.keyless ? v.score + ' of ' + v.reachable + ' reachable without a key' : v.score + ' of ' + v.max + ' (' + v.reachable + ' reachable with the next maintenance steps)';
  }
}

function rowText(row: ValueRow): string {
  if (row.status === 'off') return 'off; turn it on with: ' + (row.turn_on?.argv ?? []).join(' ');
  if (row.status === 'unavailable') return 'unavailable (' + row.code + '): ' + row.cause;
  return measuredText(row) + (row.note ? '; ' + row.note : '');
}

export function formatValueCard(card: ValueCard): string {
  const rows = card.rows.filter(r => !(r.id === 'nightly_items' && r.status === 'measured' && !(r.value as { items: number }).items));
  const labels = rows.map(r => r.label + (r.window_days ? ' (' + r.window_days + ' days)' : ''));
  const width = Math.max(...labels.map(l => l.length));
  const lines = ['What your brain holds and has done for you' + ':'];
  rows.forEach((r, i) => lines.push('  ' + labels[i]!.padEnd(width) + '  ' + rowText(r)));
  if (card.state === 'degraded') lines.push('', 'Some counts could not be read; the others above are measured.');
  return lines.join('\n') + '\n';
}
