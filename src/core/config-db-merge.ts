/**
 * #2119-class DB-plane read-side merge (also #2137/#4297).
 *
 * DB-plane values that `gbrain config set` accepted for years, `config get`
 * echoed back, and NOTHING read: provider credentials, chat/expansion model
 * pins, the chat fallback chain, and flat `cycle.*` knobs. This module owns
 * their sparse-merge into the loaded config — called by
 * `loadConfigWithEngine()` (src/core/config.ts) after its per-key merges,
 * with the same precedence: env > file > DB.
 *
 * Sibling module (not inlined in config.ts) per the module-size ratchet;
 * runtime dependency direction is config.ts → here (the GBrainConfig import
 * below is type-only, erased at compile time — no cycle).
 *
 * NEVER merged from the DB: `embedding_model` / `embedding_dimensions`. They
 * size the schema, must be stable across engine connect, and `gbrain config
 * set` hard-refuses them — a stale DB row must not resurrect the plane-split
 * footgun the #4287 fixes closed. Do not add them to any list here.
 */

import type { GBrainConfig } from './config.ts';

/**
 * The provider-credential fields sparse-merged from the DB plane. `gbrain
 * config set <vendor>_api_key` routes NEW writes to the file plane
 * (FILE_PLANE_API_KEYS in src/commands/config.ts, kept in sync by
 * test/loadConfig-merge.test.ts), but values that reached the DB anyway —
 * pre-routing writes, direct `engine.setConfig`, remote setups — used to be
 * accepted, echoed back by `config get`, and read by nothing. Merging them
 * makes the DB copy honest instead of a lie. Env presence is already folded
 * into the base config by the sync `loadConfig()` (and for the provider keys
 * it doesn't fold, `mergedProviderEnv` gives process-env precedence
 * downstream anyway), so `merged[field] === undefined` means neither env nor
 * file spoke and the DB may fill in.
 */
export const DB_MERGED_PROVIDER_KEY_FIELDS = [
  'openai_api_key',
  'anthropic_api_key',
  'zeroentropy_api_key',
  'openrouter_api_key',
  'voyage_api_key',
  'dashscope_api_key',
  'google_api_key',
  'azure_openai_api_key',
] as const;

/**
 * Minimal engine surface this module reads. `executeRaw` is optional so the
 * narrow `{ getConfig, listConfigKeys? }` fakes in test/loadConfig-merge.test.ts
 * (and any SDK caller wiring a thin config reader) keep working — they take
 * the per-key fallback path below.
 */
export interface DbPlaneEngineReader {
  getConfig(key: string): Promise<string | null | undefined>;
  listConfigKeys?(prefix: string): Promise<string[]>;
  executeRaw?<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]>;
}

/** The flat scalar keys the batched read fetches (plus the `cycle.` prefix). */
const DB_MERGED_SCALAR_KEYS: readonly string[] = [
  ...DB_MERGED_PROVIDER_KEY_FIELDS,
  'expansion_model',
  'chat_model',
  'chat_fallback_chain',
];

const CYCLE_PREFIX = 'cycle.';

/**
 * D2 remediation: this merge used to issue ~12 sequential `engine.getConfig`
 * SELECTs per loadConfigWithEngine call (which runs twice per uncached
 * search) — up to ~2s of added latency on remote Postgres. The fetched
 * key→value map is memoized per engine handle for ~30s, mirroring
 * write-through.ts's `sync.write_through` flag memo: these values change at
 * human speed, and a config write lands in a fresh process (one-shot CLI) or
 * becomes visible within the TTL (long-lived server). Fail-open: a read
 * error yields an empty map (file/env defaults win) and never throws.
 */
export const DB_MERGE_MEMO_TTL_MS = 30_000;
type DbMergeMemoEntry = { at: number; values: Map<string, string> };
let dbMergeMemo = new WeakMap<object, DbMergeMemoEntry>();
let nowFn: () => number = Date.now;

/**
 * Test seam: drop the memo (and optionally inject a clock) so config changes
 * are visible immediately and TTL behavior is pinnable without real sleeps.
 */
export function _resetDbPlaneMergeMemoForTests(now?: () => number): void {
  dbMergeMemo = new WeakMap();
  nowFn = now ?? Date.now;
}

/**
 * Fetch every DB-plane value this module merges, in ONE round trip when the
 * engine exposes `executeRaw` (`key = ANY($1) OR key LIKE 'cycle.%'`), else
 * via the legacy per-key `getConfig` walk. Empty-string values are treated
 * as unset (dbStr semantics). Quiet-failure: a missing config table
 * (pre-v36 brain mid-migration) yields an empty map and file/env wins.
 */
async function readDbPlaneMergeValues(
  engine: DbPlaneEngineReader,
): Promise<Map<string, string>> {
  const cached = dbMergeMemo.get(engine);
  if (cached && nowFn() - cached.at < DB_MERGE_MEMO_TTL_MS) return cached.values;

  const values = new Map<string, string>();
  if (typeof engine.executeRaw === 'function') {
    try {
      const rows = await engine.executeRaw<{ key: string; value: string | null }>(
        `SELECT key, value FROM config WHERE key = ANY($1) OR key LIKE 'cycle.%'`,
        [[...DB_MERGED_SCALAR_KEYS]],
      );
      for (const row of rows) {
        if (typeof row.key !== 'string') continue;
        if (row.value == null || row.value === '') continue;
        values.set(row.key, row.value);
      }
    } catch {
      // quiet failure — merge no-ops, config load proceeds on file/env
    }
  } else {
    for (const key of DB_MERGED_SCALAR_KEYS) {
      try {
        const v = await engine.getConfig(key);
        if (v !== undefined && v !== null && v !== '') values.set(key, v);
      } catch {
        // quiet failure per key
      }
    }
    if (typeof engine.listConfigKeys === 'function') {
      try {
        for (const key of await engine.listConfigKeys(CYCLE_PREFIX)) {
          if (!key.startsWith(CYCLE_PREFIX)) continue;
          const v = await engine.getConfig(key).catch(() => undefined);
          if (v !== undefined && v !== null && v !== '') values.set(key, v);
        }
      } catch {
        // quiet failure — no cycle merge this load
      }
    }
  }
  dbMergeMemo.set(engine, { at: nowFn(), values });
  return values;
}

/**
 * Apply the #2119 read-side merges to `merged` IN PLACE (matches the
 * mutate-`merged` style of every other branch in loadConfigWithEngine).
 * All DB values come from ONE batched, ~30s-memoized read (see
 * readDbPlaneMergeValues); a missing config table yields no values and
 * file/env defaults win.
 */
export async function applyDbPlaneReadSideMerge(
  merged: GBrainConfig,
  engine: DbPlaneEngineReader,
): Promise<void> {
  const values = await readDbPlaneMergeValues(engine);

  const dbMergedStringFields = [
    ...DB_MERGED_PROVIDER_KEY_FIELDS,
    'expansion_model',
    'chat_model',
  ] as const;
  for (const field of dbMergedStringFields) {
    if (merged[field] !== undefined) continue;
    const v = values.get(field);
    if (v !== undefined) merged[field] = v;
  }

  // chat_fallback_chain — stored as a string in the DB plane. Accept the same
  // comma-separated form the GBRAIN_CHAT_FALLBACK_CHAIN env var uses, plus a
  // JSON string-array (what a tooling writer would naturally store). A
  // malformed JSON payload warns and is ignored (mirrors embedding_columns);
  // an empty chain is treated as unset, never `[]` — no value → no field,
  // the same container discipline as every other merge branch.
  if (merged.chat_fallback_chain === undefined) {
    const rawChain = values.get('chat_fallback_chain');
    if (rawChain !== undefined) {
      let chain: string[] | undefined;
      if (rawChain.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(rawChain);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
            chain = parsed.map((s) => s.trim()).filter(Boolean);
          } else {
            console.warn('[gbrain] config: chat_fallback_chain DB value is not a JSON array of strings; ignoring');
          }
        } catch (err) {
          console.warn(`[gbrain] config: chat_fallback_chain DB value is not valid JSON; ignoring (${(err as Error).message})`);
        }
      } else {
        chain = rawChain.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (chain !== undefined && chain.length > 0) {
        merged.chat_fallback_chain = chain;
      }
    }
  }

  // Flat cycle.* merge (#2137/#4297 read-side), fed by the same batched read
  // (`key LIKE 'cycle.%'` arm); leaves keep their raw string values (each
  // consumer owns its parse, same contract as reading engine.getConfig
  // directly). Per-leaf precedence file > DB, mirroring provider_base_urls.
  const dbCycle: Record<string, string> = {};
  for (const key of [...values.keys()].sort()) {
    if (!key.startsWith(CYCLE_PREFIX)) continue;
    const leaf = key.slice(CYCLE_PREFIX.length);
    if (!leaf) continue;
    dbCycle[leaf] = values.get(key)!;
  }
  if (Object.keys(dbCycle).length > 0) {
    const nextCycle: Record<string, string> = { ...(merged.cycle ?? {}) };
    for (const [leaf, value] of Object.entries(dbCycle)) {
      if (nextCycle[leaf] === undefined) nextCycle[leaf] = value;
    }
    merged.cycle = nextCycle;
  }
}
