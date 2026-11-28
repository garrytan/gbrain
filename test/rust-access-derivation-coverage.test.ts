/**
 * Multi-user lane L4: every privacy policy a Rust store member builds goes through the store's derivation.
 *
 * Under the multi-user switch a policy helper asks the store (rust/crates/gbrain-store/src/access_derive.rs) through
 * `selfChecked` (src/core/rust-engine/access-self-check.ts): the self-check compares, and a principal session's server
 * mode uses the store's answer alone. A member that renders a policy in TypeScript outside that path would hand a
 * session a policy the store never derived. This scan reads every store-member file and fails on a call that builds a
 * policy (`pagePolicyFlags`, `factPolicyFlags`, `renderForStoreCaller`, `ownerOnlyFormIn`, `judgeWidenedCaller`,
 * `callerReadersPagePolicy`, `callerFoldersPagePolicy`) anywhere else than:
 *   - inside a function passed to `selfChecked`;
 *   - inside a function whose name ends in `Rendered` (the TypeScript side a `selfChecked` call compares with), or one
 *     of the builders themselves;
 * and on a call of a `...Rendered` function anywhere else than those places or the `if (!accessDerivationOn())` /
 * `if (!accessSelfCheckOn())` bypass that runs it with the switch off.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const DIR = join(import.meta.dir, '..', 'src', 'core', 'rust-engine', 'store-members');
const BUILDERS = new Set(['pagePolicyFlags', 'factPolicyFlags', 'renderForStoreCaller', 'ownerOnlyFormIn', 'judgeWidenedCaller',
  'callerReadersPagePolicy', 'callerFoldersPagePolicy']);
const BYPASS = /^!\s*(accessDerivationOn|accessSelfCheckOn)\(\)$/;

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText() ?? null;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText();
  return null;
}

/** Why `node` may build a policy here, or null. */
function allowed(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isCallExpression(n.parent) && calleeName(n.parent) === 'selfChecked') return true;
    if (ts.isIfStatement(n) && BYPASS.test(n.expression.getText(sf)) && !isInside(node, n.elseStatement)) return true;
    const name = functionName(n);
    if (name && (name.endsWith('Rendered') || BUILDERS.has(name))) return true;
  }
  return false;
}

function isInside(node: ts.Node, container: ts.Node | undefined): boolean {
  if (!container) return false;
  return node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd();
}

/** Every call that builds a policy outside the derivation, as `file:line name`. */
export function policyBuildersOutsideDerivation(dir = DIR): string[] {
  const out: string[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts')).sort()) {
    const sf = ts.createSourceFile(file, readFileSync(join(dir, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        const risky = name !== null && (BUILDERS.has(name) || name.endsWith('Rendered'));
        if (risky && !allowed(node, sf)) out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${name}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe('every store-member policy goes through the store derivation', () => {
  test('no store member builds a privacy policy outside selfChecked', () => {
    expect(policyBuildersOutsideDerivation()).toEqual([]);
  });

  test('the scan sees a builder outside the derivation', () => {
    const dir = join(import.meta.dir, '..', 'test', 'fixtures', 'access-derivation-coverage');
    expect(policyBuildersOutsideDerivation(dir)).toEqual(['bad.ts:4 pagePolicyFlags', 'bad.ts:8 storeThingRendered', 'bad.ts:9 storeThingRendered',
      'bad.ts:12 renderForStoreCaller', 'bad.ts:12 pagePolicyFlags']);
  });
});
