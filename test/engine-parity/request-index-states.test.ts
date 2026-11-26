/**
 * BrainEngine parity: the online-built request index read (readRequestIndexStates, engine-sql/doctor-persistence.ts) and
 * the two callers a Rust brain reaches: doctor `persistence_request_indexes` and the page purge's preparation.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the default online-built indexes read valid on PGLite, Postgres (DATABASE_URL, en_US.utf8) and Rust
 *    (GBRAIN_TEST_RUST_ARM=1), in the given order, and doctor's check says so the same way on every arm.
 *  - Regression: the read ran raw SQL (Postgres) or a different probe (PGLite) in checkpoint-validation.ts, and on Rust a
 *    capability branch; the purge path listed it as a raw-SQL stop, so every `delete_page --purge` on a Rust brain
 *    refused at it first (test/engine-parity/page-purge.test.ts pins the shrunk list).
 *  - Why existing coverage misses it: test/persistence-sync-checkpoint-validation.test.ts and the e2e index tests run
 *    the read on PGLite or Postgres only.
 *  - Seam: none; the engine's own schema provides the indexes.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { readRequestIndexStates } from '../../src/core/persistence/checkpoint-validation.ts';
import { requestIndexesCheck } from '../../src/commands/doctor/checks/persistence-requests.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: request index states', () => {
  parityTest('the online-built request indexes read valid, in order, and doctor persistence_request_indexes reports them healthy', {
    methods: ['readRequestIndexStates'],
  }, async (engine) => {
    const states = await readRequestIndexStates(engine);
    const raw = await engine.readRequestIndexStates(states.map(s => s.name).reverse());
    const check = await requestIndexesCheck(engine);
    const out = { states, rawNames: raw.map(r => r.name), rawValid: raw.map(r => r.valid), check: { name: check.name, status: check.status } };
    expect(states.length).toBeGreaterThan(0);
    expect(states.every(s => s.state === 'valid')).toBe(true);
    expect(out.rawNames).toEqual(states.map(s => s.name).reverse());
    expect(out.check.status).toBe('ok');
    return out;
  });
});
