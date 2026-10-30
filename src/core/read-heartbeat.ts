/**
 * Slow whole-brain reads (sync status, sources status, doctor, orphans, anomalies, status, diag) tell their caller
 * what is happening while they run, so an agent whose harness cuts the command off cannot mistake silence for an
 * empty result:
 *
 * - one stderr line when the read starts, then one every 10 s while it runs (stdout stays the one result);
 * - the `--json` document carries `elapsed_ms` and `complete`, and `incomplete` lists each field a budget or
 *   bound left out (the existing markers: a `*_read` field with `status: 'not_read'`, `complete: false`,
 *   `items_complete: false`, `budget_hit: true`, a doctor check unknown for its budget);
 * - SIGTERM, SIGHUP or SIGINT before the result prints one stderr line and, under `--json`, one `interrupted`
 *   document saying how long it ran and that no result was read.
 *
 * One read per CLI process, so module state is safe.
 */

export const READ_HEARTBEAT_EVERY_MS = 10_000;

export interface IncompleteField { field: string; reason: 'not_read' | 'bounded' | 'budget' | 'error' }

interface ActiveRead {
  label: string;
  startedAt: number;
  json: boolean;
  timer: ReturnType<typeof setInterval> | null;
  sigint: (() => void) | null;
  writeErr: (line: string) => void;
}

let active: ActiveRead | null = null;
let interruptWriter: ((doc: Record<string, unknown>) => void) | null = null;

/** The CLI's stdout writer for the `interrupted` document (cli-force-exit.ts registers it, so this module imports nothing). */
export function setInterruptedDocumentWriter(write: ((doc: Record<string, unknown>) => void) | null): void { interruptWriter = write; }

const seconds = (ms: number) => Math.round(ms / 1000);

/**
 * Starts the heartbeat for one read. `json`: the caller asked for `--json` (an interrupt then writes the
 * `interrupted` document). Returns the function that ends the read.
 */
export function beginSlowRead(label: string, opts: { json: boolean; everyMs?: number; writeErr?: (line: string) => void; now?: () => number }): () => void {
  endSlowRead();
  const now = opts.now ?? Date.now;
  const writeErr = opts.writeErr ?? (line => { try { process.stderr.write(line + '\n'); } catch { /* stderr gone */ } });
  const read: ActiveRead = { label, startedAt: now(), json: opts.json, timer: null, sigint: null, writeErr };
  active = read;
  writeErr(`[gbrain] reading ${label}; large brains can take minutes. Progress prints here every ${seconds(opts.everyMs ?? READ_HEARTBEAT_EVERY_MS)} s; the result prints on stdout when it is ready.`);
  read.timer = setInterval(() => writeErr(`[gbrain] still reading ${label} (${seconds(now() - read.startedAt)} s so far); no result yet.`), opts.everyMs ?? READ_HEARTBEAT_EVERY_MS);
  read.timer.unref?.();
  if (process.listenerCount('SIGINT') === 0) {
    read.sigint = () => { noteInterrupted('SIGINT', now()); process.exit(130); };
    process.on('SIGINT', read.sigint);
  }
  return endSlowRead;
}

/** Ends the active read: the heartbeat stops and an interrupt no longer prints a note. Idempotent. */
export function endSlowRead(): void {
  if (!active) return;
  if (active.timer) clearInterval(active.timer);
  if (active.sigint) process.off('SIGINT', active.sigint);
  active = null;
}

/** Milliseconds since the active read started; null when none is active. */
export function slowReadElapsedMs(now = Date.now()): number | null {
  return active ? now - active.startedAt : null;
}

const MAX_NODES = 50_000;

/** Every field a budget or bound left out of `doc`, by path (`sources[0].holds_read`), from the existing markers. */
export function incompleteFields(doc: unknown): IncompleteField[] {
  const out: IncompleteField[] = [];
  let nodes = 0;
  const walk = (value: unknown, path: string, depth: number) => {
    if (value === null || typeof value !== 'object' || depth > 8 || ++nodes > MAX_NODES) return;
    if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1)); return; }
    const record = value as Record<string, unknown>;
    if (path && record.status === 'not_read') out.push({ field: path, reason: 'not_read' });
    if (path && record.health === 'unknown' && record.reason === 'budget') out.push({ field: path, reason: 'budget' });
    for (const [key, child] of Object.entries(record)) {
      const at = path ? `${path}.${key}` : key;
      if (child === false && (key === 'complete' || key.endsWith('_complete')) && at !== 'complete') out.push({ field: at, reason: 'bounded' });
      else if (child === true && key === 'budget_hit') out.push({ field: at, reason: 'budget' });
      else walk(child, at, depth + 1);
    }
  };
  walk(doc, '', 0);
  return out;
}

/**
 * The read's `--json` document with `elapsed_ms` (since the read started) and `complete` (false when the document
 * says it is paged or a field was not read; `incomplete` names each). A field the document already sets wins; an
 * error envelope gets `elapsed_ms` only; a non-object document (a bare array) is returned as is. Ends the read.
 */
export function withReadMeta<T>(doc: T, now = Date.now()): T {
  const elapsed = slowReadElapsedMs(now);
  endSlowRead();
  if (elapsed === null || doc === null || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const record = doc as Record<string, unknown>;
  // An error envelope read nothing: it gains the elapsed time, never a completeness claim.
  if (record.error !== undefined && record.error !== null) return (record.elapsed_ms === undefined ? { ...record, elapsed_ms: elapsed } : record) as T;
  const incomplete = incompleteFields(record);
  const complete = record.complete !== false && incomplete.length === 0;
  return { ...record, ...(record.elapsed_ms === undefined ? { elapsed_ms: elapsed } : {}), ...(record.complete === undefined ? { complete } : {}),
    ...(incomplete.length && record.incomplete === undefined ? { incomplete } : {}) } as T;
}

/**
 * A signal arrived while a read was active: one stderr line and, under `--json`, the `interrupted` document.
 * Returns false (and writes nothing) when no read is active.
 */
export function noteInterrupted(signal: string, now = Date.now()): boolean {
  const read = active;
  if (!read) return false;
  endSlowRead();
  const elapsedMs = now - read.startedAt;
  const message = `Interrupted by ${signal} after ${seconds(elapsedMs)} s while reading ${read.label}, before the result was ready. Nothing was read, so this is not an empty result.`;
  read.writeErr(`[gbrain] ${message} Re-run with a longer timeout; large brains can take minutes.`);
  if (read.json) {
    interruptWriter?.({ error: 'interrupted', code: 'interrupted', message,
      suggestion: 'Re-run the same command with a longer timeout (large brains can take minutes), or run `gbrain diag --json` for a bounded summary.',
      signal, read: read.label, elapsed_ms: elapsedMs, complete: false, contract_version: 1 });
  }
  return true;
}
