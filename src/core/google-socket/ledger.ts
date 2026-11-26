/**
 * The broker's durable state, kept beside the socket under GBRAIN_HOME (0600,
 * atomic writes): each intent's status by idempotency key, replayed for 24
 * hours, and the per-product daily call count. No arguments, results or
 * tokens are stored, only hashes and outcome codes. One process owns it: the
 * socket's bind lock admits a single server per GBRAIN_HOME.
 *
 * The audit log (`$GBRAIN_HOME/logs/google-mint.log`, 0600) gets one line per
 * request with no token and no content, and keeps 30 days.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write.ts';
import type { GoogleServer } from './protocol.ts';

export const INTENT_REPLAY_MS = 24 * 3_600_000;
const AUDIT_KEEP_MS = 30 * 86_400_000;

export type IntentStatus = 'dispatched' | 'held' | 'done' | 'failed' | 'unknown';

export interface IntentRecord {
  key: string; args_hash: string; account: string; server: GoogleServer; tool: string; turn_id: string; caller: string;
  status: IntentStatus; code?: string; request_id: string; created_at: string; updated_at: string;
}

interface StateFile { intents: Record<string, IntentRecord>; quota: Record<string, Partial<Record<GoogleServer, number>>> }

export class BrokerLedger {
  private state: StateFile;
  /** Set when the state file exists but can't be parsed: the broker's call op stays off so no lost write is resent. */
  readonly unreadable?: string;

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    this.state = { intents: {}, quota: {} };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateFile>;
        this.state = { intents: parsed.intents ?? {}, quota: parsed.quota ?? {} };
      } catch (error) {
        this.unreadable = `broker state ${path} is unreadable (${(error as Error).message}); move it aside to start fresh, accepting that a write whose reply was lost could be sent again`;
      }
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - INTENT_REPLAY_MS;
    for (const [key, rec] of Object.entries(this.state.intents)) if (Date.parse(rec.created_at) < cutoff) delete this.state.intents[key];
    const today = this.day();
    for (const day of Object.keys(this.state.quota)) if (day < today) delete this.state.quota[day];
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.path, JSON.stringify(this.state));
    chmodSync(this.path, 0o600);
  }

  day(): string { return new Date(this.now()).toISOString().slice(0, 10); }

  get(key: string): IntentRecord | undefined {
    this.prune();
    return this.state.intents[key];
  }

  put(rec: Omit<IntentRecord, 'created_at' | 'updated_at'> & { created_at?: string }): IntentRecord {
    const at = new Date(this.now()).toISOString();
    const full: IntentRecord = { ...rec, created_at: rec.created_at ?? this.state.intents[rec.key]?.created_at ?? at, updated_at: at };
    this.state.intents[rec.key] = full;
    this.save();
    return full;
  }

  /** Drops a record whose call had no effect (throttled, token refused), so the same key can be tried again. */
  forget(key: string): void { delete this.state.intents[key]; this.save(); }

  used(product: GoogleServer): number { return this.state.quota[this.day()]?.[product] ?? 0; }

  count(product: GoogleServer): number {
    const day = this.day();
    const bucket = (this.state.quota[day] ??= {});
    bucket[product] = (bucket[product] ?? 0) + 1;
    this.save();
    return bucket[product]!;
  }

  /** Gives back a reserved call that had no effect. */
  uncount(product: GoogleServer): void {
    const bucket = this.state.quota[this.day()];
    if (!bucket?.[product]) return;
    bucket[product] = bucket[product]! - 1;
    this.save();
  }
}

/** Appends audit lines; prunes lines older than 30 days when opened. */
export function openAuditLog(path: string, now: () => number = Date.now): (fields: string[]) => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const cutoff = now() - AUDIT_KEEP_MS;
    const kept = readFileSync(path, 'utf8').split('\n').filter(line => {
      const ts = Date.parse(line.split(' ', 1)[0] ?? '');
      return line && Number.isFinite(ts) && ts >= cutoff;
    });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
    renameSync(tmp, path);
  }
  return (fields: string[]) => appendAuditLine(path, fields, now);
}

/** One audit line, appended without pruning (for a process that does not own the log, such as gbrain google exec). */
export function appendAuditLine(path: string, fields: string[], now: () => number = Date.now): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, [new Date(now()).toISOString(), ...fields.map(f => f.replace(/\s+/g, '_') || '-')].join(' ') + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

export const brokerStatePath = (home: string): string => join(home, 'google-broker', 'state.json');
