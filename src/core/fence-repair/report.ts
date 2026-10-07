/**
 * #6188 (D12, D21): what a write reports when Tier 1 rewrote one of its
 * fences. Every surface (sync, import, put_page, put_pages, remember and the
 * other append verbs) returns the same `fences_normalized` shape: how many
 * pages, fixes per class, who wrote them, sample paths for trusted local
 * callers only, their common directory, and a coaching fix. A write also gets
 * one `fence_normalized` coaching notice naming rows and classes (never a
 * cell value): the stored page differs from what was sent, so the caller
 * re-reads it before editing, and `remember` / `takes_add` write rows that
 * never need normalizing.
 */
import type { Action, Notice } from '../agent-output.ts';
import { readFix } from '../ops/op-fix.ts';
import { fenceFixesWire, fixesByClass } from './tier1.ts';
import type { FenceFix, FixClass } from './types.ts';

export interface FencesNormalized {
  /** Pages (files) whose fences Tier 1 rewrote. */
  count: number;
  by_class: Partial<Record<FixClass, number>>;
  /** By receipt principal when known, else by the paths' top directory. */
  writers: Array<{ writer: string; count: number }>;
  /** Trusted local callers only: up to five paths. */
  sample_paths?: string[];
  /** Trusted local callers only: the common directory of the sample paths ('' when none). */
  common_prefix?: string;
  /** Single-page writes: each fix's location and class. */
  fixes?: ReturnType<typeof fenceFixesWire>;
  fix: Action;
}

/** The structured-write advice every report and notice repeats. */
export const STRUCTURED_WRITE_ADVICE = 'Write facts with `remember` and takes with `takes_add` (or emit the canonical columns) so rows never need normalizing.';

/** `fences_normalized` for one page write. */
export function pageFencesNormalized(input: { sourceId: string; slug: string; fixes: readonly FenceFix[]; writer: string; path?: string | null; remote: boolean }): FencesNormalized {
  const fixes = fenceFixesWire(input.fixes);
  const local = !input.remote && input.path ? { sample_paths: [input.path], common_prefix: input.path.split('/').slice(0, -1).join('/') } : {};
  return { count: 1, by_class: fixesByClass(input.fixes), writers: [{ writer: input.writer, count: 1 }], ...local, fixes,
    fix: readFix(`gbrain normalized a facts or takes fence on page ${input.slug} (${describeFixes(input.fixes)}), so the stored page differs from what was sent. Re-read it with get_page before editing it. ${STRUCTURED_WRITE_ADVICE}`,
      { argv: ['gbrain', 'get', '--source', input.sourceId, '--', input.slug], mcp: { tool: 'get_page', arguments: { slug: input.slug, source_id: input.sourceId } } }) };
}

/** "renumber row 3 (takes, body); kind_map row 2 column kind (facts, body)": classes and locations only. */
export function describeFixes(fixes: ReadonlyArray<Pick<FenceFix, 'fence' | 'section' | 'row' | 'column' | 'class'>>): string {
  const groups = new Map<string, { rows: Set<number>; columns: Set<string> }>();
  for (const fix of fixes) {
    const key = `${fix.class}\u0000${fix.fence}\u0000${fix.section}`;
    const group = groups.get(key) ?? { rows: new Set<number>(), columns: new Set<string>() };
    if (fix.row !== null) group.rows.add(fix.row);
    if (fix.column !== null) group.columns.add(fix.column);
    groups.set(key, group);
  }
  return [...groups].map(([key, { rows, columns }]) => {
    const [cls, fence, section] = key.split('\u0000');
    const where = [rows.size ? `${rows.size > 1 ? 'rows' : 'row'} ${[...rows].slice(0, 10).join(', ')}` : '', columns.size ? `${columns.size > 1 ? 'columns' : 'column'} ${[...columns].join(', ')}` : '']
      .filter(Boolean).join(' ');
    return `${cls}${where ? ` ${where}` : ''} (${fence}, ${section})`;
  }).join('; ');
}

/** The one coaching notice a normalized write carries (D21). */
export function fenceNormalizedNotice(report: Pick<FencesNormalized, 'fixes' | 'fix' | 'by_class' | 'count'>, slug?: string): Notice {
  const what = report.fixes?.length ? describeFixes(report.fixes) : Object.entries(report.by_class).map(([cls, n]) => `${cls} x${n}`).join(', ');
  return { code: 'fence_normalized', kind: 'coaching', fix: report.fix,
    why: `gbrain rewrote a malformed facts or takes fence${slug ? ` on ${slug}` : ` on ${report.count} page(s)`} (${what}); claims and existing row numbers are unchanged, but the stored page differs from what was sent. Re-read it with get_page before editing. ${STRUCTURED_WRITE_ADVICE}` };
}

/** One `fences_normalized` for several page writes (put_pages): counts and classes summed, writers merged, the first page's fix. */
export function mergeFencesNormalized(reports: readonly FencesNormalized[]): FencesNormalized | undefined {
  if (!reports.length) return undefined;
  const byClass: Partial<Record<FixClass, number>> = {};
  const writers = new Map<string, number>();
  for (const report of reports) {
    for (const [cls, n] of Object.entries(report.by_class)) byClass[cls as FixClass] = (byClass[cls as FixClass] ?? 0) + (n ?? 0);
    for (const writer of report.writers) writers.set(writer.writer, (writers.get(writer.writer) ?? 0) + writer.count);
  }
  const paths = reports.flatMap(report => report.sample_paths ?? []).slice(0, 5);
  return { count: reports.reduce((sum, report) => sum + report.count, 0), by_class: byClass, writers: [...writers].map(([writer, count]) => ({ writer, count })),
    ...(paths.length ? { sample_paths: paths, common_prefix: commonDirectory(paths) } : {}), fix: reports[0]!.fix };
}

function commonDirectory(paths: readonly string[]): string {
  const split = paths.map(path => path.split('/').slice(0, -1));
  let length = split[0]!.length;
  for (const parts of split) { let i = 0; while (i < length && parts[i] === split[0]![i]) i++; length = i; }
  return split[0]!.slice(0, length).join('/');
}

/** A per-file import result's fence fields: raw fixes (direct import) or a page report (managed import), and residual warnings. */
interface FenceResultFields { fences_normalized?: unknown; fence_issues?: unknown }

/**
 * #6188: the file-by-file tally `gbrain import` and legacy sync report.
 * `fences_normalized` (D12) counts files whose fences Tier 1 rewrote;
 * `fence_issues` (T5) lists files a lenient import stored with a fence that
 * does not parse (their rows are not indexed until it is fixed).
 */
export function importFenceTally(sourceId: string) {
  let count = 0;
  const byClass: Partial<Record<FixClass, number>> = {};
  const paths: string[] = [];
  const dirs = new Map<string, number>();
  const issues: Array<{ path: string; fence_issues: unknown[] }> = [];
  let issueFiles = 0;
  return {
    note(path: string, result: FenceResultFields): void {
      const fixed = result.fences_normalized;
      const classes: FixClass[] = Array.isArray(fixed) ? fixed.map(f => (f as { class: FixClass }).class)
        : fixed && typeof fixed === 'object' ? Object.entries((fixed as FencesNormalized).by_class).flatMap(([cls, n]) => Array<FixClass>(n ?? 0).fill(cls as FixClass)) : [];
      if (classes.length) {
        count++;
        for (const cls of classes) byClass[cls] = (byClass[cls] ?? 0) + 1;
        if (paths.length < 5) paths.push(path);
        const dir = path.includes('/') ? `${path.split('/')[0]}/` : './';
        dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      }
      if (Array.isArray(result.fence_issues) && result.fence_issues.length) {
        issueFiles++;
        if (issues.length < 20) issues.push({ path, fence_issues: result.fence_issues });
      }
    },
    fields(): { fences_normalized?: FencesNormalized; fence_issues?: { files: number; sample: Array<{ path: string; fence_issues: unknown[] }>; why: string } } {
      return {
        ...(count ? { fences_normalized: { count, by_class: byClass, writers: [...dirs].map(([writer, n]) => ({ writer, count: n })), sample_paths: paths,
          common_prefix: commonDirectory(paths),
          fix: readFix(`${count} file(s) had a malformed facts or takes fence that import normalized losslessly (claims and existing row numbers unchanged). ${STRUCTURED_WRITE_ADVICE}`,
            { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] }) } } : {}),
        ...(issueFiles ? { fence_issues: { files: issueFiles, sample: issues,
          why: `${issueFiles} file(s) were imported with a facts or takes fence that does not parse; the page is stored as written and the fence's rows are not indexed until it is fixed. Each entry names the fence, section, rows and columns.` } } : {}),
      };
    },
    lines(): string[] {
      const f = this.fields();
      return [...(f.fences_normalized ? [`  ${f.fences_normalized.count} file(s) with fences normalized (${Object.entries(byClass).map(([c, n]) => `${c} x${n}`).join(', ')}).`] : []),
        ...(f.fence_issues ? [`  ${f.fence_issues.why}`, ...issues.slice(0, 5).map(i => `    ${i.path}`)] : [])];
    },
  };
}
