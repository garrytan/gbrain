/**
 * LHF wave 2 item 1: `executeRaw({ jitOff })` reads the server's `jit` once
 * per pool and skips the envelope when it is off; inside a transaction it
 * reads the caller's value and restores it. Real Postgres behavior is pinned
 * by test/e2e/typed-search-jit-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { needsJitOff, runJitOffStatement } from '../src/core/postgres-engine/jit-off-statement.ts';

function fakeConn(jit: string | Error) {
  const sent: string[] = [];
  const query = (text: string, rows: unknown[]) => {
    sent.push(text);
    const result = jit instanceof Error && text.includes('current_setting') ? Promise.reject(jit) : Promise.resolve(rows);
    return Object.assign(result, { execute: () => result, simple: () => ({ execute: () => result }) });
  };
  const conn = { unsafe: (text: string) => query(text, text.includes("current_setting('jit')") ? [{ jit }] : [{ ok: 1 }]) };
  return { conn: conn as never, sent };
}

describe('jitOff envelope selection', () => {
  test('the server setting is read once per pool; off skips the envelope', async () => {
    const off = fakeConn('off');
    expect(await needsJitOff(off.conn, false)).toBe(false);
    expect(await needsJitOff(off.conn, false)).toBe(false);
    const on = fakeConn('on');
    expect(await needsJitOff(on.conn, false)).toBe(true);
    expect(await needsJitOff(on.conn, false)).toBe(true);
    expect(off.sent).toEqual(["SELECT current_setting('jit') AS jit"]);
    expect(on.sent).toEqual(["SELECT current_setting('jit') AS jit"]);
  });

  test('a failed read counts as on and is retried next time', async () => {
    const failing = fakeConn(new Error('boom'));
    expect(await needsJitOff(failing.conn, false)).toBe(true);
    await Promise.resolve();
    expect(await needsJitOff(failing.conn, false)).toBe(true);
    expect(failing.sent.length).toBe(2);
  });

  test('inside a transaction the caller value decides and is restored after the statement', async () => {
    const neverRun = () => { throw new Error('run is only for signalled statements'); };
    const on = fakeConn('on');
    expect(await runJitOffStatement(on.conn, true, 'SELECT 1', [], {}, neverRun as never, () => {})).toEqual([{ ok: 1 }]);
    expect(on.sent).toEqual(["SELECT current_setting('jit') AS jit", 'SET LOCAL jit = off', 'SELECT 1', "SELECT set_config('jit', $1, true)"]);
    const off = fakeConn('off');
    let ran = 0;
    await runJitOffStatement(off.conn, true, 'SELECT 1', [], {}, (async () => { ran++; return []; }) as never, () => {});
    expect(off.sent).toEqual(["SELECT current_setting('jit') AS jit"]);
    expect(ran).toBe(1);
  });
});
