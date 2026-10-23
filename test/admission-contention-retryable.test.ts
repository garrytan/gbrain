/**
 * The agent contract's safe-recovery rule reads a failed non-idempotent mutation as not retryable, because its outcome
 * may be unknown. A write admission that database contention kept refusing rolled its transaction back, so nothing was
 * admitted: that error proves it (`provesNotAdmitted`), and only it lifts the rule. Any other mutating error, including
 * one with the same code, detail and reason but no proof, still reads not retryable.
 */
import { describe, expect, test } from 'bun:test';
import { toAgentError, type RenderContext } from '../src/core/agent-output.ts';
import { OperationError, provesNotAdmitted } from '../src/core/ops/contract.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';

const render = (over: Partial<RenderContext> = {}): RenderContext => ({
  transport: 'stdio', isCallable: () => true, preapproved: () => false, ...over,
});

describe('a rolled-back write admission on a mutating op', () => {
  async function admissionContention(): Promise<OperationError> {
    const error = await retryWriteAdmission('req-example', async () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); }, 30)
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }

  test('reads retryable on a non-idempotent mutation, because nothing was admitted', async () => {
    const error = await admissionContention();
    expect(provesNotAdmitted(error)).toBe(true);
    for (const transport of ['stdio', 'cli'] as const) {
      const env = toAgentError(error, { transport, op: 'restore_page', mutating: true, idempotent: false, render: render({ transport }) });
      expect(env).toMatchObject({ code: 'storage_error', retryable: true });
    }
  });

  test('an unknown-outcome mutating error with the same code and detail still reads not retryable', () => {
    const unknown = new OperationError('storage_error', 'write failed mid-flight', 'Read the receipt before resubmitting.');
    unknown.writeError = 'storage_error'; unknown.detail = 'database_contention'; unknown.reason = 'database_contention';
    expect(provesNotAdmitted(unknown)).toBe(false);
    for (const outcome of ['unknown', undefined] as const) {
      const env = toAgentError(unknown, { transport: 'stdio', op: 'restore_page', mutating: true, idempotent: false, ...(outcome ? { outcome } : {}), render: render() });
      expect(env.retryable).toBe(false);
    }
  });
});
