/**
 * Migrations full-record extractor (refactor wave 1: A11 + EO19).
 *
 * Produces one record per `MIGRATIONS` entry: version, name, exact-text hashes
 * of `sql` and `sqlFor.{postgres,pglite}`, `transaction`, `idempotent`,
 * handler / verify presence, and a hash of the NORMALIZED AST source text of the
 * handler and verify expressions (`scripts/lib/normalize-tokens.ts`), plus the
 * helpers they reference. `Function.prototype.toString()` is never used:
 * coverage instrumentation and re-indentation change it.
 *
 * Location independence (so W3's split into `src/core/schema-migrations/` must
 * reproduce the same records): migration object literals are found by shape
 * (`version: <number>` + `name: <string>`) in `src/core/migrate.ts` and every
 * `src/core/schema-migrations/**.ts`; helpers are keyed by name, never by file.
 * Helper closure: identifiers are resolved with the TypeScript checker
 * (following import aliases and re-exports). A declaration inside the
 * migrations file set is hashed and its own references followed transitively;
 * a declaration elsewhere is hashed but not followed.
 */

import { existsSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import ts from 'typescript';
import { normalizeNode } from '../../scripts/lib/normalize-tokens.ts';
import { sha256 } from './golden.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const MIGRATE_TS = join(REPO, 'src/core/migrate.ts');
const SCHEMA_MIGRATIONS_DIR = join(REPO, 'src/core/schema-migrations');

export interface RuntimeMigration {
  version: number;
  name: string;
  sql: string;
  sqlFor?: { postgres?: string; pglite?: string };
  transaction?: boolean;
  idempotent?: boolean;
  handler?: unknown;
  verify?: unknown;
}

export interface CodeRecord {
  /** Syntax form of the property value: arrow, function, identifier, method. */
  form: string;
  sha256: string;
  /** Names of helpers reachable from this expression (sorted). */
  helpers: string[];
}

export interface MigrationRecord {
  version: number;
  name: string;
  sql: TextHash;
  sqlFor: { postgres: TextHash | 'absent'; pglite: TextHash | 'absent' } | 'absent';
  transaction: boolean | 'absent';
  idempotent: boolean | 'absent';
  handler: CodeRecord | 'absent';
  verify: CodeRecord | 'absent';
}

export interface TextHash {
  length: number;
  sha256: string;
}

export interface MigrationsGolden {
  count: number;
  versions: number[];
  gaps: number[];
  latest: number;
  records: MigrationRecord[];
  /** name -> sha256 of the helper declaration's normalized source. */
  helpers: Record<string, string>;
}

function textHash(s: string): TextHash {
  return { length: s.length, sha256: sha256(s) };
}

export function migrationSourceFiles(): string[] {
  const files = [MIGRATE_TS];
  if (existsSync(SCHEMA_MIGRATIONS_DIR)) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(SCHEMA_MIGRATIONS_DIR);
  }
  return files;
}

function isInMigrationSet(fileName: string): boolean {
  const p = resolve(fileName);
  return p === MIGRATE_TS || p.startsWith(SCHEMA_MIGRATIONS_DIR + '/');
}

function propName(p: ts.ObjectLiteralElementLike): string | undefined {
  const n = p.name;
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return undefined;
}

function findMigrationLiterals(sf: ts.SourceFile): Map<number, ts.ObjectLiteralExpression> {
  const out = new Map<number, ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let version: number | undefined;
      let hasName = false;
      for (const p of node.properties) {
        const key = propName(p);
        if (key === 'version' && ts.isPropertyAssignment(p) && ts.isNumericLiteral(p.initializer)) {
          version = Number(p.initializer.text);
        }
        if (key === 'name' && ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) hasName = true;
      }
      if (version !== undefined && hasName) {
        if (out.has(version)) throw new Error(`duplicate migration literal for version ${version} in ${sf.fileName}`);
        out.set(version, node);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function isTypePosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
    if (ts.isStatement(p) || ts.isExpression(p)) {
      if (!ts.isTypeNode(p)) return false;
    }
  }
  return false;
}

/** Declaration node that carries the helper's code. */
function helperDeclaration(decl: ts.Declaration): ts.Node | undefined {
  if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl) || ts.isVariableDeclaration(decl) || ts.isEnumDeclaration(decl)) {
    return decl;
  }
  return undefined;
}

export function buildMigrationsGolden(migrations: readonly RuntimeMigration[]): MigrationsGolden {
  const files = migrationSourceFiles();
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();

  const literals = new Map<number, { node: ts.ObjectLiteralExpression; sf: ts.SourceFile }>();
  for (const f of files) {
    const sf = program.getSourceFile(f);
    if (!sf) throw new Error(`cannot load ${relative(REPO, f)}`);
    for (const [version, node] of findMigrationLiterals(sf)) {
      if (literals.has(version)) throw new Error(`migration v${version} literal found twice (second in ${relative(REPO, f)})`);
      literals.set(version, { node, sf });
    }
  }

  const helpers: Record<string, string> = {};
  const helperDeclIds = new Map<string, ts.Node>();
  const closureCache = new Map<ts.Node, Set<string>>();

  const resolveDecl = (id: ts.Identifier): ts.Declaration | undefined => {
    let sym = checker.getSymbolAtLocation(id);
    if (!sym) return undefined;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym.declarations?.[0];
  };

  const collect = (root: ts.Node, acc: Set<string>, seen: Set<ts.Node>): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isTypePosition(node)) {
        const parent = node.parent;
        const isMemberName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isQualifiedName(parent) && parent.right === node);
        if (!isMemberName) {
          const decl = resolveDecl(node);
          const code = decl ? helperDeclaration(decl) : undefined;
          if (code && code !== root && !isWithin(code, root)) {
            const sf = code.getSourceFile();
            // Only module-level source declarations count as helpers (lib/ambient .d.ts globals never do).
            if (isModuleLevel(code) && !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/')) {
              const name = node.text;
              const prior = helperDeclIds.get(name);
              if (prior && prior !== code) throw new Error(`two different helpers named ${name}`);
              if (!prior) {
                helperDeclIds.set(name, code);
                helpers[name] = sha256(helperText(code, sf));
              }
              acc.add(name);
              if (isInMigrationSet(sf.fileName) && !seen.has(code)) {
                seen.add(code);
                collect(code, acc, seen);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };

  const codeRecord = (p: ts.ObjectLiteralElementLike, sf: ts.SourceFile): CodeRecord => {
    let node: ts.Node;
    let form: string;
    if (ts.isPropertyAssignment(p)) {
      node = p.initializer;
      form = ts.isArrowFunction(node) ? 'arrow' : ts.isFunctionExpression(node) ? 'function' : ts.isIdentifier(node) ? 'identifier' : ts.SyntaxKind[node.kind];
    } else if (ts.isMethodDeclaration(p)) {
      node = p;
      form = 'method';
    } else if (ts.isShorthandPropertyAssignment(p)) {
      node = p.name;
      form = 'identifier';
    } else {
      throw new Error(`unsupported handler/verify form ${ts.SyntaxKind[p.kind]}`);
    }
    let acc = closureCache.get(node);
    if (!acc) {
      acc = new Set<string>();
      collect(node, acc, new Set());
      closureCache.set(node, acc);
    }
    return { form, sha256: sha256(normalizeNode(node, sf)), helpers: [...acc].sort() };
  };

  const records: MigrationRecord[] = migrations.map((m) => {
    const lit = literals.get(m.version);
    if (!lit) throw new Error(`no source literal for migration v${m.version}`);
    const byKey = new Map<string, ts.ObjectLiteralElementLike>();
    for (const p of lit.node.properties) {
      const k = propName(p);
      if (k) byKey.set(k, p);
    }
    const handlerProp = byKey.get('handler');
    const verifyProp = byKey.get('verify');
    if (!!handlerProp !== (m.handler !== undefined)) throw new Error(`v${m.version}: handler presence differs between runtime and source`);
    if (!!verifyProp !== (m.verify !== undefined)) throw new Error(`v${m.version}: verify presence differs between runtime and source`);
    return {
      version: m.version,
      name: m.name,
      sql: textHash(m.sql),
      sqlFor: m.sqlFor === undefined
        ? 'absent'
        : {
            postgres: m.sqlFor.postgres === undefined ? 'absent' : textHash(m.sqlFor.postgres),
            pglite: m.sqlFor.pglite === undefined ? 'absent' : textHash(m.sqlFor.pglite),
          },
      transaction: m.transaction === undefined ? 'absent' : m.transaction,
      idempotent: m.idempotent === undefined ? 'absent' : m.idempotent,
      handler: handlerProp ? codeRecord(handlerProp, lit.sf) : 'absent',
      verify: verifyProp ? codeRecord(verifyProp, lit.sf) : 'absent',
    };
  });

  const versions = migrations.map((m) => m.version);
  const gaps: number[] = [];
  for (let v = versions[0]!; v <= versions[versions.length - 1]!; v++) if (!versions.includes(v)) gaps.push(v);
  return {
    count: migrations.length,
    versions,
    gaps,
    latest: Math.max(...versions),
    records,
    helpers: Object.fromEntries(Object.entries(helpers).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

function isWithin(node: ts.Node, root: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (p === root) return true;
  return false;
}

function isModuleLevel(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node)) return !!node.parent?.parent && ts.isSourceFile(node.parent.parent.parent);
  return ts.isSourceFile(node.parent);
}

/** Normalized helper source without leading `export` / `default`, so exporting a moved helper keeps its hash. */
function helperText(code: ts.Node, sf: ts.SourceFile): string {
  const tokens = normalizeNode(declStatement(code), sf).split(' ');
  while (tokens[0] === 'export' || tokens[0] === 'default') tokens.shift();
  return tokens.join(' ');
}

function declStatement(node: ts.Node): ts.Node {
  if (ts.isVariableDeclaration(node)) {
    const list = node.parent;
    if (list && ts.isVariableDeclarationList(list) && list.parent && ts.isVariableStatement(list.parent)) {
      // Hash only this declarator so sibling declarators in one statement stay independent.
      return list.declarations.length === 1 ? list.parent : node;
    }
  }
  return node;
}
