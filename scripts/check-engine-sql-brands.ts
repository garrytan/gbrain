#!/usr/bin/env bun
/**
 * Engine-sql RLS brand guard (refactor wave 1, EO4 / AR2;
 * docs/TESTING.md#engine-sql-brands).
 *
 * src/core/engine-sql/brands.ts types each engine-sql read as `ScopedRead`
 * (ran inside withScopedReadTransaction on master) or `LegacyUnscopedRead`
 * (ran unscoped on the pool). The brands only mean something if nothing can
 * forge them, so this guard fails on:
 *
 *   1. a brand key (`__obtainVia...`) in any text file under src/, test/ or
 *      scripts/ outside brands.ts and this guard's own script, fixtures and test;
 *   2. in src/: a cast to ScopedRead / LegacyUnscopedRead outside brands.ts
 *      (`x as ScopedRead`, `<ScopedRead>x`), and a double cast
 *      `x as unknown as T` where T names SqlExecutor / ScopedRead /
 *      LegacyUnscopedRead or the cast is passed straight to scopedRead( /
 *      unscopedExecutor( (driver-handle casts like `tx as unknown as PgConn`
 *      are fine);
 *   3. in src/ and scripts/: importing `unscopedExecutor` / `LegacyUnscopedRead`
 *      (any form: value, type, alias, export-from, `import('...').X` type) from
 *      a file outside UNSCOPED_ALLOWLIST, or `scopedRead` outside
 *      SCOPED_ALLOWLIST; a whole-module import of brands.ts (namespace,
 *      dynamic import, require) needs SCOPED_ALLOWLIST. src/core/ops/** (the
 *      MCP-facing surface) is denied even when an allowlist entry matches.
 *      test/** may import every brand factory.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ANCHOR = 'docs/TESTING.md#engine-sql-brands';
const BRANDS = 'src/core/engine-sql/brands.ts';
const BRAND_KEY = /__obtainVia\w*/;
const BRAND_TYPES = /\b(?:SqlExecutor|ScopedRead|LegacyUnscopedRead)\b/;
const BRAND_FACTORIES = new Set(['scopedRead', 'unscopedExecutor']);
const TEXT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|sh|json|md|tsv|sql|ya?ml|txt)$/;

const KEY_EXEMPT: { match: (p: string) => boolean; reason: string }[] = [
  { match: (p) => p === BRANDS, reason: 'the brand factory module defines the keys' },
  { match: (p) => p === 'scripts/check-engine-sql-brands.ts', reason: 'this guard names the key pattern' },
  { match: (p) => p.startsWith('test/fixtures/guards/check-engine-sql-brands.ts/'), reason: 'known-bad forgeries for the self-test' },
  { match: (p) => p === 'test/scripts/engine-sql-brands.test.ts', reason: 'drives the forgery forms' },
];

interface Entry {
  name: string;
  match: (p: string) => boolean;
}

const under = (dir: string) => (p: string) => p.startsWith(`${dir}/`);
const FACADES: Entry = { name: 'engine façades', match: (p) => p === 'src/core/pglite-engine.ts' || p === 'src/core/postgres-engine.ts' };
const ENGINE_SQL: Entry = { name: 'engine-sql', match: under('src/core/engine-sql') };
const TESTS: Entry = { name: 'tests', match: under('test') };

const UNSCOPED_ALLOWLIST: Entry[] = [
  ENGINE_SQL,
  FACADES,
  { name: 'doctor', match: (p) => p === 'src/commands/doctor.ts' || under('src/commands/doctor')(p) || p.startsWith('src/core/doctor') },
  { name: 'maintenance (src/core/maintenance/**, no module yet)', match: under('src/core/maintenance') },
  { name: 'admin (src/commands/admin*.ts, src/core/admin/**, no module yet)', match: (p) => /^src\/commands\/admin[^/]*\.ts$/.test(p) || under('src/core/admin')(p) },
  { name: 'migrations', match: (p) => p === 'src/core/migrate.ts' || under('src/core/schema-migrations')(p) || under('src/commands/migrations')(p) },
  TESTS,
];
const SCOPED_ALLOWLIST: Entry[] = [ENGINE_SQL, FACADES, TESTS];
const DENY: Entry = { name: 'src/core/ops/** (MCP-facing)', match: under('src/core/ops') };

const RESTRICTED: Record<string, Entry[]> = {
  unscopedExecutor: UNSCOPED_ALLOWLIST,
  LegacyUnscopedRead: UNSCOPED_ALLOWLIST,
  scopedRead: SCOPED_ALLOWLIST,
};

function files(dir: string, filter: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full, filter));
    else if (filter(entry)) out.push(full);
  }
  return out;
}

const violations: string[] = [];
const rel = (abs: string) => relative(ROOT, abs).replace(/\\/g, '/');
const fail = (where: string, what: string, fix: string) => violations.push(`FAIL: ${where} ${what}\n      Fix: ${fix}`);

for (const abs of ['src', 'test', 'scripts'].flatMap((d) => files(join(ROOT, d), (n) => TEXT_EXTENSIONS.test(n)))) {
  const path = rel(abs);
  if (KEY_EXEMPT.some((e) => e.match(path))) continue;
  readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
    const m = BRAND_KEY.exec(line);
    if (m) fail(`${path}:${i + 1}`, `mentions brand key ${m[0]} (forges an RLS read brand)`, `obtain the executor from scopedRead(tx) inside withScopedReadTransaction or unscopedExecutor(executor, '<reason>'); never spell the key outside ${BRANDS}`);
  });
}

function allowed(path: string, entries: Entry[]): boolean {
  return !DENY.match(path) && entries.some((e) => e.match(path));
}

function checkImport(path: string, sf: ts.SourceFile, node: ts.Node, name: string): void {
  const entries = RESTRICTED[name];
  if (!entries || allowed(path, entries)) return;
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const denied = DENY.match(path) ? ` (${DENY.name} is never allowed)` : '';
  fail(`${path}:${line}`, `imports ${name} outside its allowlist${denied}`, `take a ScopedRead / LegacyUnscopedRead from the engine façade instead; allowed importers: ${entries.map((e) => e.name).join(', ')}`);
}

function resolvesToBrands(path: string, spec: string): boolean {
  if (!spec.startsWith('.')) return false;
  const target = normalize(join(dirname(path), spec)).replace(/\\/g, '/');
  return target === BRANDS || target === BRANDS.replace(/\.ts$/, '');
}

function isUnknownCast(e: ts.Expression): boolean {
  const inner = ts.isParenthesizedExpression(e) ? e.expression : e;
  return (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && inner.type.kind === ts.SyntaxKind.UnknownKeyword;
}

for (const abs of ['src', 'scripts'].flatMap((d) => files(join(ROOT, d), (n) => /\.[cm]?tsx?$/.test(n) && !n.endsWith('.d.ts')))) {
  const path = rel(abs);
  if (path === BRANDS) continue;
  const text = readFileSync(abs, 'utf8');
  if (!/ScopedRead|scopedRead|unscopedExecutor|SqlExecutor|brands/.test(text)) continue;
  const inSrc = path.startsWith('src/');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const at = (n: ts.Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const spec = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      if (clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause))) {
        for (const el of clause.elements) checkImport(path, sf, el, (el.propertyName ?? el.name).text);
      } else if (resolvesToBrands(path, spec) && !allowed(path, SCOPED_ALLOWLIST)) {
        fail(at(node), `imports all of ${BRANDS} (namespace or export *) outside the scopedRead allowlist`, 'import the one factory you need by name');
      }
    } else if (ts.isImportTypeNode(node) && node.qualifier) {
      const q = node.qualifier;
      checkImport(path, sf, node, ts.isIdentifier(q) ? q.text : q.right.text);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const arg = node.arguments[0];
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg) && resolvesToBrands(path, arg.text) && !allowed(path, SCOPED_ALLOWLIST)) {
        fail(at(node), `loads ${BRANDS} dynamically outside the scopedRead allowlist`, 'import the one factory you need by name from an allowed module');
      }
      if (inSrc && ts.isIdentifier(node.expression) && BRAND_FACTORIES.has(node.expression.text)) {
        for (const a of node.arguments) {
          if (ts.isAsExpression(a) && isUnknownCast(a.expression) && !BRAND_TYPES.test(a.type.getText(sf))) {
            fail(at(a), `double cast '${a.getText(sf).slice(0, 60)}' fed to ${node.expression.text}()`, 'pass the executor the engine gave you; if its type is wrong, fix the type at its source');
          }
        }
      }
    }
    if (inSrc && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))) {
      const typeText = node.type.getText(sf);
      if (/\b(?:ScopedRead|LegacyUnscopedRead)\b/.test(typeText)) {
        fail(at(node), `cast to ${typeText} outside ${BRANDS}`, `obtain it from scopedRead() / unscopedExecutor() in ${BRANDS}`);
      } else if (isUnknownCast(node.expression) && BRAND_TYPES.test(typeText)) {
        fail(at(node), `double cast 'as unknown as ${typeText}' onto an executor type`, 'build the executor with pgliteExecutor() / postgresExecutor() and brand it with scopedRead() / unscopedExecutor()');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (violations.length) {
  for (const v of violations) console.error(v);
  console.error('Why:  ScopedRead / LegacyUnscopedRead record how master scoped each read (RLS, #1794); a forged or widely imported brand silently changes scoping (EO4).');
  console.error(`See:  ${ANCHOR}`);
  console.error(`check-engine-sql-brands: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log('check-engine-sql-brands: ok');
