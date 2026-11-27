/**
 * No save path sends a statement straight to the database driver inside a shadowed transaction.
 *
 * The shadow wrapper hands a transaction callback a wrapped engine and sees only BrainEngine method calls on it.
 * A statement sent through the driver itself (`tx.sql`, `(tx as PostgresEngine).sql`, `(tx as any).db`, a
 * destructured `{ sql }`, or a helper that casts the engine it is given) is invisible to it: the write is never
 * compared, and a failed shadow pre-read cannot be ordered around it. This test scans every function reachable
 * from a `transaction` / `transactionDirect` callback in src/ (test/helpers/driver-accessor-scan.ts) and fails on
 * any driver accessor that is not a reviewed exception below. A new caller turns it red; so does an exception
 * that no longer matches the code.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';
import { SHADOW_TRANSACTION_MEMBERS } from '../src/shadow/reads.ts';
import { scanDriverAccessors, type AccessorSite } from './helpers/driver-accessor-scan.ts';

const root = join(import.meta.dir, '..');

/**
 * Reviewed exceptions, keyed by file and enclosing function, with the number of accessor sites in it.
 * Add a row only with a reason a reviewer can check; a write belongs on a BrainEngine method instead.
 */
const REVIEWED: Record<string, { sites: number; reason: string }> = {
  'src/core/postgres-engine.ts\tPostgresEngine.readTransaction': {
    sites: 2,
    reason: 'Search reads only. Its callers are withScopedReadTransaction and jitOffRead, which send the session settings '
      + '(app.scopes, JIT off, statement_timeout) and SELECTs; a top-level one opens BEGIN READ ONLY, and inside a caller\'s '
      + 'transaction it is a savepoint that restores the settings. A rollback there cannot undo saved data.',
  },
  'src/core/vector-index.ts\tdropAndRebuild': {
    sites: 1,
    reason: 'Swaps a rebuilt HNSW index (DROP INDEX, ALTER INDEX RENAME): DDL, not page data, and no production caller. '
      + 'Only test/vector-index-lifecycle.test.ts calls it; the test below fails if a src/ caller appears.',
  },
  'src/core/persistence/pool-capacity.ts\tordinaryPool': {
    sites: 1,
    reason: 'Reads the postgres.js pool to size publication concurrency (its options.max) and to key an in-process counter '
      + 'on the pool object. It sends no statement.',
  },
};

function keyOf(site: AccessorSite): string {
  return `${site.file}\t${site.fn}`;
}

function gaps(sites: AccessorSite[]): string[] {
  const found = new Map<string, AccessorSite[]>();
  for (const site of sites) found.set(keyOf(site), [...(found.get(keyOf(site)) ?? []), site]);
  const out: string[] = [];
  for (const [key, list] of found) {
    if (REVIEWED[key]?.sites === list.length) continue;
    for (const site of list) out.push(`${site.file}:${site.line} ${site.fn}: ${site.text}\n    reached from ${site.chain.join(' -> ')}`);
    if (REVIEWED[key]) out.push(`${key.replace('\t', ' ')}: reviewed for ${REVIEWED[key].sites} site(s), found ${list.length}`);
  }
  for (const key of Object.keys(REVIEWED)) if (!found.has(key)) out.push(`${key.replace('\t', ' ')}: reviewed exception that no longer matches a driver accessor; remove the row`);
  return out.sort();
}

function srcProgram(): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) throw new Error('tsconfig.json did not parse');
  const src = join(root, 'src') + '/';
  return ts.createProgram(parsed.fileNames.filter(file => file.startsWith(src)), { ...parsed.options, noEmit: true });
}

describe('driver accessors inside shadowed transactions', () => {
  let program: ts.Program | undefined;
  const real = () => (program ??= srcProgram());

  test('every driver accessor reachable from a transaction callback in src/ is a reviewed exception', () => {
    for (const [key, row] of Object.entries(REVIEWED)) expect(row.reason.length, key).toBeGreaterThan(60);
    const src = join(root, 'src') + '/';
    // test-reads-source-ok[structural]: a reachability census over src/ by the TypeScript checker is the only way to see a cast-and-pass escape.
    const sites = scanDriverAccessors(real(), { root, inScope: file => file.startsWith(src), txMembers: SHADOW_TRANSACTION_MEMBERS });
    expect(gaps(sites), 'Send the statement through a BrainEngine method (executeRaw, a typed engine method) so the shadow wrapper sees it, or add a reviewed row to REVIEWED in this file with a reason a reviewer can check.').toEqual([]);
  }, 120_000);

  test('dropAndRebuild keeps no production caller, which its exception depends on', () => {
    const callers: string[] = [];
    for (const sf of real().getSourceFiles()) {
      if (sf.isDeclarationFile || !sf.fileName.startsWith(join(root, 'src') + '/')) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === 'dropAndRebuild' && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) {
          callers.push(`${sf.fileName.slice(root.length + 1)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(callers, 'A src/ caller of dropAndRebuild puts its raw-driver index swap on a live path: route the swap through executeRaw and drop its REVIEWED row.').toEqual([]);
  }, 120_000);
});

/** A small in-memory program, so each escape form is proven to be caught without touching src/. */
function fixtureProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, types: [], allowImportingTsExtensions: true, lib: ['lib.esnext.d.ts'],
  };
  const host = ts.createCompilerHost(options);
  const fileExists = host.fileExists.bind(host), readFile = host.readFile.bind(host), getSourceFile = host.getSourceFile.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  host.fileExists = file => file in files || fileExists(file);
  host.directoryExists = dir => Object.keys(files).some(file => file.startsWith(dir.endsWith('/') ? dir : `${dir}/`)) || (directoryExists?.(dir) ?? false);
  host.readFile = file => files[file] ?? readFile(file);
  host.getSourceFile = (file, version, onError, create) => file in files
    ? ts.createSourceFile(file, files[file]!, version, true) : getSourceFile(file, version, onError, create);
  return ts.createProgram(Object.keys(files), options, host);
}

const ENGINE = `
export interface Sql { unsafe(query: string): Promise<unknown> }
export interface PGlite { exec(query: string): Promise<unknown> }
export interface BrainEngine {
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;
  transactionDirect<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;
  executeRaw(query: string): Promise<unknown>;
}
export class PostgresEngine implements BrainEngine {
  sql!: Sql;
  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> { return fn(this); }
  async transactionDirect<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> { return fn(this); }
  async executeRaw(query: string): Promise<unknown> { return this.sql.unsafe(query); }
}
export class PGLiteEngine implements BrainEngine {
  db!: PGlite;
  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> { return fn(this); }
  async transactionDirect<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> { return fn(this); }
  async executeRaw(query: string): Promise<unknown> { return this.db.exec(query); }
}
`;

const HELPER = `
import { type BrainEngine, PostgresEngine } from './engine.ts';
export async function castHelper(engine: BrainEngine): Promise<void> { await (engine as PostgresEngine).sql.unsafe('DELETE FROM pages'); }
export async function exprOnlyHelper(engine: BrainEngine): Promise<void> { await (engine as PostgresEngine).sql.unsafe('DELETE FROM links'); }
export class Helper { async run(engine: BrainEngine): Promise<void> { await (engine as any).sql.unsafe('UPDATE pages SET title = 1'); } }
`;

const CASES = `
import { type BrainEngine, PGLiteEngine, PostgresEngine } from './engine.ts';
import { castHelper, exprOnlyHelper, Helper } from './helper.ts';

export async function castInCallback(engine: BrainEngine) { await engine.transaction(async tx => { await (tx as PostgresEngine).sql.unsafe('INSERT'); }); }
export async function doubleCast(engine: BrainEngine) { await engine.transaction(async tx => { await (tx as unknown as { sql: any }).sql.unsafe('INSERT'); }); }
export async function anyElement(engine: BrainEngine) { await engine.transaction(async tx => { await (tx as any)['db'].exec('INSERT'); }); }
export async function destructured(engine: BrainEngine) { await engine.transaction(async tx => { const { sql } = tx as PostgresEngine; await sql.unsafe('INSERT'); }); }
export async function aliased(engine: BrainEngine) { await engine.transaction(async tx => { const pg = tx as PostgresEngine; await pg.sql.unsafe('INSERT'); }); }
export async function viaHelper(engine: BrainEngine) { await engine.transaction(async tx => { await castHelper(tx); }); }
export async function viaExpression(engine: BrainEngine) { await engine.transaction(tx => exprOnlyHelper(tx)); }
export async function viaMethod(engine: BrainEngine) { await engine.transaction(async tx => { await new Helper().run(tx); }); }
async function namedWork(tx: BrainEngine) { await (tx as PostgresEngine).sql.unsafe('INSERT'); }
export async function named(engine: BrainEngine) { await engine.transaction(namedWork); }
export async function directTx(engine: BrainEngine) { await engine.transactionDirect(async tx => { await (tx as PostgresEngine).sql.unsafe('INSERT'); }); }
export async function typedField(engine: BrainEngine) { await engine.transaction(async tx => { const routed = tx as BrainEngine & { sql?: { options?: { max?: number } } }; return routed.sql?.options?.max; }); }
export async function pgliteDb(engine: BrainEngine) { await engine.transaction(async tx => { await (tx as PGLiteEngine).db.exec('INSERT'); }); }
async function inTx<T>(engine: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> { return engine.transaction(tx => run(tx)); }
async function inTxAgain<T>(engine: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> { return inTx(engine, run); }
export async function viaWrapper(engine: BrainEngine) { await inTx(engine, async tx => { await (tx as PostgresEngine).sql.unsafe('INSERT'); }); }
export async function viaWrapperOfWrapper(engine: BrainEngine) { await inTxAgain(engine, async tx => { await (tx as PGLiteEngine).db.exec('INSERT'); }); }
export async function nestedTx(engine: BrainEngine) { await engine.transaction(async tx => tx.transaction(async inner => { await (inner as any).sql.unsafe('INSERT'); })); }

export async function outsideTx(engine: BrainEngine) { await (engine as PostgresEngine).sql.unsafe('VACUUM'); }
export async function statementText(engine: BrainEngine) { await engine.transaction(async tx => { const statement = { sql: 'SELECT 1' }; await tx.executeRaw(statement.sql); }); }
export async function throughTheInterface(engine: BrainEngine) { await engine.transaction(async tx => { await tx.executeRaw('INSERT'); }); }
export async function notAnEngine(engine: BrainEngine) { const store = { transaction(fn: () => void) { fn(); } }; store.transaction(() => { void (engine as PostgresEngine).sql; }); }
`;

describe('driver-accessor scan catches each escape form', () => {
  const program = fixtureProgram({ '/fixture/src/engine.ts': ENGINE, '/fixture/src/helper.ts': HELPER, '/fixture/src/cases.ts': CASES });
  const sites = scanDriverAccessors(program,
    { root: '/fixture', inScope: file => file.startsWith('/fixture/src/'), txMembers: SHADOW_TRANSACTION_MEMBERS });
  const caught = new Set(sites.map(site => site.fn));

  test('the fixture type-checks, so every call and cast resolves as it would in src/', () => {
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });

  test.each(['castInCallback', 'doubleCast', 'anyElement', 'destructured', 'aliased', 'castHelper', 'exprOnlyHelper', 'Helper.run', 'namedWork', 'directTx', 'typedField', 'pgliteDb', 'nestedTx', 'viaWrapper', 'viaWrapperOfWrapper'])('%s is caught', fn => {
    expect(caught.has(fn), [...caught].join(', ')).toBe(true);
  });

  test.each(['outsideTx', 'statementText', 'throughTheInterface', 'notAnEngine', 'PostgresEngine.executeRaw', 'PGLiteEngine.executeRaw'])('%s is not reported', fn => {
    expect(caught.has(fn)).toBe(false);
  });

  test('a helper site names the transaction it is reached from', () => {
    const helper = sites.find(site => site.fn === 'castHelper');
    expect(helper?.chain[0]).toMatch(/^src\/cases\.ts:\d+#viaHelper$/);
    expect(helper?.chain.at(-1)).toBe('src/helper.ts#castHelper');
  });
});
