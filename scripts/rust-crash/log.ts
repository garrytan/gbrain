/**
 * The crash cell's worker log (scripts/rust-crash/README.md): one record per line, appended by the worker (`open`,
 * `start <i>`, `ack <i>`, `seam <point> <n>`, `freeze ...`, `error ...`, `done`) and by the store's crash points
 * (`write <n>`, `sync <n>`, `synced <n>`), each line in one write.
 */
import { existsSync, readFileSync } from 'node:fs';

export type Range = [number, number];
export interface LogState {
  acked: number; started: number; freeze: string | null; error: string | null; done: boolean; open: boolean;
  /** The store's crash event numbers seen after the first operation started, by kind. */
  events: Record<'write' | 'sync' | 'synced', Range | null>;
  /** The fault point occurrence numbers seen after the first operation started, by point. */
  seams: Map<string, Range>;
}

const widen = (seen: Range | null | undefined, n: number): Range => (seen ? [seen[0], n] : [n, n]);

export function readLog(path: string): LogState {
  const state: LogState = { acked: -1, started: -1, freeze: null, error: null, done: false, open: false,
    events: { write: null, sync: null, synced: null }, seams: new Map() };
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  // The text after the last newline is a line still being written (the driver polls while the worker runs, and the
  // store's background work keeps logging after an acknowledgement), or one a kill cut short. Neither is a record yet:
  // an ack cut short was never delivered, so its operation is still in flight.
  lines.pop();
  for (const line of lines) {
    if (line === '') continue;
    // A whole line is a whole record. One that is not (a torn write, a stray byte) is a harness failure, never skipped:
    // a lost `ack` line would make an acknowledged write look still in flight.
    if (!/^(open|done|(start|ack|write|sync|synced) \d+|seam \S+ \d+|freeze( \S+){2,3}|error .*)$/.test(line)) throw new Error(`the worker log holds a line that is not a record: ${line.slice(0, 80)}`);
    const [word, a, b] = line.split(' ');
    if (word === 'open') state.open = true;
    else if (word === 'start') state.started = Math.max(state.started, Number(a));
    else if (word === 'ack') state.acked = Math.max(state.acked, Number(a));
    else if (word === 'freeze') state.freeze = line;
    else if (word === 'error') state.error = line;
    else if (word === 'done') state.done = true;
    else if (state.started < 0) continue;
    else if (word === 'write' || word === 'sync' || word === 'synced') state.events[word] = widen(state.events[word], Number(a));
    else if (word === 'seam') state.seams.set(a!, widen(state.seams.get(a!), Number(b)));
  }
  return state;
}
