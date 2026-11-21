import type { FenceExtractedFact } from './extract-from-fence.ts';

interface StoredFactTime {
  original_remember_start: string | null;
  visibility: string;
  valid_from: Date | string | null;
}

/**
 * Old remember files rendered their precise start as a plain UTC second. Preserve the
 * database value only when this exact fact's last write was its matching committed
 * creation and the request still records that precise instant. Reconcile otherwise
 * keeps its canonical date semantics. Missing receipts cannot reconstruct a timestamp.
 */
export function keepRememberPrecision(legacyStarts: ReadonlySet<number>, desired: FenceExtractedFact[],
  matched: ReadonlyMap<number, StoredFactTime>): void {
  for (const fact of desired) {
    const stored = matched.get(fact.row_num);
    if (!legacyStarts.has(fact.row_num) || !stored?.original_remember_start || stored.valid_from == null ||
        stored.visibility !== fact.visibility) continue;
    const time = new Date(stored.valid_from).getTime();
    if (Date.parse(stored.original_remember_start) === time && time % 1000 !== 0 &&
        Math.floor(time / 1000) * 1000 === fact.valid_from?.getTime()) {
      fact.valid_from = new Date(time);
    }
  }
}
