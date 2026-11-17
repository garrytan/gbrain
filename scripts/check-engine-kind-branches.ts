#!/usr/bin/env bun
/**
 * Engine-kind branch ratchet (D6 of docs/designs/RUST_ENGINE.md, "Engine
 * selection"; docs/ci-guards.md#engine-kind-branches).
 *
 * A third engine must never fall silently into a two-way `pglite` / `postgres`
 * branch. New code asks a capability question or uses an exhaustive switch
 * over every engine kind instead. This guard counts, per file under src/
 * (TypeScript compiler API), outside the engines:
 *
 *   kind_compare   `x === 'pglite'`, `x !== 'postgres'` (and `==` / `!=`, either
 *                  side) where x ends in the name kind, engineKind,
 *                  engine_kind or engine (`engine.kind`, `cfg.engine`)
 *   kind_case      `case 'pglite':` / `case 'postgres':` in a switch over such x,
 *                  unless the switch is exhaustive (its default clause opens
 *                  with a `never` check on the switched value; see isExhaustive)
 *
 * Outside the engines is the same set as the raw-SQL ratchet
 * (scripts/check-engine-raw-sql-ratchet.ts `isEngineFile`).
 *
 * Baseline: scripts/engine-kind-branches-baseline.tsv, rows
 * path<TAB>metric<TAB>count[<TAB>note]. Counts fall (scripts/lib/count-ratchet.ts);
 * a raise edits the row in the same PR with a note saying why;
 * `--prune` lowers stale rows, `--print` prints the current counts.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root; baseline read from
 * <root>/scripts/engine-kind-branches-baseline.tsv).
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { isEngineFile } from './check-engine-raw-sql-ratchet.ts';
import { runCountRatchet, tsFiles } from './lib/count-ratchet.ts';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
export const METRICS = ['kind_compare', 'kind_case'] as const;
export type Metric = (typeof METRICS)[number];

const KINDS = new Set(['pglite', 'postgres']);
const KIND_NAMES = new Set(['kind', 'engineKind', 'engine_kind', 'engine']);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

function isKindLiteral(node: ts.Expression): boolean {
  return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && KINDS.has(node.text);
}

function isKindExpr(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return isKindExpr(node.expression);
  if (ts.isIdentifier(node)) return KIND_NAMES.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return KIND_NAMES.has(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && KIND_NAMES.has(key.text);
  }
  return false;
}

/**
 * An exhaustive switch is the recommended form, so it never counts: the first
 * statement of its `default` clause (or of a block that is the clause's first
 * statement) hands the switched value itself to a compile-time `never` check
 * (`const unreachable: never = kind;`, `kind satisfies never;`,
 * `assertNever(kind);`, `return assertNever(kind);` or `throw assertNever(kind);`),
 * so a third engine fails typecheck instead of falling into a branch.
 * Nothing counts that the first statement does not prove: a check after other
 * statements (an earlier `if (kind) return` narrows the value to `never`), a
 * check inside a nested function, a cast (`kind as never`), a check on some
 * other value, or a switch whose clauses declare a name that shadows the
 * switched value's root identifier.
 */
function isExhaustive(node: ts.SwitchStatement): boolean {
  const def = node.caseBlock.clauses.find(ts.isDefaultClause);
  if (!def) return false;
  const subjectExpr = unwrap(node.expression);
  const root = rootName(subjectExpr);
  if (root === undefined) return false;
  const subject = subjectExpr.getText();
  const isSubject = (e: ts.Expression | undefined): boolean => e !== undefined && unwrap(e).getText() === subject;
  const isAssertNever = (e: ts.Expression | undefined): boolean => {
    if (e === undefined) return false;
    const c = unwrap(e);
    return ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'assertNever'
      && c.arguments.length === 1 && isSubject(c.arguments[0]);
  };
  let first: ts.Statement | undefined = def.statements[0];
  const scopes: ts.NodeArray<ts.Statement>[] = node.caseBlock.clauses.map(c => c.statements);
  if (first && ts.isBlock(first)) {
    scopes.push(first.statements);
    first = first.statements[0];
  }
  for (const statements of scopes) {
    for (const st of statements) if (declaredNames(st).includes(root)) return false;
  }
  if (!first) return false;
  if (ts.isVariableStatement(first)) {
    const decls = first.declarationList.declarations;
    return decls.length === 1 && decls[0].type?.kind === ts.SyntaxKind.NeverKeyword && isSubject(decls[0].initializer);
  }
  if (ts.isExpressionStatement(first)) {
    const e = unwrap(first.expression);
    if (ts.isSatisfiesExpression(e)) return e.type.kind === ts.SyntaxKind.NeverKeyword && isSubject(e.expression);
    return isAssertNever(e);
  }
  if (ts.isReturnStatement(first) || ts.isThrowStatement(first)) return isAssertNever(first.expression);
  return false;
}

/** The leftmost identifier of `kind`, `engine.kind` or `cfg['engine']`; undefined for anything else. */
function rootName(e: ts.Expression): string | undefined {
  const x = unwrap(ts.isAsExpression(e) ? e.expression : e);
  if (ts.isIdentifier(x)) return x.text;
  if (x.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) return rootName(x.expression);
  return undefined;
}

/** Names a statement declares in the scope it sits in (variables, functions, classes). */
function declaredNames(st: ts.Statement): string[] {
  const out: string[] = [];
  const bind = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) out.push(n.text);
    else for (const el of n.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
  };
  if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach(d => bind(d.name));
  else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) out.push(st.name.text);
  return out;
}

function unwrap(e: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) ? unwrap(e.expression) : e;
}

export function countFile(text: string, fileName = 'file.ts'): Record<Metric, number> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts: Record<Metric, number> = { kind_compare: 0, kind_case: 0 };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      if ((isKindLiteral(node.right) && isKindExpr(node.left)) || (isKindLiteral(node.left) && isKindExpr(node.right))) counts.kind_compare++;
    } else if (ts.isSwitchStatement(node) && isKindExpr(node.expression) && !isExhaustive(node)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && isKindLiteral(clause.expression)) counts.kind_case++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}

export function scanTree(root: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const abs of tsFiles(join(root, 'src'))) {
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (isEngineFile(rel)) continue;
    const counts = countFile(readFileSync(abs, 'utf8'), abs);
    for (const m of METRICS) if (counts[m] > 0) out.set(rel + '\t' + m, counts[m]);
  }
  return out;
}

if (import.meta.main) {
  runCountRatchet({
    name: 'check-engine-kind-branches',
    script: 'scripts/check-engine-kind-branches.ts',
    baselineRel: 'scripts/engine-kind-branches-baseline.tsv',
    anchor: 'docs/ci-guards.md#engine-kind-branches',
    metrics: METRICS,
    why: 'a third engine must never fall into a two-way pglite/postgres branch; these branches fall, and a raise needs a written reason (D6, docs/designs/RUST_ENGINE.md "Engine selection").',
    riseFix: 'ask a capability question (engine.capabilities) or switch over every engine kind with a default clause whose first statement is a never check on the switched value (`const unreachable: never = kind;`; that switch never counts) instead of comparing with \'pglite\' / \'postgres\'; a moved file carries its row with it in the same PR',
    scan: scanTree,
  }, ROOT, process.argv);
}
