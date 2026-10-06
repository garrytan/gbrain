/**
 * Lock-order tracing for the crash robot. A worker patches both engines'
 * transaction entry points so every row lock taken inside one transaction
 * (`SELECT ... FROM <table> ... FOR UPDATE|SHARE`) is recorded in order, then
 * checks the cross-path lock order the write path relies on to stay
 * deadlock-free:
 *   - worktree rows are locked before source rows;
 *   - source rows are locked in id order (a multi-source lock such as
 *     `id = ANY($1) ORDER BY id`, or several single-source locks);
 *   - a publication (a transaction that locks its request row) never takes
 *     an exclusive lock on the brain row (shared reads by the writer guard
 *     and company receipts are counted, not refused);
 *   - the brain row is locked before any worktree, source or counter row
 *     whenever one transaction locks both. Writing `persistence_requests` or
 *     `persistence_effects` counts as a brain-row FOR SHARE lock at that
 *     statement, because their protocol triggers read it; worktree claims and
 *     topology changes hold it FOR UPDATE before their worktrees, sources and
 *     counters, so a later brain read inverts against them.
 * The core-memory source lock (`lockCoreSources`, when present) is a
 * multi-source `sources` lock and is checked by the same rules.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

interface Lock { table: string; ids: string[]; sql: string; exclusive: boolean }
interface Trace { locks: Lock[]; publication: boolean }
export interface LockOrderViolation { rule: 'worktrees_before_sources' | 'sources_in_id_order' | 'publication_locks_brain' | 'brain_before_rows'; detail: string }

const LOCK = /^\s*SELECT\b[\s\S]*?\bFROM\s+([a-z_]+)\b(?:\s+[a-z]\b)?[\s\S]*\bFOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b(?!\s+OF\b)/i;
/** A statement writing a journal table fires its protocol trigger's brain-row FOR SHARE read; counters it updates are locked first. */
const TRIGGERED_BRAIN = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+persistence_(?:requests|effects)\b/i;
const COUNTER_WRITE = /\b(?:INSERT\s+INTO|UPDATE)\s+persistence_counters\b/i;
const ORDERED_ROWS = new Set(['persistence_worktrees', 'sources', 'persistence_counters']);
const store = new AsyncLocalStorage<Trace>();
const violations: LockOrderViolation[] = [];
let installed = false;
let enabled = false;
let traced = 0;
let sharedBrainPublications = 0;

function record(sql: string, params: unknown[] | undefined): void {
  const trace = store.getStore();
  if (!trace) return;
  const flat = sql.replace(/\s+/g, ' ').slice(0, 140);
  if (!/^\s*SELECT\b/i.test(sql)) {
    if (COUNTER_WRITE.test(sql)) trace.locks.push({ table: 'persistence_counters', ids: [], sql: flat, exclusive: true });
    if (TRIGGERED_BRAIN.test(sql)) trace.locks.push({ table: 'persistence_brain', ids: [], sql: `trigger: ${flat}`, exclusive: false });
  }
  const match = LOCK.exec(sql);
  if (!match) return;
  const table = match[1].toLowerCase();
  // The locked ids: the parameter bound to `id = $n` or `id = ANY($n)`.
  const position = /\bid\s*=\s*(?:ANY\s*\(\s*)?\$(\d+)/i.exec(sql)?.[1];
  const bound = position ? params?.[Number(position) - 1] : undefined;
  const ids = Array.isArray(bound) ? bound.map(String) : bound === undefined ? [] : [String(bound)];
  trace.locks.push({ table, ids, sql: flat, exclusive: /UPDATE/i.test(match[2]) });
  if (table === 'persistence_requests' && /\bWHERE\s+id\s*=\s*\$1/i.test(sql)) trace.publication = true;
}

function check(trace: Trace): void {
  traced++;
  const firstSource = trace.locks.findIndex(l => l.table === 'sources');
  const worktrees = new Set<string>();
  for (const [i, lock] of trace.locks.entries()) {
    if (lock.table !== 'persistence_worktrees') continue;
    const fresh = lock.ids.some(id => !worktrees.has(id)) || !lock.ids.length;
    if (firstSource >= 0 && i > firstSource && fresh) violations.push({ rule: 'worktrees_before_sources',
      detail: `${trace.locks[firstSource].sql} [${trace.locks[firstSource].ids}] before ${lock.sql} [${lock.ids}]` });
    for (const id of lock.ids) worktrees.add(id);
  }
  // Re-locking a row this transaction already holds acquires nothing new, so only first locks count.
  const held = new Set<string>(); let previous = '';
  for (const lock of trace.locks.filter(l => l.table === 'sources')) {
    const fresh = lock.ids.filter(id => !held.has(id)).sort();
    if (fresh.length && previous && fresh[0] < previous) violations.push({ rule: 'sources_in_id_order', detail: `${previous} locked before ${fresh[0]}` });
    for (const id of fresh) held.add(id);
    previous = fresh.at(-1) ?? previous;
  }
  // The writer guard's trigger and company receipts read the brain row FOR SHARE inside publications;
  // an exclusive brain lock there would serialize every write behind topology changes.
  const firstBrain = trace.locks.findIndex(l => l.table === 'persistence_brain');
  const early = firstBrain > 0 ? trace.locks.slice(0, firstBrain).find(l => ORDERED_ROWS.has(l.table)) : undefined;
  if (early) violations.push({ rule: 'brain_before_rows', detail: `${early.sql} [${early.ids}] before ${trace.locks[firstBrain].sql}` });
  const brain = trace.locks.find(l => l.table === 'persistence_brain' && l.exclusive);
  if (trace.publication && brain) violations.push({ rule: 'publication_locks_brain', detail: brain.sql });
  if (trace.publication && trace.locks.some(l => l.table === 'persistence_brain')) sharedBrainPublications++;
}

/**
 * Patch both engines once per worker process and start tracing. Nested
 * transactions extend the outer trace. Call it after fixture setup: an
 * unmanaged pre-activation claim runs no publication to order against.
 */
export function installLockOrderTrace(): void {
  enabled = true;
  if (installed) return;
  installed = true;
  for (const Engine of [PGLiteEngine, PostgresEngine] as const) {
    const proto = Engine.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of ['transaction', 'transactionDirect']) {
      const original = proto[method];
      proto[method] = function (this: unknown, fn: unknown) {
        if (!enabled || store.getStore()) return original.call(this, fn);
        const trace: Trace = { locks: [], publication: false };
        return store.run(trace, async () => {
          try { return await original.call(this, fn); } finally { check(trace); }
        });
      };
    }
    const execute = proto.executeRaw;
    proto.executeRaw = function (this: unknown, sql: unknown, params?: unknown) {
      record(String(sql), params as unknown[] | undefined);
      return execute.call(this, sql, params, ...[...arguments].slice(2));
    };
  }
}

export function lockOrderReport(): { transactions: number; publications_reading_brain_for_share: number; violations: LockOrderViolation[] } {
  return { transactions: traced, publications_reading_brain_for_share: sharedBrainPublications, violations: [...violations] };
}
