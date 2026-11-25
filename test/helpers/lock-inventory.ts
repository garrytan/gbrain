/**
 * The BrainEngine members whose PGLite implementation takes a SQL lock that a Rust store could skip
 * (docs/designs/rust-engine/multi-user-server.md, audit row A1, groundwork G1). Read from the code, not from comments:
 * each PGLiteEngine member's body is walked through the functions and constants it reaches (same-file declarations,
 * named and namespace imports under src/, `this.<member>` calls), and every string or template text that holds a lock
 * clause is recorded. test/serialized-transactions-guard.test.ts requires a disposition for every such member the Rust
 * engine serves.
 *
 * It over-approximates on purpose: a helper reached through any identifier counts, whichever branch takes it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const LOCK_CLAUSE = /\bFOR (?:UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)\b|\bSKIP LOCKED\b|\bpg_advisory_(?:xact_)?lock(?:_shared)?\b|\bLOCK TABLE\b/i;

const ROOT = resolve(import.meta.dir, '../..');
/**
 * PGLiteEngine members that run a caller's callback or raw SQL rather than a statement of their own: a member that calls
 * them does not inherit what they reach (the transaction wrapper reaches planner and schema code).
 */
const WRAPPERS = new Set(['transaction', 'transactionDirect', 'executeRaw', 'executeRawDirect', 'withReservedConnection', 'connect',
  'disconnect', 'initSchema', 'engineSql', 'db']);

interface FileIndex {
  path: string;
  source: ts.SourceFile;
  /** Top-level functions, constants and classes by name. */
  decls: Map<string, ts.Node>;
  /** Named imports: local name -> [module file, exported name]. */
  named: Map<string, [string, string]>;
  /** Namespace imports: local name -> module file. */
  namespaces: Map<string, string>;
}

const files = new Map<string, FileIndex | null>();

function resolveModule(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, join(base, 'index.ts')]) if (p.endsWith('.ts') && existsSync(p)) return p;
  return null;
}

function indexFile(path: string): FileIndex | null {
  if (files.has(path)) return files.get(path)!;
  if (!path.startsWith(join(ROOT, 'src')) || !existsSync(path)) { files.set(path, null); return null; }
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const idx: FileIndex = { path, source, decls: new Map(), named: new Map(), namespaces: new Map() };
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) idx.decls.set(stmt.name.text, stmt);
    else if (ts.isClassDeclaration(stmt) && stmt.name) idx.decls.set(stmt.name.text, stmt);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) idx.decls.set(d.name.text, d.initializer);
    } else if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause && !stmt.importClause.isTypeOnly) {
      const mod = resolveModule(path, stmt.moduleSpecifier.text);
      if (!mod) continue;
      const b = stmt.importClause.namedBindings;
      if (b && ts.isNamespaceImport(b)) idx.namespaces.set(b.name.text, mod);
      else if (b && ts.isNamedImports(b)) {
        for (const el of b.elements) if (!el.isTypeOnly) idx.named.set(el.name.text, [mod, (el.propertyName ?? el.name).text]);
      }
    }
  }
  files.set(path, idx);
  return idx;
}

/** A declaration exported by `file` under `name`, following one level of `export { x } from` / `export *`. */
function exported(file: string, name: string, seen = new Set<string>()): [FileIndex, ts.Node] | null {
  const idx = indexFile(file);
  if (!idx || seen.has(`${file}#${name}`)) return null;
  seen.add(`${file}#${name}`);
  const own = idx.decls.get(name);
  if (own) return [idx, own];
  const imp = idx.named.get(name);
  if (imp) return exported(imp[0], imp[1], seen);
  for (const stmt of idx.source.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = resolveModule(file, stmt.moduleSpecifier.text);
    if (!mod) continue;
    if (!stmt.exportClause) { const hit = exported(mod, name, seen); if (hit) return hit; }
    else if (ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) if (el.name.text === name) return exported(mod, (el.propertyName ?? el.name).text, seen);
    }
  }
  return null;
}

/** The initializer of `obj.key` when `obj` names a constant object literal (`{ ... } as const`), with its file. */
function objectProperty(n: ts.PropertyAccessExpression, idx: FileIndex): [FileIndex, ts.Node] | null {
  const name = (n.expression as ts.Identifier).text;
  let target: [FileIndex, ts.Node] | null = idx.decls.has(name) ? [idx, idx.decls.get(name)!] : null;
  if (!target) { const imp = idx.named.get(name); if (imp) target = exported(imp[0], imp[1]); }
  if (!target) return null;
  let init = target[1];
  while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isObjectLiteralExpression(init)) return null;
  for (const p of init.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === n.name.text) return [target[0], p.initializer];
  }
  return null;
}

type Hits = Set<string>;
const memo = new Map<ts.Node, Hits>();
const inProgress = new Set<ts.Node>();

/** Lock clauses reached from `node` (declared in `idx`), as `<file>:<line>` entries. */
function locksOf(node: ts.Node, idx: FileIndex, cls?: Map<string, ts.Node>): Hits {
  const cached = memo.get(node);
  if (cached) return cached;
  const out: Hits = new Set();
  if (inProgress.has(node)) return out;
  inProgress.add(node);
  const follow = (target: [FileIndex, ts.Node] | null, sameClass?: Map<string, ts.Node>) => {
    if (target) for (const h of locksOf(target[1], target[0], sameClass)) out.add(h);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (LOCK_CLAUSE.test(n.text)) out.add(`${relative(ROOT, idx.path)}:${idx.source.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
    } else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && objectProperty(n, idx)) {
      // `SQL_MAP.key` of a constant object of statements: only that statement, not every statement of the map.
      follow(objectProperty(n, idx));
      return;
    } else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const ns = idx.namespaces.get(n.expression.text);
      if (ns) follow(exported(ns, n.name.text));
      else if (n.expression.text === 'this' && cls && !WRAPPERS.has(n.name.text)) { const m = cls.get(n.name.text); if (m) follow([idx, m], cls); }
    } else if (n.kind === ts.SyntaxKind.ThisKeyword && cls && ts.isPropertyAccessExpression(n.parent) && !WRAPPERS.has(n.parent.name.text)) {
      const m = cls.get(n.parent.name.text);
      if (m) follow([idx, m], cls);
    } else if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      const local = idx.decls.get(n.text);
      if (local && local !== node) follow([idx, local]);
      else if (!local) { const imp = idx.named.get(n.text); if (imp) follow(exported(imp[0], imp[1])); }
    }
    ts.forEachChild(n, visit);
  };
  // The node itself first: a constant's initializer may be the statement text.
  visit(node);
  inProgress.delete(node);
  memo.set(node, out);
  return out;
}

/** The PGLite members (by name) whose implementation reaches a lock clause, each with where the clauses are. */
export function lockingMembers(): Map<string, string[]> {
  const path = join(ROOT, 'src/core/pglite-engine.ts');
  const idx = indexFile(path)!;
  const cls = idx.decls.get('PGLiteEngine');
  if (!cls || !ts.isClassDeclaration(cls)) throw new Error('lock-inventory: PGLiteEngine class not found');
  const methods = new Map<string, ts.Node>();
  for (const m of cls.members) {
    if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessor(m)) && m.name && ts.isIdentifier(m.name)) methods.set(m.name.text, m);
  }
  const out = new Map<string, string[]>();
  for (const [name, m] of methods) {
    const hits = locksOf(m, idx, methods);
    if (hits.size) out.set(name, [...hits].sort());
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
