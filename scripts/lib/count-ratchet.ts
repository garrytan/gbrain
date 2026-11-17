/**
 * Shared runner for per-file count ratchets (D6 of docs/designs/RUST_ENGINE.md):
 * scripts/check-engine-raw-sql-ratchet.ts and scripts/check-engine-kind-branches.ts.
 *
 * A guard supplies a scanner that returns `path<TAB>metric -> count` for the
 * tree. The baseline holds rows `path<TAB>metric<TAB>count[<TAB>note]`. Counts
 * fall by default:
 *   1. a count above its row (no row = 0)            -> FAIL
 *   2. a count below its row (stale)                 -> FAIL
 *   3. a duplicate or malformed row                  -> FAIL
 * A row goes up only by a reviewer-visible edit in the same PR that raises the
 * count and writes the reason in the note column (as
 * scripts/module-size-limits.tsv does). `--prune` lowers stale rows to the
 * actual count, keeps their notes and drops rows at zero; it never raises a row
 * or adds one. `--print` writes the current counts as rows to stdout (used to
 * generate a baseline from the tree at its commit).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CountRatchet {
  /** Guard name used in output, e.g. `check-engine-raw-sql-ratchet`. */
  name: string;
  /** Script path for fix hints, e.g. `scripts/check-engine-raw-sql-ratchet.ts`. */
  script: string;
  baselineRel: string;
  anchor: string;
  metrics: readonly string[];
  /** One line: why the counts only fall. */
  why: string;
  /** What to do instead of adding a new site. */
  riseFix: string;
  scan(root: string): Map<string, number>;
}

export function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface Row { lineNo: number; key: string; count: number; note: string | undefined; malformed: string | null }

function parseBaseline(text: string, metrics: readonly string[]): Row[] {
  const rows: Row[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const cols = raw.split('\t');
    const [path, metric, count, note] = cols;
    let malformed: string | null = null;
    if (cols.length < 3 || cols.length > 4 || !path) malformed = "want 'path<TAB>metric<TAB>count' with an optional '<TAB>note'";
    else if (cols.length === 4 && note.trim() === '') malformed = 'the note column is empty (drop it, or say why the row was raised)';
    else if (!metrics.includes(metric)) malformed = 'unknown metric ' + JSON.stringify(metric) + ' (one of ' + metrics.join(', ') + ')';
    else if (!/^[1-9]\d*$/.test(count)) malformed = 'count must be a positive integer';
    rows.push({ lineNo: i + 1, key: path + '\t' + metric, count: Number(count), note, malformed });
  });
  return rows;
}

export function totals(actual: Map<string, number>, metrics: readonly string[]): { byMetric: Record<string, number>; all: number; files: number } {
  const byMetric = Object.fromEntries(metrics.map((m) => [m, 0])) as Record<string, number>;
  const files = new Set<string>();
  let all = 0;
  for (const [key, n] of actual) {
    const [path, metric] = key.split('\t');
    byMetric[metric] += n;
    all += n;
    files.add(path);
  }
  return { byMetric, all, files: files.size };
}

const RAISE_HINT = '\n      If the site must stay until its area is converted: raise the row (or add it) in this PR with a note column saying why.';

export function runCountRatchet(guard: CountRatchet, root: string, argv: string[]): never {
  const actual = guard.scan(root);
  if (argv.includes('--print')) {
    const keys = [...actual.keys()].sort();
    for (const key of keys) console.log(key + '\t' + actual.get(key));
    process.exit(0);
  }
  const prune = argv.includes('--prune');
  const baselinePath = join(root, guard.baselineRel);
  if (!existsSync(baselinePath)) {
    console.error('FAIL: ' + guard.baselineRel + ':1 baseline file missing');
    console.error('Fix:  git checkout ' + guard.baselineRel);
    console.error('See:  ' + guard.anchor);
    process.exit(1);
  }
  const baselineText = readFileSync(baselinePath, 'utf8');
  const rows = parseBaseline(baselineText, guard.metrics);
  const violations: string[] = [];
  const rewrite = new Map<number, string | null>();
  const seen = new Set<string>();
  const pruneHint = '(or: bun ' + guard.script + ' --prune)';

  for (const row of rows) {
    const where = guard.baselineRel + ':' + row.lineNo;
    if (row.malformed) {
      violations.push('FAIL: ' + where + ' malformed row: ' + row.malformed);
      continue;
    }
    const [path, metric] = row.key.split('\t');
    if (seen.has(row.key)) {
      rewrite.set(row.lineNo, null);
      violations.push('FAIL: ' + where + ' duplicate row for ' + path + ' ' + metric + '\n      Fix:  delete this line ' + pruneHint);
      continue;
    }
    seen.add(row.key);
    const now = actual.get(row.key) ?? 0;
    if (now > row.count) {
      violations.push('FAIL: ' + path + ' ' + metric + ': baseline ' + row.count + ', actual ' + now + '\n      Fix:  ' + guard.riseFix + RAISE_HINT);
    } else if (now < row.count) {
      rewrite.set(row.lineNo, now === 0 ? null : [path, metric, String(now), ...(row.note === undefined ? [] : [row.note])].join('\t'));
      violations.push('FAIL: ' + where + ' stale row: ' + path + ' ' + metric + ': baseline ' + row.count + ', actual ' + now
        + '\n      Fix:  lower the row to ' + now + (now === 0 ? ' (delete it)' : '') + '; counts only fall ' + pruneHint);
    }
  }
  for (const [key, now] of actual) {
    if (seen.has(key)) continue;
    const [path, metric] = key.split('\t');
    violations.push('FAIL: ' + path + ' ' + metric + ': baseline 0, actual ' + now + '\n      Fix:  ' + guard.riseFix + RAISE_HINT);
  }

  if (prune) {
    const kept: string[] = [];
    baselineText.split('\n').forEach((line, i) => {
      if (!rewrite.has(i + 1)) kept.push(line);
      else if (rewrite.get(i + 1) !== null) kept.push(rewrite.get(i + 1)!);
    });
    writeFileSync(baselinePath, kept.join('\n'));
    console.log(guard.name + ': pruned ' + rewrite.size + ' row(s) in ' + guard.baselineRel);
    process.exit(0);
  }
  if (violations.length) {
    for (const v of violations) console.error(v);
    console.error('Why:  ' + guard.why);
    console.error('See:  ' + guard.anchor);
    console.error(guard.name + ': ' + violations.length + ' violation(s)');
    process.exit(1);
  }
  const t = totals(actual, guard.metrics);
  console.log(guard.name + ': ok (' + t.all + ' sites in ' + t.files + ' files: ' + guard.metrics.map((m) => m + ' ' + t.byMetric[m]).join(', ') + ')');
  process.exit(0);
}
