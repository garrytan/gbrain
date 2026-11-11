/**
 * GST-2422: the PGLite statement counter names a statement the engine's cache prepared before counting started.
 *
 * Protects: test/helpers/statement-counter.ts `countPgliteStatements`. pglite-statements.ts prepares a statement the
 * second time it runs and binds it by name from then on. A Bind whose Parse ran before the counter started used to take
 * the text of the statement before it, so a golden comparison (test/fold-hook-noop-6712.test.ts) failed whenever
 * something read config twice before its window: `SELECT value FROM config WHERE key = $1` came out as the
 * write-context `set_config` that preceded it.
 * Fails when: a statement prepared before `countPgliteStatements` starts is recorded with any text but its own.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countPgliteStatements } from './helpers/statement-counter.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine?.disconnect(); });

test('a statement prepared before counting starts is recorded with its own text', async () => {
  await engine.getConfig('gst2422.warm');
  await engine.getConfig('gst2422.warm');
  const counter = countPgliteStatements(engine);
  try {
    await engine.executeRaw("SELECT set_config('gst2422.before',$1,true)", ['x']);
    await engine.getConfig('gst2422.warm');
  } finally { counter.stop(); }
  expect(counter.records.filter(record => record.kind === 'execute').map(record => record.sql))
    .toEqual(["SELECT set_config('gst2422.before',$1,true)", 'SELECT value FROM config WHERE key = $1']);
});
