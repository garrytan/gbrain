#!/usr/bin/env bun
/**
 * SyncRun state guard (refactor wave 1, W4 sync, A17;
 * docs/TESTING.md#syncrun-state-guard).
 *
 * `SyncRun` (src/commands/sync/sync-run.ts) holds the mutable state one
 * incremental sync shares between closures that interleave across awaits
 * (checkpoint flush, import workers, stall watchdog, partial exit). A local
 * copy of a mutable field is a snapshot another closure can invalidate at the
 * next await, which is how a stale `checkpointDead` or `bankedFiles` would
 * reach a result. So over src/commands/sync/**\/*.ts this guard fails on:
 *   1. destructuring a mutable field from a SyncRun value
 *      (`const { bankedFiles } = run`, or a `{ bankedFiles }: SyncRun` parameter)
 *   2. aliasing one (`const banked = run.bankedFiles`)
 *   3. writing a checkpoint field (JSDoc tag `@checkpoint`) outside
 *      sync-run.ts, which is the single owner of checkpoint and cleanup state
 * Mutable fields are the non-`readonly` properties of `interface SyncRun`;
 * readonly fields (collection references, fixed config) may be destructured.
 * A SyncRun value is a variable or parameter annotated `SyncRun` or
 * initialized from `createSyncRun(...)`, or any binding named `run`.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const DIR = 'src/commands/sync';
const TYPE_FILE = `${DIR}/sync-run.ts`;
const SEE = 'docs/TESTING.md#syncrun-state-guard';

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return listTs(full);
    return e.endsWith('.ts') ? [full] : [];
  });
}

const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

function syncRunFields(): { mutable: Set<string>; checkpoint: Set<string> } | null {
  const file = join(ROOT, TYPE_FILE);
  if (!existsSync(file)) return null;
  const sf = parse(file);
  const decl = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'SyncRun');
  if (!decl) return null;
  const mutable = new Set<string>();
  const checkpoint = new Set<string>();
  for (const m of decl.members) {
    if (!ts.isPropertySignature(m) || !m.name) continue;
    const readonly = m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ReadonlyKeyword);
    if (!readonly) mutable.add(m.name.getText(sf));
    if (ts.getJSDocTags(m).some((t) => t.tagName.text === 'checkpoint')) checkpoint.add(m.name.getText(sf));
  }
  return { mutable, checkpoint };
}

function isSyncRunType(t: ts.TypeNode | undefined): boolean {
  return !!t && ts.isTypeReferenceNode(t) && t.typeName.getText() === 'SyncRun';
}
function isCreateCall(e: ts.Expression | undefined): boolean {
  return !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'createSyncRun';
}

const shape = syncRunFields();
const fields = shape?.mutable;
const problems: string[] = [];
if (!shape || !fields) {
  problems.push(`FAIL: ${TYPE_FILE}:1 interface SyncRun not found`);
} else {
  for (const file of listTs(join(ROOT, DIR))) {
    const rel = relative(ROOT, file);
    const sf = parse(file);
    const runNames = new Set<string>(['run']);
    const collect = (n: ts.Node) => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name)) {
        if (isSyncRunType(n.type) || (ts.isVariableDeclaration(n) && isCreateCall(n.initializer))) runNames.add(n.name.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const isRunExpr = (e: ts.Expression | undefined) => !!e && ts.isIdentifier(e) && runNames.has(e.text);
    const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const checkPattern = (p: ts.ObjectBindingPattern) => {
      for (const el of p.elements) {
        const key = (el.propertyName ?? el.name).getText(sf);
        if (fields.has(key)) problems.push(`FAIL: ${at(el)} destructures mutable SyncRun field '${key}'`);
      }
    };
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n)) {
        if (ts.isObjectBindingPattern(n.name) && (isRunExpr(n.initializer) || isSyncRunType(n.type) || isCreateCall(n.initializer))) checkPattern(n.name);
        const init = n.initializer;
        if (init && ts.isPropertyAccessExpression(init) && isRunExpr(init.expression) && fields.has(init.name.text)) {
          problems.push(`FAIL: ${at(n)} copies mutable SyncRun field '${init.name.text}' into '${n.name.getText(sf)}'`);
        }
      }
      if (ts.isParameter(n) && ts.isObjectBindingPattern(n.name) && isSyncRunType(n.type)) checkPattern(n.name);
      if (rel !== TYPE_FILE) {
        const target =
          ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? n.left
          : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) ? n.operand
          : undefined;
        if (target && ts.isPropertyAccessExpression(target) && isRunExpr(target.expression) && shape.checkpoint.has(target.name.text)) {
          problems.push(`FAIL: ${at(n)} writes checkpoint field '${target.name.text}' outside ${TYPE_FILE}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.log(p);
  console.log('Why:  SyncRun fields change across awaits (checkpoint flush, workers, stall watchdog); a local copy goes stale,');
  console.log('      and checkpoint/cleanup state has one owner so a flush, the SIGTERM hook and partial() cannot disagree.');
  console.log(`Fix:  use run.<field> at each read/write; change @checkpoint fields only through a function in ${TYPE_FILE}.`);
  console.log(`See:  ${SEE}`);
  process.exit(1);
}
console.log(`OK: SyncRun mutable fields accessed only as run.<field> (${fields!.size} fields, ${listTs(join(ROOT, DIR)).length} files).`);
