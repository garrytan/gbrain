/**
 * Kill switches for write-path behaviors, read from one per-process snapshot.
 *
 * Every switch is on by default unless its entry says `defaultOn: false`. An
 * environment variable overrides the brain config key; `0` or `false` (either
 * source) turns a switch off, `1` or `true` turns it on. The snapshot
 * reads every switch key in one statement and is reused for SWITCH_TTL_MS, so
 * `gbrain config set <key> false` reaches a running `serve` within that time
 * without a round trip per write. Config writes are trusted-local only (no
 * remote operation writes config), so a remote caller cannot flip a switch.
 */
import type { SqlEngine } from './model.ts';
import { DEFAULT_PREPARATION_POLICY, PREPARATION_BUDGET_CONFIG_KEYS, resolvePreparationPolicy, type PreparationPolicy } from './preparation-budget.ts';

export const WRITE_SWITCHES = {
  /** Phase 4.1/4.3/4.4: single page writes publish as a group of one, the own admission claims directly, publication reuses a warm connection. */
  single_write_group: { key: 'persistence.single_write_group', env: 'GBRAIN_SINGLE_WRITE_GROUP' },
  /** Phase 4.2: per-process cache of pre-admission reads that admission rechecks under lock. */
  preadmit_cache: { key: 'persistence.preadmit_cache', env: 'GBRAIN_PREADMIT_CACHE' },
  /** Batched waiver runs; `GBRAIN_SYNC_WAIVE_NOOP=0` wins over it. */
  waive_batch: { key: 'sync.waive_batch', env: 'GBRAIN_SYNC_WAIVE_BATCH' },
  /** Phase 4.5: a foreground write goes ahead of queued sync groups that do not name its page; off restores the FIFO and the sync side's pauses. */
  foreground_priority: { key: 'sync.foreground_priority', env: 'GBRAIN_SYNC_FOREGROUND_PRIORITY' },
  /** #6278: every preparation has a deadline and a counted attempt; off restores the 30 s budget for remember/put_page/edit_page only and never counts. */
  preparation_deadlines: { key: 'persistence.preparation_deadlines', env: 'GBRAIN_PREPARATION_DEADLINES' },
  /**
   * #6317 (B1): resident processes (`sync`, `jobs`, `autopilot`, `mcp`) defer to the first live full consumer of their host
   * (consumer-election.ts) instead of starting their own. Off by default until Phase 0's preregistered reading sets it.
   */
  single_consumer: { key: 'persistence.single_consumer', env: 'GBRAIN_SINGLE_CONSUMER', defaultOn: false },
} as const;
export type WriteSwitch = keyof typeof WRITE_SWITCHES;
export type WriteSwitches = Record<WriteSwitch, boolean>;
export const WRITE_SWITCH_KEYS: readonly string[] = Object.values(WRITE_SWITCHES).map(s => s.key);
export const SWITCH_TTL_MS = 5000;

const off = (value: string | null | undefined) => typeof value === 'string' && /^(0|false)$/i.test(value.trim());
const on = (value: string | null | undefined) => typeof value === 'string' && /^(1|true)$/i.test(value.trim());
/** One snapshot read: the switches plus the #6278 preparation budgets (preparation-budget.ts), so a claim never reads config on its own. */
export interface WriteSwitchSnapshot { switches: WriteSwitches; preparation: PreparationPolicy }
const snapshots = new WeakMap<object, { at: number; generation: number; read: Promise<WriteSwitchSnapshot> }>();
let generation = 0;
const SNAPSHOT_KEYS: readonly string[] = [...WRITE_SWITCH_KEYS, ...PREPARATION_BUDGET_CONFIG_KEYS];

function resolve(configured: Map<string, string>): WriteSwitchSnapshot {
  const out = {} as WriteSwitches;
  for (const [name, { key, env, defaultOn }] of Object.entries(WRITE_SWITCHES) as Array<[WriteSwitch, { key: string; env: string; defaultOn?: boolean }]>) {
    const fromEnv = process.env[env];
    const fromConfig = configured.get(key);
    out[name] = off(fromEnv) ? false : on(fromEnv) ? true : fromConfig === undefined ? defaultOn ?? true : !off(fromConfig);
  }
  return { switches: out, preparation: resolvePreparationPolicy(configured) };
}

/** Read-through views of an engine (preparation config, pre-admission cache) and the engine they read through. */
const views = new WeakMap<object, object>();
export function registerEngineView<T extends object>(view: T, engine: object): T { views.set(view, engine); return view; }
/** The engine a view reads through (itself when it is not a view), so a view shares its engine's snapshots and memos. */
export function viewedEngine<T extends object>(engine: T): T { return (views.get(engine) as T | undefined) ?? engine; }

/**
 * The switch snapshot of `engine`'s brain, at most SWITCH_TTL_MS old. A failed read is not kept.
 * `signal` cancels a read this call starts (the consumer's tick reads under its phase deadline).
 */
export function readWriteSwitches(viewed: SqlEngine, opts: { now?: () => number; signal?: AbortSignal } = {}): Promise<WriteSwitches> {
  return readWriteSwitchSnapshot(viewed, opts).then(snapshot => snapshot.switches);
}
/** The switches and the preparation budgets of `engine`'s brain, from the same snapshot. */
export function readWriteSwitchSnapshot(viewed: SqlEngine, opts: { now?: () => number; signal?: AbortSignal } = {}): Promise<WriteSwitchSnapshot> {
  const now = opts.now ?? Date.now;
  const engine = viewedEngine(viewed);
  const held = snapshots.get(engine);
  if (held && held.generation === generation && now() - held.at < SWITCH_TTL_MS) return held.read;
  const read = engine.executeRaw<{ key: string; value: string }>('SELECT key,value FROM config WHERE key = ANY($1::text[])', [SNAPSHOT_KEYS], { signal: opts.signal })
    .then(rows => resolve(new Map(rows.map(row => [row.key, row.value]))));
  snapshots.set(engine, { at: now(), generation, read });
  read.catch(() => { if (snapshots.get(engine)?.read === read) snapshots.delete(engine); });
  return read;
}
/** The preparation budgets in effect (defaults when the read fails). */
export async function readPreparationPolicy(engine: SqlEngine): Promise<PreparationPolicy> {
  return readWriteSwitchSnapshot(engine).then(snapshot => snapshot.preparation, () => ({ ...DEFAULT_PREPARATION_POLICY }));
}

export async function writeSwitchOn(engine: SqlEngine, name: WriteSwitch): Promise<boolean> {
  return (await readWriteSwitches(engine))[name];
}

/** Test seam: the next read of every engine sees the current config. */
export function resetWriteSwitches(): void { generation++; }
