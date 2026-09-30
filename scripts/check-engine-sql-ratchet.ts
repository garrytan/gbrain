#!/usr/bin/env bun
/**
 * Engine-sql ratchet (refactor wave 1, goal (a); docs/TESTING.md#engine-sql-ratchet).
 *
 * Each storage domain's SQL lives once, in src/core/engine-sql/<domain>.ts,
 * and both engines delegate to it. This guard keeps SQL from growing back
 * into the engines. It parses (TypeScript compiler API):
 *
 *   src/core/pglite-engine.ts, src/core/postgres-engine.ts
 *   src/core/pglite-engine/**\/*.ts, src/core/postgres-engine/**\/*.ts
 *
 * and names every unit that can carry SQL: each class member (method,
 * constructor, accessor, property) as `Class.member`, each top-level function
 * and each top-level variable as its name. A unit is SQL-bearing when a
 * string literal, template literal, tagged template or `+` chain inside it
 * has LITERAL text (comments and identifiers never count) with SQL
 * structure, not bare keywords: `SELECT ... FROM <x>`, `SELECT <fn>(` /
 * `SELECT <number|$n>`, `INSERT INTO <x>`, `UPDATE <x> [alias] SET`,
 * `DELETE FROM <x>`, `WITH <x> AS (`, `CREATE|ALTER|DROP <object kind>`,
 * `TRUNCATE <x>`. Keywords match in upper or lower case, never Title Case
 * ("Select a file"); an all-lowercase match also needs a second SQL signal
 * (where, returning, values, join, limit, order by, group by, on conflict,
 * `$<digit>`, `::`, `;`, `*`), so prose like "delete from cache" never counts.
 *
 * Rules (every violation is reported, then one exit):
 *   1. a SQL-bearing unit with no baseline row and no marker      -> FAIL (new)
 *   2. a `method` row whose unit is gone, no longer SQL-bearing,
 *      or now carries a marker                                     -> FAIL (stale)
 *   3. a duplicate row                                             -> FAIL
 *   4. a `migrated` row with no src/core/engine-sql/<domain>.ts    -> FAIL
 *   5. a malformed row, or a marker with an empty reason           -> FAIL
 *
 * Marker: `// engine-sql-ok: <reason>` on the unit's declaration line or the
 * line directly above it (non-empty reason).
 *
 * Baseline: scripts/engine-sql-baseline.tsv, rows `migrated<TAB><domain>` and
 * `method<TAB><path><TAB><QualifiedName>`. Rows only shrink.
 * `--prune` rewrites the file without stale and duplicate rows; nothing ever
 * adds rows.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root; baseline read from
 * <root>/scripts/engine-sql-baseline.tsv).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const BASELINE_REL = 'scripts/engine-sql-baseline.tsv';
const ANCHOR = 'docs/TESTING.md#engine-sql-ratchet';
const FACADES = ['src/core/pglite-engine.ts', 'src/core/postgres-engine.ts'];
const MODULE_DIRS = ['src/core/pglite-engine', 'src/core/postgres-engine'];
const MARKER = 'engine-sql-ok';
const SUB = ' _sub_ ';

const IDENT = String.raw`"?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?`;
const OBJECT_KINDS = [
  'TABLE', 'UNIQUE INDEX', 'INDEX', 'FUNCTION', 'TRIGGER', 'EXTENSION', 'MATERIALIZED VIEW', 'VIEW', 'POLICY', 'SCHEMA',
  'SEQUENCE', 'TYPE',
];

function compileStructure(source: string): RegExp {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- source is assembled only from the constant keyword and identifier fragments in this file; no input reaches it
  return new RegExp(source);
}

function structurePatterns(kw: (word: string) => string): RegExp[] {
  return [
    compileStructure(String.raw`\b${kw('SELECT')}\b[\s\S]*?\b${kw('FROM')}\s+[("A-Za-z_]`),
    compileStructure(String.raw`\b${kw('SELECT')}\s+(?:\d|\$\d|[A-Za-z_][\w.]*\s*\()`),
    compileStructure(String.raw`\b${kw('INSERT')}\s+${kw('INTO')}\s+${IDENT}`),
    compileStructure(String.raw`\b${kw('UPDATE')}\s+${IDENT}(?:\s+(?:${kw('AS')}\s+)?[A-Za-z_]\w*)?\s+${kw('SET')}\b`),
    compileStructure(String.raw`\b${kw('DELETE')}\s+${kw('FROM')}\s+${IDENT}`),
    compileStructure(String.raw`\b${kw('WITH')}\s+(?:${kw('RECURSIVE')}\s+)?[A-Za-z_]\w*(?:\s*\([^)]*\))?\s+${kw('AS')}\s+(?:(?:${kw('NOT')}\s+)?${kw('MATERIALIZED')}\s+)?\(`),
    compileStructure(String.raw`\b(?:${kw('CREATE')}|${kw('ALTER')}|${kw('DROP')})\s+(?:${kw('OR REPLACE')}\s+)?(?:${kw('TEMPORARY')}\s+|${kw('TEMP')}\s+)?(?:${OBJECT_KINDS.map(kw).join('|')})\b`),
    compileStructure(String.raw`\b${kw('TRUNCATE')}\s+(?:${kw('TABLE')}\s+)?${IDENT}`),
    compileStructure(String.raw`\b${kw('SET')}\s+(?:${kw('LOCAL')}|${kw('SESSION')})\s+[A-Za-z_]\w*`),
    compileStructure(String.raw`\b${kw('LOCK')}\s+${kw('TABLE')}\s+${IDENT}`),
    compileStructure(String.raw`\b${kw('ON CONFLICT')}\s*[(A-Za-z]`),
    compileStructure(String.raw`\b${kw('WHERE')}\b[\s\S]*?\b(?:${kw('ORDER BY')}|${kw('GROUP BY')}|${kw('LIMIT')})\b`),
  ];
}

const UPPER = structurePatterns((w) => w.replace(/ /g, String.raw`\s+`));
const LOWER = structurePatterns((w) => w.toLowerCase().replace(/ /g, String.raw`\s+`));
const PARAM_CAST = /\$\d+::[A-Za-z_]/;
const LOWER_SIGNAL = /\b(?:where|returning|values|join|limit|order\s+by|group\s+by|on\s+conflict)\b|\$\d|::|;|\*/;

export function isSqlText(text: string): boolean {
  if (PARAM_CAST.test(text) || UPPER.some((re) => re.test(text))) return true;
  return LOWER.some((re) => re.test(text)) && LOWER_SIGNAL.test(text);
}

function literalTexts(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) text += (text.endsWith('$') ? '0' : SUB) + span.literal.text;
    return [text];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts: string[] = [];
    const flatten = (n: ts.Expression): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        flatten(n.left);
        flatten(n.right);
      } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
      else parts.push(SUB);
    };
    flatten(node);
    return [parts.join('')];
  }
  return [];
}

function sqlLine(node: ts.Node, sf: ts.SourceFile): number | null {
  let hit: number | null = null;
  const visit = (n: ts.Node): void => {
    if (hit !== null) return;
    if (literalTexts(n).some(isSqlText)) {
      hit = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

export interface Unit {
  path: string;
  name: string;
  line: number;
  sqlLine: number | null;
  marker: { line: number; reason: string } | null;
}

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

function markers(sf: ts.SourceFile): Map<number, string> {
  const text = sf.getFullText();
  const out = new Map<number, string>();
  const re = new RegExp(String.raw`//\s*${MARKER}\b(:?)([^\n]*)`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const token = ts.getTokenAtPosition(sf, m.index);
    if (token.getStart(sf) <= m.index && m.index < token.end) continue;
    out.set(sf.getLineAndCharacterOfPosition(m.index).line + 1, m[1] ? m[2].trim() : '');
  }
  return out;
}

function memberName(member: ts.ClassElement, sf: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  if (ts.isClassStaticBlockDeclaration(member)) return 'static';
  const name = member.name;
  if (!name) return '<anonymous>';
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

export function scanFile(abs: string, rel: string): Unit[] {
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const marks = markers(sf);
  const units = new Map<string, Unit>();
  const add = (name: string, decl: ts.Node, body: ts.Node) => {
    const line = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
    const markLine = marks.has(line) ? line : marks.has(line - 1) ? line - 1 : null;
    const unit: Unit = {
      path: rel,
      name,
      line,
      sqlLine: sqlLine(body, sf),
      marker: markLine === null ? null : { line: markLine, reason: marks.get(markLine)! },
    };
    const prev = units.get(name);
    if (!prev) {
      units.set(name, unit);
      return;
    }
    prev.sqlLine ??= unit.sqlLine;
    prev.marker ??= unit.marker;
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text, stmt, stmt);
    else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) add(decl.name.text, stmt, decl);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      for (const member of stmt.members) add(`${stmt.name.text}.${memberName(member, sf)}`, member, member);
    }
  }
  return [...units.values()];
}

export function scanTree(root: string): Unit[] {
  const files = [
    ...FACADES.map((f) => join(root, f)).filter((f) => existsSync(f)),
    ...MODULE_DIRS.flatMap((d) => tsFiles(join(root, d))),
  ];
  return files.flatMap((abs) => scanFile(abs, relative(root, abs).replace(/\\/g, '/')));
}

interface Row {
  lineNo: number;
  raw: string;
  kind: 'migrated' | 'method' | 'malformed';
  key: string;
  domain?: string;
}

function parseBaseline(text: string): Row[] {
  const rows: Row[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const cols = raw.split('\t');
    if (cols[0] === 'migrated' && cols.length === 2 && /^[a-z0-9][a-z0-9-]*$/.test(cols[1])) {
      rows.push({ lineNo: i + 1, raw, kind: 'migrated', key: raw, domain: cols[1] });
    } else if (cols[0] === 'method' && cols.length === 3 && cols[1] && cols[2]) {
      rows.push({ lineNo: i + 1, raw, kind: 'method', key: `${cols[1]}\t${cols[2]}` });
    } else rows.push({ lineNo: i + 1, raw, kind: 'malformed', key: raw });
  });
  return rows;
}

function domainHint(path: string): string {
  const m = /^src\/core\/(?:pglite|postgres)-engine\/(.+)\.ts$/.exec(path);
  return m ? m[1] : '<domain>';
}

if (import.meta.main) {
  const prune = process.argv.includes('--prune');
  const baselinePath = join(ROOT, BASELINE_REL);
  if (!existsSync(baselinePath)) {
    console.error(`FAIL: ${BASELINE_REL}:1 baseline file missing`);
    console.error('Why:  the ratchet compares SQL-bearing engine members against the committed baseline.');
    console.error(`Fix:  git checkout ${BASELINE_REL}`);
    console.error(`See:  ${ANCHOR}`);
    process.exit(1);
  }
  const baselineText = readFileSync(baselinePath, 'utf8');
  const rows = parseBaseline(baselineText);
  const units = new Map(scanTree(ROOT).map((u) => [`${u.path}\t${u.name}`, u]));
  const violations: string[] = [];
  const stale = new Set<number>();
  const seen = new Set<string>();
  const baselined = new Set<string>();

  for (const row of rows) {
    const where = `${BASELINE_REL}:${row.lineNo}`;
    if (row.kind === 'malformed') {
      violations.push(`FAIL: ${where} malformed row '${row.raw}'\n      Fix:  use 'migrated<TAB><domain>' or 'method<TAB><path><TAB><QualifiedName>'`);
      continue;
    }
    if (seen.has(row.key)) {
      stale.add(row.lineNo);
      violations.push(`FAIL: ${where} duplicate row '${row.raw.replace(/\t/g, ' ')}'\n      Fix:  delete this line (or: bun scripts/check-engine-sql-ratchet.ts --prune)`);
      continue;
    }
    seen.add(row.key);
    if (row.kind === 'migrated') {
      const mod = `src/core/engine-sql/${row.domain}.ts`;
      if (!existsSync(join(ROOT, mod))) {
        violations.push(`FAIL: ${where} migrated domain '${row.domain}' has no ${mod}\n      Fix:  add ${mod} with the domain's SQL, or delete this row if the domain was never migrated`);
      }
      continue;
    }
    baselined.add(row.key);
    const unit = units.get(row.key);
    const reason = !unit ? 'no longer exists' : unit.marker ? 'now carries an engine-sql-ok marker' : unit.sqlLine === null ? 'is no longer SQL-bearing' : null;
    if (reason) {
      stale.add(row.lineNo);
      violations.push(`FAIL: ${where} stale row: ${row.key.replaceAll('\t', ' ')} ${reason}\n      Fix:  delete this line; rows only shrink (or: bun scripts/check-engine-sql-ratchet.ts --prune)`);
    }
  }

  for (const [key, unit] of units) {
    if (unit.marker && unit.marker.reason === '') {
      violations.push(`FAIL: ${unit.path}:${unit.marker.line} ${MARKER} marker on ${unit.name} has no reason\n      Fix:  write '// ${MARKER}: <why this SQL stays in the engine>'`);
      continue;
    }
    if (unit.sqlLine === null || unit.marker || baselined.has(key)) continue;
    violations.push(`FAIL: ${unit.path}:${unit.sqlLine} new SQL-bearing engine member ${unit.name}\n      Fix:  put the SQL in src/core/engine-sql/${domainHint(unit.path)}.ts and delegate, or add \`// ${MARKER}: <reason>\` above the declaration`);
  }

  if (prune) {
    const kept = baselineText.split('\n').filter((_line, i) => !stale.has(i + 1));
    writeFileSync(baselinePath, kept.join('\n'));
    console.log(`check-engine-sql-ratchet: pruned ${stale.size} row(s) from ${BASELINE_REL}`);
    process.exit(0);
  }

  if (violations.length) {
    for (const v of violations) console.error(v);
    console.error('Why:  each storage domain\'s SQL lives once in src/core/engine-sql/; engine SQL only shrinks (goal (a)).');
    console.error(`See:  ${ANCHOR}`);
    console.error(`check-engine-sql-ratchet: ${violations.length} violation(s)`);
    process.exit(1);
  }
  const methods = rows.filter((r) => r.kind === 'method').length;
  const migrated = rows.filter((r) => r.kind === 'migrated').length;
  console.log(`check-engine-sql-ratchet: ok (${methods} baseline methods, ${migrated} migrated domains)`);
}
