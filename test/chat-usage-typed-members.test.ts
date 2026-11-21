/**
 * The chat usage ledger runs through typed engine members, never `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `get_usage` reads the window and the first logged time through `readChatUsage` (records come in through
 *    `logChatUsage`; the engine sink that calls it is not in this cut). The read runs no raw ledger statement, so an engine
 *    that refuses raw SQL (the Rust engine) still reports the ledger.
 *  - Regression: a caller that goes back to `executeRaw` fails here, because the engine below refuses every raw
 *    statement that names chat_usage_log with the Rust engine's refusal.
 *  - Why existing coverage misses it: test/chat-usage.test.ts runs the sink and the op on a plain PGLite engine, where
 *    the raw statements succeed.
 *  - Seam: a real PGLite brain behind a Proxy that refuses raw SQL on the ledger table only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { usageOperations } from '../src/core/ops/usage.ts';

let pglite: PGLiteEngine;
let rawLedgerStatements = 0;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
}, 60_000);

afterAll(async () => { await pglite.disconnect(); });

/** PGLite, except that executeRaw refuses every statement naming chat_usage_log, as the Rust engine refuses raw SQL. */
function noRawLedger(): BrainEngine {
  return new Proxy(pglite, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (/\bchat_usage_log\b/.test(sql)) {
            rawLedgerStatements++;
            throw capabilityMissing('raw_sql', 'executeRaw');
          }
          return target.executeRaw(sql, params);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

function opCtx(engine: BrainEngine): OperationContext {
  return { engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false, remote: false, sourceId: 'default' } as OperationContext;
}

describe('the chat usage ledger runs on typed members', () => {
  test('get_usage reads the ledger with no raw ledger statement', async () => {
    const engine = noRawLedger();
    const sink = (record: Parameters<BrainEngine['logChatUsage']>[0]) => engine.logChatUsage(record);
    await sink({ model: 'acme:model-a', provider: 'acme', phase: 'job:dream', input_tokens: 10, output_tokens: 20,
      cache_read_tokens: 1, cache_write_tokens: 2, cost_usd: 0.5 });
    await sink({ model: 'acme:model-a', provider: 'acme', phase: null, input_tokens: 5, output_tokens: 5,
      cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null });
    const getUsage = usageOperations.find((op) => op.name === 'get_usage')!;
    const out = await getUsage.handler(opCtx(engine), { days: 7 }) as {
      totals: { calls: number; input_tokens: number; cost_usd: number };
      coverage: { table_present: boolean; logged_since: string | null; priced_calls: number; unpriced_calls: number };
    };
    expect(rawLedgerStatements).toBe(0);
    expect(out.totals.calls).toBe(2);
    expect(out.totals.input_tokens).toBe(15);
    expect(out.totals.cost_usd).toBe(0.5);
    expect(out.coverage.table_present).toBe(true);
    expect(out.coverage.logged_since).not.toBeNull();
    expect({ priced: out.coverage.priced_calls, unpriced: out.coverage.unpriced_calls }).toEqual({ priced: 1, unpriced: 1 });
  });
});
