/**
 * `remember` with `items[]`: save several facts in one call (the
 * pre-compaction "save what matters" path). Additive to the frozen
 * MEMORY_VERBS v1 `remember` contract: a call without `items` is unchanged.
 *
 * Semantics:
 *  - every item is validated (same rules as a single remember) before any is
 *    admitted; one invalid item refuses the whole call and writes nothing;
 *  - each item is then admitted as its own write request with a
 *    deterministic child request_id derived from the caller's request_id and
 *    the item index, so replaying the same request_id replays each child
 *    (committed children return their receipt, nothing is written twice);
 *  - each item's receipt is compact (status, fact id, entity, warnings, and
 *    the write state only when it is not committed); repeated hints appear
 *    once at the top level;
 *  - publication is per item: the response reports each item's status and
 *    `partial: true` when some failed. Replaying the same request_id returns
 *    the same per-item outcomes; failed items are resubmitted in a new call
 *    with a new request_id.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { OperationContext } from './operations.ts';
import { OperationError } from './ops/contract.ts';

export const REMEMBER_BATCH_MAX = 20;
const ITEM_KEYS = new Set(['fact', 'provenance', 'entity', 'infer_entity', 'kind', 'ttl', 'visibility', 'replaces']);

/** Deterministic UUID for child `index` of a batch request (stable across replays). */
export function childRequestId(requestId: string, index: number): string {
  const h = createHash('sha256').update(`${requestId}\u0000remember-item\u0000${index}`).digest('hex');
  // RFC 4122 layout with version 5 / variant bits so it reads as a UUID everywhere.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

type Handler = (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown>;

export interface BatchItemResult {
  index: number;
  status: string;
  request_id: string;
  [key: string]: unknown;
}

/** Runs a remember batch through the single-item handler. */
export async function runRememberBatch(ctx: OperationContext, p: Record<string, unknown>, single: Handler,
  verbError: (code: string, message: string, suggestion: string) => Error): Promise<Record<string, unknown>> {
  const items = p.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > REMEMBER_BATCH_MAX) {
    throw verbError('invalid_params', `items must be an array of 1 to ${REMEMBER_BATCH_MAX} facts.`,
      'Pass items: [{ "fact": "...", "entity": "..." }, ...] with provenance on each item or once at the top level.');
  }
  if (typeof p.fact === 'string' && p.fact.trim()) {
    throw verbError('invalid_params', 'Pass either fact or items, not both.', 'Move the single fact into items, or drop items.');
  }
  if (p.replaces !== undefined) {
    throw verbError('invalid_params', 'replaces names one fact, so it cannot apply to a whole batch.',
      'Put replaces on the item it belongs to: items: [{ "fact": "...", "replaces": "<fact_id>" }].');
  }
  const shared: Record<string, unknown> = {};
  for (const key of ['provenance', 'source_id', 'kind', 'ttl', 'visibility', 'infer_entity']) if (p[key] !== undefined) shared[key] = p[key];
  const normalized = items.map((raw, index) => {
    // A bare string is the common shorthand for one fact.
    if (typeof raw === 'string') return { ...shared, fact: raw };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw verbError('invalid_params', `items[${index}] must be an object.`, 'Each item is { "fact": "...", optional entity, kind, ttl, visibility, provenance }.');
    }
    const extra = Object.keys(raw).filter(k => !ITEM_KEYS.has(k));
    if (extra.length) throw verbError('invalid_params', `items[${index}] has unknown field(s): ${extra.join(', ')}.`, `Allowed item fields: ${[...ITEM_KEYS].join(', ')}.`);
    return { ...shared, ...(raw as Record<string, unknown>) };
  });
  // All-or-none validation before any admission.
  for (const [index, item] of normalized.entries()) {
    try { await single({ ...ctx, dryRun: true }, item); } catch (e) {
      if (e instanceof OperationError) e.message = `items[${index}]: ${e.message} Nothing was saved; fix that item and resend the whole batch.`;
      throw e;
    }
  }
  if (ctx.dryRun) return { dry_run: true, action: 'remember', items: normalized.length, protocol_version: 1 };
  const requestId = typeof p.request_id === 'string' && p.request_id ? p.request_id : randomUUID();
  const results: BatchItemResult[] = [];
  const hints = new Set<string>();
  for (const [index, item] of normalized.entries()) {
    const child = childRequestId(requestId, index);
    try {
      const out = await single(ctx, { ...item, request_id: child }) as Record<string, unknown>;
      // Compact per-item receipt: a batch lands in the agent's context, so it carries what the agent acts on, not the full single-fact envelope.
      if (typeof out?.hint === 'string') hints.add(out.hint);
      results.push({
        index, request_id: child, status: String(out?.status ?? 'saved'),
        ...(out?.id !== undefined ? { id: out.id } : {}),
        ...(out?.entity_slug !== undefined ? { entity_slug: out.entity_slug } : {}),
        ...(Array.isArray(out?.warnings) && out.warnings.length ? { warnings: out.warnings } : {}),
        ...(out?.valid_until ? { valid_until: out.valid_until } : {}),
        ...(typeof out?.state === 'string' && out.state !== 'committed' ? { state: out.state, retry_after_ms: out.retry_after_ms ?? null } : {}),
      });
    } catch (e) {
      if (!(e instanceof OperationError)) throw e;
      results.push({ index, request_id: child, status: 'failed', error: { code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) } });
    }
  }
  const failed = results.filter(r => r.status === 'failed').length;
  return {
    protocol_version: 1,
    request_id: requestId,
    items: results,
    saved: results.length - failed,
    failed,
    partial: failed > 0 && failed < results.length,
    ...(hints.size ? { hints: [...hints] } : {}),
    ...(failed > 0 ? { next: 'Fix each failed item as its error says, then send only the failed items in a new remember call with a new request_id; the saved items are already stored.' } : {}),
  };
}
