#!/usr/bin/env bun
/**
 * Windows hidden-console guard (#4992; docs/TESTING.md#windows-hidden-console-guard).
 *
 * On Windows a detached gbrain child has no console, so every console program
 * it launches without `windowsHide` opens a visible console window that takes
 * focus. src/core/spawn.ts is the one module that launches subprocesses and
 * defaults `windowsHide: true`. Outside it, this guard fails on any runtime
 * use of `child_process` in src/ (a static, dynamic or `require` import that
 * is not type-only) and on any `Bun.spawn` / `Bun.spawnSync` reference, so a
 * new spawn site, detached or not, cannot skip the default. It also fails on
 * an explicit `windowsHide: false` outside ALLOWLIST, which names each
 * deliberate opt-out with its reason; a stale entry fails.
 *
 * Fix: import the launcher from src/core/spawn.ts (`spawn`, `spawnSync`,
 * `exec`, `execSync`, `execFile`, `execFileSync`, `bunSpawn`, `bunSpawnSync`).
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ANCHOR = 'docs/TESTING.md#windows-hidden-console-guard';
const SEAM = 'src/core/spawn.ts';
const MODULES = new Set(['child_process', 'node:child_process']);

/** Files allowed an explicit `windowsHide: false`. Each entry names its reason; a stale entry fails. */
const ALLOWLIST: Record<string, string> = {
  'src/core/creds/redirect.ts': 'openBrowser launches the system browser through `cmd /c start`; the launch stays as visible as before',
};

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const isModule = (node: ts.Node | undefined): boolean => !!node && ts.isStringLiteralLike(node) && MODULES.has(node.text);

/** An import that loads child_process at runtime (not `import type`, not all-`type` specifiers). */
function valueImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    return !bindings || ts.isNamespaceImport(bindings) || bindings.elements.length === 0 || bindings.elements.some(e => !e.isTypeOnly);
  }
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  return !clause || !ts.isNamedExports(clause) || clause.elements.some(e => !e.isTypeOnly);
}

const violations: string[] = [];
const optedOut = new Set<string>();
for (const abs of tsFiles(join(ROOT, 'src'))) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  if (rel === SEAM) continue;
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fail = (node: ts.Node, code: string, what: string, fix: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    violations.push(`FAIL [${code}]: ${rel}:${line} ${what}\n      Fix: ${fix}`);
  };
  const useSeam = `import it from ${SEAM}, which defaults windowsHide: true`;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isModule(node.moduleSpecifier) && valueImport(node)) {
      fail(node, 'windows_hide_direct_child_process', 'imports child_process directly', useSeam);
    } else if (ts.isCallExpression(node) && isModule(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      fail(node, 'windows_hide_direct_child_process', `loads child_process with ${node.expression.getText(sf)}()`, useSeam);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Bun'
      && (node.name.text === 'spawn' || node.name.text === 'spawnSync')) {
      const wrapper = node.name.text === 'spawn' ? 'bunSpawn' : 'bunSpawnSync';
      fail(node, 'windows_hide_direct_bun_spawn', `calls Bun.${node.name.text}`, `call ${wrapper} from ${SEAM}, which defaults windowsHide: true`);
    } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
      && node.name.text === 'windowsHide' && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
      optedOut.add(rel);
      if (!ALLOWLIST[rel]) fail(node, 'windows_hide_opt_out', 'sets windowsHide: false', `drop it, or add ${rel} to ALLOWLIST in scripts/check-windows-hide.ts with the reason the window must show`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
for (const [rel, reason] of Object.entries(ALLOWLIST)) {
  if (existsSync(join(ROOT, rel)) && !optedOut.has(rel)) {
    violations.push(`FAIL [windows_hide_stale_allowlist]: ${rel} no longer sets windowsHide: false (allowlisted: ${reason})\n      Fix: delete its ALLOWLIST entry in scripts/check-windows-hide.ts`);
  }
}

if (violations.length) {
  for (const v of violations) console.error(v);
  console.error('Why:  on Windows a console program launched from a detached gbrain process without windowsHide opens a visible console window that takes focus (#4992).');
  console.error(`See:  ${ANCHOR}`);
  console.error(`check-windows-hide: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log(`check-windows-hide: ok (src/, seam ${SEAM}, ${Object.keys(ALLOWLIST).length} allowlisted opt-out)`);
