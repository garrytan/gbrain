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
  const openRe = new RegExp(`^\\s+async\\s+${name}\\s*\\(`, 'm');
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
