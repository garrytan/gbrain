/**
 * #6712 PR 2 (L3): the `sync.*` config keys in three kinds.
 *
 * - Tunables: user intent a brain keeps (`config set` writes them, every sync reads them).
 * - Rollback keys: a published notice or migration names them as the way back from a default
 *   (`CONFIG_ROLLBACK_WINDOWS` in `src/core/wire-skew.ts` holds each one's window). They stay readable and honored,
 *   but they are not tunables: `config set` says so, and help text and printed fixes never recommend them.
 * - Retired keys: no longer read. Each names its replacement (a `GBRAIN_SYNC_*` environment variable read by the
 *   process that syncs, or nothing when the behavior itself was removed). `config set` warns and writes nothing,
 *   `config get` prints the value in effect and where it comes from, and doctor (`sync_config_keys`) reports a value
 *   stored before the upgrade as unapplied.
 */
import { CONFIG_ROLLBACK_WINDOWS, type ConfigRollbackWindow } from './wire-skew.ts';

export const SYNC_TUNABLE_KEYS = ['sync.bulk_size', 'sync.lanes', 'sync.exclude', 'sync.include_hidden', 'sync.include_working_tree', 'sync.holds',
  'sync.write_through', 'sync.cost_gate_min_usd', 'sync.on_commit', 'sync.freshness_target_seconds'] as const;

/**
 * #6858 ask 6, option C (Garry's "rec", via GBRA-108): a resident serve starts a managed source's sync when its
 * checkout's HEAD moves (serve-head-watcher.ts). Off by default. `sync.freshness_target_seconds` (default 300) is the
 * p95 commit→searchable target doctor `managed_sync_latency` grades against (persistence/sync-freshness.ts).
 */
export const SYNC_ON_COMMIT_KEY = 'sync.on_commit';
export const SYNC_FRESHNESS_TARGET_KEY = 'sync.freshness_target_seconds';

export interface RetiredSyncKey {
  key: string;
  retired_in: string;
  /** What the key tuned, in the words `config get` and doctor print. */
  tuned: string;
  /** The environment variable that replaces it and the value in effect without one; null when the behavior was removed. */
  replacement: { env: string; default: string } | null;
}

export const RETIRED_SYNC_KEYS = {
  'sync.bulk_max_txn_ms': { key: 'sync.bulk_max_txn_ms', retired_in: '0.60.266.0', tuned: 'the target time of one bulk group without lanes, in ms',
    replacement: { env: 'GBRAIN_SYNC_BULK_MAX_TXN_MS', default: '15000' } },
  'sync.hold_cap': { key: 'sync.hold_cap', retired_in: '0.60.266.0', tuned: 'how many held files a sync result lists in detail',
    replacement: { env: 'GBRAIN_SYNC_HOLD_CAP', default: '500' } },
  'sync.hold_escalate_count': { key: 'sync.hold_escalate_count', retired_in: '0.60.266.0', tuned: 'the held-file count above which a source escalates',
    replacement: { env: 'GBRAIN_SYNC_HOLD_ESCALATE_COUNT', default: '50' } },
  'sync.hold_escalate_pct': { key: 'sync.hold_escalate_pct', retired_in: '0.60.266.0', tuned: 'the share of a run\'s screened imports above which it escalates, in percent',
    replacement: { env: 'GBRAIN_SYNC_HOLD_ESCALATE_PCT', default: '5' } },
  'sync.parser_regression': { key: 'sync.parser_regression', retired_in: '0.60.266.0', tuned: 'whether sync stops (stop) or holds the file (hold) when bytes that imported before are refused',
    replacement: { env: 'GBRAIN_SYNC_PARSER_REGRESSION', default: 'stop' } },
  'sync.knock_on_refreeze_limit': { key: 'sync.knock_on_refreeze_limit', retired_in: '0.60.255.0', tuned: 'the knock-on re-freeze budget', replacement: null },
  'sync.knock_on_run_limit': { key: 'sync.knock_on_run_limit', retired_in: '0.60.255.0', tuned: 'the knock-on re-freeze budget per run', replacement: null },
} as const satisfies Record<string, RetiredSyncKey>;

export type RetiredSyncKeyName = keyof typeof RETIRED_SYNC_KEYS;
export const SYNC_ROLLBACK_KEYS = Object.keys(CONFIG_ROLLBACK_WINDOWS) as Array<keyof typeof CONFIG_ROLLBACK_WINDOWS>;

export function retiredSyncKey(key: string): RetiredSyncKey | null {
  return (RETIRED_SYNC_KEYS as Record<string, RetiredSyncKey>)[key] ?? null;
}
export function rollbackSyncKey(key: string): ConfigRollbackWindow | null {
  return (CONFIG_ROLLBACK_WINDOWS as Record<string, ConfigRollbackWindow>)[key] ?? null;
}

/** The value a retired key's replacement puts in effect: its environment variable, else the built-in default. */
export function retiredSyncSetting(key: RetiredSyncKeyName, env: NodeJS.ProcessEnv = process.env): string {
  const replacement = (RETIRED_SYNC_KEYS[key] as RetiredSyncKey).replacement!;
  const value = env[replacement.env]?.trim();
  return value ? value : replacement.default;
}

const isOff = (value: string | null | undefined) => typeof value === 'string' && /^(0|false)$/i.test(value.trim());
const isOn = (value: string | null | undefined) => typeof value === 'string' && /^(1|true)$/i.test(value.trim());
const exactOff = (value: string) => value === '0' || value === 'false';

/** How each rollback key resolves at runtime (the readers' own rules), so `config get` reports what a sync does. */
const ROLLBACK_RESOLVERS: Record<keyof typeof CONFIG_ROLLBACK_WINDOWS, { env?: string; resolve: (stored: string | null, envValue: string | undefined) => { on: boolean; from: 'env' | 'config' | 'default' } }> = {
  // sync-group.ts resolveGrouping: a non-empty env wins; `0`/`false` exactly turn it off.
  'sync.bulk': { env: 'GBRAIN_SYNC_BULK', resolve: (stored, envValue) => envValue ? { on: !exactOff(envValue), from: 'env' } : stored !== null ? { on: !exactOff(stored), from: 'config' } : { on: true, from: 'default' } },
  // sync-waivers.ts waiverBatchEnabled: env ?? config; `0`/`false` exactly turn it off.
  'sync.waive_batch': { env: 'GBRAIN_SYNC_WAIVE_BATCH', resolve: (stored, envValue) => envValue !== undefined ? { on: !exactOff(envValue), from: 'env' } : stored !== null ? { on: !exactOff(stored), from: 'config' } : { on: true, from: 'default' } },
  // persistence/switches.ts: env `0|false|1|true` (any case) wins, else config, else on.
  'sync.foreground_priority': { env: 'GBRAIN_SYNC_FOREGROUND_PRIORITY', resolve: (stored, envValue) => isOff(envValue) || isOn(envValue) ? { on: isOn(envValue), from: 'env' }
    : stored !== null ? { on: !isOff(stored), from: 'config' } : { on: true, from: 'default' } },
  // feature-flags.ts and handlers/sync-job-drain.ts: exactly `false` turns it off.
  'sync.federated_v2': { resolve: stored => stored !== null ? { on: stored !== 'false', from: 'config' } : { on: true, from: 'default' } },
  'sync.job_drain': { resolve: stored => stored !== null ? { on: stored !== 'false', from: 'config' } : { on: true, from: 'default' } },
};

export interface EffectiveSyncKey {
  /** The value a sync runs with (stdout of `config get`). */
  value: string;
  /** Where it comes from, one line (stderr of `config get`). */
  origin: string;
}

/** The value in effect for a retired or rollback key and where it comes from; null for any other key. */
export function effectiveSyncKey(key: string, stored: string | null, env: NodeJS.ProcessEnv = process.env): EffectiveSyncKey | null {
  const retired = retiredSyncKey(key);
  if (retired) {
    const unapplied = stored !== null ? ` The stored ${key}=${stored} is not applied.` : '';
    if (!retired.replacement) return { value: 'removed', origin: `${key} was retired in ${retired.retired_in} with ${retired.tuned}; nothing replaces it.${unapplied}` };
    const fromEnv = env[retired.replacement.env]?.trim();
    return { value: fromEnv || retired.replacement.default,
      origin: `${fromEnv ? `environment ${retired.replacement.env}` : `built-in default (${retired.replacement.env} unset)`}: ${key} was retired in ${retired.retired_in}; `
        + `set ${retired.replacement.env} for the process that syncs to change ${retired.tuned}.${unapplied}` };
  }
  const window = rollbackSyncKey(key);
  if (!window) return null;
  const resolver = ROLLBACK_RESOLVERS[key as keyof typeof CONFIG_ROLLBACK_WINDOWS];
  const { on, from } = resolver.resolve(stored, resolver.env ? env[resolver.env] : undefined);
  const where = from === 'env' ? `environment ${resolver.env}` : from === 'config' ? 'brain config' : 'default';
  return { value: String(on), origin: `${where}: ${key} is a rollback key, not a tunable; false restores ${window.restores}. Honored until at least ${window.honored_until} (named in ${window.named_in}).` };
}

/** The `config set` warning for a retired or rollback key (null for any other key); `writes` says whether the value is stored. */
export function syncKeySetNotice(key: string): { writes: boolean; lines: string[] } | null {
  const retired = retiredSyncKey(key);
  if (retired) return { writes: false, lines: [
    `[config] WARN: ${key} was retired in ${retired.retired_in} and is no longer read; nothing was written.`,
    retired.replacement
      ? `[config] To change ${retired.tuned}, set ${retired.replacement.env}=<value> in the environment of the process that syncs (the serve, the cron line or the shell); default ${retired.replacement.default}.`
      : `[config] ${retired.tuned} was removed with the behavior it tuned; nothing replaces it.`,
  ] };
  const window = rollbackSyncKey(key);
  if (window) return { writes: true, lines: [
    `[config] note: ${key} is a rollback key, not a tunable: false restores ${window.restores}. It is honored until at least ${window.honored_until} (named in ${window.named_in}); after that a release may stop reading it.`,
  ] };
  return null;
}

/**
 * `gbrain config get|set` of a retired or rollback key. `get` prints the value in effect (stdout) and its origin
 * (stderr); `set` prints the key's notice. True when the command is done: every `get`, and the `set` of a retired key,
 * which writes nothing. A rollback key's `set` returns false so the write goes ahead; any other key returns false.
 */
export async function handleSyncKeyConfig(engine: { getConfig(key: string): Promise<string | null> }, action: 'get' | 'set', key: string): Promise<boolean> {
  if (!retiredSyncKey(key) && !rollbackSyncKey(key)) return false;
  if (action === 'set') {
    const notice = syncKeySetNotice(key)!;
    for (const line of notice.lines) console.error(line);
    return !notice.writes;
  }
  const effective = effectiveSyncKey(key, await engine.getConfig(key))!;
  console.log(effective.value);
  console.error(`[config] source: ${effective.origin}`);
  return true;
}
