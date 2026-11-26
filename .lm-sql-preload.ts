// Records every SQL text PGLite runs (lane LM off-is-identical proof). Text only, no parameters.
import { appendFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const out = process.env.LM_SQL_LOG!;
const proto = PGlite.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const name of ['query', 'exec']) {
  const original = proto[name];
  proto[name] = function (this: unknown, sql: unknown, ...rest: unknown[]) {
    if (typeof sql === 'string') appendFileSync(out, JSON.stringify(sql) + '\n');
    return original.call(this, sql, ...rest);
  };
}
// Statements inside a transaction run on its Transaction object, not on PGlite.prototype.
const originalTransaction = proto.transaction;
proto.transaction = function (this: unknown, callback: (tx: Record<string, (...a: unknown[]) => unknown>) => unknown) {
  return originalTransaction.call(this, (tx: Record<string, (...a: unknown[]) => unknown>) => {
    for (const name of ['query', 'exec']) {
      const original = tx[name].bind(tx);
      tx[name] = (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql === 'string') appendFileSync(out, JSON.stringify(sql) + '\n');
        return original(sql, ...rest);
      };
    }
    return callback(tx);
  });
};
