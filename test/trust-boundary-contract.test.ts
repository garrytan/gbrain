/**
 * Trust-boundary contract regression tests (F7b).
 *
 * Pins the fail-closed semantics on `ctx.remote`. After v0.27 the field is
 * REQUIRED in the TypeScript type, but consumer code MUST still treat any
 * value that isn't strictly `false` as remote/untrusted. This is the runtime
 * defense-in-depth for the case where a context is constructed via `as` cast
 * or `Partial<>` spread and `remote` ends up undefined despite the type.
 *
 * The bug class this guards against: a future transport (HTTP/2, WebSocket,
 * a third-party plugin) inlines its own OperationContext literal and forgets
 * to set `remote`. Without these tests, the type system's compile-time check
 * is the only line of defense, and any `as OperationContext` cast bypasses
 * it.
 */

import { describe, expect, test } from 'bun:test';
import {
  operations,
  type Operation,
  type OperationContext,
} from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const submit_job = operations.find(o => o.name === 'submit_job') as Operation;
if (!submit_job) throw new Error('submit_job operation missing');

// Stub engine — submit_job's protected-name guard fires before any DB call,
// so the engine handle is never read on the rejection path.
const stubEngine = {} as BrainEngine;
const stubLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Construct an OperationContext with `remote` deliberately undefined despite
 * the type system saying it's required. Mimics what would happen if a future
 * transport inlines its own context literal and forgets the field.
 */
function castUndefinedRemoteCtx(): OperationContext {
  return {
    engine: stubEngine,
    config: { engine: 'pglite' } as any,
    logger: stubLogger,
    dryRun: false,
    // remote intentionally omitted; cast through unknown to bypass the type
  } as unknown as OperationContext;
}

describe('F7b — trust-boundary contract fail-closed semantics', () => {
  test('protected job submission rejected when remote is undefined (cast bypass)', async () => {
    const ctx = castUndefinedRemoteCtx();
    await expect(
      submit_job.handler(ctx, { name: 'shell', data: { cmd: 'id' } })
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('protected job submission rejected when remote is true', async () => {
    const ctx = { ...castUndefinedRemoteCtx(), remote: true } as OperationContext;
    await expect(
      submit_job.handler(ctx, { name: 'shell', data: { cmd: 'id' } })
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('protected job submission ALLOWED only when remote is strictly false', async () => {
    const ctx = { ...castUndefinedRemoteCtx(), remote: false } as OperationContext;
    // The handler now passes the protected-name guard and continues into the
    // queue. We don't actually want to enqueue anything in a unit test, so
    // we expect the call to fail at a LATER point (engine.executeRaw on the
    // stub). That's fine — what we're proving is that the guard does NOT
    // throw `permission_denied`, which is the failure mode we'd see if F7b
    // regressed back to a falsy check that treated remote=false as remote.
    await expect(
      submit_job.handler(ctx, { name: 'shell', data: { cmd: 'id' } })
    ).rejects.not.toMatchObject({ code: 'permission_denied' });
  });

  test('non-protected job names always allowed regardless of remote', async () => {
    // 'default-noop' is not in PROTECTED_JOB_NAMES. The protected-name guard
    // skips entirely, so we again get a downstream stub-engine error.
    const cases: OperationContext[] = [
      castUndefinedRemoteCtx(),
      { ...castUndefinedRemoteCtx(), remote: true } as OperationContext,
      { ...castUndefinedRemoteCtx(), remote: false } as OperationContext,
    ];
    for (const ctx of cases) {
      await expect(
        submit_job.handler(ctx, { name: 'noop-job', data: {} })
      ).rejects.not.toMatchObject({ code: 'permission_denied' });
    }
  });
});
