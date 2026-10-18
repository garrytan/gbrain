#!/usr/bin/env bun
/**
 * Item allowlist-catch ratchet (GBRA-130; docs/TESTING.md#pathological-states).
 *
 * A per-item loop that hand-rolls its own item-vs-run decision, a catch that
 * compares the caught error's code against a list and rethrows everything
 * else, is the shape that lets one bad item stop a whole unit: every code the
 * list misses aborts the run. src/core/item-failure.ts (`classifyItemFailure`,
 * `ItemRun`) owns that decision, and test/pathological/ proves each adopted
 * site. This guard keeps the hand-rolled shape from spreading.
 *
 * A catch clause in src/**\/*.ts (excluding *.generated.ts and .d.ts) is a site when:
 *   1. it sits in a per-item loop: walking up from the catch to the nearest
 *      enclosing function boundary passes through the body of a for, for-of,
 *      for-in, while or do-while statement, or that boundary is a callback
 *      passed to `.forEach(...)` / `.map(...)`. A function declared inside a
 *      loop body is its own boundary, so a catch in it counts only when that
 *      function is itself a forEach/map callback or holds the loop;
 *   2. the catch block tests the caught error's code against a set, list or
 *      literal: `X.has(e.code)`, `[...].includes(e.code)`, `e.code === '23503'`,
 *      `e?.code !== CODE`, `switch (e.code)`, through parentheses, `as`
 *      casts and non-null assertions, a `const err = e as T` alias, or a code
 *      alias (`const code = (e as {code?: string}).code`, `const { code } = e`);
 *   3. the catch block rethrows the caught error: `throw e` (or an alias)
 *      anywhere in the block outside nested functions, including nested if/else.
 *
 * Rules (every violation is reported, then one exit):
 *   - a file with more sites than its baseline row, or sites and no row  -> FAIL
 *   - a file with fewer sites than its row                               -> FAIL (lower the row)
 *   - a row for a file with no sites, or a file that no longer exists    -> FAIL (remove the row)
 *   - malformed, duplicate or unsorted rows, or a missing header         -> FAIL
 *
 * `--update` rewrites scripts/item-allowlist-catches-baseline.tsv from the
 * current tree. It exists for shrinking: a raised or added row does not pass
 * review; adopt classifyItemFailure / ItemRun instead.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture root; baseline read from
 * <root>/scripts/item-allowlist-catches-baseline.tsv).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const BASELINE_REL = 'scripts/item-allowlist-catches-baseline.tsv';
const HEADER = 'path\tcount';
const ANCHOR = 'docs/TESTING.md#pathological-states';
const CALLBACK_METHODS = new Set(['forEach', 'map']);
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

export interface AllowlistCatch {
  path: string;
  line: number;
}

function strip(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function loopBody(node: ts.Node): ts.Statement | undefined {
  if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return node.statement;
  }
  return undefined;
}

function isLoopCallback(fn: ts.Node): boolean {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.some(arg => arg === fn)) return false;
  const callee = strip(call.expression);
  return ts.isPropertyAccessExpression(callee) && CALLBACK_METHODS.has(callee.name.text);
}

/** Rule 1: the catch is in a loop body, or its nearest function boundary is a forEach/map callback. */
function inPerItemLoop(clause: ts.CatchClause): boolean {
  let child: ts.Node = clause;
  for (let node: ts.Node | undefined = clause.parent; node && !ts.isSourceFile(node); child = node, node = node.parent) {
    if (isFunctionBoundary(node)) return isLoopCallback(node);
    if (loopBody(node) === child) return true;
  }
  return false;
}

/** A value a code can be compared with: a literal or a named constant, never `undefined`. */
function isComparand(node: ts.Expression): boolean {
  const n = strip(node);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return true;
  if (ts.isIdentifier(n)) return n.text !== 'undefined';
  return ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
}

/** Rules 2 and 3 over one catch block: the caught error's code is tested, and the error is rethrown. */
function testsCodeAndRethrows(block: ts.Block, catchVar: string): boolean {
  const errors = new Set([catchVar]);
  const codes = new Set<string>();
  const isError = (e: ts.Expression) => { const n = strip(e); return ts.isIdentifier(n) && errors.has(n.text); };
  const isCodeRead = (e: ts.Expression): boolean => {
    const n = strip(e);
    if (ts.isIdentifier(n)) return codes.has(n.text);
    if (ts.isPropertyAccessExpression(n)) return n.name.text === 'code' && isError(n.expression);
    return ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === 'code' && isError(n.expression);
  };
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && isError(node.initializer)) errors.add(node.name.text);
      else if (ts.isIdentifier(node.name) && isCodeRead(node.initializer)) codes.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name) && isError(node.initializer)) {
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          if (ts.isIdentifier(key) && key.text === 'code' && ts.isIdentifier(el.name)) codes.add(el.name.text);
        }
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  ts.forEachChild(block, collectAliases);

  let tested = false;
  const findTest = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      if ((isCodeRead(node.left) && isComparand(node.right)) || (isCodeRead(node.right) && isComparand(node.left))) tested = true;
    } else if (ts.isCallExpression(node) && node.arguments[0] && isCodeRead(node.arguments[0])) {
      const callee = strip(node.expression);
      if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'has' || callee.name.text === 'includes')) tested = true;
    } else if (ts.isSwitchStatement(node) && isCodeRead(node.expression)) {
      tested = true;
    }
    ts.forEachChild(node, findTest);
  };
  ts.forEachChild(block, findTest);
  if (!tested) return false;

  let rethrows = false;
  const findRethrow = (node: ts.Node): void => {
    if (ts.isThrowStatement(node) && isError(node.expression)) rethrows = true;
    if (!isFunctionBoundary(node)) ts.forEachChild(node, findRethrow);
  };
  ts.forEachChild(block, findRethrow);
  return rethrows;
}

/** Every allowlist-and-rethrow catch inside a per-item loop in one source file. */
export function findAllowlistCatches(path: string, text: string): AllowlistCatch[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: AllowlistCatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)
      && inPerItemLoop(node) && testsCodeAndRethrows(node.block, node.variableDeclaration.name.text)) {
      found.push({ path, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Compares per-file site counts with the baseline text and returns every
 * violation. `exists` says whether a baselined path is still a scanned source
 * file, so a row for a deleted file reads differently from one whose sites are gone.
 */
export function compareBaseline(sites: AllowlistCatch[], baselineText: string, exists: (path: string) => boolean = () => true): string[] {
  const problems: string[] = [];
  const rows = new Map<string, number>();
  let sawHeader = false;
  let prev = '';
  baselineText.split('\n').forEach((raw, i) => {
    if (!raw.trim() || raw.startsWith('#')) return;
    if (raw === HEADER) { sawHeader = true; return; }
    const cols = raw.split('\t');
    const count = Number(cols[1]);
    if (cols.length !== 2 || !cols[0] || !/^\d+$/.test(cols[1] ?? '') || count < 1) {
      problems.push(`FAIL: ${BASELINE_REL}:${i + 1} malformed row (want path<TAB>count, count >= 1)`);
      return;
    }
    if (rows.has(cols[0])) problems.push(`FAIL: ${BASELINE_REL}:${i + 1} duplicate row for ${cols[0]}`);
    if (prev && cols[0] < prev) problems.push(`FAIL: ${BASELINE_REL}:${i + 1} rows must be sorted by path`);
    prev = cols[0];
    rows.set(cols[0], count);
  });
  if (!sawHeader) problems.push(`FAIL: ${BASELINE_REL} is missing the header line "path<TAB>count"`);

  const byFile = new Map<string, number[]>();
  for (const site of sites) byFile.set(site.path, [...(byFile.get(site.path) ?? []), site.line]);
  for (const [path, lines] of byFile) {
    const allowed = rows.get(path) ?? 0;
    if (lines.length > allowed) {
      problems.push(`FAIL: ${path} has ${lines.length} allowlist-and-rethrow catch(es) in per-item loops, over its baseline of ${allowed}\n`
        + `      sites: ${lines.map(line => `${path}:${line}`).join(', ')}`);
    } else if (lines.length < allowed) {
      problems.push(`FAIL: ${path} dropped to ${lines.length} site(s); lower its baseline row from ${allowed} to ${lines.length}`);
    }
  }
  for (const path of rows.keys()) {
    if (byFile.has(path)) continue;
    problems.push(exists(path) ? `FAIL: ${path} has no allowlist-and-rethrow catches left: remove its baseline row`
      : `FAIL: ${path} no longer exists: remove its baseline row`);
  }
  return problems;
}

/** The baseline for `sites`: header, then one `path<TAB>count` row per file, sorted by path. */
export function formatBaseline(sites: AllowlistCatch[], preamble = ''): string {
  const counts = new Map<string, number>();
  for (const site of sites) counts.set(site.path, (counts.get(site.path) ?? 0) + 1);
  const rows = [...counts.keys()].sort().map(path => `${path}\t${counts.get(path)}`);
  return preamble + [HEADER, ...rows].join('\n') + '\n';
}

function srcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.generated.ts') && !entry.endsWith('.d.ts')) out.push(relative(root, full));
    }
  };
  walk(join(root, 'src'));
  return out;
}

function main(): number {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = process.env.GBRAIN_GUARD_ROOT ?? (git.status === 0 ? git.stdout.trim() : process.cwd());
  const baselinePath = join(root, BASELINE_REL);
  const files = srcFiles(root);
  const sites = files.flatMap(f => findAllowlistCatches(f, readFileSync(join(root, f), 'utf8')));
  const summary = `${sites.length} site(s) in ${new Set(sites.map(s => s.path)).size} file(s)`;
  const baselineText = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : null;

  if (process.argv.includes('--update')) {
    const preamble = (baselineText ?? '').split('\n').findIndex(line => !line.startsWith('#'));
    const kept = baselineText && preamble > 0 ? baselineText.split('\n').slice(0, preamble).join('\n') + '\n' : '';
    writeFileSync(baselinePath, formatBaseline(sites, kept));
    console.log(`wrote ${BASELINE_REL}: ${summary}; review the diff (rows only shrink)`);
    return 0;
  }
  if (baselineText === null) {
    console.error(`FAIL: ${BASELINE_REL} not found under ${root}`);
    return 1;
  }
  const scanned = new Set(files);
  const problems = compareBaseline(sites, baselineText, path => scanned.has(path));
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error('Why:  a per-item catch that rethrows every error code its list misses lets one bad item stop the whole unit;');
    console.error('      the baseline only shrinks.');
    console.error('Fix:  classify the failure with classifyItemFailure / ItemRun (src/core/item-failure.ts), register the site in');
    console.error('      ISOLATE_SITES and cover it in test/pathological/ (catalogue.ts + harness.ts); after a shrink run');
    console.error(`      bun scripts/check-item-allowlist-catches.ts --update. Raising or adding a row does not pass review.`);
    console.error(`See:  ${ANCHOR}`);
    console.error(`item-allowlist-catches: ${problems.length} violation(s); ${summary}`);
    return 1;
  }
  console.log(`OK: item allowlist catches match ${BASELINE_REL} (${summary})`);
  return 0;
}

if (import.meta.main) process.exit(main());
