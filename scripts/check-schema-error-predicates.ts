#!/usr/bin/env bun
/**
 * Schema-error predicate guard (wave 18b lane 1; registered in scripts/guards-manifest.tsv).
 *
 * `isUndefinedColumnError(e, col)` returns true for ANY SQLSTATE 42703 (the
 * column argument only matters when the driver drops the code), and
 * `isUndefinedTableError(e)` also matches `column "x" of relation "y" does not
 * exist`. A handler that uses either to mean "this brain predates migration N"
 * reports ok / skipped for every missing column or table, including the one
 * that is a real bug. A raw `'42703'` comparison has the same hole.
 *
 * This guard fails on a new call to either broad helper, or a comparison
 * against the string '42703' (`===`, `!==`, `==`, `!=`, `case`), anywhere in
 * src/ outside src/core/utils.ts unless the file is in ALLOWLIST below. Files
 * already allowlisted are the reviewed degrade ladders that still use the
 * broad helpers; an entry that no longer needs it fails as stale.
 *
 * Fix: name the objects the old schema lacks with the strict predicate,
 * `isMissingSchemaObject(e, "column", [names])` (or `"table"`), from
 * src/core/utils.ts.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ANCHOR = 'scripts/check-schema-error-predicates.ts (header)';
const HELPER = 'src/core/utils.ts';
const BROAD = new Set(['isUndefinedColumnError', 'isUndefinedTableError']);

/** Files allowed to keep a broad schema-error predicate. Each entry names its reason; a stale entry fails. */
const ALLOWLIST: Record<string, string> = {
  'src/core/oauth-provider.ts': 'OAuth token/client degrade ladders retry narrower projections on any 42703; per-column audit is a follow-up',
  'src/core/grants/legacy-token.ts': 'maps a missing grant column to grant_schema_required (a refusal, never a silent ok)',
  'src/core/item-failure.ts': 'classifies a missing table or column as run-scoped (the unit stops, never a silent ok or a skipped item)',
  'src/core/grants/rescope.ts': 'rescope degrade ladder over optional oauth_clients columns; per-column audit is a follow-up',
  'src/core/ops/request-tools.ts': 'surface-column degrade on the request-tools op; per-column audit is a follow-up',
  'src/core/token-mint.ts': 'maps a missing grant column to a schema refusal (never a silent ok)',
  'src/core/trust/min-trust.ts': 'maps a missing min_trust column to migrations_pending (a refusal, never a silent ok)',
  'src/core/sources-load.ts': 'local code-only 42703 helper behind the sources projection ladder; per-column audit is a follow-up',
  'src/core/migration-orchestration-lock.ts': 'lock probe treats a pre-lock schema as "no lock held" before migrations run',
};

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const is42703 = (node: ts.Node | undefined): boolean => !!node && ts.isStringLiteralLike(node) && node.text === '42703';
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

const violations: string[] = [];
const flagged = new Set<string>();
for (const abs of tsFiles(join(ROOT, 'src'))) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  if (rel === HELPER) continue;
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const report = (node: ts.Node, what: string) => {
    flagged.add(rel);
    if (ALLOWLIST[rel]) return;
    violations.push(`FAIL [schema_error_predicate_broad]: ${rel}:${line(node)} ${what}\n`
      + `      Fix: use isMissingSchemaObject(e, "column", [names]) (or "table") from ${HELPER}, naming the objects the old schema lacks\n`
      + `      Allowlist: only for a reviewed degrade that can never read as ok, add '${rel}': '<reason>' to ALLOWLIST in scripts/check-schema-error-predicates.ts`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && BROAD.has(name)) report(node, `calls ${name}, which matches any missing column or table`);
    } else if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind) && (is42703(node.left) || is42703(node.right))) {
      report(node, "compares a SQLSTATE against '42703', which matches any missing column");
    } else if (ts.isCaseClause(node) && is42703(node.expression)) {
      report(node, "switches on SQLSTATE '42703', which matches any missing column");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
for (const [rel, reason] of Object.entries(ALLOWLIST)) {
  if (existsSync(join(ROOT, rel)) && !flagged.has(rel)) {
    violations.push(`FAIL [schema_error_predicate_stale_allowlist]: ${rel} no longer uses a broad schema-error predicate (allowlisted: ${reason})\n`
      + '      Fix: delete its ALLOWLIST entry in scripts/check-schema-error-predicates.ts');
  }
}

if (violations.length) {
  for (const v of violations) console.error(v);
  console.error('Why:  a broad predicate reads ANY missing column or table as "pre-migration", so a real schema bug reports ok or skipped.');
  console.error(`See:  ${ANCHOR}`);
  console.error(`check-schema-error-predicates: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log(`check-schema-error-predicates: ok (src/, helper ${HELPER}, ${Object.keys(ALLOWLIST).length} allowlisted)`);
