/**
 * Bounded ownership leases for the resolver's files (a catalog build, a
 * session commit). A lease file is created with O_EXCL and holds a random
 * per-acquisition token, the host, the pid (diagnostic only), a purpose,
 * the generation it guards and an expiry. A lease is reclaimed only after
 * its expiry: never because its pid looks dead, since pids are not
 * comparable across PID namespaces or after reuse. Release, renewal and
 * publication re-read the file and act only while it still carries the
 * caller's token, so a stale owner cannot act on its successor's lease.
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { ResolverError } from './errors.ts';

export interface LeaseRecord { v: 1; token: string; host: string; pid: number; purpose: string; generation: number; acquired_ms: number; expires_ms: number }
export interface Lease { path: string; token: string; record: LeaseRecord }
export interface LeaseOpts { purpose: string; leaseMs: number; generation?: number; now?: () => number }

/** A lease file that never parses (a crash mid-create) counts as expired this long after its last write. */
const UNPARSABLE_GRACE_MS = 60_000;

function readLease(path: string): LeaseRecord | 'unparsable' | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  try {
    const r = JSON.parse(text) as LeaseRecord;
    return r && typeof r.token === 'string' && typeof r.expires_ms === 'number' ? r : 'unparsable';
  } catch { return 'unparsable'; }
}

function makeRecord(opts: LeaseOpts): LeaseRecord {
  const now = (opts.now ?? Date.now)();
  return { v: 1, token: randomBytes(16).toString('hex'), host: hostname(), pid: process.pid, purpose: opts.purpose, generation: opts.generation ?? 0, acquired_ms: now, expires_ms: now + opts.leaseMs };
}

function writeNew(path: string, rec: LeaseRecord): boolean {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
  try { writeSync(fd, JSON.stringify(rec)); fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

function replaceWith(path: string, rec: LeaseRecord): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(rec)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

/** One attempt: the lease, or the live holder's record. */
export function tryAcquireLease(path: string, opts: LeaseOpts): Lease | { held: LeaseRecord | 'unparsable' } {
  const now = (opts.now ?? Date.now)();
  const rec = makeRecord(opts);
  if (writeNew(path, rec)) return { path, token: rec.token, record: rec };
  const cur = readLease(path);
  if (cur === null) return writeNew(path, rec) ? { path, token: rec.token, record: rec } : { held: readLease(path) ?? 'unparsable' };
  const expired = cur === 'unparsable'
    ? (() => { try { return now - statSync(path).mtimeMs > UNPARSABLE_GRACE_MS; } catch { return true; } })()
    : now > cur.expires_ms;
  if (!expired) return { held: cur };
  replaceWith(path, rec);
  const after = readLease(path);
  return after !== null && after !== 'unparsable' && after.token === rec.token ? { path, token: rec.token, record: rec } : { held: after ?? 'unparsable' };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Wait and retry up to `retries` times while a live lease is held, then skill_index_locked. */
export async function acquireLease(path: string, opts: LeaseOpts & { retries?: number; waitMs?: number }): Promise<Lease> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const r = tryAcquireLease(path, opts);
    if ('token' in r) return r;
    if (attempt >= retries) {
      const h = r.held;
      throw new ResolverError('skill_index_locked',
        h === 'unparsable' ? 'Another process holds this skill-index lock.' : `Another process holds this skill-index lock (${h.purpose} on ${h.host}, pid ${h.pid}); its lease expires in ${Math.max(0, Math.ceil((h.expires_ms - (opts.now ?? Date.now)()) / 1000))} s.`,
        { suggestion: 'Retry after the holder finishes or its lease expires; a crashed holder is reclaimed when its lease runs out.' },
        h === 'unparsable' ? {} : { holder_purpose: h.purpose, holder_host: h.host, holder_pid: h.pid });
    }
    await sleep((opts.waitMs ?? 50) * 2 ** attempt);
  }
}

export function holdsLease(lease: Lease): boolean {
  const cur = readLease(lease.path);
  return cur !== null && cur !== 'unparsable' && cur.token === lease.token;
}

export function renewLease(lease: Lease, leaseMs: number, now: () => number = Date.now): boolean {
  if (!holdsLease(lease)) return false;
  const rec = { ...lease.record, expires_ms: now() + leaseMs };
  replaceWith(lease.path, { ...rec, token: lease.token });
  lease.record = rec;
  return holdsLease(lease);
}

export function releaseLease(lease: Lease): boolean {
  if (!holdsLease(lease)) return false;
  try { unlinkSync(lease.path); return true; } catch { return false; }
}
