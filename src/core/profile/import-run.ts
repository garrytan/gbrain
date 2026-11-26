/**
 * Lane 3 P2: applying a previewed profile import, with a progress receipt (d6). Each batch is one remember call whose
 * request id comes from the preview hash; the receipt keeps every item's own receipt (its child request id, status,
 * fact id or error) and the batch's state. A resume first polls each pending item by its request id, then sends only
 * batches never sent; a failed item is reported, never retried: it is saved again only after the file is repaired and
 * previewed again. The caller loads and saves the receipt (src/commands/profile-import.ts). The receipt binds the preview, the file and the target, so a resume writes the same items to the
 * same profile as the same caller, or refuses.
 */
import { batches, batchParams, batchRequestId, type ImportPlan, type ImportTarget } from './import.ts';

/** One tool call on the brain the import writes: in process for a local brain, over MCP on a thin client. */
export type ImportCall = (tool: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ImportItemReceipt { line: number; request_id: string; status: string; fact_id?: string; error?: { code: string; message: string } }
export interface ImportBatchReceipt {
  index: number;
  request_id: string;
  state: 'not_started' | 'committed' | 'pending' | 'partial' | 'failed';
  items: ImportItemReceipt[];
  error?: { code: string; message: string };
}
export interface ImportReceipt {
  schema: 1;
  preview: string;
  file: string;
  format: ImportPlan['format'];
  content_sha256: string;
  target: ImportTarget;
  provenance: string;
  batches: ImportBatchReceipt[];
}

export function newReceipt(plan: ImportPlan, hash: string, file: string, target: ImportTarget, provenance: string): ImportReceipt {
  return { schema: 1, preview: hash, file, format: plan.format, content_sha256: plan.content_sha256, target, provenance,
    batches: batches(plan).map((_, index) => ({ index, request_id: batchRequestId(hash, index), state: 'not_started', items: [] })) };
}

/** A refusal's code: top-level on a local op error, under `detail` on a thin client's RemoteMcpError. */
const errorOf = (e: unknown) => {
  const err = e as { code?: unknown; detail?: { code?: unknown } } | null;
  return { code: String(err?.code ?? err?.detail?.code ?? 'error'), message: String((e as Error)?.message ?? e).slice(0, 500) };
};

function batchState(items: ImportItemReceipt[]): ImportBatchReceipt['state'] {
  if (items.some(i => i.status === 'pending')) return 'pending';
  return items.some(i => i.status === 'failed') ? 'partial' : 'committed';
}

/** The receipt states a write ends in without committing (ops/persistence.ts). */
const ENDED = new Set(['failed', 'conflict', 'cancelled']);

/** Polls an item still publishing; its receipt says where it ended. */
async function poll(call: ImportCall, item: ImportItemReceipt): Promise<ImportItemReceipt> {
  try {
    const r = await call('get_write_request', { request_id: item.request_id });
    const state = String(r.state ?? '');
    const outcome = (r.outcome ?? {}) as Record<string, unknown>;
    if (state === 'committed') return { ...item, status: String(outcome.status ?? 'committed'), ...(outcome.id !== undefined ? { fact_id: String(outcome.id) } : {}) };
    if (ENDED.has(state)) return { ...item, status: 'failed', error: { code: String(r.error_code ?? state), message: String(r.error_message ?? state) } };
    return item;
  } catch (e) {
    return { ...item, error: errorOf(e) };
  }
}

/**
 * Brings the receipt forward: polls pending items, then sends each batch never sent, saving the receipt after every
 * step. Stops at the first batch the brain refuses as a whole (its error is on the batch; later batches stay
 * not_started for a resume); a batch refused for one of its items (invalid_params naming items[N]) records its
 * lines as failed, and the import moves on. Returns the receipt.
 */
export async function runImport(plan: ImportPlan, receipt: ImportReceipt, call: ImportCall, save: (r: ImportReceipt) => void): Promise<ImportReceipt> {
  const groups = batches(plan);
  for (const batch of receipt.batches) {
    if (batch.state === 'pending') {
      batch.items = await Promise.all(batch.items.map(i => i.status === 'pending' ? poll(call, i) : i));
      batch.state = batchState(batch.items);
      save(receipt);
      continue;
    }
    if (batch.state !== 'not_started' && batch.state !== 'failed') continue;
    const items = groups[batch.index]!;
    try {
      const out = await call('remember', batchParams(plan, receipt.preview, batch.index, items, receipt.provenance));
      const children = (out.items ?? []) as Array<Record<string, unknown>>;
      batch.items = items.map((it, k) => {
        const c = children.find(x => x.index === k) ?? {};
        const status = String(c.status ?? 'failed');
        const err = c.error as { code?: unknown; message?: unknown } | undefined;
        return { line: it.line, request_id: String(c.request_id ?? ''), status,
          ...(c.id !== undefined ? { fact_id: String(c.id) } : {}), ...(err ? { error: { code: String(err.code ?? 'error'), message: String(err.message ?? '') } } : {}) };
      });
      delete batch.error;
      batch.state = batchState(batch.items);
      save(receipt);
    } catch (e) {
      const error = errorOf(e);
      if (error.code === 'invalid_params' && /\bitems\[\d+\]/.test(error.message)) {
        batch.items = items.map(it => ({ line: it.line, request_id: '', status: 'failed', error }));
        batch.state = 'partial';
        save(receipt);
        continue;
      }
      batch.state = 'failed';
      batch.error = error;
      save(receipt);
      break;
    }
  }
  return receipt;
}

export function summarize(r: ImportReceipt): { batches: Record<string, number>; items: Record<string, number>; failed: ImportItemReceipt[]; complete: boolean } {
  const batchCounts: Record<string, number> = {};
  const itemCounts: Record<string, number> = {};
  for (const b of r.batches) {
    batchCounts[b.state] = (batchCounts[b.state] ?? 0) + 1;
    for (const i of b.items) itemCounts[i.status] = (itemCounts[i.status] ?? 0) + 1;
  }
  const failed = r.batches.flatMap(b => b.items.filter(i => i.status === 'failed'));
  return { batches: batchCounts, items: itemCounts, failed, complete: r.batches.every(b => b.state === 'committed' || b.state === 'partial') };
}
