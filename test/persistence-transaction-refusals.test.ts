/**
 * Three write-journal steps run as one transaction each: claimNextWrite (head select and claim stamp), compactReceipt
 * (recheck under the row lock, then the counter release) and trueUpRequests (counter lock, then the reservation
 * compare-and-set). On an engine that serves no transaction (the Rust engine today) each step must refuse before it
 * opens one, with a refusal that names the step and why it needs a transaction, so an operator reading the receipt
 * knows which journal step stopped; the generic refusal of the `transaction` member does not say. On an engine with
 * transactions each step opens exactly its one transaction, as before.
 *
 * Real PGLite engine behind a proxy that changes only the reported capability set (and, for the true-up, the candidate
 * read), and counts how often a transaction opens.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { ENGINE_CAPABILITIES, type Capability } from '../src/core/engine-capabilities.ts';
import { claimNextWrite, compactReceipt } from '../src/core/persistence/journal.ts';
import { trueUpRequests } from '../src/core/persistence/receipt-true-up.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

const ALL_BUT_TRANSACTIONS = new Set<Capability>(ENGINE_CAPABILITIES.filter(c => c !== 'transactions'));
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000001';
/** A settled terminal request whose reservation is far above what its receipt keeps, so the true-up would shrink it. */
const CANDIDATE = {
  id: UNKNOWN_ID, intent: null, authority: null, outcome: null, error_message: null, error_detail: null, client_request_id: null,
  terminal_reservation: '100000000', principal_kind: 'local', principal_id: 'test', compacted: false, effect_bytes: '0', unfinished: false,
};

function engineReporting(capabilities: ReadonlySet<Capability>): { engine: BrainEngine; opened: () => number } {
  let opened = 0;
  const proxy = new Proxy(engine as BrainEngine, {
    get(target, prop, receiver) {
      if (prop === 'capabilities') return capabilities;
      if (prop === 'listTrueUpRequests') return async () => [CANDIDATE];
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'transaction' || prop === 'transactionDirect') {
        return (...args: unknown[]) => { opened++; return (value as (...a: unknown[]) => unknown).apply(target, args); };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: proxy, opened: () => opened };
}

const STEPS: Array<[string, (e: BrainEngine) => Promise<unknown>, unknown]> = [
  ['claimNextWrite', e => claimNextWrite(e, UNKNOWN_ID), null],
  ['compactReceipt', e => compactReceipt(e, { id: UNKNOWN_ID, principal_kind: 'local_cli', principal_id: 'test' }), { skipped: 'changed' }],
  ['trueUpRequests', e => trueUpRequests(e, [UNKNOWN_ID]), 0],
];

describe('write-journal steps that need one transaction', () => {
  for (const [step, run] of STEPS) {
    test(`${step} refuses by name before it opens a transaction on an engine that serves none`, async () => {
      const { engine: rust, opened } = engineReporting(ALL_BUT_TRANSACTIONS);
      const refusal = await run(rust).then(() => null, (e: unknown) => e as { code?: string; detail?: string });
      expect({ code: refusal?.code, detail: refusal?.detail?.replace(/ \(.*\) /, ' (why) '), opened: opened() })
        .toEqual({ code: 'engine_capability_missing', detail: `member=${step} (why) capability=transactions outcome=none written=nothing`, opened: 0 });
    });
  }

  for (const [step, run, answer] of STEPS) {
    test(`${step} opens its one transaction on an engine that serves transactions`, async () => {
      const { engine: sql, opened } = engineReporting(engine.capabilities);
      expect({ answer: await run(sql), opened: opened() }).toEqual({ answer, opened: 1 });
    });
  }
});
