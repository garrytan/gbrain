/**
 * #6543 (A4): the in-flight budget is derived per statement from the
 * statement_timeout its operation declared on the connection, read by the
 * vendored driver from the statements it sends (so it holds behind a
 * transaction-mode pooler that never applies a session SET).
 *
 * The guard below fails CI when gbrain code raises (or lifts) a statement
 * timeout in a form the driver cannot read: that statement would keep the
 * pool's budget and be retired as stuck while its own timeout still runs.
 * Regression that fails it on master: `Connection.statementTimeoutChanges`
 * does not exist, and `poolHealthOptions` sets no age cap.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { poolHealthOptions } from '../src/core/db.ts';
import { withEnv } from './helpers/with-env.ts';

type Change = { kind: 'set'; local: boolean; ms: number | undefined } | { kind: 'reset' | 'end' | 'unknown' };
const { default: Connection } = await import(new URL('../vendor/postgres/src/connection.js', import.meta.url).href) as { default: { statementTimeoutChanges: (text: string, parameters?: unknown[]) => Change[] } };
const changes = Connection.statementTimeoutChanges;

describe('statementTimeoutChanges: what one statement does to the connection statement_timeout', () => {
  test('SET [LOCAL|SESSION] statement_timeout with units, quotes, TO and DEFAULT', () => {
    expect(changes("SET LOCAL statement_timeout = '600s'")).toEqual([{ kind: 'set', local: true, ms: 600_000 }]);
    expect(changes('SET statement_timeout = 0')).toEqual([{ kind: 'set', local: false, ms: 0 }]);
    expect(changes("SET SESSION statement_timeout TO '2min'")).toEqual([{ kind: 'set', local: false, ms: 120_000 }]);
    expect(changes("set local statement_timeout='10s'")).toEqual([{ kind: 'set', local: true, ms: 10_000 }]);
    expect(changes('SET LOCAL statement_timeout = 60000')).toEqual([{ kind: 'set', local: true, ms: 60_000 }]);
    expect(changes('SET statement_timeout TO DEFAULT')).toEqual([{ kind: 'set', local: false, ms: undefined }]);
    expect(changes("SET LOCAL statement_timeout = 'soon'")).toEqual([{ kind: 'unknown' }]);
  });

  test('set_config with literal or bound values, local or session', () => {
    expect(changes("SELECT set_config('statement_timeout', $1, true)", ['8s'])).toEqual([{ kind: 'set', local: true, ms: 8_000 }]);
    expect(changes("SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)")).toEqual([{ kind: 'set', local: true, ms: 5_000 }]);
    expect(changes("SELECT set_config('statement_timeout', '0', false)")).toEqual([{ kind: 'set', local: false, ms: 0 }]);
    expect(changes("SELECT set_config('statement_timeout', $1, true)", [])).toEqual([{ kind: 'unknown' }]);
  });

  test('transaction boundaries, RESET and DISCARD; dollar-quoted bodies are not boundaries', () => {
    expect(changes("BEGIN; SET LOCAL statement_timeout = 250")).toEqual([{ kind: 'end' }, { kind: 'set', local: true, ms: 250 }]);
    expect(changes('commit')).toEqual([{ kind: 'end' }]);
    expect(changes('ROLLBACK')).toEqual([{ kind: 'end' }]);
    expect(changes('ROLLBACK TO SAVEPOINT s1')).toEqual([]);
    expect(changes('RESET statement_timeout')).toEqual([{ kind: 'reset' }]);
    expect(changes('RESET ALL')).toEqual([{ kind: 'reset' }]);
    expect(changes('DISCARD ALL')).toEqual([{ kind: 'reset' }]);
    expect(changes("DO $$ BEGIN PERFORM set_config('statement_timeout','0',false); END $$")).toEqual([]);
    expect(changes("SELECT CASE WHEN true THEN 1 END FROM pages")).toEqual([]);
  });
});

describe('poolHealthOptions: one budget caps both silence and total age', () => {
  test('inflight_max equals inflight_timeout, inflight_grace is the grace in seconds, and grace off disables both', () => {
    withEnv({ GBRAIN_PG_STUCK_GRACE_MS: '2000' }, () => {
      const options = poolHealthOptions(undefined, '3000');
      expect(options.inflight_timeout).toBe(5);
      expect(options.inflight_max).toBe(5);
      expect(options.inflight_grace).toBe(2);
    });
    withEnv({ GBRAIN_PG_STUCK_GRACE_MS: 'off' }, () => {
      const options = poolHealthOptions(undefined, '3000');
      expect(options.inflight_timeout).toBeNull();
      expect(options.inflight_max).toBeNull();
      expect(options.inflight_grace).toBeNull();
    });
  });
});

const ROOT = join(import.meta.dir, '..', 'src');
const RAISER = /set_config\s*\(\s*'statement_timeout'|\bSET\s+(?:LOCAL\s+|SESSION\s+)?statement_timeout\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** The SQL string literal on `line` that holds the statement_timeout change: a tagged template's interpolations are bind parameters ($1, $2, …), any other interpolation is spliced text, read as a number. */
function sqlLiteral(line: string): string {
  const at = line.search(RAISER);
  const before = line.slice(0, at);
  const open = Math.max(before.lastIndexOf('`'), before.lastIndexOf('"'));
  let literal: string;
  if (open >= 0) {
    const end = line.indexOf(line[open]!, at);
    literal = line.slice(open + 1, end > 0 ? end : undefined);
  } else if (line.indexOf('`', at) > 0) {
    literal = line.slice(0, line.indexOf('`', at));
  } else {
    const end = line.indexOf("'", at);
    literal = line.slice(before.lastIndexOf("'") + 1, end > 0 ? end : undefined);
  }
  if (open >= 0 && line[open] === '`' && /[\w$]$/.test(before.slice(0, open))) {
    let n = 0;
    return literal.replace(/\$\{[^}]*\}/g, () => `$${++n}`);
  }
  return literal.replace(/\$\{[^}]*\}/g, '1000');
}

/** A literal that reads as SQL (prose that names the setting, such as an error message, is not a change). */
const isSql = (literal: string) => /^\s*(SET|SELECT|BEGIN|START|WITH|set_config)\b/i.test(literal);

/** Why the driver cannot read this statement_timeout change, or null when it can. */
function unreadable(literal: string): string | null {
  const found = changes(literal, Array.from({ length: 9 }, () => '1000'));
  if (!found.some(c => c.kind === 'set')) return 'no statement_timeout change the driver can read';
  if (found.some(c => c.kind === 'unknown')) return 'a statement_timeout value the driver cannot read';
  return null;
}

describe('guard: every statement_timeout change in gbrain reaches the driver budget', () => {
  test('the guard itself flags a change the driver cannot read', () => {
    expect(unreadable(sqlLiteral(`await tx.executeRaw("SELECT set_config('statement_timeout', current_setting('app.t'), true)");`))).not.toBeNull();
    expect(unreadable(sqlLiteral(`await tx.executeRaw("SET LOCAL statement_timeout = 'later'");`))).not.toBeNull();
    expect(unreadable(sqlLiteral("await conn.executeRaw(`SET LOCAL statement_timeout = '${perBatchTimeoutSec}s'`);"))).toBeNull();
    expect(sqlLiteral("await tx`SELECT set_config('statement_timeout', ${statementTimeout}, true)`;")).toBe("SELECT set_config('statement_timeout', $1, true)");
    expect(unreadable(sqlLiteral("await tx`SELECT set_config('statement_timeout', ${statementTimeout}, true)`;"))).toBeNull();
    expect(unreadable(sqlLiteral("await tx`SELECT set_config('statement_timeout', ${statementTimeout}, ${local})`;"))).toBeNull();
  });

  test('no src/ path raises or lifts statement_timeout in a form the per-statement budget misses', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!RAISER.test(line) || /^(\/\/|\*|\/\*)/.test(trimmed)) return;
        if (/\bALTER\s+(ROLE|DATABASE|SYSTEM)\b/i.test(line)) return;
        const literal = sqlLiteral(line);
        if (!isSql(literal)) return;
        seen += 1;
        const why = unreadable(literal);
        if (why) offenders.push(`${relative(join(ROOT, '..'), file)}:${i + 1}: ${why}: ${trimmed}`);
      });
    }
    expect(seen).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
