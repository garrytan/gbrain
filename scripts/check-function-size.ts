#!/usr/bin/env bun
/**
 * Function-size ratchet (refactor wave 1, W5; docs/TESTING.md#function-size-ratchet).
 *
 * check-module-size.sh caps FILE size, so a 3,000-line function inside a file
 * under its ceiling was invisible. This guard measures every function-like
 * node in src/**\/*.ts (excluding *.generated.ts and .d.ts) with the
 * TypeScript compiler API: function declarations, methods, constructors,
 * accessors, arrow functions and function expressions, including the
 * object-literal and class-property forms. Nested functions are measured on
 * their own; an outer function's length includes them.
 *
 * Rules (every violation is reported, then one exit):
 *   1. a function over LIMIT lines with no baseline row          -> FAIL (new)
 *   2. a baselined function longer than its row                   -> FAIL (growth)
 *   3. a baselined function at or under LIMIT                     -> FAIL (remove the row)
 *   4. a baselined function more than SLACK lines under its row   -> FAIL (lower the row)
 *   5. a baseline row whose function no longer exists             -> FAIL (remove or transfer)
 *   6. a row raised above (or added since) the base baseline
 *      without an issue/TODO id in its justification              -> FAIL (raise)
 *   7. malformed, duplicate or unsorted rows                      -> FAIL
 *
 * Rows are keyed by `path<TAB>name-path`, never line numbers, so unrelated
 * edits above a function do not churn the baseline. The name path is built
 * from enclosing declarations, property names and call context, e.g.
 * `PGLiteEngine.initSchema`, `runServeHttp>app.post('/mcp')`,
 * `MIGRATIONS[v131].handler`, `add>result=this.engine.transaction(#0)`
 * (`>` enters a function, `.` a member, `=` a call whose result is bound); a repeated key gets a `#2`, `#3` ordinal in
 * source order. Every failure prints the computed key so it can be copied.
 *
 * Baseline identity transfer: a move-only commit changes a function's key.
 * `bun scripts/check-function-size.ts --transfer` rewrites a missing row to
 * the one unbaselined over-limit function whose whitespace-normalized text is
 * identical to the old function at the base ref (default HEAD; `--from <ref>`)
 * apart from an added leading `export` and re-relativized module specifiers,
 * keeping lines and justification. Anything that is not a verified identical
 * move is left for review.
 *
 * Seams: GBRAIN_GUARD_ROOT (fixture root; baseline read from
 * <root>/scripts/function-size-baseline.tsv, base baseline from
 * <root>/scripts/function-size-baseline.base.tsv if present),
 * GBRAIN_FUNCTION_SIZE_LIMIT, GBRAIN_FUNCTION_SIZE_SLACK,
 * GBRAIN_FUNCTION_SIZE_BASE_REF (git ref whose merge-base supplies the base
 * baseline; default origin/master).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const FIXTURE_ROOT = process.env.GBRAIN_GUARD_ROOT;
const ROOT = FIXTURE_ROOT ?? gitOut(['rev-parse', '--show-toplevel'], process.cwd())?.trim() ?? process.cwd();
const BASELINE_REL = 'scripts/function-size-baseline.tsv';
const BASELINE = join(ROOT, BASELINE_REL);
const LIMIT = positiveInt(process.env.GBRAIN_FUNCTION_SIZE_LIMIT, 300);
const SLACK = positiveInt(process.env.GBRAIN_FUNCTION_SIZE_SLACK, 50);
const ANCHOR = 'docs/TESTING.md#function-size-ratchet';
const ISSUE_ID = /(#\d+|TODOS\.md:\d+|\bTODO[-:]\s*\S+|\b[A-Z][A-Z0-9]+-\d+\b)/;
const HEADER = 'path\tname\tlines\tjustification';

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function gitOut(args: string[], cwd: string): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

export interface MeasuredFunction {
  path: string;
  name: string;
  line: number;
  lines: number;
  text: string;
}

function propertyName(name: ts.PropertyName | ts.BindingName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return name.getText(sf).replace(/\s+/g, ' ');
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function callLabel(call: ts.CallExpression | ts.NewExpression, sf: ts.SourceFile, child: ts.Node): string {
  const callee = call.expression.getText(sf).replace(/\s+/g, '');
  const args = call.arguments ?? ts.factory.createNodeArray();
  const literal = args.find((a) => ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) as
    | ts.StringLiteral
    | undefined;
  if (literal) return `${callee}('${literal.text.slice(0, 60)}')`;
  const index = args.findIndex((a) => a === child || (child.pos >= a.pos && child.end <= a.end));
  return `${callee}(#${index < 0 ? 0 : index})`;
}

function arrayElementLabel(obj: ts.ObjectLiteralExpression, arr: ts.ArrayLiteralExpression): string {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
    if (p.name.text === 'version' && ts.isNumericLiteral(p.initializer)) return `[v${p.initializer.text}]`;
  }
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
    if (p.name.text === 'name' && ts.isStringLiteral(p.initializer)) return `[${p.initializer.text}]`;
  }
  return `[${arr.elements.indexOf(obj)}]`;
}

/**
 * Label contributed by one ancestor (or the function itself), or null when the
 * node adds nothing to the name path. `fn` marks labels that open a function
 * scope, so the next segment is joined with `>` instead of `.`.
 */
type Segment = { label: string; fn: boolean; bracket?: boolean; call?: boolean };

function labelOf(node: ts.Node, child: ts.Node, sf: ts.SourceFile): Segment | null {
  if (ts.isFunctionDeclaration(node)) return { label: node.name?.text ?? '<anonymous>', fn: true };
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return { label: node.name?.text ?? '<class>', fn: false };
  if (ts.isMethodDeclaration(node)) return { label: propertyName(node.name, sf), fn: true };
  if (ts.isConstructorDeclaration(node)) return { label: 'constructor', fn: true };
  if (ts.isGetAccessorDeclaration(node)) return { label: `get ${propertyName(node.name, sf)}`, fn: true };
  if (ts.isSetAccessorDeclaration(node)) return { label: `set ${propertyName(node.name, sf)}`, fn: true };
  if (ts.isVariableDeclaration(node)) return { label: propertyName(node.name, sf), fn: false };
  if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) return { label: propertyName(node.name, sf), fn: false };
  if (ts.isExportAssignment(node)) return { label: 'default', fn: false };
  if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && child !== node.expression) {
    return { label: callLabel(node, sf, child), fn: false, call: true };
  }
  if (ts.isCallExpression(node) && child === node.expression) return { label: '<iife>', fn: false };
  if (ts.isArrayLiteralExpression(node) && ts.isObjectLiteralExpression(child)) {
    return { label: arrayElementLabel(child, node), fn: false, bracket: true };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node.name ? { label: node.name.text, fn: true } : { label: '', fn: true };
  }
  return null;
}

function namePath(fnNode: ts.Node, sf: ts.SourceFile): string {
  const segments: Segment[] = [];
  let child: ts.Node = fnNode;
  let node: ts.Node | undefined = fnNode;
  while (node && !ts.isSourceFile(node)) {
    const l = labelOf(node, child, sf);
    if (l) segments.unshift(l);
    child = node;
    node = node.parent;
  }
  let out = '';
  let prev = null as Segment | null;
  for (const s of segments) {
    if (s.label === '') {
      const before: Segment | null = prev;
      prev = before ? { ...before, fn: before.fn || s.fn } : s;
      continue;
    }
    if (!out) out = s.label;
    else if (s.bracket) out += s.label;
    else if (prev?.fn) out += '>' + s.label;
    else if (s.call && prev && !prev.call && !prev.bracket) out += '=' + s.label;
    else out += '.' + s.label;
    prev = s;
  }
  return out || '<anonymous>';
}

export function measureSource(path: string, text: string): MeasuredFunction[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: MeasuredFunction[] = [];
  const seen = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      let name = namePath(node, sf);
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name}#${n}`;
      found.push({ path, name, line: start + 1, lines: end - start + 1, text: node.getText(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function srcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.generated.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(join(root, 'src'));
  return out;
}

interface BaselineRow {
  path: string;
  name: string;
  lines: number;
  justification: string;
  lineNo: number;
}

function parseBaseline(text: string, label: string, problems: string[]): BaselineRow[] {
  const rows: BaselineRow[] = [];
  const lines = text.split('\n');
  let sawHeader = false;
  lines.forEach((raw, i) => {
    if (!raw.trim() || raw.startsWith('#')) return;
    if (raw === HEADER) {
      sawHeader = true;
      return;
    }
    const cols = raw.split('\t');
    const lines = Number(cols[2]);
    if (cols.length !== 4 || !cols[0] || !cols[1] || !Number.isInteger(lines) || !cols[3]?.trim()) {
      problems.push(`FAIL: ${label}:${i + 1} malformed row (want path<TAB>name<TAB>lines<TAB>justification)`);
      return;
    }
    rows.push({ path: cols[0], name: cols[1], lines, justification: cols[3], lineNo: i + 1 });
  });
  if (!sawHeader && rows.length) problems.push(`FAIL: ${label} is missing the header line "${HEADER.replace(/\t/g, '<TAB>')}"`);
  return rows;
}

function baseBaselineText(): { text: string | null; source: string } {
  if (FIXTURE_ROOT) {
    const p = join(ROOT, 'scripts/function-size-baseline.base.tsv');
    return existsSync(p) ? { text: readFileSync(p, 'utf8'), source: 'fixture base' } : { text: null, source: 'none' };
  }
  const ref = process.env.GBRAIN_FUNCTION_SIZE_BASE_REF ?? 'origin/master';
  const mergeBase = gitOut(['merge-base', 'HEAD', ref], ROOT)?.trim();
  const at = mergeBase ?? (gitOut(['rev-parse', '--verify', 'HEAD'], ROOT) ? 'HEAD' : null);
  if (!at) return { text: null, source: 'none (no git history)' };
  const text = gitOut(['show', `${at}:${BASELINE_REL}`], ROOT);
  const source = mergeBase ? `merge-base with ${ref}` : `HEAD (${ref} unavailable)`;
  return { text, source: text === null ? `${source}: no baseline yet (seed)` : source };
}

const keyOf = (path: string, name: string) => `${path}\t${name}`;
const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Move-normalized text for --transfer: a move into another module may add a
 * leading `export` and must re-relativize module specifiers (`import('../x.ts')`
 * becomes `import('../../x.ts')` one directory down). Specifier-shaped string
 * literals are resolved against their own file, so they compare equal only
 * when both sides name the same module.
 */
function moveNormalized(text: string, path: string): string {
  const resolved = text.replace(/(['"])(\.\.?\/[^'"\n]*)\1/g, (_m, q: string, spec: string) =>
    `${q}@${relative(ROOT, resolve(dirname(join(ROOT, path)), spec))}${q}`);
  return normalized(resolved).replace(/^export /, '');
}

function formatBaseline(rows: Omit<BaselineRow, 'lineNo'>[], preamble: string): string {
  const sorted = [...rows].sort((a, b) => (a.path === b.path ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.path < b.path ? -1 : 1));
  return preamble + [HEADER, ...sorted.map((r) => `${r.path}\t${r.name}\t${r.lines}\t${r.justification}`)].join('\n') + '\n';
}

function preambleOf(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) out.push(line);
    else break;
  }
  return out.length ? out.join('\n') + '\n' : '';
}

function main(): number {
  const t0 = performance.now();
  const args = process.argv.slice(2);
  const measured = srcFiles(ROOT).flatMap((f) => measureSource(relative(ROOT, f), readFileSync(f, 'utf8')));
  const byKey = new Map(measured.map((m) => [keyOf(m.path, m.name), m]));
  const problems: string[] = [];
  if (!existsSync(BASELINE)) {
    console.error(`FAIL: ${BASELINE_REL} not found under ${ROOT}`);
    return 1;
  }
  const baselineText = readFileSync(BASELINE, 'utf8');
  const rows = parseBaseline(baselineText, BASELINE_REL, problems);

  if (args[0] === '--seed') {
    const seeded = measured
      .filter((m) => m.lines > LIMIT)
      .map((m) => ({ path: m.path, name: m.name, lines: m.lines, justification: args[1] ?? 'seed' }));
    writeFileSync(BASELINE, formatBaseline(seeded, preambleOf(baselineText)));
    console.log(`seeded ${seeded.length} row(s) into ${BASELINE_REL}`);
    return 0;
  }

  if (args[0] === '--transfer') {
    const fromIdx = args.indexOf('--from');
    const ref = fromIdx >= 0 ? args[fromIdx + 1] : 'HEAD';
    const baselined = new Set(rows.map((r) => keyOf(r.path, r.name)));
    const candidates = measured.filter((m) => m.lines > LIMIT && !baselined.has(keyOf(m.path, m.name)));
    let moved = 0;
    const next = rows.map((r) => {
      if (byKey.has(keyOf(r.path, r.name))) return r;
      const old = gitOut(['show', `${ref}:${r.path}`], ROOT);
      const oldFn = old ? measureSource(r.path, old).find((m) => m.name === r.name) : undefined;
      const matches = oldFn ? candidates.filter((c) => moveNormalized(c.text, c.path) === moveNormalized(oldFn.text, r.path)) : [];
      if (matches.length !== 1) {
        console.log(`skip: ${r.path}\t${r.name} (${oldFn ? `${matches.length} identical candidates` : `not found at ${ref}`})`);
        return r;
      }
      moved++;
      console.log(`transfer: ${r.path}\t${r.name} -> ${matches[0].path}\t${matches[0].name}`);
      return { ...r, path: matches[0].path, name: matches[0].name };
    });
    writeFileSync(BASELINE, formatBaseline(next, preambleOf(baselineText)));
    console.log(`transferred ${moved} row(s); review the ${BASELINE_REL} diff`);
    return 0;
  }

  const seenRows = new Set<string>();
  let prev = '';
  for (const r of rows) {
    const key = keyOf(r.path, r.name);
    if (seenRows.has(key)) problems.push(`FAIL: ${BASELINE_REL}:${r.lineNo} duplicate row for ${key}`);
    seenRows.add(key);
    if (prev && key < prev) problems.push(`FAIL: ${BASELINE_REL}:${r.lineNo} rows must be sorted by path then name (regenerate order)`);
    prev = key;
  }
  const baselineByKey = new Map(rows.map((r) => [keyOf(r.path, r.name), r]));

  const newLong = measured.filter((m) => m.lines > LIMIT && !baselineByKey.has(keyOf(m.path, m.name)));
  for (const m of newLong) {
    problems.push(`FAIL: ${m.path}:${m.line} ${m.name} is ${m.lines} lines, over the ${LIMIT}-line limit (no baseline row)\n      key: ${m.path}\t${m.name}`);
  }
  const missing: BaselineRow[] = [];
  for (const r of rows) {
    const m = byKey.get(keyOf(r.path, r.name));
    if (!m) {
      missing.push(r);
      problems.push(`FAIL: ${BASELINE_REL}:${r.lineNo} ${r.path} ${r.name} no longer exists (remove the row, or --transfer a verified move)`);
    } else if (m.lines > r.lines) {
      problems.push(`FAIL: ${m.path}:${m.line} ${m.name} grew to ${m.lines} lines, over its ${r.lines}-line baseline\n      key: ${m.path}\t${m.name}`);
    } else if (m.lines <= LIMIT) {
      problems.push(`FAIL: ${m.path}:${m.line} ${m.name} shrank to ${m.lines} lines, under the ${LIMIT}-line limit: remove its baseline row`);
    } else if (r.lines - m.lines > SLACK) {
      problems.push(`FAIL: ${m.path}:${m.line} ${m.name} shrank to ${m.lines} lines; lower its baseline row from ${r.lines} to ${m.lines}`);
    }
  }
  const moveHints = missing.filter((r) => newLong.some((m) => m.name.split(/[>.]/).pop() === r.name.split(/[>.]/).pop()));
  if (moveHints.length) {
    problems.push(`FAIL: ${moveHints.length} missing row(s) match a new over-limit function by name; if this is a move-only commit run: bun scripts/check-function-size.ts --transfer`);
  }

  const base = baseBaselineText();
  const raises: string[] = [];
  if (base.text !== null) {
    const baseRows = new Map(parseBaseline(base.text, 'base baseline', []).map((r) => [keyOf(r.path, r.name), r]));
    for (const r of rows) {
      const b = baseRows.get(keyOf(r.path, r.name));
      if (b && r.lines <= b.lines) continue;
      const what = b ? `raised ${b.lines} -> ${r.lines}` : `added at ${r.lines}`;
      raises.push(`${r.path}\t${r.name} ${what}: ${r.justification}`);
      if (!ISSUE_ID.test(r.justification)) {
        problems.push(`FAIL: ${BASELINE_REL}:${r.lineNo} ${r.name} ${what} without an issue/TODO id in its justification`);
      }
    }
  }

  const seconds = ((performance.now() - t0) / 1000).toFixed(1);
  const overLimit = measured.filter((m) => m.lines > LIMIT).length;
  for (const r of raises) console.log(`raise: ${r}`);
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(`Why:  functions over ${LIMIT} lines may not appear or grow; the baseline only shrinks (W5 ratchet).`);
    console.error('Fix:  extract cohesive blocks into named helpers or sibling modules (phase / stage / handler-table pattern);');
    console.error(`      a justified exception edits ${BASELINE_REL} with an issue/TODO id in the justification.`);
    console.error(`See:  ${ANCHOR}`);
    console.error(`function-size: ${problems.length} violation(s); ${overLimit} over-limit function(s), ${rows.length} baseline row(s), base: ${base.source}, ${seconds}s`);
    return 1;
  }
  console.log(`OK: function sizes within ${BASELINE_REL} (${overLimit} over-limit function(s) baselined, ${raises.length} raise(s), base: ${base.source}, ${seconds}s)`);
  return 0;
}

if (import.meta.main) process.exit(main());
