import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { readExportWithdrawals } from '../src/core/export-snapshot.ts';
import { EXPORT_PAYLOAD_LIMIT } from '../src/core/export-stage.ts';
import { listExportWithdrawals, readExportWithdrawalLedgerBytes } from '../src/core/engine-sql/export-reads.ts';

// The export reads the ledger through two engine members; these run the members' own SQL against a scripted executeRaw.
function ledgerEngine(executeRaw: (sql: string, params: unknown[]) => Promise<unknown[]>): BrainEngine {
  const raw = { executeRaw } as never;
  return {
    readExportWithdrawalLedgerBytes: (sourceId: string) => readExportWithdrawalLedgerBytes(raw, sourceId),
    listExportWithdrawals: (sourceId: string) => listExportWithdrawals(raw, sourceId),
  } as unknown as BrainEngine;
}

test('export refuses an over-limit withdrawal ledger before fetching its payload', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const engine = ledgerEngine(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return [{ bytes: EXPORT_PAYLOAD_LIMIT + 1 }];
  });
  await expect(readExportWithdrawals(engine, 'synthetic-source')).rejects.toThrow('withdrawal ledger capacity');
  expect(calls).toHaveLength(1);
  expect(calls[0].sql).toContain('sum(octet_length(');
  expect(calls[0].params).toEqual(['synthetic-source']);
});

test('export accepts the exact ledger limit and keeps both reads source scoped', async () => {
  const params: unknown[][] = [];
  const ledger = [{ visibility: 'world' as const, fact_hash: 'synthetic-fingerprint', withdrawn_at: '2026-01-01T00:00:00Z', subject: '*' }];
  const engine = ledgerEngine(async (_sql: string, bound: unknown[]) => {
    params.push(bound);
    return params.length === 1 ? [{ bytes: String(EXPORT_PAYLOAD_LIMIT) }] : ledger;
  });
  expect(await readExportWithdrawals(engine, 'synthetic-source')).toEqual(ledger);
  expect(params).toEqual([['synthetic-source'], ['synthetic-source']]);
});

test('export ledger size-read failure never proceeds to the unbounded payload read', async () => {
  let calls = 0;
  const engine = ledgerEngine(async () => { calls++; throw new Error('synthetic read failure'); });
  await expect(readExportWithdrawals(engine, 'synthetic-source')).rejects.toThrow('synthetic read failure');
  expect(calls).toBe(1);
});

test('an empty withdrawal ledger remains an explicit empty snapshot', async () => {
  let calls = 0;
  const engine = ledgerEngine(async () => ++calls === 1 ? [{ bytes: 2 }] : []);
  expect(await readExportWithdrawals(engine, 'synthetic-source')).toEqual([]);
  expect(calls).toBe(2);
});
