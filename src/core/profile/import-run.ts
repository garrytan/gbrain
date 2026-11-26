/**
 * Lane 3 P2: applying a previewed profile import, with a progress receipt (d6). Each batch is one remember call whose
 * request id comes from the preview hash; the receipt keeps every item's own receipt (its child request id, status,
 * fact id or error) and the batch's state. A resume first polls each pending item by its request id, then sends only
 * batches never sent; a failed item is reported, never retried: it is saved again only after the file is repaired and
 * previewed again. The caller loads and saves the receipt (src/commands/profile-import.ts). The receipt binds the preview, the file and the target, so a resume writes the same items to the
 * same profile as the same caller, or refuses.
 */
import { batches, batchParams, batchRequestId, type ImportItem, type ImportPlan, type ImportTarget } from './import.ts';

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

/**
 * A write the write gate held for owner review, as the brain refuses it (`write_held: held for owner review as h7 …`):
 * recorded as failed with the command that keeps it, never as a refusal of the whole batch.
 */
const held = (message: string): { code: string; message: string } | null => {
  const ref = /\bwrite_held: held for owner review as ([A-Za-z0-9_-]+)/.exec(message)?.[1];
  return ref ? { code: 'write_held', message: `Held for owner review as ${ref}; nothing was saved. Keep it with: gbrain trust release ${ref}` } : null;
};

function batchState(items: ImportItemReceipt[]): ImportBatchReceipt['state'] {
  if (items.some(i => i.status === 'pending')) return 'pending';
  return items.some(i => i.status === 'failed') ? 'partial' : 'committed';
}

/** The receipt states a write ends in without committing (ops/persistence.ts). */
const ENDED = new Set(['failed', 'conflict', 'cancelled']);

const failed = (item: ImportItemReceipt, code: string, message: string): ImportItemReceipt => ({ ...item, status: 'failed', error: { code, message } });

/**
 * Polls an item still publishing, or whose admission is unknown; its receipt says where it ended. A committed write the
 * write gate held for review saved nothing, and a write the brain has no record of was never admitted.
 */
async function poll(call: ImportCall, item: ImportItemReceipt): Promise<ImportItemReceipt> {
  if (!item.request_id) return failed(item, 'write_outcome_unknown', 'The brain reported this line without a request id, so whether it was saved cannot be checked; gbrain profile shows what was. To send it again, move the receipt aside and apply again: the brain replays lines it already saved, so nothing is saved twice.');
  try {
    const r = await call('get_write_request', { request_id: item.request_id });
    const state = String(r.state ?? '');
    const outcome = (r.outcome ?? {}) as Record<string, unknown>;
    if (state === 'committed' && outcome.status === 'held') {
      const next = (outcome.gate as { next?: { argv?: unknown } } | undefined)?.next?.argv;
      return failed(item, 'write_held', `Held for owner review as ${String(outcome.hold_ref ?? '')}; nothing was saved.${Array.isArray(next) ? ` Keep it with: ${next.join(' ')}` : ''}`);
    }
    if (state === 'committed') return { line: item.line, request_id: item.request_id, status: String(outcome.status ?? 'committed'), ...(outcome.id !== undefined ? { fact_id: String(outcome.id) } : {}) };
    if (ENDED.has(state)) return failed(item, String(r.write_error ?? r.error_code ?? state), String(r.write_error_message ?? r.error_message ?? state));
    return { ...item, status: 'pending' };
  } catch (e) {
    const error = errorOf(e);
    if (error.code === 'not_found') return failed(item, 'write_outcome_unknown', 'The brain no longer shows this write, so whether it was saved is unknown; gbrain profile shows what was. To send it again, move the receipt aside and apply again: the brain replays lines it already saved, so nothing is saved twice.');
    return { ...item, status: 'pending', error };
  }
}

/** One remember call's per-item receipts; an item whose admission is unknown is checked on resume, never counted. */
function childReceipts(items: ImportItem[], out: Record<string, unknown>): ImportItemReceipt[] {
  const children = (out.items ?? []) as Array<Record<string, unknown>>;
  return items.map((it, k) => {
    const c = children.find(x => x.index === k) ?? {};
    const err = c.error as { code?: unknown; message?: unknown; write_error?: unknown } | undefined;
    const unknown = err?.write_error === 'write_outcome_unknown' || err?.code === 'write_outcome_unknown';
    const status = unknown ? 'pending' : String(c.status ?? 'failed');
    const receipt: ImportItemReceipt = { line: it.line, request_id: String(c.request_id ?? ''), status,
      ...(c.id !== undefined ? { fact_id: String(c.id) } : {}), ...(err ? { error: held(String(err.message ?? '')) ?? { code: String(err.code ?? 'error'), message: String(err.message ?? '') } } : {}) };
    return status === 'pending' && !receipt.request_id ? failed(receipt, 'write_outcome_unknown', 'The brain reported this line pending without a request id, so it cannot be checked; gbrain profile shows what was saved. To send it again, move the receipt aside and apply again: the brain replays lines it already saved, so nothing is saved twice.') : receipt;
  });
}

/**
 * Brings the receipt forward: polls pending items, then sends each batch never sent, saving the receipt after every
 * step. Stops at the first batch the brain refuses as a whole (its error is on the batch; later batches stay
 * not_started for a resume). A batch refused for one of its items (invalid_params or a write-gate hold naming items[N]) records that line
 * as failed and sends the rest of the batch again under its own request id, so one bad line costs only itself; after a
 * hold the rest go one line at a time.
 * Returns the receipt.
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
    let rest = groups[batch.index]!;
    const refused: ImportItemReceipt[] = [];
    const sent: ImportItemReceipt[] = [];
    let one = false;
    for (let attempt = 0; rest.length; attempt++) {
      const group = one ? rest.slice(0, 1) : rest;
      const params = { ...batchParams(plan, receipt.preview, batch.index, group, receipt.provenance), ...(attempt ? { request_id: `${batch.request_id}-r${attempt}` } : {}) };
      try {
        sent.push(...childReceipts(group, await call('remember', params)));
        rest = rest.slice(group.length);
      } catch (e) {
        const error = errorOf(e);
        const hold = held(error.message);
        const named = error.code === 'invalid_params' || hold ? /\bitems\[(\d+)\]/.exec(error.message) : null;
        const bad = named ? Number(named[1]) : -1;
        if (bad < 0 || bad >= group.length) {
          if (refused.length || sent.length) batch.items = [...refused, ...sent].sort((a, b) => a.line - b.line);
          batch.state = 'failed';
          batch.error = error;
          save(receipt);
          return receipt;
        }
        refused.push({ line: group[bad]!.line, request_id: '', status: 'failed', error: hold ?? error });
        rest = rest.filter(item => item !== group[bad]);
        if (hold) one = true;
      }
    }
    delete batch.error;
    batch.items = [...refused, ...sent].sort((a, b) => a.line - b.line);
    batch.state = batchState(batch.items);
    save(receipt);
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
