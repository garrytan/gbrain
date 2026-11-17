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
 *   kind_case      `case 'pglite':` / `case 'postgres':` in a switch over such x
 *
 * Outside the engines is the same set as the raw-SQL ratchet
 * (scripts/check-engine-raw-sql-ratchet.ts `isEngineFile`).
 *
 * Baseline: scripts/engine-kind-branches-baseline.tsv, rows
 * path<TAB>metric<TAB>count. Counts only fall (scripts/lib/count-ratchet.ts);
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
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return KIND_NAMES.has(node.argumentExpression.text);
  return false;
}

export function countFile(text: string, fileName = 'file.ts'): Record<Metric, number> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts: Record<Metric, number> = { kind_compare: 0, kind_case: 0 };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      if ((isKindLiteral(node.right) && isKindExpr(node.left)) || (isKindLiteral(node.left) && isKindExpr(node.right))) counts.kind_compare++;
    } else if (ts.isSwitchStatement(node) && isKindExpr(node.expression)) {
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
    why: 'a third engine must never fall into a two-way pglite/postgres branch; these branches only fall (D6, docs/designs/RUST_ENGINE.md "Engine selection").',
    riseFix: 'ask a capability question (engine.capabilities) or switch exhaustively over every engine kind instead of comparing with \'pglite\' / \'postgres\'; a moved file carries its row with it in the same PR',
    scan: scanTree,
  }, ROOT, process.argv);
}
