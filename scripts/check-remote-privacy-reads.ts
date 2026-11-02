#!/usr/bin/env bun
/**
 * Remote-privacy resolver guard (GBRA-218, plan section 2.1). This header is
 * its documentation; `bun run check:remote-privacy-reads`, in `bun run verify`.
 *
 * The operator relaxations of remote privacy (the env hatch
 * GBRAIN_REMOTE_PRIVATE_PAGES and the config key search.remote_private_pages)
 * are read in exactly one file, src/core/search/private-visibility.ts, whose
 * resolver keeps the member-access part mandatory on a restricted brain. A
 * second reader would relax privacy without it. This guard parses every
 * src/ TypeScript file (compiler API) except that one and fails on:
 *
 *   1. a property access `<x>.GBRAIN_REMOTE_PRIVATE_PAGES`, an element access
 *      `<x>['GBRAIN_REMOTE_PRIVATE_PAGES']`, or a destructured binding of it;
 *   2. the string 'GBRAIN_REMOTE_PRIVATE_PAGES' anywhere but as an element of
 *      a declared array literal (name lists such as env-trust.ts are not
 *      reads; an array passed straight to a call, such as query parameters, is);
 *   3. the string 'search.remote_private_pages' (exactly, or quoted inside
 *      SQL text), or a reference to REMOTE_PRIVATE_PAGES_KEY, anywhere but as
 *      an array-literal element or an import specifier (config.ts's key list).
 *
 * Prose that merely mentions the key (a message telling an operator which
 * key to set) is not flagged. There is no baseline: the count is zero.
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const RESOLVER = 'src/core/search/private-visibility.ts';
const ENV = 'GBRAIN_REMOTE_PRIVATE_PAGES';
const KEY = 'search.remote_private_pages';
const KEY_CONST = 'REMOTE_PRIVATE_PAGES_KEY';

export interface Violation { path: string; line: number; what: string }

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

/** An element of a declared name list (an array literal that is not a call or constructor argument, such as a query's parameters). */
function inArrayLiteral(node: ts.Node): boolean {
  return ts.isArrayLiteralExpression(node.parent) && !ts.isCallExpression(node.parent.parent) && !ts.isNewExpression(node.parent.parent);
}

export function scanSource(path: string, text: string): Violation[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: Violation[] = [];
  const flag = (node: ts.Node, what: string) => out.push({ path, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what });
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === ENV) flag(node, 'reads the env hatch ' + ENV);
    else if (ts.isBindingElement(node) && [node.propertyName, node.name].some(n => n && ts.isIdentifier(n) && n.text === ENV)) flag(node, 'destructures the env hatch ' + ENV);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const value = node.text;
      if (value === ENV && !inArrayLiteral(node)) flag(node, 'names the env hatch ' + ENV + ' outside a name list');
      else if ((value === KEY && !inArrayLiteral(node)) || value.includes("'" + KEY + "'")) flag(node, 'reads the config key ' + KEY);
    } else if (ts.isTemplateExpression(node) && [node.head.text, ...node.templateSpans.map(s => s.literal.text)].some(t => t.includes("'" + KEY + "'"))) {
      flag(node, 'reads the config key ' + KEY + ' in SQL text');
    } else if (ts.isIdentifier(node) && node.text === KEY_CONST && !ts.isImportSpecifier(node.parent) && !inArrayLiteral(node)
      && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
      flag(node, 'uses ' + KEY_CONST + ' (a config read of the opt-out)');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function scan(root = ROOT): Violation[] {
  return tsFiles(join(root, 'src')).flatMap(file => {
    const path = relative(root, file).split(sep).join('/');
    return path === RESOLVER ? [] : scanSource(path, readFileSync(file, 'utf8'));
  });
}

if (import.meta.main) {
  const violations = scan();
  if (violations.length) {
    for (const v of violations) console.error(v.path + ':' + v.line + ': ' + v.what + '. Route it through ' + RESOLVER + ' (remotePrivacyRelaxed, readRemotePolicyNow or resolveExcludePrivatePages).');
    console.error('check-remote-privacy-reads: ' + violations.length + ' violation(s); see scripts/check-remote-privacy-reads.ts (header)');
    process.exit(1);
  }
  console.log('check-remote-privacy-reads: ok');
}
