#!/usr/bin/env bun
/**
 * Model-call routing guard (docs/TESTING.md#ai-sdk-importer-guard).
 *
 * Every model provider call must stay observable through `invokeAI`
 * (src/core/ai/invocation-guard.ts): admission guards, the write-inference
 * tripwire and GBRAIN_AI_CALL_LOG all rely on it. This guard fails when a file
 * outside the allowlist imports a provider SDK as a runtime value (`ai`,
 * `@ai-sdk/*`, `@anthropic-ai/sdk`, `openai`). Type-only imports are fine.
 * The allowlist only shrinks.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ANCHOR = 'docs/TESTING.md#ai-sdk-importer-guard';
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'ai-sdk-importers.allowlist');
const SDK = /^(ai|openai|@anthropic-ai\/sdk(\/.*)?|@ai-sdk\/.+)$/;

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'node_modules') out.push(...tsFiles(full)); }
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function runtimeSdkImports(sf: ts.SourceFile): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && SDK.test(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly
        || (!!clause && !clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(e => e.isTypeOnly));
      if (!typeOnly) out.push({ spec: node.moduleSpecifier.text, line: at(node) });
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier) && SDK.test(node.moduleSpecifier.text)) {
      out.push({ spec: node.moduleSpecifier.text, line: at(node) });
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const arg = node.arguments[0];
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg) && SDK.test(arg.text)) out.push({ spec: arg.text, line: at(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const allowlist = new Set(existsSync(ALLOWLIST_PATH)
  ? readFileSync(ALLOWLIST_PATH, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
  : []);
const violations: string[] = [];
const importers = new Set<string>();
for (const abs of [...tsFiles(join(ROOT, 'src')), ...tsFiles(join(ROOT, 'scripts'))]) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const { spec, line } of runtimeSdkImports(sf)) {
    importers.add(rel);
    if (!allowlist.has(rel)) violations.push(`FAIL: ${rel}:${line} imports the provider SDK '${spec}' as a runtime value`);
  }
}
const stale = [...allowlist].filter(f => !importers.has(f));

if (violations.length || stale.length) {
  for (const v of violations) console.error(v);
  for (const f of stale) console.error(`FAIL: scripts/ai-sdk-importers.allowlist lists ${f}, which no longer imports a provider SDK; remove the line (the allowlist only shrinks)`);
  if (violations.length) console.error('Fix:  call the model through src/core/ai/gateway.ts (chat, embed, generate) so the call routes through invokeAI; use `import type` for SDK types.');
  console.error('Why:  admission guards, the write-inference tripwire and GBRAIN_AI_CALL_LOG observe model calls only through invokeAI.');
  console.error(`See:  ${ANCHOR}`);
  process.exit(1);
}
console.log(`check-ai-sdk-importers: ok (${importers.size} allowlisted importer(s))`);
