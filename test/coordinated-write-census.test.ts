/**
 * G5 (git-canonical plan): every direct coordinated database write is classified. `withCoordinatedWrite` and
 * `coordinatedDatabaseWrite` commit rows inside a source-scoped coordinated transaction with no file and no
 * receipt, so a new call site could write memory content the database holds and git never sees. Each call site,
 * keyed by its file and enclosing function, needs a row in docs/architecture/coordinated-writes.tsv naming why it
 * may stay database-only. Authored content has no class here: it goes through the page-mutation door instead.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
const WRITERS = new Set(['withCoordinatedWrite', 'coordinatedDatabaseWrite']);
const DEFINITIONS = new Set(['src/core/persistence/context.ts', 'src/core/persistence/database-write.ts']);
const CLASSES = ['door', 'projection', 'operational', 'metadata', 'removal', 'generated', 'facts_lane'];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
}

function enclosingName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isGetAccessor(at)) && at.name) return at.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && at.parent) {
      const owner = at.parent;
      if ((ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner)) && owner.name) return owner.name.getText();
    }
  }
  return '<module>';
}

/** `path\tfunction` -> call sites, for every coordinated-write call in `sources`; aliased imports count as sites. */
function sitesOf(sources: Iterable<[string, string]>): Map<string, number> {
  const sites = new Map<string, number>();
  for (const [path, text] of sources) {
    if (DEFINITIONS.has(path) || ![...WRITERS].some(name => text.includes(name))) continue;
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      const aliased = ts.isImportSpecifier(node) && node.propertyName && WRITERS.has(node.propertyName.text);
      const called = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && WRITERS.has(node.expression.text);
      if (aliased || called) {
        const key = `${path}\t${aliased ? `<alias ${node.getText()}>` : enclosingName(node)}`;
        sites.set(key, (sites.get(key) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return sites;
}

type Row = { sites: number; klass: string; reason: string };
function loadCensus(): Map<string, Row> {
  return new Map(readFileSync(join(root, 'docs/architecture/coordinated-writes.tsv'), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t'))
    .map(([path, fn, sites, klass, reason]) => [`${path}\t${fn}`, { sites: Number(sites), klass: klass ?? '', reason: reason ?? '' }]));
}

function gaps(sites: Map<string, number>, census: Map<string, Row>): string[] {
  const out: string[] = [];
  for (const [key, n] of sites) {
    const row = census.get(key);
    if (!row || row.sites !== n) out.push(`${key.replace('\t', ' ')}: ${n} coordinated write(s); classified ${row?.sites ?? 0}`);
  }
  for (const key of census.keys()) if (!sites.has(key)) out.push(`${key.replace('\t', ' ')}: classified but no longer a call site`);
  return out.sort();
}

const tree = () => files(join(root, 'src')).map(file => [relative(root, file), readFileSync(file, 'utf8')] as [string, string]);

test('every withCoordinatedWrite / coordinatedDatabaseWrite call site is classified', () => {
  const census = loadCensus();
  for (const [key, row] of census) {
    expect(CLASSES, key).toContain(row.klass);
    expect(row.reason.length, key).toBeGreaterThan(30);
  }
  // test-reads-source-ok[structural]: the census is a source-text tripwire by design.
  expect(gaps(sitesOf(tree()), census), 'Classify the call site in docs/architecture/coordinated-writes.tsv; authored content goes through the page-mutation door instead.').toEqual([]);
});

test('a planted coordinated write in a new function, a new file or behind an alias fails the census', () => {
  const census = loadCensus();
  // test-reads-source-ok[structural]: the planted copies prove the census flags each new site shape.
  const aliases = readFileSync(join(root, 'src/core/repair/aliases.ts'), 'utf8');
  expect(gaps(sitesOf([['src/core/repair/aliases.ts', aliases]]), census).filter(gap => gap.startsWith('src/core/repair/aliases.ts'))).toEqual([]);
  const planted = sitesOf([
    ['src/core/repair/aliases.ts', `${aliases}\nexport async function plantedWriter(tx: BrainEngine) { await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw('SELECT 1'), attribution); }`],
    ['src/core/planted-writer.ts', "export const plant = (ctx: OperationContext) => coordinatedDatabaseWrite(ctx, 'add_link', 'a', ['a'], async () => 1);"],
    ['src/core/planted-alias.ts', "import { withCoordinatedWrite as write } from './persistence/context.ts';"],
  ]);
  expect(gaps(planted, census).filter(gap => !gap.endsWith('classified but no longer a call site'))).toEqual([
    "src/core/planted-alias.ts <alias withCoordinatedWrite as write>: 1 coordinated write(s); classified 0",
    'src/core/planted-writer.ts plant: 1 coordinated write(s); classified 0',
    'src/core/repair/aliases.ts plantedWriter: 1 coordinated write(s); classified 0',
  ]);
});
