#!/usr/bin/env bun
/**
 * Raw-SQL ratchet (D6 of docs/designs/RUST_ENGINE.md; docs/ci-guards.md#engine-raw-sql-ratchet).
 *
 * Raw SQL outside the engines moves behind typed engine methods, one
 * subsystem at a time, and never grows back. This guard counts, per file
 * under src/ (TypeScript compiler API), the raw-SQL call sites outside the
 * engines:
 *
 *   execute_raw    calls named executeRaw, executeRawDirect or executeRawJsonb
 *                  (on the engine, a transaction, a `Pick<BrainEngine,
 *                  'executeRaw'>` helper or an executor; any receiver)
 *   sql_template   tagged templates whose literal text has SQL structure
 *                  (postgres.js `sql\`...\``, sqlQueryForEngine tags)
 *   driver_call    `.unsafe(...)`, and `.query(...)` / `.exec(...)` whose
 *                  argument literal text has SQL structure (driver handles)
 *
 * SQL structure is the same test as the engine-sql ratchet (`isSqlText`), so
 * comments and prose never count. A SQL string held in a variable and passed
 * to `.query(v)` is not seen; executeRaw calls are counted whatever their
 * argument.
 *
 * Outside the engines means every .ts file under src/ except
 * src/core/engine.ts, src/core/pglite-engine.ts, src/core/postgres-engine.ts,
 * src/core/pglite-engine/**, src/core/postgres-engine/** and
 * src/core/engine-sql/** (where SQL belongs; the engine-sql ratchet guards
 * the engines themselves).
 *
 * Baseline: scripts/engine-raw-sql-baseline.tsv, rows path<TAB>metric<TAB>count[<TAB>note].
 * Counts fall; a raise edits the row in the same PR with a note saying why
 * (scripts/lib/count-ratchet.ts): a rise or a new file
 * fails, a lower count fails until its row is lowered (`--prune` lowers stale
 * rows and never raises one). `--print` prints the current counts.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root; baseline read from
 * <root>/scripts/engine-raw-sql-baseline.tsv).
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { isSqlText } from './check-engine-sql-ratchet.ts';
import { runCountRatchet, tsFiles } from './lib/count-ratchet.ts';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
export const METRICS = ['execute_raw', 'sql_template', 'driver_call'] as const;
export type Metric = (typeof METRICS)[number];

const EXECUTE_RAW = new Set(['executeRaw', 'executeRawDirect', 'executeRawJsonb']);
const SQL_ARG_DRIVER = new Set(['query', 'exec']);
const ENGINE_FILES = new Set(['src/core/engine.ts', 'src/core/pglite-engine.ts', 'src/core/postgres-engine.ts']);
const ENGINE_DIRS = ['src/core/pglite-engine/', 'src/core/postgres-engine/', 'src/core/engine-sql/'];

export function isEngineFile(rel: string): boolean {
  return ENGINE_FILES.has(rel) || ENGINE_DIRS.some((d) => rel.startsWith(d));
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) text += (text.endsWith('$') ? '0' : ' _sub_ ') + span.literal.text;
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts: string[] = [];
    const flatten = (n: ts.Expression): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        flatten(n.left);
        flatten(n.right);
      } else parts.push(literalText(n) ?? ' _sub_ ');
    };
    flatten(node);
    return parts.join('');
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literalText(node.expression);
  return null;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression;
    return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : null;
  }
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) return calleeName(expr.expression);
  return null;
}

/** `db.unsafe(...)` or `db['unsafe'](...)`: a member call, never a bare function named the same. */
function isMemberCall(expr: ts.Expression): boolean {
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) return isMemberCall(expr.expression);
  return ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr);
}

export function countFile(text: string, fileName = 'file.ts'): Record<Metric, number> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts: Record<Metric, number> = { execute_raw: 0, sql_template: 0, driver_call: 0 };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name !== null && EXECUTE_RAW.has(name)) counts.execute_raw++;
      else if (name === 'unsafe' && isMemberCall(node.expression)) counts.driver_call++;
      else if (name !== null && SQL_ARG_DRIVER.has(name) && isMemberCall(node.expression)
        && node.arguments.some((a) => { const t = literalText(a); return t !== null && isSqlText(t); })) counts.driver_call++;
    } else if (ts.isTaggedTemplateExpression(node)) {
      const name = calleeName(node.tag);
      const text = literalText(node.template);
      if (name !== null && EXECUTE_RAW.has(name)) counts.execute_raw++;
      else if (text !== null && isSqlText(text)) counts.sql_template++;
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
    name: 'check-engine-raw-sql-ratchet',
    script: 'scripts/check-engine-raw-sql-ratchet.ts',
    baselineRel: 'scripts/engine-raw-sql-baseline.tsv',
    anchor: 'docs/ci-guards.md#engine-raw-sql-ratchet',
    metrics: METRICS,
    why: 'raw SQL outside the engines falls, and a raise needs a written reason; it moves behind typed engine methods (D6, docs/designs/RUST_ENGINE.md "Track 2 rules").',
    riseFix: 'call a typed engine method instead (add one: SQL in src/core/engine-sql/<domain>.ts, both engines delegate; CONTRIBUTING.md "Storage method"); a moved file carries its row with it in the same PR',
    scan: scanTree,
  }, ROOT, process.argv);
}
