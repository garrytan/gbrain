#!/usr/bin/env bun
/**
 * Layering guard (refactor wave 1, EO10; docs/TESTING.md#layering-guard).
 *
 * The wave's new directories sit BELOW the modules that load them, so an
 * import back up would create an ESM cycle that can hit a temporal-dead-zone
 * error at module load (worst in the compiled binary):
 *
 *   src/core/engine-sql/**         imports no engine façade
 *                                  (pglite-engine.ts, postgres-engine.ts,
 *                                  engine-factory.ts); types come from engine.ts
 *   src/core/schema-migrations/**  imports no src/core/migrate.ts; shared
 *                                  helpers live in schema-migrations/helpers.ts
 *                                  and the Migration type in schema-migrations/types.ts
 *   src/core/persistence/**        imports no src/core/ai/gateway.ts: the write
 *                                  commit path makes no generative model call
 *
 * Every import form counts, type-only included: static import/export-from,
 * dynamic import() and require() with a literal relative specifier.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ANCHOR = 'docs/TESTING.md#layering-guard';

interface Rule {
  dir: string;
  banned: string[];
  fix: string;
}

const RULES: Rule[] = [
  {
    dir: 'src/core/engine-sql',
    banned: ['src/core/pglite-engine.ts', 'src/core/postgres-engine.ts', 'src/core/engine-factory.ts'],
    fix: 'take the connection/executor as a parameter and import types from src/core/engine.ts',
  },
  {
    dir: 'src/core/schema-migrations',
    banned: ['src/core/migrate.ts'],
    fix: 'import shared helpers from ./helpers.ts and the Migration type from ./types.ts',
  },
  {
    dir: 'src/core/persistence',
    banned: ['src/core/ai/gateway.ts'],
    fix: 'the write commit path never calls a generative model: embed through src/core/embedding.ts, and queue derived model work as an effect or job',
  },
];

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function specifiers(sf: ts.SourceFile): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  const add = (node: ts.Node, lit: ts.Expression | undefined) => {
    if (lit && ts.isStringLiteralLike(lit)) out.push({ spec: lit.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression);
    else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) add(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal as ts.Expression);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const violations: string[] = [];
for (const rule of RULES) {
  for (const abs of tsFiles(join(ROOT, rule.dir))) {
    const rel = relative(ROOT, abs);
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const { spec, line } of specifiers(sf)) {
      if (!spec.startsWith('.')) continue;
      const target = normalize(join(dirname(rel), spec)).replace(/\\/g, '/');
      const hit = rule.banned.find((b) => target === b || target === b.replace(/\.ts$/, ''));
      if (!hit) continue;
      violations.push(`FAIL: ${rel}:${line} imports ${hit} ('${spec}')\n      Fix: ${rule.fix}`);
    }
  }
}

if (violations.length) {
  for (const v of violations) console.error(v);
  console.error('Why:  engine-sql/ and schema-migrations/ are loaded BY the engines and migrate.ts (an import back up is an ESM cycle, TDZ at load); persistence/ is the write commit path, which stays free of generative model calls.');
  console.error(`See:  ${ANCHOR}`);
  console.error(`check-layering: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log(`check-layering: ok (${RULES.map((r) => r.dir).join(', ')})`);
