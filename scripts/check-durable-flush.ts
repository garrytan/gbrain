#!/usr/bin/env bun
/**
 * Durable-flush guard (#5595, #5475; docs/ci-guards.md#durable-flush-guard).
 *
 * Windows `FlushFileBuffers` needs write access and Windows has no directory
 * flush, so the POSIX idiom `fsyncSync(openSync(path, 'r'))` fails with EPERM
 * there. That idiom, copied across persistence, wedged the managed write queue
 * (#5595) and every skill-bundle publication (#5475). Outside
 * src/core/fs-durable.ts this guard fails on any `fsyncSync(fd)` in src/ whose
 * `fd` is assigned from a read-only `openSync` (flags omitted, a flag string
 * without w/a/+, or O_RDONLY without O_WRONLY/O_RDWR), file or directory, and
 * on one whose flags it cannot read. Flushes of descriptors opened for writing
 * stay as they are.
 *
 * Fix: flush the descriptor you wrote through before closing it, or call
 * flushFile / flushDirectory from src/core/fs-durable.ts.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ANCHOR = 'docs/ci-guards.md#durable-flush-guard';
const HELPER = 'src/core/fs-durable.ts';

/** Files allowed to keep a read-only-handle flush until they migrate. Each entry names its reason; a stale entry fails. */
const ALLOWLIST: Record<string, string> = {
};

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

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

/** 'read' | 'write' | 'unknown' for an openSync call's flags argument. */
function access(call: ts.CallExpression, sf: ts.SourceFile): 'read' | 'write' | 'unknown' {
  const flags = call.arguments[1];
  if (!flags) return 'read';
  if (ts.isStringLiteralLike(flags)) return /[wa+]/.test(flags.text) ? 'write' : 'read';
  const text = flags.getText(sf);
  if (/\bO_(?:WRONLY|RDWR)\b/.test(text)) return 'write';
  if (/\bO_RDONLY\b/.test(text)) return 'read';
  return 'unknown';
}

/** Whether `scope` itself (not a nested block or function) declares the variable `name`. */
function declaresDirectly(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isBlock(node) || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

/** The nearest enclosing block, function or file that declares `name`; null when it is a parameter or undeclared. */
function declaringScope(node: ts.Node, name: string): ts.Node | null {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === name)) return null;
    if ((ts.isBlock(scope) || ts.isSourceFile(scope)) && declaresDirectly(scope, name)) return scope;
  }
  return null;
}

/** Every `openSync` call assigned to `name` inside `scope` (declaration initializers and plain assignments). */
function openCalls(scope: ts.Node, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const take = (value: ts.Expression | undefined) => {
    if (value && ts.isCallExpression(value) && calleeName(value) === 'openSync') out.push(value);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) take(node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left) && node.left.text === name) take(node.right);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return out;
}

const violations: string[] = [];
const flagged = new Set<string>();
for (const abs of tsFiles(join(ROOT, 'src'))) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  if (rel === HELPER) continue;
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node) === 'fsyncSync') {
      const fd = node.arguments[0];
      const opens = fd && ts.isIdentifier(fd)
        ? (() => { const scope = declaringScope(node, fd.text); return scope ? openCalls(scope, fd.text) : []; })()
        : fd && ts.isCallExpression(fd) && calleeName(fd) === 'openSync' ? [fd] : [];
      for (const open of opens) {
        const kind = access(open, sf);
        if (kind === 'write') continue;
        flagged.add(rel);
        if (ALLOWLIST[rel]) continue;
        violations.push(`FAIL [durable_flush_read_handle]: ${rel}:${line(node)} fsyncs a descriptor opened ${kind === 'read' ? 'read-only' : 'with flags this guard cannot read'} at line ${line(open)} (${open.getText(sf).replace(/\s+/g, ' ').slice(0, 80)})\n`
          + `      Fix: fsync the descriptor you wrote through before closing it, or call flushFile/flushDirectory from ${HELPER}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
for (const [rel, reason] of Object.entries(ALLOWLIST)) {
  if (existsSync(join(ROOT, rel)) && !flagged.has(rel)) {
    violations.push(`FAIL [durable_flush_stale_allowlist]: ${rel} no longer fsyncs a read-only descriptor (allowlisted: ${reason})\n      Fix: delete its ALLOWLIST entry in scripts/check-durable-flush.ts`);
  }
}

if (violations.length) {
  for (const v of violations) console.error(v);
  console.error('Why:  Windows refuses fsync on a read-only handle and has no directory flush (EPERM), so the write wedges there (#5595, #5475).');
  console.error(`See:  ${ANCHOR}`);
  console.error(`check-durable-flush: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log(`check-durable-flush: ok (src/, helper ${HELPER}, ${Object.keys(ALLOWLIST).length} allowlisted)`);
