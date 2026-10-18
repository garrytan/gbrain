#!/usr/bin/env bun
/**
 * Page body reader ratchet (Wave B segmented storage, spec 1.5 layer 4;
 * docs/TESTING.md#page-body-readers).
 *
 * A segmented page keeps its body in segments: `pages.compiled_truth` and
 * `pages.timeline` are NULL, and `rowToPage` / the snapshot readers give the
 * page object getters that throw `page_body_segmented`. `Page` stays one
 * TypeScript shape, so the type checker does not stop a new whole-body
 * reader; those getters (runtime) and this ratchet (static) do. Every site
 * that reads or writes a body as one string is listed with what it must
 * become, and the list only shrinks.
 *
 * Parses src/**\/*.ts (generated files excluded) with the TypeScript compiler
 * API and names units like the engine-sql ratchet: top-level functions and
 * variables by name, class members as `Class.member`, any other top-level
 * statement as `<module>`. A unit hits:
 *
 *   field              `.compiled_truth` / `.timeline` property access, the
 *                      same names in an element access or a destructuring
 *   sql                a string literal naming a body column (`x.compiled_truth`,
 *                      a bare `compiled_truth` / `timeline` column in SQL text,
 *                      quoted values like `chunk_source = 'timeline'` excluded)
 *                      or projecting `*` / `p.*` from `pages`
 *   call:<name>        a call to serializePageToMarkdown, serializeMarkdown,
 *                      contentHash, prepareMarkdownChunks, pageDocument,
 *                      refreshPageBody or putPage
 *
 * `boundedBodyPrefixSql` (page-window/bounded-lead.ts), the one sanctioned
 * COALESCE of the body and its lead, is allowed by name.
 *
 * Baseline: scripts/page-body-readers-baseline.tsv, rows
 * `path<TAB>unit<TAB>kind<TAB>action<TAB>note`. Action codes: STREAM (moves to
 * the segment reader), LEAD (a bounded prefix by design), META (size or hash
 * only: body_bytes / content_hash), SEGW (a writer that must go through the
 * segment writer; until then it refuses a segmented page), INLINE (the page
 * is inline by construction; asserts it), NONE (the name is not the page body;
 * the note says why). The note records how the site treats a segmented page
 * today.
 *
 * Rules (every violation is reported, then one exit):
 *   1. a hit with no row                        -> FAIL (new reader)
 *   2. a row with no hit                        -> FAIL (stale; rows only shrink)
 *   3. a duplicate row                          -> FAIL
 *   4. a malformed row, an unknown action, or NONE without a note -> FAIL
 *
 * `--prune` rewrites the file without stale and duplicate rows; nothing ever
 * adds rows.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root; baseline read from
 * <root>/scripts/page-body-readers-baseline.tsv).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { isSqlText } from './check-engine-sql-ratchet.ts';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const BASELINE_REL = 'scripts/page-body-readers-baseline.tsv';
const ANCHOR = 'docs/TESTING.md#page-body-readers';
const BODY_FIELDS = new Set(['compiled_truth', 'timeline']);
const BODY_CALLS = new Set(['serializePageToMarkdown', 'serializeMarkdown', 'contentHash', 'prepareMarkdownChunks', 'pageDocument',
  'refreshPageBody', 'putPage']);
const ALLOWED_UNITS = new Set(['boundedBodyPrefixSql']);
export const ACTIONS = new Set(['STREAM', 'LEAD', 'META', 'SEGW', 'INLINE', 'NONE']);

const QUALIFIED_COLUMN = /\.(?:compiled_truth|timeline)\b/;
const BARE_COLUMN = /(?<![\w'".])(?:compiled_truth|timeline)(?![\w'"])/;
const SELECT_STAR_FROM_PAGES = /\bselect\s+(?:distinct\s+)?\*\s+from\s+pages\b/i;
const RETURNING_STAR_FROM_PAGES = /\b(?:update|into)\s+pages\b[\s\S]*\breturning\s+\*/i;
const ALIAS_STAR = /\b([a-z_]\w*)\.\*/gi;

function aliasesPages(text: string, alias: string): boolean {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- alias is a \w+ identifier captured by ALIAS_STAR
  return alias === 'pages' || new RegExp(`\\bpages\\s+(?:as\\s+)?${alias}\\b`, 'i').test(text);
}

/** True when literal text names a body column or projects every column of `pages` (`*`, `p.*`, `RETURNING *`). */
export function namesBodyColumn(text: string): boolean {
  if (QUALIFIED_COLUMN.test(text)) return true;
  if (!isSqlText(text)) return false;
  if (BARE_COLUMN.test(text) || SELECT_STAR_FROM_PAGES.test(text) || RETURNING_STAR_FROM_PAGES.test(text)) return true;
  return [...text.matchAll(ALIAS_STAR)].some((m) => aliasesPages(text, m[1]));
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => ` _sub_ ${s.literal.text}`).join('');
  return null;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

export interface Hit { path: string; unit: string; kind: string; line: number }

function hitsIn(body: ts.Node, sf: ts.SourceFile, path: string, unit: string, out: Map<string, Hit>): void {
  const add = (kind: string, node: ts.Node) => {
    const key = `${path}\t${unit}\t${kind}`;
    if (!out.has(key)) out.set(key, { path, unit, kind, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const allowed = ALLOWED_UNITS.has(unit);
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && BODY_FIELDS.has(n.name.text)) add('field', n);
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && BODY_FIELDS.has(n.argumentExpression.text)) add('field', n);
    else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const name = n.propertyName ?? n.name;
      if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && BODY_FIELDS.has(name.text)) add('field', n);
    } else if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && BODY_CALLS.has(name)) add(`call:${name}`, n);
    }
    const text = literalText(n);
    if (text !== null && !allowed && namesBodyColumn(text)) add('sql', n);
    ts.forEachChild(n, visit);
  };
  visit(body);
}

function memberName(member: ts.ClassElement, sf: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  if (ts.isClassStaticBlockDeclaration(member)) return 'static';
  const name = member.name;
  if (!name) return '<anonymous>';
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

export function scanFile(abs: string, rel: string): Hit[] {
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map<string, Hit>();
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isImportDeclaration(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) hitsIn(stmt, sf, rel, stmt.name.text, out);
    else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) hitsIn(decl, sf, rel, ts.isIdentifier(decl.name) ? decl.name.text : '<module>', out);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      for (const member of stmt.members) hitsIn(member, sf, rel, `${stmt.name.text}.${memberName(member, sf)}`, out);
    } else hitsIn(stmt, sf, rel, '<module>', out);
  }
  return [...out.values()];
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.includes('.generated.')) out.push(full);
  }
  return out;
}

export function scanTree(root: string): Hit[] {
  return tsFiles(join(root, 'src')).flatMap((abs) => scanFile(abs, relative(root, abs).replace(/\\/g, '/')));
}

interface Row { lineNo: number; raw: string; key: string | null; problem: string | null }

function parseBaseline(text: string): Row[] {
  const rows: Row[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const [path, unit, kind, action, note, ...extra] = raw.split('\t');
    const problem = !path || !unit || !kind || !action || extra.length ? "use 'path<TAB>unit<TAB>kind<TAB>action<TAB>note'"
      : !ACTIONS.has(action) ? `unknown action '${action}' (one of ${[...ACTIONS].join(', ')})`
      : action === 'NONE' && !note?.trim() ? 'a NONE row needs a note saying why the name is not the page body'
      : null;
    rows.push({ lineNo: i + 1, raw, key: problem ? null : `${path}\t${unit}\t${kind}`, problem });
  });
  return rows;
}

if (import.meta.main) {
  const prune = process.argv.includes('--prune');
  const baselinePath = join(ROOT, BASELINE_REL);
  if (!existsSync(baselinePath)) {
    console.error(`FAIL: ${BASELINE_REL}:1 baseline file missing`);
    console.error('Why:  the ratchet compares page body readers against the committed baseline.');
    console.error(`Fix:  git checkout ${BASELINE_REL}`);
    console.error(`See:  ${ANCHOR}`);
    process.exit(1);
  }
  const baselineText = readFileSync(baselinePath, 'utf8');
  const rows = parseBaseline(baselineText);
  const hits = new Map(scanTree(ROOT).map((h) => [`${h.path}\t${h.unit}\t${h.kind}`, h]));
  const violations: string[] = [];
  const stale = new Set<number>();
  const listed = new Set<string>();

  for (const row of rows) {
    const where = `${BASELINE_REL}:${row.lineNo}`;
    if (row.problem || !row.key) {
      violations.push(`FAIL: ${where} malformed row '${row.raw.replace(/\t/g, ' ')}'\n      Fix:  ${row.problem}`);
      continue;
    }
    if (listed.has(row.key)) {
      stale.add(row.lineNo);
      violations.push(`FAIL: ${where} duplicate row '${row.key.replace(/\t/g, ' ')}'\n      Fix:  delete this line (or: bun scripts/check-page-body-readers.ts --prune)`);
      continue;
    }
    listed.add(row.key);
    if (!hits.has(row.key)) {
      stale.add(row.lineNo);
      violations.push(`FAIL: ${where} stale row: ${row.key.replace(/\t/g, ' ')} no longer reads the body\n      Fix:  delete this line; rows only shrink (or: bun scripts/check-page-body-readers.ts --prune)`);
    }
  }

  for (const [key, hit] of hits) {
    if (listed.has(key)) continue;
    violations.push(`FAIL: ${hit.path}:${hit.line} new page body reader in ${hit.unit} (${hit.kind})\n      Fix:  read size and identity from body_bytes / content_hash (pageBodyBytes) or a bounded prefix from boundedBodyPrefixSql; a whole-body reader that has to stay (refusing a segmented page with assertInlineBody, or waiting for the segment reader) needs a reviewed row in ${BASELINE_REL} with its action code`);
  }

  if (prune) {
    const kept = baselineText.split('\n').filter((_line, i) => !stale.has(i + 1));
    writeFileSync(baselinePath, kept.join('\n'));
    console.log(`check-page-body-readers: pruned ${stale.size} row(s) from ${BASELINE_REL}`);
    process.exit(0);
  }

  if (violations.length) {
    for (const v of violations) console.error(v);
    console.error('Why:  a segmented page has no body string; a whole-body reader would see nothing or throw page_body_segmented. Readers only shrink.');
    console.error(`See:  ${ANCHOR}`);
    console.error(`check-page-body-readers: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log(`check-page-body-readers: ok (${listed.size} baseline rows)`);
}
