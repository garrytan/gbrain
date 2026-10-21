/**
 * #7191: human renderers for `gbrain find` (find_pages) and grouped
 * `gbrain stats --by` (get_stats). `--json` prints the op result instead
 * (formatResult). Find rows are tab-separated like `gbrain list`; the
 * truncation note goes to stderr so stdout stays parseable.
 */
import type { StatsByResult } from '../core/page-counts.ts';

const cell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return text.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
};

export function formatFindPages(result: any): string {
  if (!result.complete) {
    process.stderr.write(`[find] showing ${result.pages.length} of ${result.total} matches (--limit ${result.limit}); narrow the pattern, add --type or --source, or raise --limit.\n`);
  }
  if (result.pages.length === 0) return 'No pages found.\n';
  return result.pages.map((p: any) =>
    [p.slug, p.source_id, p.type, String(p.updated_at ?? '').slice(0, 10), p.title].map(cell).join('\t'),
  ).join('\n') + '\n';
}

export function formatStatsBy(result: StatsByResult): string {
  const lines = [`Pages:     ${result.total_pages} (${result.distinct_slugs} distinct slugs)`];
  if (result.since) lines.push(`Since:     ${result.since}`);
  if (result.groups.length > 0) {
    const header = [...result.by, 'pages', ...(result.groups[0]!.distinct_slugs !== undefined ? ['distinct_slugs'] : [])];
    lines.push('', header.join('\t'));
    for (const g of result.groups) {
      const keys = result.by.map((dim) => (dim === 'source' ? g.source_id : g.type || '(untyped)'));
      lines.push([...keys, g.pages, ...(g.distinct_slugs !== undefined ? [g.distinct_slugs] : [])].map(cell).join('\t'));
      if (g.member_types && (g.member_types.length > 1 || g.member_types[0]?.type !== g.type)) {
        lines.push(`  = ${g.member_types.map((m) => `${cell(m.type)} (${m.pages}, ${m.via})`).join(', ')}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}
