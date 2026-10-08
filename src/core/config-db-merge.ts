/**
 * #2119-class DB-plane read-side merge (also #2137/#4297).
 *
 * DB-plane values that `gbrain config set` accepted for years, `config get`
 * echoed back, and NOTHING read: provider credentials, chat/expansion model
 * pins, the chat fallback chain and its refusal switch, provider chat options,
 * and flat `cycle.*` knobs. This module owns
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
  'openrouter_api_key',
  'voyage_api_key',
  'dashscope_api_key',
  'deepseek_api_key',
  'litellm_api_key',
  'together_api_key',
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
  /** One-round-trip whole-table read (see config-snapshot.ts). Optional so
   *  narrow readers and SDK callers keep working on the per-key path. */
  getAllConfig?(): Promise<Record<string, string>>;
  executeRaw?<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]>;
}

/**
 * The DB-plane `chat_fallback_chain` string: the comma-separated form the
 * GBRAIN_CHAT_FALLBACK_CHAIN env var uses, or a JSON string array. `error`
 * names why a JSON payload was rejected (doctor reports it); an empty chain
 * is no chain.
 */
export function parseDbChatFallbackChain(raw: string): { chain?: string[]; error?: string } {
  if (!raw.trim().startsWith('[')) {
    const chain = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return chain.length > 0 ? { chain } : {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) return { error: 'is not a JSON array of strings' };
    const chain = parsed.map((s) => s.trim()).filter(Boolean);
    return chain.length > 0 ? { chain } : {};
  } catch (err) {
    return { error: `is not valid JSON (${(err as Error).message})` };
  }
}

/** The root keys the batched read fetches (plus cycle/chat-option prefixes). */
const DB_MERGED_SCALAR_KEYS: readonly string[] = [
  ...DB_MERGED_PROVIDER_KEY_FIELDS,
  'expansion_model',
  'chat_model',
  'chat_fallback_chain',
  'chat_fallback_on_refusal',
  'provider_chat_options',
];

const CYCLE_PREFIX = 'cycle.';

function optionsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeOptionKey(key: string): boolean {
  return key !== '' && !['__proto__', 'constructor', 'prototype'].includes(key);
}

/** Merge nested option objects; arrays/scalars (including false/0/null) are leaves. */
function overlayOptions(low: Record<string, unknown>, high: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const source of [low, high]) {
    for (const [key, value] of Object.entries(source)) {
      if (!safeOptionKey(key) || value === undefined) continue;
      next[key] = optionsObject(value)
        ? overlayOptions(optionsObject(next[key]) ? next[key] : {}, value)
        : value;
    }
  }
  return next;
}

/**
 * DB root JSON supplies defaults; dotted rows override those defaults, then
 * the file plane wins per leaf. Selector IDs in root JSON stay literal (a
 * model may contain dots). A declared selector is matched longest-first;
 * otherwise the first dot separates the recipe/model from its option path.
 * Use the root JSON form for otherwise ambiguous dotted model IDs, e.g.
 * config set provider_chat_options '{"openai:gpt-5.4":{"reasoningEffort":"none"}}'.
 */
function mergeProviderChatOptions(merged: GBrainConfig, values: Map<string, string>): void {
  let db: Record<string, unknown> = {};
  const root = values.get('provider_chat_options');
  if (root !== undefined) {
    try {
      const parsed: unknown = JSON.parse(root);
      if (optionsObject(parsed)) db = overlayOptions({}, parsed);
      else console.warn('[gbrain] config: provider_chat_options DB value is not a JSON object; ignoring');
    } catch {
      console.warn('[gbrain] config: provider_chat_options DB value is not valid JSON; ignoring');
    }
  }
  const selectors = [...new Set([...Object.keys(db), ...Object.keys(merged.provider_chat_options ?? {})])]
    .filter(safeOptionKey).sort((a, b) => b.length - a.length);
  for (const [key, raw] of [...values.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!key.startsWith('provider_chat_options.')) continue;
    const suffix = key.slice('provider_chat_options.'.length);
    const selector = selectors.find(id => suffix === id || suffix.startsWith(`${id}.`)) ?? suffix.split('.')[0];
    const path = suffix === selector ? [] : suffix.slice(selector.length + 1).split('.');
    if (!safeOptionKey(selector) || !path.every(safeOptionKey)) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }
    if (path.length === 0) {
      if (optionsObject(value)) db[selector] = overlayOptions(optionsObject(db[selector]) ? db[selector] : {}, value);
      continue;
    }
    if (!optionsObject(db[selector])) db[selector] = {};
    let target = db[selector] as Record<string, unknown>;
    for (const part of path.slice(0, -1)) {
      if (!optionsObject(target[part])) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[path[path.length - 1]] = optionsObject(value) ? overlayOptions({}, value) : value;
  }
  // Reject malformed selector containers rather than sending them to the SDK.
  db = Object.fromEntries(Object.entries(db).filter(([, value]) => optionsObject(value)));
  if (Object.keys(db).length > 0) {
    merged.provider_chat_options = overlayOptions(db, merged.provider_chat_options ?? {}) as NonNullable<GBrainConfig['provider_chat_options']>;
  }
}

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
 * engine exposes `executeRaw` (root keys plus cycle/chat-option prefixes), else
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
        `SELECT key, value FROM config WHERE key = ANY($1) OR key LIKE 'cycle.%' OR key LIKE 'provider_chat_options.%'`,
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
      for (const prefix of [CYCLE_PREFIX, 'provider_chat_options.']) {
        try {
          for (const key of await engine.listConfigKeys(prefix)) {
            if (!key.startsWith(prefix)) continue;
            const v = await engine.getConfig(key).catch(() => undefined);
            if (v !== undefined && v !== null && v !== '') values.set(key, v);
          }
        } catch {
          // quiet failure per prefix — healthy siblings can still merge
        }
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
  mergeProviderChatOptions(merged, values);

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
      const parsed = parseDbChatFallbackChain(rawChain);
      if (parsed.error) console.warn(`[gbrain] config: chat_fallback_chain DB value ${parsed.error}; ignoring`);
      if (parsed.chain) merged.chat_fallback_chain = parsed.chain;
    }
  }
  // chat_fallback_on_refusal — 'true' / 'false' (strict); any other DB value is ignored.
  if (merged.chat_fallback_on_refusal === undefined) {
    const rawOnRefusal = values.get('chat_fallback_on_refusal');
    if (rawOnRefusal === 'true' || rawOnRefusal === 'false') merged.chat_fallback_on_refusal = rawOnRefusal === 'true';
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
