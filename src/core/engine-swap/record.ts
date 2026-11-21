/**
 * The persisted run record of `gbrain engine swap --to rust --yes` (docs/designs/RUST_ENGINE.md "Swap and the way
 * back"): one JSON file per brain, 0600, replaced atomically at every state change, under
 * `<gbrain home>/.gbrain/engine-swap/<brain key>/`. `--status` reads it without opening any engine, and `--resume`
 * continues from its state. It holds no secret: paths, hashes, counts and the run's own ids.
 *
 * Writes go through `SwapFs`, whose default is the real filesystem. Tests replace it to inject a full disk; nothing
 * in production can.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../config.ts';

export const SWAP_RECORD_VERSION = 1;

/** The persisted states, in order. `succeeded` is reported only after the route probe passed. */
export const SWAP_STATES = ['planned', 'checkpointed', 'fenced', 'verified', 'switched', 'succeeded'] as const;
export type SwapState = typeof SWAP_STATES[number];

export interface SwapRecord {
  version: typeof SWAP_RECORD_VERSION;
  run_id: string;
  plan_hash: string;
  policy_hash: string;
  brain: { key: string; engine: string; database_path: string };
  rust_store: string;
  shadow_dir: string;
  state: SwapState;
  started_at: string;
  updated_at: string;
  checkpoint?: { path: string; sha256: string; bytes: number; tables: Record<string, number> };
  fence?: { tables: number; drained: number; at: string };
  verify?: {
    passes: Array<{ id: string; repaired_rows: number; error: string | null }>;
    digests: Array<{ relation: string; rows: number; primary: string; rust: string }>;
    allocators: Array<{ relation: string; counter: string; floor: string | null; ok: boolean }>;
    probe: string;
    at: string;
  };
  switch?: { previous: { engine: string; database_path: string }; at: string };
  probe?: { effective_engine: string | null; database_path: string | null; ok: boolean; at: string };
  /** The last failure: the state it stopped at, its code and a diagnostic id (never a value). */
  error?: { state: SwapState; code: string; reason: string | null; diagnostic_id: string; at: string } | null;
}

/** The filesystem calls the record makes; tests replace them, production never does. */
export interface SwapFs {
  open(path: string): number;
  write(fd: number, data: string | Uint8Array): void;
  fsync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
}

export const REAL_FS: SwapFs = {
  open: path => openSync(path, 'w', 0o600),
  write: (fd, data) => { if (typeof data === 'string') writeSync(fd, data); else writeSync(fd, data); },
  fsync: fd => fsyncSync(fd),
  close: fd => closeSync(fd),
  rename: (from, to) => renameSync(from, to),
};

export function swapRunDir(brainKey: string): string {
  return join(configDir(), 'engine-swap', brainKey);
}

export function swapRecordPath(brainKey: string): string {
  return join(swapRunDir(brainKey), 'run.json');
}

export function readSwapRecord(path: string): SwapRecord | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const record = JSON.parse(text) as SwapRecord;
  if (record.version !== SWAP_RECORD_VERSION || !SWAP_STATES.includes(record.state)) {
    throw new Error(`${path} is not a swap run record this gbrain reads`);
  }
  return record;
}

/** Atomic replace: write a temp file, fsync it, rename over the record, fsync the directory. */
export function writeSwapRecord(path: string, record: SwapRecord, fs: SwapFs = REAL_FS): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = fs.open(tmp);
  try {
    fs.write(fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsync(fd);
  } finally {
    fs.close(fd);
  }
  fs.rename(tmp, path);
  try { const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* a platform without directory fsync */ }
}

/** The state after `state` in the run's order. */
export function nextState(state: SwapState): SwapState | null {
  const i = SWAP_STATES.indexOf(state);
  return i >= 0 && i < SWAP_STATES.length - 1 ? SWAP_STATES[i + 1]! : null;
}
