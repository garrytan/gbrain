#!/usr/bin/env bun
/**
 * Silent read-catch ratchet (docs/ci-guards.md#silent-read-catches; the
 * "silent-failure class" of docs/research/gbrain-behavior-audit.md).
 *
 * A catch that turns a failed read into an empty answer tells the user "nothing
 * found" or "healthy" when the truth is "I could not look". The Rust engine copies
 * every such answer. This guard counts them per (file, enclosing function) with the
 * TypeScript compiler API, over src/**\/*.ts (excluding *.generated.ts and .d.ts),
 * so a new one fails CI and a fixed one deletes its baseline row.
 *
 * What it flags (the rules are in scripts/silent-read-rules.ts):
 *   catch_empty          a `catch` whose try block is read-shaped and whose handler answers
 *                        nothing: it is empty (`catch {}`, comment only, rethrow-only), or its
 *                        last statement returns / assigns / pushes an empty answer
 *   promise_catch_empty  the same for `.catch(fn)` handlers: `.catch(() => [])`, `.catch(() => {})`
 *   capability_refusal_swallowed  a catch or `.catch(fn)` around a raw-SQL engine call (executeRaw,
 *                        executeRawDirect, executeRawJsonb) whose handler can fall back before it rethrows a capability
 *                        refusal (scripts/capability-refusal-rule.ts; engine implementation files excluded)
 *   Read-shaped: the guarded code calls an engine/db receiver (engine, tx, exec, db, sql, store, ...)
 *   or a read-verb name (read, load, get, list, find, count, search, fetch, query, select, lookup,
 *   resolve, has, exists, executeRaw, traverse, hybrid), minus the named write-only methods in
 *   WRITE_ONLY_METHODS. For `p.catch(...)` on a local `const p = loadX(...)`, the initializer counts.
 *   An empty answer: `[]`, `{}`, null, undefined, 0, false, 'ok', an object with `status: 'ok'`,
 *   `new Map()`, `new Set()`, or a local initialized to one of those in the same function before
 *   the try (`const m = new Map(); try { ... } catch { return m; }`). A leading
 *   `rethrowCapabilityRefusal(err)` does not exempt a site.
 *
 * Known unsupported shapes (not counted; deliberately, to keep the heuristic quiet):
 *   - a catch that only logs (console.*, logger) and then falls through or returns nothing useful;
 *   - `.catch(handlerFn)` with a named function, and `.then(ok, onError)` second arguments;
 *   - a handler that returns a non-empty fallback (`[pageSlug]`, `{ rows: [], total: 0 }`);
 *   - a read behind a helper that takes the engine as an argument and has no read-verb name, such as
 *     `budgetLimitedReport(engine, ...)` (src/core/held-embedding.ts budgetLimitedField) and
 *     `fenceHoldEntries(engine, ...)`. Counting every call that is handed the engine adds about 340 sites,
 *     most of them writes and bookkeeping, so the heuristic stays on engine receivers and read verbs.
 *
 * The fix, in order of preference:
 *   1. return a typed degraded marker (DegradedStageEntry, src/core/search/hybrid/degraded.ts), never
 *      the empty value, and call rethrowCapabilityRefusal(err) first so a Rust brain keeps its typed refusal;
 *   2. in a doctor check, use checkError(name, what, err) (warn plus health unknown);
 *   3. where an empty answer is truly right (a pre-migration "relation does not exist"), catch only that
 *      error and write `// silent-read-ok: <reason>` on the catch line or the line above. An empty
 *      reason fails.
 *
 * Baseline: scripts/silent-read-catches-baseline.tsv, rows
 *   <path>#<function><TAB><metric><TAB><count>[<TAB><note>]
 * Function names: `fn`, `Class.method`, a nested function `outer>inner`, a named const arrow `name`, an
 * object-literal member `owner.prop`; an anonymous callback is `<enclosing><anon@N>` with N the order
 * of anonymous callbacks under that enclosing function, and code outside any function is `<module>`.
 * Counts only fall (scripts/lib/count-ratchet.ts): growth, a stale row and a malformed row fail;
 * `--prune` lowers stale rows and `--print` prints the current rows; `--list` prints every site as
 * `path:line<TAB>path#function<TAB>metric`.
 *
 * Adding a rule (the plug-in point; the scanner, the baseline format and the manifest row do not change):
 *   1. Add ONE entry to SILENT_READ_RULES in scripts/silent-read-rules.ts: `{ name, metric, matcher }`.
 *      `metric` is a new unique baseline column value; `matcher(site)` returns true for a violation and
 *      sees the catch node, the try block or `.catch` receiver (`site.guarded`), the handler statements,
 *      the enclosing function and the error name. An optional `okMarker` names its opt-out comment.
 *   2. Add fixtures: known-bad and known-good trees under test/fixtures/guards/check-silent-read-catches.ts/
 *      (bad-<rule>/ and a case in good/), and cases in test/scripts/silent-read-catches.test.ts.
 *   3. Generate the new rule's baseline rows from the tree:
 *        bun scripts/check-silent-read-catches.ts --print | grep -P '\t<metric>\t' >> scripts/silent-read-catches-baseline.tsv
 *      then sort the file (rows are sorted by key) and add notes where a row maps to an audit finding.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture root; baseline read from <root>/scripts/silent-read-catches-baseline.tsv).
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { runCountRatchet, tsFiles } from './lib/count-ratchet.ts';
import { SILENT_READ_RULES, type SilentReadRule, type SiteContext } from './silent-read-rules.ts';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const BASELINE_REL = 'scripts/silent-read-catches-baseline.tsv';
const DEFAULT_MARKER = 'silent-read-ok';
export const METRICS: readonly string[] = SILENT_READ_RULES.map(r => r.metric);

export interface FileScan {
  /** `key<TAB>metric` -> count, where key is `path#function`. */
  counts: Map<string, number>;
  /** Sites that carry an opt-out marker with no reason: `path:line: message`. */
  problems: string[];
  /** Every counted site, for `--list`: `path:line<TAB>key<TAB>metric`. */
  sites: string[];
}

function isNamedBy(node: ts.Node): string | undefined {
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return undefined;
}

function propName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : name.getText();
}

/** The name segment a function-like node contributes, or undefined when it is an anonymous callback. */
function segmentOf(node: ts.Node, className: string | undefined): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? 'default';
  if (ts.isConstructorDeclaration(node)) return (className ?? '<class>') + '.constructor';
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const prefix = ts.isGetAccessorDeclaration(node) ? 'get ' : ts.isSetAccessorDeclaration(node) ? 'set ' : '';
    return ts.isClassLike(node.parent) ? (className ?? '<class>') + '.' + prefix + propName(node.name) : prefix + propName(node.name);
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if (ts.isFunctionExpression(node) && node.name) return node.name.text;
    const p = node.parent;
    const viaVar = isNamedBy(node);
    if (viaVar) return viaVar;
    if (p && ts.isPropertyAssignment(p)) {
      const owner = ts.isObjectLiteralExpression(p.parent) ? isNamedBy(p.parent) : undefined;
      return (owner ? owner + '.' : '') + propName(p.name);
    }
    if (p && ts.isPropertyDeclaration(p)) return (className ?? '<class>') + '.' + propName(p.name);
  }
  return undefined;
}

/** `path#function` key per function-like node, in document order; anonymous callbacks are numbered under their parent. */
function nameFunctions(sf: ts.SourceFile): Map<ts.Node, string> {
  const keys = new Map<ts.Node, string>();
  const anon = new Map<string, number>();
  const visit = (node: ts.Node, parentKey: string, className: string | undefined): void => {
    let nextParent = parentKey;
    let nextClass = className;
    if (ts.isClassLike(node)) nextClass = node.name?.text ?? isNamedBy(node) ?? '<class>';
    else if (ts.isFunctionLike(node) && !ts.isSourceFile(node) && 'body' in node) {
      const seg = segmentOf(node, className);
      let key: string;
      if (seg !== undefined) key = parentKey ? parentKey + '>' + seg : seg;
      else {
        const base = parentKey || '<module>';
        const n = (anon.get(base) ?? 0) + 1;
        anon.set(base, n);
        key = base + '<anon@' + n + '>';
      }
      keys.set(node, key);
      nextParent = key;
    }
    ts.forEachChild(node, c => visit(c, nextParent, nextClass));
  };
  visit(sf, '', undefined);
  return keys;
}

function enclosingFunction(node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isSourceFile(n) || (ts.isFunctionLike(n) && 'body' in n)) return n;
  }
  return node.getSourceFile();
}

/** The reason text of a `// <marker>: <reason>` comment on the line or the line above; null when no marker. */
function markerReason(lines: readonly string[], lineIdx: number, marker: string): string | null {
  for (const i of [lineIdx, lineIdx - 1]) {
    const reason = i >= 0 && i < lines.length ? lineMarkerReason(lines[i], marker) : null;
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * One line's marker reason, parsed with string operations instead of a RegExp built from `marker`
 * (semgrep's detect-non-literal-regexp). Accepts `//` or `/*`, optional whitespace, the marker as a
 * whole word, then either nothing or `: <reason>`, then an optional closing `*\/`. After a `/*` the
 * reason stops at that comment's own `*\/`, so code following an empty comment is never read as one.
 */
function lineMarkerReason(line: string, marker: string): string | null {
  for (let p = 0; p < line.length - 1; p++) {
    const opener = line.slice(p, p + 2);
    if (opener !== '//' && opener !== '/*') continue;
    const rest = line.slice(p + 2).replace(/^\s+/, '');
    if (!rest.startsWith(marker) || /^\w/.test(rest.slice(marker.length))) continue;
    // A block comment's reason ends at its own `*/`; the code after it is never part of the reason.
    let tail = rest.slice(marker.length);
    if (opener === '/*') {
      const close = tail.indexOf('*/');
      if (close >= 0) tail = tail.slice(0, close);
    }
    if (/[\r\u2028\u2029]/.test(tail)) continue;
    const colon = tail.startsWith(':');
    if (colon) tail = tail.slice(1);
    tail = tail.replace(/[ \t]+$/, '');
    if (tail.endsWith('*/')) tail = tail.slice(0, -2).replace(/[ \t]+$/, '');
    if (!colon) {
      if (tail.trim() === '') return '';
      continue;
    }
    return tail.trim();
  }
  return null;
}

/** The fix text for a count rise: each rule's `fix`, grouped by metric (rules that share a fix print it once). */
export function riseFix(rules: readonly SilentReadRule[]): string {
  const byFix = new Map<string, string[]>();
  for (const r of rules) {
    const fix = r.fix ?? 'see the rule in scripts/silent-read-rules.ts';
    byFix.set(fix, [...(byFix.get(fix) ?? []), r.metric]);
  }
  return [...byFix].map(([fix, metrics]) => metrics.join(' / ') + ': ' + fix).join('\n            ');
}

export function scanFile(text: string, rel: string, rules: readonly SilentReadRule[] = SILENT_READ_RULES): FileScan {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split('\n');
  const names = nameFunctions(sf);
  const counts = new Map<string, number>();
  const problems: string[] = [];
  const sites: string[] = [];

  const evaluate = (site: SiteContext, anchor: ts.Node): void => {
    const fn = enclosingFunction(site.catchNode);
    const fnKey = ts.isSourceFile(fn) ? '<module>' : names.get(fn) ?? '<module>';
    const lineIdx = sf.getLineAndCharacterOfPosition(anchor.getStart(sf)).line;
    for (const rule of rules) {
      if (!rule.matcher(site)) continue;
      const marker = rule.okMarker ?? DEFAULT_MARKER;
      const reason = markerReason(lines, lineIdx, marker);
      if (reason) continue;
      if (reason === '') problems.push(rel + ':' + (lineIdx + 1) + ': `' + marker + '` needs a reason: `// ' + marker + ': <why an empty answer is right>`');
      const key = rel + '#' + fnKey + '\t' + rule.metric;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      sites.push(rel + ':' + (lineIdx + 1) + '\t' + key);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && ts.isTryStatement(node.parent)) {
      const handler = node.block.statements;
      evaluate({
        kind: 'try-catch', catchNode: node, handlerStatements: handler, guarded: node.parent.tryBlock,
        tryStatement: node.parent, enclosingFunction: enclosingFunction(node), sourceFile: sf,
        errorName: node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name) ? node.variableDeclaration.name.text : undefined,
      }, node);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch'
      && node.arguments.length === 1 && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))) {
      const fn = node.arguments[0] as ts.ArrowFunction | ts.FunctionExpression;
      const handler: readonly ts.Statement[] = ts.isBlock(fn.body)
        ? fn.body.statements
        : [ts.factory.createReturnStatement(fn.body as ts.Expression)];
      const param = fn.parameters[0];
      evaluate({
        kind: 'promise-catch', catchNode: node, handlerStatements: handler, guarded: node.expression.expression,
        enclosingFunction: enclosingFunction(node), sourceFile: sf,
        errorName: param && ts.isIdentifier(param.name) ? param.name.text : undefined,
      }, node.expression.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { counts, problems, sites };
}

export function scanTree(root: string, rules: readonly SilentReadRule[] = SILENT_READ_RULES): FileScan {
  const counts = new Map<string, number>();
  const problems: string[] = [];
  const sites: string[] = [];
  for (const abs of tsFiles(join(root, 'src'))) {
    if (abs.endsWith('.generated.ts')) continue;
    const rel = relative(root, abs).replace(/\\/g, '/');
    const text = readFileSync(abs, 'utf8');
    if (!text.includes('catch')) continue; // no catch clause and no `.catch(`: nothing to parse
    const scan = scanFile(text, rel, rules);
    for (const [k, n] of scan.counts) counts.set(k, (counts.get(k) ?? 0) + n);
    problems.push(...scan.problems);
    sites.push(...scan.sites);
  }
  return { counts, problems, sites };
}

if (import.meta.main) {
  const scan = scanTree(ROOT);
  if (process.argv.includes('--list')) {
    for (const site of scan.sites) console.log(site);
    process.exit(0);
  }
  if (scan.problems.length && !process.argv.includes('--print') && !process.argv.includes('--prune')) {
    for (const p of scan.problems) console.error('FAIL: ' + p);
    console.error('Why:  an opt-out marker with no reason hides a silent failure from review');
    console.error('See:  docs/ci-guards.md#silent-read-catches');
    console.error('check-silent-read-catches: ' + scan.problems.length + ' violation(s)');
    process.exit(1);
  }
  runCountRatchet({
    name: 'check-silent-read-catches',
    script: 'scripts/check-silent-read-catches.ts',
    baselineRel: BASELINE_REL,
    anchor: 'docs/ci-guards.md#silent-read-catches',
    metrics: METRICS,
    why: 'a catch that turns a failed read into an empty answer (or a Rust capability refusal into a quiet default) reads as "nothing found" or "healthy"; these sites only fall, and the Rust engine copies every one that stays.',
    riseFix: riseFix(SILENT_READ_RULES),
    scan: () => scan.counts,
  }, ROOT, process.argv);
}
