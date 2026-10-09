#!/usr/bin/env python3
"""Debug-only instrumentation for the #6278 stall reproduction. Never commit its output.

Applies, to the gbrain checkout given as argv[1] (default: the current one), a
SIGUSR2 dump of every preparation in flight: which `prepareManagedSyncMutation`
step each request is in, for how long, plus the consumer's `status()`
(phase observation with first_conn_ms / conn_wait_ms, preparations). The
repro script sends the signal with `--stall-signal SIGUSR2` once a stall is
detected, and the dump lands in `pass-<n>.stderr` as `[stall-debug] ...` lines.

It edits three files in place (idempotent: a second run is a no-op) and adds
`src/core/persistence/stall-debug.ts`. Undo with `git checkout -- src` in that checkout.
Anchors that do not exist in that checkout are reported and skipped.
"""
import os
import re
import sys

repo = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
P = lambda *parts: os.path.join(repo, 'src', 'core', 'persistence', *parts)

MODULE = '''/** Debug-only (#6278 Phase 0): SIGUSR2 dumps every preparation in flight with its current step and age. Installed by scripts/bench/stall-debug-instrument.py. */
const inflight = new Map<string, { step: string; since: number; started: number; steps: string[] }>();
const extras = new Map<string, () => unknown>();
let installed = false;
function install(): void {
  if (installed) return;
  installed = true;
  process.on('SIGUSR2', () => {
    const now = Date.now();
    const rows = [...inflight.entries()].map(([id, s]) => ({ id, step: s.step, step_age_ms: now - s.since, total_age_ms: now - s.started, steps: s.steps.slice(-20) }));
    const extra: Record<string, unknown> = {};
    for (const [name, fn] of extras) { try { extra[name] = fn(); } catch (error) { extra[name] = String(error); } }
    process.stderr.write(`[stall-debug] ${JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, inflight: rows, ...extra, memory: process.memoryUsage() })}\\n`);
  });
}
export function stallMark(id: string, step: string): void {
  install();
  const now = Date.now();
  const s = inflight.get(id);
  if (s) { s.step = step; s.since = now; s.steps.push(`${step}@${now - s.started}`); }
  else inflight.set(id, { step, since: now, started: now, steps: [`${step}@0`] });
}
export function stallDone(id: string): void { inflight.delete(id); }
export function stallRegister(name: string, fn: () => unknown): void { install(); extras.set(name, fn); }
/** #6317: every raw statement between its send in JS and its settle; one that is here but not in pg_stat_activity is waiting for a connection. */
const sqlInflight = new Map<number, { sql: string; since: number; pool: string; reserved: boolean }>();
let sqlSeq = 0;
export function stallSql(sql: string, pool: string, reserved = false): () => void {
  install();
  const id = ++sqlSeq;
  sqlInflight.set(id, { sql: sql.replace(/\\s+/g, ' ').slice(0, 160), since: Date.now(), pool, reserved });
  return () => { sqlInflight.delete(id); };
}
/** #6317: postgres.js pool queues (vendor/postgres/src/index.js exposes `queues` and registers each pool here when instrumented). */
export function stallPools(): unknown {
  const pools = (globalThis as { __gbrainPools?: Array<{ options: { max: number; host?: string[]; port?: number[]; database?: string }; queues?: Record<string, { length: number }> }> }).__gbrainPools ?? [];
  return pools.map((pool, i) => ({ i, max: pool.options?.max, database: pool.options?.database, port: pool.options?.port,
    ...Object.fromEntries(Object.entries(pool.queues ?? {}).map(([name, queue]) => [name, queue.length])) }));
}
/**
 * #6317 forced wedge (debug only): with STALL_DEBUG_HANG_KIND=<intent kind> (e.g. managed_sync_import), the preparation of
 * the STALL_DEBUG_HANG_AFTER-th (default 40th) request of that kind in this process parks on a promise that never settles and
 * ignores its signal: the reporter's never-settling await with nothing in flight at the database. STALL_DEBUG_HANG_ROLE limits
 * it to processes whose GBRAIN_SQL_TRACE_LABEL starts with that prefix (e.g. serve, cli-sync). Hung ids appear in the dump.
 */
const hung: Array<{ id: string; since: number }> = [];
let seenOfKind = 0;
const hungIds = new Set<string>();
export async function stallMaybeHang(id: string, kind: string | undefined, attempts = 0): Promise<void> {
  const wanted = process.env.STALL_DEBUG_HANG_KIND;
  if (!wanted || kind !== wanted) return;
  const role = process.env.STALL_DEBUG_HANG_ROLE;
  const mine = !role || (process.env.GBRAIN_SQL_TRACE_LABEL ?? '').startsWith(role);
  if (mine) seenOfKind++;
  // Sticky: the chosen request hangs again whenever this process prepares it, and (budget builds) any request already cut once
  // hangs in every process, so a re-claim after a cut parks again the way the reporter's did.
  if (!(mine && seenOfKind === Number(process.env.STALL_DEBUG_HANG_AFTER ?? '40')) && !hungIds.has(id) && !(attempts > 0)) return;
  hungIds.add(id);
  hung.push({ id, since: Date.now() });
  process.stderr.write(`[stall-debug] HANG request ${id} (${kind}) parked forever in pid ${process.pid}\n`);
  await new Promise<never>(() => {});
}
stallRegister('hung', () => { const now = Date.now(); return hung.map(h => ({ ...h, age_ms: now - h.since })); });
stallRegister('sql_inflight', () => { const now = Date.now(); return [...sqlInflight.values()].map(s => ({ ...s, age_ms: now - s.since })); });
stallRegister('pools', stallPools);
'''

def edit(path, fn):
    with open(path) as f: text = f.read()
    new = fn(text)
    if new != text:
        with open(path, 'w') as f: f.write(new)
    return new != text

def ensure_import(text, line):
    if line in text: return text
    m = re.search(r"^import .*?;\n(?!import)", text, re.S | re.M)
    at = m.end() if m else 0
    return text[:at] + line + '\n' + text[at:]

report = []

# 1. the module
mod = P('stall-debug.ts')
if not os.path.exists(mod):
    with open(mod, 'w') as f: f.write(MODULE)
    report.append('added stall-debug.ts')

# 2. service.ts: wrap preparePersistedMutation; register the consumer status
def service(text):
    if 'preparePersistedMutationInner' in text: return text
    text = ensure_import(text, "import { stallDone, stallMark, stallMaybeHang, stallRegister } from './stall-debug.ts';")
    text = text.replace('export async function preparePersistedMutation(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {',
        'export async function preparePersistedMutation(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {\n'
        "  stallMark(row.request_id, `dispatch:${row.operation}:${row.intent?.kind ?? ''}`);\n"
        "  stallMark(row.request_id, 'debug_hang_check'); await stallMaybeHang(row.request_id, row.intent?.kind as string | undefined, Number((row as { preparation_attempts?: number }).preparation_attempts ?? 0));\n"
        '  try { return await preparePersistedMutationInner(e, row, cfg, signal); } finally { stallDone(row.request_id); }\n'
        '}\n'
        'async function preparePersistedMutationInner(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {', 1)
    m = re.search(r"(  const consumer = new PersistenceConsumer\(engine, config, preparePersistedMutation,.*?\);\n)", text, re.S)
    if m:
        text = text[:m.end()] + "  stallRegister('consumer', () => consumer.status());\n" + text[m.end():]
    else: report.append('service.ts: consumer registration anchor missing')
    return text
report.append(f"service.ts edited={edit(P('service.ts'), service)}")

# 3. sync-prepare.ts: a mark before each major await of prepareManagedSyncMutation
ANCHORS = [
    ('  await assertManagedSyncActive(engine);', 'sync_active'),
    ('  await validateSyncAuthority(engine, p.syncAuthority, row.slug);', 'authority'),
    ('  const binding = await getWorktreeBinding(engine, row.source_id);', 'binding'),
    ("  const [configuredSource] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [row.source_id]);", 'source_path'),
    ("  if (p.kind !== 'managed_sync_checkpoint') await assertKnowledgePublicationAllowed(engine, row,", 'knowledge_guard'),
    ("    originContext = { root, gitRoot: realpathSync(syncGit(root, ['rev-parse', '--show-toplevel']).trim()), target: p.target, slugMode: p.slugMode };", 'git_rev_parse'),
    ("    await assertSyncPageOrigin(engine, row.source_id, p.sourcePath, originPageId, p.kind === 'managed_sync_delete', originScope);", 'page_origin'),
    ('  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });', 'snapshot'),
    ('  const activePack = p.processingOptions?.noSchemaPack ? undefined', 'active_pack'),
    ('  const { screen, parsedInput, newerWorkingTree } = await settledSyncScreen(engine,', 'screen'),
    ('  const result = await importFromContent(engine, renamed?.slug ?? row.slug, importContent, { ...importOptions,', 'import_prepare'),
    ('  const project = await prepareCanonicalProjections(engine, ready.parsedPage, row.slug, row.source_id, base,', 'projections'),
    ('  const preparedImport: PreparedMutation = {', 'prepared'),
]
def sync_prepare(text):
    if "from './stall-debug.ts'" in text: return text
    text = ensure_import(text, "import { stallMark } from './stall-debug.ts';")
    for anchor, step in ANCHORS:
        lines = text.split('\n')
        hits = [i for i, l in enumerate(lines) if l.startswith(anchor)]
        if len(hits) != 1: report.append(f'sync-prepare.ts: anchor {step} matched {len(hits)}x, skipped'); continue
        indent = re.match(r'\s*', lines[hits[0]]).group(0)
        lines.insert(hits[0], f"{indent}stallMark(row.request_id, '{step}');")
        text = '\n'.join(lines)
    return text
report.append(f"sync-prepare.ts edited={edit(P('sync-prepare.ts'), sync_prepare)}")

# 4. prepared-maintenance.ts and page-prepare.ts: entry marks only (the dispatch wrapper already covers start/end)
def maintenance(text):
    if "from './stall-debug.ts'" in text: return text
    text = ensure_import(text, "import { stallMark } from './stall-debug.ts';")
    lines = text.split('\n')
    hits = [i for i, l in enumerate(lines) if l.startswith('export async function prepareMaintenanceMutation(')]
    if len(hits) == 1: lines.insert(hits[0] + 1, "  stallMark(row.request_id, `maintenance:${String(row.intent?.kind ?? '')}`);")
    else: report.append('prepared-maintenance.ts: entry anchor missing')
    return '\n'.join(lines)
if os.path.exists(P('prepared-maintenance.ts')): report.append(f"prepared-maintenance.ts edited={edit(P('prepared-maintenance.ts'), maintenance)}")


# 5. consumer.ts: the group claim path before executeClaimedGroup (#6317: head order, follower claim, group start)
def consumer(text):
    if "from './stall-debug.ts'" in text: return text
    text = ensure_import(text, "import { stallMark, stallDone } from './stall-debug.ts';")
    text = text.replace("    const order = await claimedHeadOrder(this.engine, row, lane !== null);",
        "    stallMark(row.request_id, 'consumer:head_order');\n    const order = await claimedHeadOrder(this.engine, row, lane !== null);\n    stallMark(row.request_id, `consumer:head_order_done:${order === 'wait' ? 'wait' : order ? 'cancel' : 'go'}`);", 1)
    text = text.replace("    const followers = await claimGroupFollowers(this.engine, row, group,",
        "    stallMark(row.request_id, 'consumer:claim_followers');\n    const followers = await claimGroupFollowers(this.engine, row, group,", 1)
    text = text.replace("      return await executeClaimedGroup(this.engine, rows, {",
        "      stallMark(row.request_id, `consumer:group_start:${rows.length}:${lane ? 'lane' : 'fifo'}`);\n      return await executeClaimedGroup(this.engine, rows, {", 1)
    text = text.replace("    } finally { for (const member of rows) this.executing.delete(member.id); }\n  }\n  /** Mandatory barrier",
        "    } finally { for (const member of rows) { this.executing.delete(member.id); stallDone(member.request_id); } stallDone(row.request_id); }\n  }\n  /** Mandatory barrier", 1)
    return text
report.append(f"consumer.ts edited={edit(P('consumer.ts'), consumer)}")

# 6. group-publish.ts: wave dispatch, lease outcome, publish entry (both the 0.60.110 and the budget shape)
def group_publish(text):
    if "from './stall-debug.ts'" in text: return text
    text = ensure_import(text, "import { stallMark } from './stall-debug.ts';")
    text = text.replace("          try { prepared[start + offset] = { ok: await run.prepare(row) }; }",
        "          stallMark(row.request_id, `group:dispatch:${start + offset}`);\n          try { prepared[start + offset] = { ok: await run.prepare(row) }; stallMark(row.request_id, 'group:prepared'); }", 1)
    text = text.replace("            return run.prepare(row, reads, undefined, clocks[i]);",
        "            stallMark(row.request_id, `group:dispatch:${i}`);\n            return run.prepare(row, reads, undefined, clocks[i]).then(value => { stallMark(row.request_id, 'group:prepared'); return value; });", 1)
    text = text.replace("    const preparing = (async () => {",
        "    for (const row of rows) stallMark(row.request_id, 'group:queued_in_group');\n    const preparing = (async () => {", 1)
    text = text.replace("  const lock = lane ? await acquireWorktreeShared(binding, engine)",
        "  for (const row of rows) stallMark(row.request_id, lane ? 'publish:acquire_worktree_shared' : 'publish:acquire_worktree');\n  const lock = lane ? await acquireWorktreeShared(binding, engine)", 1)
    text = text.replace("    if (lane) await awaitLaneBegin(lane, rows);\n    const done = await transaction(",
        "    if (lane) { for (const row of rows) stallMark(row.request_id, 'publish:await_lane_begin'); await awaitLaneBegin(lane, rows); }\n    for (const row of rows) stallMark(row.request_id, 'publish:transaction');\n    const done = await transaction(", 1)
    text = text.replace("    if (lane) await awaitLaneBegin(lane, rows);\n    const done = await engine.transaction(",
        "    if (lane) { for (const row of rows) stallMark(row.request_id, 'publish:await_lane_begin'); await awaitLaneBegin(lane, rows); }\n    for (const row of rows) stallMark(row.request_id, 'publish:transaction');\n    const done = await engine.transaction(", 1)
    return text
report.append(f"group-publish.ts edited={edit(P('group-publish.ts'), group_publish)}")

# 7. postgres-engine.ts: every raw statement and reserve while it is in flight in JS
PE = os.path.join(repo, 'src', 'core', 'postgres-engine.ts')
def postgres_engine(text):
    if "persistence/stall-debug.ts" in text: return text
    text = ensure_import(text, "import { stallSql } from './persistence/stall-debug.ts';")
    text = text.replace("        reserved = signal && typeof conn.reserve === 'function' ? await reserveWithCancellation(opts => conn.reserve(opts), signal) : undefined;",
        "        const __reserveDone = signal && typeof conn.reserve === 'function' ? stallSql(`RESERVE for ${sql}`, 'raw', true) : null;\n        try { reserved = signal && typeof conn.reserve === 'function' ? await reserveWithCancellation(opts => conn.reserve(opts), signal) : undefined; } finally { __reserveDone?.(); }", 1)
    text = text.replace("        pending = conn.unsafe(sql, params as Parameters<typeof conn.unsafe>[1], driverOpts);\n        return await pending as unknown as T[];",
        "        const __sqlDone = stallSql(sql, reserved ? 'raw:reserved' : this._pageTransaction ? 'tx' : 'raw', !!reserved);\n        try {\n          pending = conn.unsafe(sql, params as Parameters<typeof conn.unsafe>[1], driverOpts);\n          return await pending as unknown as T[];\n        } finally { __sqlDone(); }", 1)
    text = text.replace("      reserved = await pool.reserve();\n    } catch (e) {",
        "      const __reserveDone = stallSql('RESERVE withReservedConnection', 'reserved', true);\n      try { reserved = await pool.reserve(); } finally { __reserveDone(); }\n    } catch (e) {", 1)
    text = text.replace("      return await withHeldPageKeys(this._pageTransaction ? this._heldPageKeys : null, held => conn.begin(async (handle) => {",
        "      const __beginDone = this._pageTransaction ? null : stallSql('BEGIN (transaction checkout)', 'tx', true);\n      try { return await withHeldPageKeys(this._pageTransaction ? this._heldPageKeys : null, held => conn.begin(async (handle) => {\n        __beginDone?.();", 1)
    text = text.replace("        return fn(txEngine);\n      }) as Promise<T>);\n    } finally {\n      if (!this._pageTransaction) this.checkoutGauge.release('tx');",
        "        return fn(txEngine);\n      }) as Promise<T>); } finally { __beginDone?.(); }\n    } finally {\n      if (!this._pageTransaction) this.checkoutGauge.release('tx');", 1)
    return text
report.append(f"postgres-engine.ts edited={edit(PE, postgres_engine)}")

# 8. vendor/postgres/src/index.js: expose the pool queues and register every pool (debug only)
VP = os.path.join(repo, 'vendor', 'postgres', 'src', 'index.js')
def vendor_pool(text):
    if '__gbrainPools' in text: return text
    return text.replace("  Object.assign(sql, {\n    get parameters() { return options.parameters },",
        "  ;(globalThis.__gbrainPools ??= []).push(sql)\n  Object.assign(sql, {\n    queues,\n    get parameters() { return options.parameters },", 1)
report.append(f"vendor/postgres edited={edit(VP, vendor_pool)}")

print('\n'.join(report))
