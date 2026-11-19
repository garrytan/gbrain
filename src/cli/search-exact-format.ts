/** Human rendering of `search_exact` (`foresights search --exact`): one block per page, then the completeness line. */
interface ExactOut {
  phrase: string;
  matches: Array<{ slug: string; source_id: string; title: string; matching_chunks: number; snippets: Array<{ text: string }> }>;
  complete: boolean;
  incomplete_reasons: string[];
  resume_after: number | null;
  pages_scanned: number;
  unreadable: { total: number; by_reason: Record<string, number>; sample: Array<{ slug: string; source_id: string; reason: string }> };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function formatSearchExact(r: ExactOut): string {
  const lines: string[] = [];
  for (const m of r.matches) {
    lines.push(m.source_id + ':' + m.slug + '  (' + m.matching_chunks + ' chunk' + (m.matching_chunks === 1 ? '' : 's') + ')  ' + m.title);
    for (const s of m.snippets) lines.push('    ' + oneLine(s.text ?? ''));
  }
  if (!r.matches.length) lines.push('No page contains "' + r.phrase + '".');
  if (r.complete) {
    lines.push('Complete: scanned all ' + r.pages_scanned + ' page(s) in scope.');
  } else {
    lines.push('INCOMPLETE (' + r.incomplete_reasons.join(', ') + '): scanned ' + r.pages_scanned + ' page(s).');
    if (r.resume_after !== null) lines.push('  Continue: foresights search --exact ' + JSON.stringify(r.phrase) + ' --after ' + r.resume_after);
    if (r.unreadable.total) {
      const reasons = Object.entries(r.unreadable.by_reason).map(([k, v]) => k + ' ' + v).join(', ');
      lines.push('  ' + r.unreadable.total + ' page(s) have text the scan could not read (' + reasons + '):');
      for (const g of r.unreadable.sample) lines.push('    ' + g.source_id + ':' + g.slug + ' (' + g.reason + ')');
    }
  }
  return lines.join('\n') + '\n';
}
