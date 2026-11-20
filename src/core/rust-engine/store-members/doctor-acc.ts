/**
 * Doctor reads, second set (src/core/engine-sql/doctor-acc.ts). The chronicle ledger rollup is served by the store's
 * chronicle rows and reservations (`readChronicleLedger`, rust/docs/store/chronicle-ledger.md), shaped as the SQL
 * engines shape their four statements.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

interface StoreChronicleLedger {
  counts: { pending: number; extracted: number; failed: number; skipped: number; known_usd: number | null; unpriced: number; incomplete: number };
  reasons: Array<{ state: string; reason: string; n: number }>;
  calls: number;
  principals: Array<{ principal: string; calls: number }>;
}

export const readChronicleLedgerStats: Member<'readChronicleLedgerStats'> = async (brain) => {
  const ledger = await storeCall({ member: 'readChronicleLedgerStats' }, () => brain.readChronicleLedger()) as StoreChronicleLedger;
  const { counts, reasons } = ledger;
  const tally = (rows: typeof reasons) => rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] ?? 0) + Number(r.n);
    return acc;
  }, {});
  return {
    available: true,
    pending: Number(counts.pending),
    autoCalls24h: Number(ledger.calls),
    principals24h: ledger.principals.map((p) => ({ principal: p.principal, calls: Number(p.calls) })),
    last7d: { extracted: Number(counts.extracted), failed: Number(counts.failed), skipped: Number(counts.skipped),
      reasons: tally(reasons), failedReasons: tally(reasons.filter((r) => r.state === 'failed')) },
    spend7d: { knownUsd: Number(counts.known_usd ?? 0), unpricedCalls: Number(counts.unpriced),
      incompleteRecords: Number(counts.incomplete) },
  };
};
