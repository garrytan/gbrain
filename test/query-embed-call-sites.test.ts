/**
 * #3783 call-site guard: a query-side embedding outside the two prefix-aware
 * paths skips the brain's `embedding_query_prefix`. The prefix-aware paths
 * are `embedQueryWithPrefix` (search/query-prefix.ts: loads the prefix, then
 * the unbounded `embedQuery`) and hybrid search's bounded
 * `embedQueryBounded`, which receives the prefix hybrid already loaded.
 *
 * This walks the TypeScript AST of src/** and lists every expression-position
 * reference to `embedQuery` / `embedQueryBounded` (calls and function values
 * such as `opts.fn ?? embedQuery`; imports, declarations and type positions
 * are not uses). A file not in ALLOWED fails: route its query embed through
 * `embedQueryWithPrefix(engine, text)`, or add an ALLOWED row with the reason
 * the prefix does not apply and the exact use count.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const NAMES = new Set(['embedQuery', 'embedQueryBounded']);

/** file → [uses, why the brain prefix is applied or does not apply there]. */
const ALLOWED: Record<string, [number, string]> = {
  'src/core/search/query-prefix.ts': [1, 'embedQueryWithPrefix itself: loads the brain prefix and passes it'],
  'src/core/search/hybrid.ts': [2, 'embedQueryBounded (forwards its embedOpts, prefix included) and the cache-lookup embed, which passes the prefix hybrid loaded'],
  'src/core/search/hybrid/arms.ts': [1, "the vector arm's embedOneQuery passes opts._queryPrefix in embedOpts"],
  'src/core/facts/question-recall.ts': [1, 'recall --question passes loadEmbeddingQueryPrefix in the bounded embed'],
  'src/core/embedding-migration.ts': [1, "the migration's verify smoke embeds a stored chunk under the target model, whose prefix the operator has not set yet; the brain's current prefix belongs to the model being replaced"],
  'src/eval/longmemeval/diagnostics.ts': [2, 'LongMemEval runs against an isolated in-memory brain per question, which has no embedding_query_prefix'],
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Expression-position references: not an import/export specifier, a declaration name, a property name or a type. */
function isUse(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isBindingElement(parent)) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)
    || ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent))
    && parent.name === id) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  return true;
}

function usesIn(text: string, file: string): number[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NAMES.has(node.text) && isUse(node)) lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe('#3783 query-embed call sites', () => {
  const found = new Map<string, number[]>();
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('embedQuery')) continue;
    const lines = usesIn(text, path);
    if (lines.length) found.set(relative(ROOT, path).split(sep).join('/'), lines);
  }

  test('every query embed outside the prefix-aware paths is allowlisted with its reason and count', () => {
    const unexpected = [...found].filter(([file, lines]) => ALLOWED[file]?.[0] !== lines.length)
      .map(([file, lines]) => `${file}:${lines.join(',')} (allowed ${ALLOWED[file]?.[0] ?? 0})`);
    expect(unexpected).toEqual([]);
  });

  test('every ALLOWED row still matches a real use (stale rows are removed)', () => {
    expect(Object.keys(ALLOWED).filter(file => !found.has(file))).toEqual([]);
  });

  test('the scanner sees the shapes that skip the prefix: a direct call and a function value', () => {
    expect(usesIn("import { embedQuery } from './embedding.ts';\nconst v = await embedQuery(q);", 'a.ts')).toEqual([2]);
    expect(usesIn("const fn = opts.embedQueryFn ?? embedQuery;", 'b.ts')).toEqual([1]);
    expect(usesIn("export async function embedQuery(text: string) {}\ntype T = typeof embedQuery;\nconst { embedQuery: e } = m;", 'c.ts')).toEqual([]);
  });
});
