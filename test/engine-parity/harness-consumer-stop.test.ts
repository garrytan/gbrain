/**
 * BrainEngine parity — the harness stops the write queue after every case, on every arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a write operation starts a persistence consumer keyed on the engine object the case received (the
 *    harness's recording wrapper). When a parity case ends on an arm, the harness has stopped that consumer, and the
 *    one keyed on the arm's own engine, before the next case's reset starts. So no queued projection or effect work runs
 *    into a reset. Observed through persistenceConsumerStatus (service.ts): `not_running` for every engine object the
 *    cases used, on every arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the reset did not stop the consumer of the engine the case received, so its projection and effect work
 *    ran into the next case's reset: a Postgres deadlock on `DELETE FROM sources` in 1 of 10 stress runs of
 *    slug-normalize.test.ts, which stopped it by hand in a wrapper of its own (as repair-frontmatter-holds.test.ts does).
 *  - Why existing coverage misses it: the cases that write all pass or fail on their own answers; nothing looks at what
 *    the harness leaves running between two cases.
 *  - Seam: none. The remember handler runs whole, on the arm's engine, with the consumer it starts. The check reads the
 *    consumer's state in an afterEach hook, which runs after the harness's own cleanup and before the next case's reset.
 *    The brain is keyless, as in remember-whole.test.ts; the preload's gateway config comes back after the file.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer, persistenceConsumerStatus } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const suite = parityArms(testBackends());
const { parityTest } = suite;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Every engine object a case wrote through, with the arm it ran on. */
const received: Array<{ backend: ParityBackend; engine: BrainEngine }> = [];
/** What each consumer was doing the moment its case had ended, before the next reset. */
const afterCase: Array<{ case: string; backend: ParityBackend; engine: 'received' | 'arm'; state: string }> = [];
let caseName = '';

afterEach(() => {
  const arms = suite.arms();
  for (const { backend, engine } of received.splice(0)) {
    afterCase.push({ case: caseName, backend, engine: 'received', state: persistenceConsumerStatus(engine).state });
    const arm = arms.find((a) => a.backend === backend);
    if (arm) afterCase.push({ case: caseName, backend, engine: 'arm', state: persistenceConsumerStatus(arm.engine).state });
  }
});

afterAll(async () => {
  // Whatever a failing run left behind must not outlive the file.
  for (const arm of suite.arms()) await disposePersistenceConsumer(arm.engine).catch(() => undefined);
  resetGateway();
});

async function rememberOne(engine: BrainEngine, fact: string): Promise<string> {
  configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
  const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
  const r = await operationsByName.remember.handler(ctx, { fact, provenance: 'parity notes 2026-11-21', request_id: randomUUID() }) as Record<string, unknown>;
  expect(await engine.getPage('memory/unattributed')).not.toBeNull();
  return String(((r.outcome ?? r) as Record<string, unknown>).status);
}

describe('engine parity: the harness stops the write queue after every case', () => {
  for (const name of ['first write case', 'second write case']) {
    parityTest(`${name}: a remember starts a consumer and the harness has stopped it when the case ends`, { methods: ['getPage'], timeout: 180_000 }, async (engine, backend) => {
      caseName = name;
      received.push({ backend, engine });
      // The consumer starts with the write, and is running while the case still holds the engine.
      const status = await rememberOne(engine, `The harness stop example fact for the ${name}.`);
      expect(persistenceConsumerStatus(engine).state).toBe('open');
      return { status };
    });
  }

  test('no consumer was left running after either case, on any arm', () => {
    const arms = suite.arms().map((a) => a.backend);
    // Both cases looked at the received engine and the arm's own engine, once per arm.
    expect(afterCase.length).toBe(2 * 2 * arms.length);
    const running = afterCase.filter((row) => row.state !== 'not_running');
    expect({ checked: afterCase.length, running: running.length, rows: running }).toEqual({ checked: afterCase.length, running: 0, rows: [] });
  });
});
