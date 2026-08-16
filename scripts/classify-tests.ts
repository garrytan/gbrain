#!/usr/bin/env bun
/**
 * Test-intent classifier: separates STRUCTURAL suites (assert on repo source/
 * doc TEXT — guards against code shape) from BEHAVIORAL suites (execute
 * product code). Output is a committed TSV (scripts/structural-suites.tsv)
 * kept fresh by scripts/check-structural-manifest.sh in `bun run verify`, and
 * rendered next to coverage numbers so the headline test count stops
 * conflating the two.
 *
 * Method (suite-level, content-based — filename heuristics measured 22/23
 * false-positive on `*audit*`):
 *   1. Per test file, find repo-anchored source-read DETECTORS:
 *      - readFileSync / Bun.file whose argument window names a repo path
 *        (src/, scripts/, docs/, .github/, llms*, CLAUDE.md and friends) and
 *        not a tmpdir
 *      - execSync/spawnSync windows that grep/scan repo sources or invoke
 *        scripts/check-*.sh
 *      - the doctor-source helpers (test/helpers/doctor-source.ts), which
 *        exist precisely to feed structural guards
 *   2. Bind each detector to constants it initializes; attribute a describe()
 *      suite as structural when its region contains a detector or references
 *      a bound constant. Hits outside any describe attribute to the suites
 *      that reference the binding, else to a '(file-level)' pseudo-suite.
 *   3. Anything with detectors but no attributable suite lands in the
 *      `unknown` bucket — surfaced in reporting, never silently dropped.
 *
 * This is an APPROXIMATE inventory by design; the TSV freshness check makes
 * drift loud, and misclassifications are fixed by editing the detector list
 * here (never by hand-editing the TSV).
 *
 * Usage:
 *   bun scripts/classify-tests.ts            # rewrite scripts/structural-suites.tsv
 *   bun scripts/classify-tests.ts --check    # exit 1 if the committed TSV is stale
 *   bun scripts/classify-tests.ts --summary  # print counts only
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const OUT_TSV = join(REPO_ROOT, 'scripts', 'structural-suites.tsv');

const REPO_ANCHORS = [
  /['"`]\.?\.?\/?src\//,
  /['"]src['"]/, // join(..., 'src', ...)
  /['"`]\.?\.?\/?scripts\//,
  /['"]scripts['"]/,
  /['"`]\.?\.?\/?docs\//,
  /['"`]\.?\.?\/?\.github\//,
  /llms(?:-full)?\.txt/,
  /CLAUDE\.md|AGENTS\.md|TESTING\.md|CONTRIBUTING\.md|README\.md|CHANGELOG\.md/,
  /['"`]\.?\.?\/?skills\//,
  /package\.json['"`]/,
];
const TMP_ANCHORS = /tmpdir|mkdtemp|TMPDIR|os\.tmp|TMP_|tmpPath|tempDir|testDir|workDir|FIXTURES?_/i;

export interface SuiteRow {
  file: string;
  suite: string;
  cases: number;
  detector: string;
}
export interface FileResult {
  rows: SuiteRow[];
  unknown: boolean; // detectors present but nothing attributable
}

interface Detector {
  line: number;
  kind: string;
  binding: string | null;
}

/** Window of a line plus the next few — read args often span lines. */
function windowAt(lines: string[], i: number, span = 4): string {
  return lines.slice(i, i + span).join('\n');
}

function isRepoAnchored(win: string): boolean {
  if (TMP_ANCHORS.test(win)) return false;
  return REPO_ANCHORS.some((r) => r.test(win));
}

export function classifyFile(relPath: string, content: string): FileResult {
  const lines = content.split('\n');
  const detectors: Detector[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // comments
    let kind: string | null = null;
    if (/\b(?:readFileSync|readFile)\s*\(/.test(line)) kind = 'readFileSync';
    else if (/\bBun\.file\s*\(/.test(line)) kind = 'bun-file';
    else if (/\b(?:execSync|spawnSync|execFileSync)\s*\(/.test(line)) kind = 'exec-scan';
    else if (/\bdoctor(?:File)?Source\s*\(/.test(line)) kind = 'doctor-source-helper';
    if (!kind) continue;

    const win = windowAt(lines, i);
    if (kind === 'exec-scan') {
      // Only exec calls that scan repo sources / run repo guards are structural.
      // Anchor check is looser than the read-path one: shell commands name
      // repo dirs bare (`grep ... src/`), not as quoted path prefixes.
      const scansRepo = /(^|[\s'"`=])(src|scripts|docs)\//.test(win) && !TMP_ANCHORS.test(win);
      if (!(/grep|rg\s|scripts\/check-|--include=.*\.ts/.test(win) && scansRepo)) continue;
    } else if (kind !== 'doctor-source-helper' && !isRepoAnchored(win)) {
      continue;
    }

    const bind = line.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    detectors.push({ line: i, kind, binding: bind ? bind[1] : null });
  }

  if (detectors.length === 0) return { rows: [], unknown: false };

  // describe regions: [start, nextDescribeStart)
  const describes: { line: number; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/(?:^|\s)describe(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    if (m) describes.push({ line: i, title: m[2] });
  }

  const bindings = detectors.map((d) => d.binding).filter((b): b is string => b !== null);
  const rows: SuiteRow[] = [];
  let attributedAny = false;

  const caseCount = (start: number, end: number): number => {
    let n = 0;
    for (let i = start; i < end; i++) {
      if (/(?:^|\s)(?:test|it)(?:\.\w+)?\s*\(\s*['"`]/.test(lines[i])) n++;
    }
    return n;
  };

  for (let d = 0; d < describes.length; d++) {
    const start = describes[d].line;
    const end = d + 1 < describes.length ? describes[d + 1].line : lines.length;
    const kinds = new Set<string>();
    for (const det of detectors) {
      if (det.line >= start && det.line < end) kinds.add(det.kind);
    }
    if (bindings.length > 0) {
      const region = lines.slice(start, end).join('\n');
      for (const b of bindings) {
        // Binding names may contain regex metachars (e.g. `$SRC`) — escape
        // them or the interpolated RegExp misparses (a `$` reads as an
        // end-anchor and the binding can never match). `\b` anchors are also
        // wrong for `$`-prefixed names ($ is not a word char, so \b$ never
        // matches after `(`), so bound the name with explicit
        // non-identifier-char checks instead.
        const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?:^|[^\\w$])${escaped}(?![\\w$])`).test(region)) {
          const det = detectors.find((x) => x.binding === b);
          if (det) kinds.add(det.kind);
        }
      }
    }
    if (kinds.size > 0) {
      rows.push({
        file: relPath,
        suite: describes[d].title,
        cases: caseCount(start, end),
        detector: [...kinds].sort().join(','),
      });
      attributedAny = true;
    }
  }

  if (!attributedAny) {
    // Detectors exist but no describe claimed them: file-level tests, or
    // bindings only used outside describes.
    const total = caseCount(0, lines.length);
    if (total > 0) {
      rows.push({
        file: relPath,
        suite: '(file-level)',
        cases: total,
        detector: [...new Set(detectors.map((d) => d.kind))].sort().join(','),
      });
      return { rows, unknown: false };
    }
    return { rows: [], unknown: true };
  }

  return { rows, unknown: false };
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'fixtures' || entry === 'node_modules') continue;
      out.push(...listTestFiles(full));
    } else if (entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

export function generate(): { tsv: string; suites: number; cases: number; files: number; unknown: string[] } {
  const testDir = join(REPO_ROOT, 'test');
  const rows: SuiteRow[] = [];
  const unknown: string[] = [];
  for (const f of listTestFiles(testDir)) {
    const rel = relative(REPO_ROOT, f);
    const res = classifyFile(rel, readFileSync(f, 'utf-8'));
    rows.push(...res.rows);
    if (res.unknown) unknown.push(rel);
  }
  // Codepoint compare, NOT localeCompare: the committed TSV is byte-diffed
  // by check-structural-manifest.sh, and localeCompare ordering shifts
  // across ICU versions/locales — a flake source, not a real change.
  const codepointCompare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  rows.sort((a, b) => (a.file === b.file ? codepointCompare(a.suite, b.suite) : codepointCompare(a.file, b.file)));
  const header = [
    '# Structural test suites — suites whose assertions read repo source/doc text.',
    '# GENERATED by scripts/classify-tests.ts; freshness-checked in verify.',
    '# Fix misclassifications in the classifier, never by hand-editing rows.',
    '# Columns: file\tsuite\tcases\tdetector',
  ].join('\n');
  const body = rows.map((r) => `${r.file}\t${r.suite}\t${r.cases}\t${r.detector}`).join('\n');
  const unknownBlock = unknown.length
    ? `\n# unknown (detectors present, no attributable suite):\n${unknown.map((u) => `# unknown\t${u}`).join('\n')}`
    : '';
  return {
    tsv: `${header}\n${body}${unknownBlock}\n`,
    suites: rows.length,
    cases: rows.reduce((s, r) => s + r.cases, 0),
    files: new Set(rows.map((r) => r.file)).size,
    unknown,
  };
}

if (import.meta.main) {
  const mode = process.argv[2] ?? '';
  const res = generate();
  const summary = `structural suites: ${res.suites} · cases: ${res.cases} · files: ${res.files} · unknown: ${res.unknown.length}`;
  if (mode === '--check') {
    let committed = '';
    try {
      committed = readFileSync(OUT_TSV, 'utf-8');
    } catch {
      console.error(`FAIL: ${relative(REPO_ROOT, OUT_TSV)} missing. Run: bun scripts/classify-tests.ts`);
      process.exit(1);
    }
    if (committed !== res.tsv) {
      console.error('FAIL: scripts/structural-suites.tsv is stale (test suites changed shape).');
      console.error('      Regenerate and commit: bun scripts/classify-tests.ts');
      process.exit(1);
    }
    console.log(`OK: structural-suites.tsv fresh (${summary})`);
  } else if (mode === '--summary') {
    console.log(summary);
  } else {
    writeFileSync(OUT_TSV, res.tsv);
    console.log(`wrote scripts/structural-suites.tsv (${summary})`);
  }
}
