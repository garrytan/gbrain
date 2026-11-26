/**
 * `labelledOnlyFor` (src/core/access/labelled-only.ts) surfaces a refused member read instead of answering for it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when the engine refuses the typed member read the check makes (engine_capability_missing), the check
 *    rejects with that refusal. It never turns the refusal into an answer (labelled-only "yes" or "no").
 *  - Regression: the check caught every failure and answered "yes", so a Rust brain, which refused the raw read it made,
 *    marked every bound member labelled-only without saying why.
 *  - Why existing coverage misses it: the parity case (test/engine-parity/labelled-only-for.test.ts) checks answers, not
 *    a refusal.
 *  - Seam: the refusal is injected at the typed member the check calls (hasLabelledOnlyMemberAmong), never at statement text.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addMember } from '../src/core/access/members.ts';
import { labelledOnlyFor } from '../src/core/access/labelled-only.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await addMember(engine, 'bob-example', { remote: false });
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

/** The engine with `hasLabelledOnlyMemberAmong` refused as an engine without access members would refuse it. */
function refusingMembers(base: BrainEngine): BrainEngine {
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key === 'hasLabelledOnlyMemberAmong') return async () => { throw capabilityMissing('access_control', 'hasLabelledOnlyMemberAmong'); };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('labelledOnlyFor and a refused member read', () => {
  test('the refusal surfaces; it is never read as labelled-only or as not labelled-only', async () => {
    const error = await labelledOnlyFor(refusingMembers(engine), [['member:bob-example']]).then(() => null, (e: unknown) => e);
    expect((error as { code?: string } | null)?.code).toBe('engine_capability_missing');
    expect(String((error as Error).message)).toContain('hasLabelledOnlyMemberAmong');
  });

  test('a caller with no member reads nothing and is not labelled-only', async () => {
    expect(await labelledOnlyFor(refusingMembers(engine), [['token:x']])).toBe(false);
  });
});
