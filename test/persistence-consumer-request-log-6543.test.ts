/**
 * #6543 F1: the consumer's `[persistence] phase=` line names the request it is about. Two requests failing
 * the same phase in the same tick each get their own line carrying request_id, principal, slug and
 * elapsed_ms; a repeat of the same request's failure inside the throttle window stays one line.
 *
 * Regression that fails it: a throttle keyed only on phase and code (the second request's line is
 * dropped), or a line without the request identity.
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { admission, fixtures, initializeFixtures, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-consumer-request-log-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 6543, schedules: 0, operations: 0,
  sourceIds: ['request-log-a', 'request-log-b'], principalIds: [randomUUID()],
};
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let engine: PGLiteEngine;
const stderr: string[] = [];
let spy: ReturnType<typeof spyOn> | undefined;

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => { spy?.mockRestore(); spy = undefined; stderr.length = 0; });

test('two requests failing the same phase in one tick each log a line naming the request', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const first = await admitWrite(engine, admission(config, sources[0], 'request-log/first', 'first body'));
  const second = await admitWrite(engine, admission(config, sources[1], 'request-log/second', 'second body'));
  spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => {
    throw Object.assign(new Error('synthetic preparer failure'), { code: 'storage_error' });
  }, { hostId: config.hostId, pollMs: 20 });
  try {
    consumer.start();
    await waitFor(async () => (await getWriteRequestById(engine, first.id))?.state === 'failed'
      && (await getWriteRequestById(engine, second.id))?.state === 'failed', { timeoutMs: 5_000 });
  } finally { await consumer.stop(); }
  const lines = stderr.filter(entry => entry.startsWith('[persistence] phase=preparation'));
  for (const row of [first, second]) {
    const line = lines.find(entry => entry.includes(`request_id=${row.request_id}`));
    expect(line).toBeDefined();
    expect(line).toContain(`slug=${row.slug}`);
    expect(line).toContain(`source=${row.source_id}`);
    expect(line).toContain('operation=put_page');
    expect(line).toContain('principal=local_cli');
    expect(line).toMatch(/elapsed_ms=\d+/);
  }
  expect(lines.length).toBe(2);
}), 15_000);

test('the same request failing the same phase again inside the window stays one line', async () => {
  spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { throw new Error('unused'); }, { hostId: randomUUID() });
  const row = { id: randomUUID(), request_id: randomUUID(), principal_kind: 'local_cli', operation: 'put_page', source_id: 's', slug: 'a/b', created_at: new Date() };
  const log = (consumer as unknown as { log(phase: string, code: string, detail?: string, timing?: string, row?: unknown): void }).log.bind(consumer);
  log('publication', 'storage_error', 'boom', '', row);
  log('publication', 'storage_error', 'boom', '', row);
  log('publication', 'storage_error', 'boom', '', { ...row, id: randomUUID(), request_id: randomUUID() });
  expect(stderr.filter(entry => entry.includes(`request_id=${row.request_id}`)).length).toBe(1);
  expect(stderr.length).toBe(2);
  await consumer.stop();
});
