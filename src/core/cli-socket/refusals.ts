/**
 * Refusal counts of the warm CLI socket, for doctor `cli_socket_refusals`. A refused CLI call takes its cold path,
 * several times slower, so a caller whose environment drifted from the serve's pays that on every call. The serve
 * counts each refusal by the identity part that differed (never its value) and keeps the counts in
 * `<run dir>/cli-socket-refusals.json` (0600, written at most once per FLUSH_MS and when the serve closes); doctor
 * reads that file. Best-effort: a write that fails is retried at the next refusal and never affects an answer.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REFUSALS_FILE = 'cli-socket-refusals.json';
const FLUSH_MS = 5_000;

export interface RefusalPart { count: number; first_at: string; last_at: string }
export interface RefusalRecord { v: 1; pid: number; started_at: string; parts: Record<string, RefusalPart> }

export interface RefusalCounter { record(part: string): void; flush(): void }

export function refusalCounter(dir: string, now: () => Date = () => new Date()): RefusalCounter {
  const state: RefusalRecord = { v: 1, pid: process.pid, started_at: now().toISOString(), parts: {} };
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    const path = join(dir, REFUSALS_FILE);
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(state) + '\n', { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      dirty = false;
    } catch { /* retried at the next refusal */ }
  };
  return {
    record(part) {
      const at = now().toISOString();
      const entry = state.parts[part];
      state.parts[part] = entry ? { ...entry, count: entry.count + 1, last_at: at } : { count: 1, first_at: at, last_at: at };
      dirty = true;
      if (!timer) { timer = setTimeout(flush, FLUSH_MS); timer.unref(); }
    },
    flush,
  };
}

/** The newest serve's counts, or null when no serve recorded a refusal (or the file is unreadable). */
export function readRefusals(dir: string): RefusalRecord | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, REFUSALS_FILE), 'utf8')) as RefusalRecord;
    if (value?.v !== 1 || typeof value.parts !== 'object' || value.parts === null) return null;
    return value;
  } catch {
    return null;
  }
}
