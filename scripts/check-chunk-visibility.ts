#!/usr/bin/env bun
/**
 * Chunk-visibility ratchet (Wave B large pages, spec 4.2). This header is its
 * documentation (docs/TESTING.md is at its byte cap); `bun run check:chunk-visibility`, in `bun run verify`.
 *
 * A segmented page stages chunk rows under a body generation above the page's
 * (invisible until the generation flip) and retires rows by generation, so a
 * `content_chunks` reader that skips the generation predicate can serve staged
 * rows of an unpublished write or retired rows of an old body. This guard
 * parses every `src/**\/*.ts` file (TypeScript compiler API) and finds each
 * string or template literal whose own literal text reads `FROM content_chunks`
 * or `JOIN content_chunks` (`DELETE FROM` is a write and never counts). Such a
 * statement is covered when:
 *
 *   - its source text (substitutions included) calls `chunkVisibleFilter(`,
 *     `chunkGenerationFilter(` or `chunkGenerationProbe(`
 *     (`src/core/search/safe-chunks.ts`), or `buildVisibilityClause(...)` with
 *     a chunk alias, or names a function or variable declared in the same file
 *     whose declaration does (transitively), or
 *   - it carries a marker with a non-empty reason: `-- chunk-visibility-ok: <reason>`
 *     inside the SQL, or `// chunk-visibility-ok: <reason>` on the literal's first
 *     line or the line directly above it.
 *
 * Every uncovered statement counts against its file's row in
 * scripts/chunk-visibility-baseline.tsv (`<path><TAB><count>`). Rows only shrink:
 *
 *   1. a file with more uncovered statements than its row (or no row) -> FAIL (new)
 *   2. a file with fewer uncovered statements than its row            -> FAIL (stale; lower the row)
 *   3. a duplicate or malformed row, or a marker with an empty reason   -> FAIL
 *
 * `--prune` rewrites the baseline with the current (lower) counts; nothing ever
 * raises a row. Seam: GBRAIN_GUARD_ROOT (fixture tree root; baseline read from
 * <root>/scripts/chunk-visibility-baseline.tsv).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** `ts.getTokenAtPosition` is exported at runtime but absent from typescript's public declarations. */
const tsInternal = ts as typeof ts & { getTokenAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node };

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const BASELINE_REL = 'scripts/chunk-visibility-baseline.tsv';
const ANCHOR = 'scripts/check-chunk-visibility.ts (header)';
const MARKER = 'chunk-visibility-ok';
const READ = /(?<!\bdelete\s{1,40})\b(?:from|join)\s+content_chunks\b/i;
const COVERED = /\bchunk(?:VisibleFilter|GenerationFilter|GenerationProbe)\(|\bbuildVisibilityClause\(\s*'\w+'\s*,\s*'\w+'\s*,(?:[^()]|\([^()]*\))*?\bchunkAlias:\s*'\w+'/;
const SQL_MARKER = new RegExp(String.raw`--\s*${MARKER}:([^\n]*)`);

export interface Statement {
  path: string;
  line: number;
  covered: boolean;
  /** Line of a marker whose reason is empty. */
  emptyMarker: number | null;
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

function ownLiteralText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(' _sub_ ');
  return null;
}

function lineComments(sf: ts.SourceFile): Map<number, string> {
  const text = sf.getFullText();
  const out = new Map<number, string>();
  const re = new RegExp(String.raw`//\s*${MARKER}\b(:?)([^\n]*)`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const token = tsInternal.getTokenAtPosition(sf, m.index);
    if (token.getStart(sf) <= m.index && m.index < token.end) continue;
    out.set(sf.getLineAndCharacterOfPosition(m.index).line + 1, m[1] ? m[2].trim() : '');
  }
  return out;
}

/** Identifiers referenced inside a node (substitutions and call arguments; never literal text). */
function identifiers(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

interface Decl { name: string; covered: boolean; refs: Set<string> }

function enclosingScope(node: ts.Node): ts.Node {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return n;
  return node.getSourceFile();
}

/** Functions and variables declared directly in each scope (function body or file). */
function scopeDecls(sf: ts.SourceFile): Map<ts.Node, Decl[]> {
  const out = new Map<ts.Node, Decl[]>();
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      const body = ts.isFunctionDeclaration(node) ? node.body : node.initializer;
      if (body) {
        const scope = enclosingScope(node);
        out.set(scope, [...(out.get(scope) ?? []), { name: node.name.text, covered: COVERED.test(body.getText(sf)), refs: identifiers(body) }]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Names visible from `node` (its scope chain) whose declarations apply the predicate, transitively. */
export function coveringNames(node: ts.Node, decls: Map<ts.Node, Decl[]>): Set<string> {
  const visible: Decl[] = [];
  for (let scope: ts.Node | undefined = enclosingScope(node); scope; scope = ts.isSourceFile(scope) ? undefined : enclosingScope(scope)) {
    visible.push(...(decls.get(scope) ?? []));
  }
  const names = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const d of visible) {
      if (names.has(d.name) || !(d.covered || [...d.refs].some(r => names.has(r)))) continue;
      names.add(d.name);
      grew = true;
    }
  }
  return names;
}

function covers(node: ts.Node, decls: Map<ts.Node, Decl[]>): boolean {
  const names = coveringNames(node, decls);
  return [...identifiers(node)].some(id => names.has(id));
}

export function scanFile(abs: string, rel: string): Statement[] {
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const comments = lineComments(sf);
  const decls = scopeDecls(sf);
  const out: Statement[] = [];
  const visit = (node: ts.Node): void => {
    const literal = ownLiteralText(node);
    if (literal !== null && READ.test(literal)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const sqlMarker = SQL_MARKER.exec(literal);
      const commentLine = comments.has(line) ? line : comments.has(line - 1) ? line - 1 : null;
      const reason = sqlMarker ? sqlMarker[1].trim() : commentLine !== null ? comments.get(commentLine)! : null;
      out.push({
        path: rel,
        line,
        covered: COVERED.test(node.getText(sf)) || covers(node, decls) || !!reason,
        emptyMarker: reason === '' ? (commentLine ?? line) : null,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function scanTree(root: string): Statement[] {
  return tsFiles(join(root, 'src')).flatMap(abs => scanFile(abs, relative(root, abs).replace(/\\/g, '/')));
}

interface Row { lineNo: number; raw: string; path: string; count: number; malformed: boolean }

function parseBaseline(text: string): Row[] {
  const rows: Row[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const cols = raw.split('\t');
    const count = Number(cols[1]);
    const malformed = cols.length !== 2 || !cols[0] || !Number.isInteger(count) || count < 1;
    rows.push({ lineNo: i + 1, raw, path: cols[0] ?? '', count, malformed });
  });
  return rows;
}

if (import.meta.main) {
  const prune = process.argv.includes('--prune');
  const baselinePath = join(ROOT, BASELINE_REL);
  if (!existsSync(baselinePath)) {
    console.error(`FAIL: ${BASELINE_REL}:1 baseline file missing`);
    console.error(`Fix:  git checkout ${BASELINE_REL}`);
    console.error(`See:  ${ANCHOR}`);
    process.exit(1);
  }
  const baselineText = readFileSync(baselinePath, 'utf8');
  const rows = parseBaseline(baselineText);
  const statements = scanTree(ROOT);
  const uncovered = new Map<string, Statement[]>();
  for (const s of statements) {
    if (s.covered) continue;
    uncovered.set(s.path, [...(uncovered.get(s.path) ?? []), s]);
  }
  const violations: string[] = [];
  const allowed = new Map<string, number>();
  const pruned = new Map<number, string | null>();

  for (const s of statements) {
    if (s.emptyMarker !== null) violations.push(`FAIL: ${s.path}:${s.emptyMarker} ${MARKER} marker has no reason\n      Fix:  write '${MARKER}: <why this reader may see staged or retired chunk rows>'`);
  }
  for (const row of rows) {
    const where = `${BASELINE_REL}:${row.lineNo}`;
    if (row.malformed) {
      violations.push(`FAIL: ${where} malformed row '${row.raw}'\n      Fix:  use '<path><TAB><positive count>'`);
      continue;
    }
    if (allowed.has(row.path)) {
      pruned.set(row.lineNo, null);
      violations.push(`FAIL: ${where} duplicate row for ${row.path}\n      Fix:  delete this line (or: bun scripts/check-chunk-visibility.ts --prune)`);
      continue;
    }
    allowed.set(row.path, row.count);
    const found = uncovered.get(row.path)?.length ?? 0;
    if (found < row.count) {
      pruned.set(row.lineNo, found === 0 ? null : `${row.path}\t${found}`);
      violations.push(`FAIL: ${where} stale row: ${row.path} has ${found} uncovered content_chunks reader(s), the row allows ${row.count}\n      Fix:  lower the row to ${found}${found === 0 ? ' (delete it)' : ''}; rows only shrink (or: bun scripts/check-chunk-visibility.ts --prune)`);
    }
  }
  for (const [path, list] of uncovered) {
    const limit = allowed.get(path) ?? 0;
    if (list.length <= limit) continue;
    const lines = list.map(s => s.line).join(', ');
    violations.push(`FAIL: ${path}:${list[0].line} ${list.length} content_chunks reader(s) without the chunk-visibility predicate (lines ${lines}), the baseline allows ${limit}\n      Fix:  add \${chunkVisibleFilter('p', 'cc')} (search-facing) or \${chunkGenerationFilter('p', 'cc')} (maintenance), or mark the statement '-- ${MARKER}: <reason>'`);
  }

  if (prune) {
    const kept = baselineText.split('\n').flatMap((line, i) => {
      const next = pruned.get(i + 1);
      return next === undefined ? [line] : next === null ? [] : [next];
    });
    writeFileSync(baselinePath, kept.join('\n'));
    console.log(`check-chunk-visibility: pruned ${pruned.size} row(s) in ${BASELINE_REL}`);
    process.exit(0);
  }
  if (violations.length) {
    for (const v of violations) console.error(v);
    console.error('Why:  staged chunk rows (body_generation above the page) and retired rows must never reach search, chunk reads or embedding.');
    console.error(`See:  ${ANCHOR}`);
    console.error(`check-chunk-visibility: ${violations.length} violation(s)`);
    process.exit(1);
  }
  const covered = statements.filter(s => s.covered).length;
  console.log(`check-chunk-visibility: ok (${covered} covered, ${statements.length - covered} baselined content_chunks readers)`);
}
