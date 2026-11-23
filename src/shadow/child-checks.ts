/**
 * The child's side of its questions to the serving process (checks.ts): the pending-answer table, the per-item privacy
 * verdict, and the bounded one-at-a-time queue of stable reruns. Content-free: only page ids and counts cross.
 *
 * Privacy verdict (plan decision 6, review F1). The source-scope check in classify.ts runs first. After it, every Rust row
 * the primary's own answer did not hold is a page the primary did not show this caller: the serving process judges it
 * with the primary's read policy under the captured `CallerAccess`. A page the caller may not read is a violation. A rise
 * of the policy generation during the check, or no answer, is `inconclusive`, never a pass. A row the primary's answer
 * holds needs no check, and a read that did not ask for the policy (`excludePrivate`) is not judged.
 */
import type { CallerAccess } from '../core/search/private-visibility.ts';
import type { PageCandidates, PrivacyAnswer } from './checks.ts';

export const PRIVACY_ASK_TIMEOUT_MS = 10_000;
export const RERUN_QUEUE_BOUND = 64;

const SEP = '\u001f';
type Row = Record<string, unknown>;

function rowsOf(encoded: unknown): Row[] {
  const list = Array.isArray(encoded) ? encoded : encoded && typeof encoded === 'object' ? [encoded] : [];
  return list.filter((r): r is Row => !!r && typeof r === 'object');
}

/** The page a result row belongs to: a search or chunk row names it by `page_id`; a page row is its own (it has a slug). */
function pageOf(row: Row): { id?: number; key?: string } {
  const id = row.page_id ?? (typeof row.slug === 'string' ? row.id : undefined);
  return {
    ...(typeof id === 'number' ? { id } : {}),
    ...(typeof row.source_id === 'string' && typeof row.slug === 'string' ? { key: `${row.source_id}${SEP}${row.slug}` } : {}),
  };
}

/** The Rust rows the primary's answer did not hold, each by its page; `unidentified` counts those that name no page at all. */
export function extraRows(encodedPrimary: unknown, encodedRust: unknown): { rows: Array<{ id?: number; key?: string }>; unidentified: number } {
  const have = rowsOf(encodedPrimary).map(pageOf);
  const ids = new Set(have.flatMap((p) => (p.id === undefined ? [] : [p.id])));
  const keys = new Set(have.flatMap((p) => (p.key === undefined ? [] : [p.key])));
  const out: { rows: Array<{ id?: number; key?: string }>; unidentified: number } = { rows: [], unidentified: 0 };
  for (const p of rowsOf(encodedRust).map(pageOf)) {
    if ((p.id !== undefined && ids.has(p.id)) || (p.key !== undefined && keys.has(p.key))) continue;
    if (p.id === undefined && p.key === undefined) out.unidentified++; else out.rows.push(p);
  }
  return out;
}

/** The pages of the Rust answer that the primary's answer did not hold. */
export function missingPages(encodedPrimary: unknown, encodedRust: unknown): PageCandidates {
  const out: PageCandidates = { ids: [], keys: [] };
  for (const p of extraRows(encodedPrimary, encodedRust).rows) {
    if (p.id !== undefined) out.ids.push(p.id);
    if (p.key !== undefined) out.keys.push(p.key);
  }
  return out;
}

/** Did the read ask for the read policy (`excludePrivate`, plain or under `remote`)? Only then is a missing row a policy question. */
export function policyApplies(args: unknown[]): boolean {
  return args.some((a) => {
    const o = a as { excludePrivate?: unknown; remote?: { excludePrivate?: unknown } } | null;
    return !!o && typeof o === 'object' && (o.excludePrivate === true || o.remote?.excludePrivate === true);
  });
}

export type PrivacyVerdict = 'clean' | 'violation' | 'privacy_check_moved' | 'privacy_check_unavailable';
/** `complete`: every extra Rust row was identified and the primary judged it (or there was none). Only then is a ranked diff accepted (exactness.ts RANKED_PRIVATE_EXCEPTION). */
export interface PrivacyResult { verdict: PrivacyVerdict; complete: boolean }

/**
 * Asks the serving process (checks.ts `policyCheck`) about every Rust page the primary's answer lacked, under the same
 * captured caller record and the primary's own policy text. A row the check cannot evaluate (no page identity, a page the
 * primary does not have, a failed or moved check) leaves `complete` false.
 */
export async function privacyVerdict(ask: Asker, args: unknown[], primary: unknown, rust: unknown, access: CallerAccess | undefined, at: number): Promise<PrivacyResult> {
  if (!policyApplies(args)) return { verdict: 'clean', complete: false };
  const extra = extraRows(primary, rust);
  if (extra.rows.length === 0) return { verdict: 'clean', complete: extra.unidentified === 0 };
  const candidates = missingPages(primary, rust);
  try {
    const answer = await ask({ kind: 'privacy', access, at, candidates }, PRIVACY_ASK_TIMEOUT_MS) as PrivacyAnswer;
    if (answer.moved) return { verdict: 'privacy_check_moved', complete: false };
    if (answer.violations > 0) return { verdict: 'violation', complete: false };
    const ids = new Set(answer.found.ids);
    const keys = new Set(answer.found.keys);
    return { verdict: 'clean', complete: extra.unidentified === 0 && extra.rows.every((r) => (r.id !== undefined && ids.has(r.id)) || (r.key !== undefined && keys.has(r.key))) };
  } catch { return { verdict: 'privacy_check_unavailable', complete: false }; }
}

export type Asker = ((payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>) & { answer(line: { id?: number; ok?: boolean; value?: unknown; error?: { code?: string } }): void; closeAll(): void };

/** One `ask` line out, one `answer` line back, matched by id; a late answer after the timeout is ignored. */
export function createAsker(write: (line: string) => void): Asker {
  let next = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (id: number, ok: boolean, value: unknown): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(value); else p.reject(Object.assign(new Error(String(value)), { code: String(value) }));
  };
  const ask = ((payload: Record<string, unknown>, timeoutMs: number) => new Promise<unknown>((resolve, reject) => {
    if (closed) { reject(Object.assign(new Error('closing'), { code: 'closing' })); return; }
    const id = ++next;
    const timer = setTimeout(() => settle(id, false, 'timeout'), Math.max(1, timeoutMs));
    (timer as { unref?: () => void }).unref?.();
    pending.set(id, { resolve, reject, timer });
    try { write(JSON.stringify({ t: 'ask', id, ...payload }) + '\n'); } catch { settle(id, false, 'parent_gone'); }
  })) as Asker;
  ask.answer = (line) => { if (typeof line.id === 'number') settle(line.id, line.ok === true, line.ok === true ? line.value : line.error?.code ?? 'failed'); };
  ask.closeAll = () => { closed = true; for (const id of [...pending.keys()]) settle(id, false, 'closing'); };
  return ask;
}

/** Runs queued tasks one at a time, at most `bound` queued or running; a task over the bound is refused to its caller. */
export function createSerialQueue<T>(bound: number, run: (task: T) => Promise<void>) {
  const items: T[] = [];
  let busy: Promise<void> | null = null;
  const pump = (): void => {
    busy ??= (async () => {
      while (items.length) { try { await run(items.shift()!); } catch { /* run records its own failures */ } }
      busy = null;
    })();
  };
  return {
    /** False when the queue is full. */
    add(task: T): boolean {
      if (items.length + (busy ? 1 : 0) >= bound) return false;
      items.push(task);
      pump();
      return true;
    },
    /** Takes out what has not started, for the caller to finish as skipped. */
    drop(): T[] { return items.splice(0); },
    idle: (): Promise<void> => busy ?? Promise.resolve(),
  };
}
