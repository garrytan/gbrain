/**
 * The own-write count's static census (src/core/postgres-engine/own-writes.ts): every place PostgresEngine takes a
 * connection the counting pool does not hand out (the physical pool, the direct DDL pool, a reserved connection) is
 * listed here, either wrapped in `this.counted(...)` (a reservation: `_ownWrites?.reserved(...)` and
 * `this.counted(reservedTransactions(...))`) or with the reason its statements are not counted.
 *
 * Protects: the shadow seal's rule that the write counters may move by exactly this process's own counted writes. A
 * new write path on a raw connection leaves the counters ahead of the count, so every session that used it ends with a
 * seal refusal and a full pass. Regression it catches: a new `ddl()`, `reserve()`, `getConnection()` or `physicalSql`
 * use that nobody decided about. The dynamic half is the census on the parity harness's Postgres arm
 * (test/engine-parity/own-write-census.ts), which fails a case whose committed rows skipped the count.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const FILES = ['src/core/postgres-engine.ts', ...readdirSync(join(ROOT, 'src/core/postgres-engine')).filter((f) => f.endsWith('.ts')).map((f) => `src/core/postgres-engine/${f}`)];

type Kind = 'ddl' | 'reserve' | 'getConnection' | 'physicalSql';
interface Site { file: string; fn: string; kind: Kind; counted: boolean }

/**
 * `file fn kind` -> why. `counted:` sites must pass the connection through `this.counted(...)`; every other site says
 * why its statements stay out of the count (the count then falls short, so a seal refuses: never a hidden write).
 */
const DECIDED: Record<string, string> = {
  'src/core/postgres-engine.ts sql physicalSql': 'counted: the engine pool every statement and transaction goes through',
  'src/core/postgres-engine.ts countOwnWrites physicalSql': 'the activation reads (server version, relation oids), no write',
  'src/core/postgres-engine.ts physicalSql getConnection': 'the module pool behind physicalSql; the sql getter counts it',
  'src/core/postgres-engine.ts connect getConnection': 'registers the module pool as the read pool; statements still go through sql',
  'src/core/postgres-engine.ts reconnect getConnection': 'registers the module pool as the read pool after a reconnect',
  'src/core/postgres-engine.ts initSchema ddl': 'schema replay and migrations: DDL and migration backfills, before any seal basis exists',
  'src/core/postgres-engine.ts initSchema reserve': 'the schema replay backend (initSchema)',
  'src/core/postgres-engine.ts holdSchemaMigrationLock ddl': 'the schema migration lock (migrations only)',
  'src/core/postgres-engine.ts holdSchemaMigrationLock reserve': 'the schema migration lock backend (migrations only)',
  'src/core/postgres-engine.ts transactionDirect ddl': 'counted: transactions on the direct pool',
  'src/core/postgres-engine.ts executeRawDirect ddl': 'counted: lock heartbeats and claims on the direct pool',
  'src/core/postgres-engine.ts withReservedConnection ddl': 'the direct pool a long hold reserves from; the reserve site counts the reservation',
  'src/core/postgres-engine.ts withReservedConnection reserve': 'counted: conn.executeRaw through this._ownWrites?.reserved(...), conn.transaction through this.counted(reservedTransactions(...))',
  'src/core/postgres-engine.ts runUnsafe reserve': 'counted: a statement with a signal runs alone on its own reserved connection, through this._ownWrites.reservedStatement(...)',
  'src/core/postgres-engine/cancellation.ts reserveWithCancellation reserve': 'the cancellable reserve helper the sites above call',
  'src/core/postgres-engine/bounded-statement.ts runBoundedStatement reserve': 'executeRaw with timeoutMs: bounded preparation reads; a write here is left out',
  'src/core/postgres-engine/bounded-statement.ts runDeadlineRead reserve': 'deadline reads, no write',
};

function sites(): Site[] {
  const out: Site[] = [];
  for (const file of FILES) {
    const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node, fn: string): void => {
      let name = fn;
      if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isGetAccessor(n) || ts.isPropertyDeclaration(n)) && n.name) name = n.name.getText(sf);
      let kind: Kind | null = null;
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const called = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : '';
        if (called === 'reserve' || called === 'ddl' || called === 'getConnection') kind = called;
      }
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'physicalSql') kind = 'physicalSql';
      if (kind) out.push({ file, fn: name, kind, counted: countedWrap(n) });
      ts.forEachChild(n, (c) => visit(c, name));
    };
    visit(sf, '<module>');
  }
  return out;
}

/** Whether the connection is the argument of `this.counted(...)` (an `await` between them allowed), or the counting getter itself. */
function countedWrap(n: ts.Node): boolean {
  let at: ts.Node = n;
  while (ts.isAwaitExpression(at.parent) || ts.isParenthesizedExpression(at.parent)) at = at.parent;
  if (ts.isCallExpression(at.parent) && ts.isPropertyAccessExpression(at.parent.expression) && at.parent.expression.name.text === 'counted') return true;
  // A reservation kept in a variable, through `reserveWithCancellation(o => pool.reserve(o), signal)` and a `signal ? ... : undefined` too.
  for (;;) {
    const p = at.parent;
    if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || (ts.isArrowFunction(p) && p.body === at)
      || (ts.isCallExpression(p) && p.arguments.includes(at as ts.Expression) && p.expression.getText() === 'reserveWithCancellation')
      || (ts.isConditionalExpression(p) && p.whenTrue === at)) at = p;
    else break;
  }
  const call = at.parent;
  const held = ts.isBinaryExpression(call) && call.operatorToken.kind === ts.SyntaxKind.EqualsToken ? call.left.getText()
    : ts.isVariableDeclaration(call) ? call.name.getText() : null;
  if (held && /^\w+$/.test(held)) {
    let body: ts.Node | undefined = n;
    while (body && !ts.isMethodDeclaration(body)) body = body.parent;
    const text = body?.getText() ?? '';
    // Driven by the caller: both its raw statements and its transactions go through the count.
    if (new RegExp(`_ownWrites\\?\\.reserved\\(${held}\\b`).test(text) && new RegExp(`this\\.counted\\(reservedTransactions\\(${held}\\)\\)`).test(text)) return true;
    // Reserved for one statement alone: that statement goes through the count.
    if (new RegExp(`_ownWrites\\.reservedStatement\\(${held}\\b`).test(text)) return true;
  }
  // The sql getter: `const pool = this.physicalSql; return this._ownWrites ? this._ownWrites.pool(pool) : pool;`
  let fn: ts.Node | undefined = n;
  while (fn && !ts.isGetAccessor(fn)) fn = fn.parent;
  return !!fn && ts.isGetAccessor(fn) && fn.name.getText() === 'sql' && /_ownWrites\.pool\(pool\)/.test(fn.getText());
}

describe('own-write count: static census of raw connections in PostgresEngine', () => {
  test('every raw connection site is decided, and the counted ones go through the counting pool', () => {
    const found = sites();
    const keys = [...new Set(found.map((s) => `${s.file} ${s.fn} ${s.kind}`))].sort();
    expect({ undecided: keys.filter((k) => !(k in DECIDED)) }).toEqual({ undecided: [] });
    expect({ stale: Object.keys(DECIDED).filter((k) => !keys.includes(k)).sort() }).toEqual({ stale: [] });
    const wrong = found.filter((s) => DECIDED[`${s.file} ${s.fn} ${s.kind}`]!.startsWith('counted:') !== s.counted)
      .map((s) => `${s.file} ${s.fn} ${s.kind}: ${s.counted ? 'counted but listed as left out' : 'listed as counted but not wrapped in this.counted(...)'}`);
    expect(wrong).toEqual([]);
  });

  test('the census sees a new raw connection: the scan finds the sites it pins', () => {
    const kinds = new Set(sites().map((s) => s.kind));
    expect([...kinds].sort()).toEqual(['ddl', 'getConnection', 'physicalSql', 'reserve']);
  });
});
