import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SubagentResult } from '../src/core/minions/types.ts';
import { finalizeWriteAccounting } from '../src/core/minions/handlers/subagent-persistence.ts';

const result: SubagentResult = {
  result: 'I will call brain_put_page now.',
  turns_count: 1,
  stop_reason: 'end_turn',
  tokens: { in: 10, out: 5, cache_read: 0, cache_create: 0 },
};

function ledger(rows: Array<{ status: string; error: string | null; output?: unknown }>): BrainEngine {
  return { executeRaw: async () => rows } as unknown as BrainEngine;
}

describe('required-write postcondition (#5098)', () => {
  test('a clean prose-only finish cannot satisfy required writes', async () => {
    await expect(finalizeWriteAccounting(ledger([]), 1, result, { requireWrites: true }))
      .rejects.toThrow('required put_page write');
  });

  test('an unsettled write cannot satisfy required writes', async () => {
    await expect(finalizeWriteAccounting(ledger([{ status: 'pending', error: null }]), 1, result, { requireWrites: true }))
      .rejects.toThrow('required put_page write');
  });

  test('read-only and no-op jobs still finish without inferring unsupported tools', async () => {
    const actual = await finalizeWriteAccounting(ledger([]), 1, result, { requireWrites: false });
    expect(actual.stop_reason).toBe('end_turn');
    expect(actual.pages_written).toBe(0);
  });

  test('a settled successful write satisfies the postcondition', async () => {
    const actual = await finalizeWriteAccounting(ledger([{ status: 'complete', error: null }]), 1, result, { requireWrites: true });
    expect(actual.pages_written).toBe(1);
  });

  for (const output of [
    { status: 'error', error: 'Invalid YAML frontmatter', chunks: 0 },
    { status: 'error', chunks: 0 },
    { status: 'skipped', error: 'Content too large', chunks: 0 },
    JSON.stringify({ status: 'skipped', error: 'Content rejected', chunks: 0 }),
  ]) {
    test(`a historical completed rejection is a failed write: ${JSON.stringify(output)}`, async () => {
      const engine = ledger([{ status: 'complete', error: null, output }]);
      await expect(finalizeWriteAccounting(engine, 1, result, { requireWrites: true }))
        .rejects.toThrow('all 1 put_page write(s) failed');
      const optional = await finalizeWriteAccounting(engine, 1, result, { requireWrites: false });
      expect(optional.pages_attempted).toBe(1);
      expect(optional.pages_written).toBe(0);
      expect(optional.pages_failed).toBe(1);
    });
  }

  for (const output of [
    { status: 'skipped', chunks: 0 },
    { status: 'created_or_updated', embedding: { status: 'failed', error: 'Embedding unavailable' } },
    JSON.stringify({ status: 'skipped', chunks: 0 }),
  ]) {
    test(`persisted and unchanged pages remain successful: ${JSON.stringify(output)}`, async () => {
      const actual = await finalizeWriteAccounting(ledger([{ status: 'complete', error: null, output }]), 1, result, { requireWrites: true });
      expect(actual.pages_attempted).toBe(1);
      expect(actual.pages_written).toBe(1);
      expect(actual.pages_failed).toBe(0);
    });
  }

  test('historical rejects do not hide a separate successful write', async () => {
    const actual = await finalizeWriteAccounting(ledger([
      { status: 'complete', error: null, output: { status: 'error' } },
      { status: 'complete', error: null, output: { status: 'skipped' } },
      { status: 'pending', error: null, output: { status: 'error' } },
    ]), 1, result, { requireWrites: true });
    expect(actual.pages_attempted).toBe(2);
    expect(actual.pages_written).toBe(1);
    expect(actual.pages_failed).toBe(1);
  });
});
