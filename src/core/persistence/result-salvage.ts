import { isWriteReceipt, type WriteReceipt } from './types.ts';

/**
 * Receipt and failure discovery for a mutation result that could not be framed.
 * Commitment may be attested only when discovery is COMPLETE: every container the
 * wire encoding would carry was inspected. Traversal is iterative and cycle-safe,
 * walks arrays and every depth, and reports `complete: false` instead of guessing
 * when a bound is hit or a value cannot be inspected.
 */
export const SALVAGE_MAX_DEPTH = 256;
/** Object keys plus array elements examined; primitives inside strings cost nothing. */
export const SALVAGE_MAX_ENTRIES = 1_000_000;

/** Result-level failure signals; the CLI already exits 1 on `status: 'error'`. `warn`/`fail` carry partial failures (e.g. extract-atoms, ledger checks). */
const FAILED_STATUSES = new Set(['error', 'failed', 'partial', 'blocked_by_failures', 'warn', 'fail']);
const FAILURE_LISTS = ['errors', 'failures'];
const FAILURE_COUNTS = ['failedFiles', 'failed', 'failures', 'pages_failed'];

export interface DiscoveredReceipts {
  /** One receipt per request_id; a disagreeing copy never upgrades a request to committed. */
  receipts: WriteReceipt[];
  /** Receipt-keyed values that did not validate. */
  dropped: number;
  /** The result reported a failure somewhere in its tree. */
  failed: boolean;
  /** False when a bound was hit or a value could not be inspected; commitment is then unprovable. */
  complete: boolean;
}

function failureSignal(value: Record<string, unknown>): boolean {
  if (typeof value.status === 'string' && FAILED_STATUSES.has(value.status)) return true;
  if (value.error !== undefined || value.skipped !== undefined || value.ok === false || value.success === false) return true;
  if (FAILURE_LISTS.some(key => Array.isArray(value[key]) && (value[key] as unknown[]).length > 0)) return true;
  return FAILURE_COUNTS.some(key => typeof value[key] === 'number' && (value[key] as number) > 0);
}

/** Values the JSON encoding renders without nested receipts. */
function opaqueLeaf(value: object): boolean {
  return value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

export function discoverResultReceipts(result: unknown,
  limits: { maxDepth?: number; maxEntries?: number } = {}): DiscoveredReceipts {
  const maxDepth = limits.maxDepth ?? SALVAGE_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? SALVAGE_MAX_ENTRIES;
  const found: WriteReceipt[] = [];
  let dropped = 0, failed = false, complete = true, entries = 0;
  const candidate = (value: unknown) => { if (isWriteReceipt(value)) found.push(value); else dropped++; };
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: result, depth: 0 }];
  try {
    while (stack.length) {
      const { value, depth } = stack.pop()!;
      if (typeof value !== 'object' || value === null) continue;
      // A revisited object was already inspected in full; a cycle cannot loop.
      if (seen.has(value)) continue;
      seen.add(value);
      if (opaqueLeaf(value)) continue;
      if (depth > maxDepth) { complete = false; break; }
      // A custom encoder can emit anything, including receipts discovery never saw.
      if (typeof (value as { toJSON?: unknown }).toJSON === 'function') { complete = false; continue; }
      if (Array.isArray(value)) {
        entries += value.length;
        if (entries > maxEntries) { complete = false; break; }
        for (const item of value) if (typeof item === 'object' && item !== null) stack.push({ value: item, depth: depth + 1 });
        continue;
      }
      const fields = Object.entries(value);
      entries += fields.length;
      if (entries > maxEntries) { complete = false; break; }
      const node = value as Record<string, unknown>;
      if (failureSignal(node)) failed = true;
      for (const [key, child] of fields) {
        if (key === 'write_request') candidate(child);
        else if (key === 'write_requests') {
          if (!Array.isArray(child)) dropped++;
          else { entries += child.length; if (entries > maxEntries) { complete = false; break; } child.forEach(candidate); }
        } else if (typeof child === 'object' && child !== null) stack.push({ value: child, depth: depth + 1 });
      }
      if (!complete) break;
    }
  } catch {
    // A throwing getter or proxy: whatever was not inspected cannot be vouched for.
    complete = false;
  }
  const byId = new Map<string, WriteReceipt>();
  for (const receipt of found) {
    const prior = byId.get(receipt.request_id);
    if (!prior || prior.state === 'committed' || receipt.state !== 'committed') byId.set(receipt.request_id, receipt);
  }
  return { receipts: [...byId.values()], dropped, failed, complete };
}
