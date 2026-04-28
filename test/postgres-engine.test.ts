/**
 * postgres-engine.ts source-level guardrails.
 *
 * Live Postgres coverage for search paths lives in test/e2e/search-quality.test.ts.
 * This file stays fast and DB-free: it inspects the source of
 * src/core/postgres-engine.ts to lock in decisions that protect the
 * shared connection pool from per-request GUC leaks.
 *
 * Regression: R6-F006 / R4-F002.
 * searchKeyword and searchVector used to call bare
 *   await sql`SET statement_timeout = '8s'`
 *   ...query...
 *   finally { await sql`SET statement_timeout = '0'` }
 * against the shared pool. Each tagged template picks an arbitrary
 * connection, so the SET, the query, and the reset could all land on
 * DIFFERENT connections. Worst case: the 8s GUC sticks on some pooled
 * connection and clips the next caller's long-running query; or the
 * reset to 0 lands on a connection that other code expected to be
 * protected. The fix wraps each query in sql.begin() and uses
 * SET LOCAL so the GUC is transaction-scoped and auto-resets on
 * COMMIT/ROLLBACK, regardless of error path.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'core', 'postgres-engine.ts'),
  'utf-8',
);

describe('postgres-engine / search path timeout isolation', () => {
  test('no bare `SET statement_timeout` statement survives', () => {
    // Strip comments so the commentary mentioning the anti-pattern does
    // not trigger a false positive. Block-comment + line-comment strip.
    const stripped = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');

    // Match a tagged-template statement of the form
    //   sql`SET statement_timeout = ...`
    // that is NOT preceded by LOCAL. This is the exact shape that bleeds
    // onto pooled connections; SET LOCAL is safe inside a transaction.
    const bare = stripped.match(
      /sql`\s*SET\s+(?!LOCAL\s)statement_timeout\b[^`]*`/gi,
    );
    expect(bare).toBeNull();
  });

  test('searchKeyword wraps its query in sql.begin()', () => {
    const fn = extractMethod(SRC, 'searchKeyword');
    expect(fn).toMatch(/sql\.begin\s*\(\s*async\s+sql\s*=>/);
  });

  test('searchVector wraps its query in sql.begin()', () => {
    const fn = extractMethod(SRC, 'searchVector');
    expect(fn).toMatch(/sql\.begin\s*\(\s*async\s+sql\s*=>/);
  });

  test('both search methods use SET LOCAL for the timeout', () => {
    const keyword = extractMethod(SRC, 'searchKeyword');
    const vector = extractMethod(SRC, 'searchVector');
    expect(keyword).toMatch(/SET\s+LOCAL\s+statement_timeout/);
    expect(vector).toMatch(/SET\s+LOCAL\s+statement_timeout/);
  });

  test('connect() with poolSize honors resolvePrepare (PgBouncer regression guard)', () => {
    // Regression: worker-instance pools were NOT honoring the prepare decision
    // before v0.15.4. Module singleton connect() in db.ts was fixed by #284 but
    // PostgresEngine.connect({poolSize}) (the branch used by `gbrain jobs work`)
    // silently ignored it — agents running background work against Supabase
    // pooler URLs still hit `prepared statement "..." does not exist` under
    // load. Source-level grep is enough: runtime mocking of postgres.js's
    // tagged-template interface is painful under bun ESM and the wiring is
    // simple enough that if `resolvePrepare` name appears and a conditional
    // `prepare` key appears in the options literal, the wire-up is live.
    const stripped = stripComments(SRC);
    expect(stripped).toMatch(/db\.resolvePrepare\s*\(\s*url\s*\)/);
    expect(stripped).toMatch(/typeof\s+prepare\s*===\s*['"]boolean['"]/);
  });

  test('neither search method clears the timeout with `SET statement_timeout = 0`', () => {
    // The reset-to-zero pattern was the other half of the leak: if SET
    // LOCAL is in play, COMMIT handles the reset and an explicit
    // `SET statement_timeout = '0'` would itself leak the GUC change
    // onto the returned connection. Strip comments first so the
    // commentary in the method itself (which quotes the anti-pattern
    // to explain it) does not trigger a false positive.
    const keyword = stripComments(extractMethod(SRC, 'searchKeyword'));
    const vector = stripComments(extractMethod(SRC, 'searchVector'));
    expect(keyword).not.toMatch(/SET\s+statement_timeout\s*=\s*['"]?0/);
    expect(vector).not.toMatch(/SET\s+statement_timeout\s*=\s*['"]?0/);
  });
});

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// extractMethod grabs the body of a class method by brace-matching from
// its opening line. Returns the method body up to the matching closing
// brace. Good enough for the small number of methods in this file.
function extractMethod(source: string, name: string): string {
  // Find "async <name>(" at method-definition indentation (2 spaces).
  // Accept an optional generic parameter list (`async transaction<T>(...)`).
  const openRe = new RegExp(`^\\s+async\\s+${name}(?:\\s*<[^>]+>)?\\s*\\(`, 'm');
  const match = openRe.exec(source);
  if (!match) {
    throw new Error(`method ${name} not found in postgres-engine.ts`);
  }
  // Scan forward balancing braces.
  let i = source.indexOf('{', match.index);
  if (i < 0) throw new Error(`no opening brace for ${name}`);
  const start = i;
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/**
 * Supabase pooler (PgBouncer transaction mode, port 6543) silently strips
 * connection-level statement_timeout startup parameters and session-scoped
 * SET. Only `SET LOCAL` inside an explicit transaction survives. Without
 * this, schema bootstrap, migrations, and put_page write paths silently
 * hit the pooler's 2-min default — visible as "canceling statement due to
 * statement timeout" with no other context.
 *
 * These guardrails lock in the SET LOCAL placement so a future refactor
 * doesn't regress the fix. DB-free — pure source inspection.
 */
describe('postgres-engine / pooler timeout compatibility', () => {
  test('runMigration prepends SET LOCAL statement_timeout = 0', () => {
    const fn = stripComments(extractMethod(SRC, 'runMigration'));
    // Must contain SET LOCAL prefix concatenated before the migration sqlStr.
    expect(fn).toMatch(/SET\s+LOCAL\s+statement_timeout\s*=\s*0\s*;[\s\S]*\+\s*sqlStr/);
  });

  test('runMigration does not use a bare SET (would leak across pooled connections)', () => {
    const fn = stripComments(extractMethod(SRC, 'runMigration'));
    expect(fn).not.toMatch(/[^L]\bSET\s+(?!LOCAL\s)statement_timeout/i);
  });

  test('initSchema wraps SCHEMA_SQL in a conn.begin() transaction', () => {
    const fn = extractMethod(SRC, 'initSchema');
    expect(fn).toMatch(/conn\.begin\s*\(\s*async\s*\(\s*tx\s*\)\s*=>/);
    // SCHEMA_SQL must be inside that transaction, not a bare conn.unsafe().
    const stripped = stripComments(fn);
    expect(stripped).toMatch(/tx\.unsafe\s*\(\s*SCHEMA_SQL\s*\)/);
    expect(stripped).not.toMatch(/conn\.unsafe\s*\(\s*SCHEMA_SQL\s*\)/);
  });

  test('initSchema sets SET LOCAL statement_timeout = 0 inside the SCHEMA_SQL transaction', () => {
    const fn = extractMethod(SRC, 'initSchema');
    expect(fn).toMatch(/SET\s+LOCAL\s+statement_timeout\s*=\s*0/);
  });

  test('transaction() sets SET LOCAL statement_timeout = 0 before the user callback', () => {
    const fn = extractMethod(SRC, 'transaction');
    expect(fn).toMatch(/tx\.unsafe\s*\(\s*['"]SET LOCAL statement_timeout = 0['"]\s*\)/);
    // Ordering: SET must be issued before fn(txEngine) so user code runs
    // under the loosened timeout. Verify by source position.
    const setIdx = fn.search(/SET\s+LOCAL\s+statement_timeout/);
    const callIdx = fn.search(/fn\s*\(\s*txEngine\s*\)/);
    expect(setIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(callIdx);
  });
});
