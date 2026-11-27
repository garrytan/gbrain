/**
 * The brain id of the Rust store a swap moves to, which the plan binds and the swap run's server probe must find
 * (lane L5, B1; served-probe.ts).
 *
 * The destination store is `<shadow dir>/store`: the swap run switches this host's config to it (route.ts
 * `switchAuthority`), and the brain server on this host then serves it. The shadow child creates that store, and the
 * store mints its persistence brain id, the first time the shadow runs (src/shadow/child.ts `openRustStore`;
 * gbrain-store `Store::open_kv_in`), so the id exists long before a plan can read READY. The store also writes the id
 * to its `FORMAT` file, and an open refuses a FORMAT that names another brain than the records (`store_corrupt`), so
 * the FORMAT id is the id the served brain reports (`readPersistenceBrainId`). The plan reads that one file: the store
 * is never opened, and a store that does not exist is never created. It lives beside the shadow state, not in src/core,
 * because it reads the machine (scripts/check-core-world-reads.ts): the plan core takes the id as an argument.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toEngineConfig, type GBrainConfig } from '../core/config.ts';
import { shadowBrainKey, shadowDirFor } from './state.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Rust store a swap of the brain `config` selects moves to (the swap run's `rustStore`), or null with no brain. */
export function swapStoreDir(config: GBrainConfig): string | null {
  const key = shadowBrainKey(toEngineConfig(config));
  return key ? join(shadowDirFor(key), 'store') : null;
}

/** The brain id in `<store>/FORMAT`, or null when there is no such file or it names no brain id. Reads one file. */
export function readStoreBrainId(store: string): string | null {
  let raw: string;
  try { raw = readFileSync(join(store, 'FORMAT'), 'utf8'); } catch { return null; } // silent-read-ok: no FORMAT is no store id, which refuses
  try {
    const id = (JSON.parse(raw) as { brain_id?: unknown }).brain_id;
    return typeof id === 'string' && UUID.test(id) ? id : null;
  } catch { return null; } // silent-read-ok: an unreadable FORMAT is no store id, which refuses
}
