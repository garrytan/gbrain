/**
 * The writer admin lock read (`src/core/persistence/admin-lock.ts`): graduation's blocker list, deactivation's blocker
 * list and the in-transaction refusal of claim, activation and transfer read the lock through the typed config read
 * (`getConfig`), not a raw `SELECT value FROM config WHERE key=$1`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an unset lock blocks nothing; a set lock (or a value that is not JSON, which never unlocks) is a
 *    `writer_admin_lock` blocker for graduation and deactivation and refuses `writer_admin_locked` inside a
 *    transaction; every one of these reads asks `getConfig` for the lock key and runs no raw config read.
 *  - Regression: the raw config read the Rust engine refuses, which graduation, deactivation and the
 *    in-transaction refusal reached through the retired raw `readWriterAdminLock`.
 *  - Why existing coverage misses it: the graduation and deactivation tests assert the blockers, not how the lock is
 *    read, so a raw read passes them on PGLite and Postgres.
 *  - Seam: a recording proxy over a real PGLite engine (and its transaction handle) that forwards every call and keeps
 *    the statements and config keys it saw. Nothing is answered by the proxy.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../src/core/persistence/admin-contract.ts';
import { assertWriterAdminUnlocked } from '../src/core/persistence/admin-lock.ts';
import { deactivationBlockers } from '../src/core/persistence/deactivation.ts';
import { graduationBlockers } from '../src/core/persistence/graduation-drain.ts';

const RAW_CONFIG_READ = 'SELECT value FROM config WHERE key=$1';
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

interface Seen { sql: string[]; configKeys: string[] }

function recording(engine: BrainEngine, seen: Seen): BrainEngine {
  return new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: unknown) => {
      seen.sql.push(flat(sql));
      return target.executeRaw(sql, params, opts as never);
    };
    if (key === 'getConfig') return (name: string) => { seen.configKeys.push(name); return target.getConfig(name); };
    if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(recording(tx, seen)));
    const member = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
}

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

async function readAll(): Promise<{ seen: Seen; graduation: string[]; deactivation: string[]; refusal: string | null }> {
  const seen: Seen = { sql: [], configKeys: [] };
  const view = recording(engine, seen);
  const graduation = (await graduationBlockers(view, randomUUID())).filter(b => b.kind === 'writer_admin_lock').map(b => b.detail);
  const deactivation = (await deactivationBlockers(view)).filter(b => b.kind === 'writer_admin_lock').map(b => b.detail);
  const refusal = await view.transaction(tx => assertWriterAdminUnlocked(tx)).then(() => null, (e: { code?: string }) => e.code ?? String(e));
  return { seen, graduation, deactivation, refusal };
}

describe('writer admin lock: typed config read', () => {
  test('an unset lock blocks nothing, and the lock is read through getConfig only', async () => {
    const { seen, graduation, deactivation, refusal } = await readAll();
    expect({ graduation, deactivation, refusal }).toEqual({ graduation: [], deactivation: [], refusal: null });
    expect(seen.sql).not.toContain(RAW_CONFIG_READ);
    expect(seen.configKeys.filter(k => k === WRITER_ADMIN_LOCK_KEY)).toHaveLength(3);
  }, 60_000);

  test('a set lock blocks graduation and deactivation and refuses inside a transaction, read through getConfig only', async () => {
    await engine.setConfig(WRITER_ADMIN_LOCK_KEY, JSON.stringify({ locked: true, set_at: '2026-01-02T03:04:05Z', host_id: null, generation: 1 }));
    try {
      const { seen, graduation, deactivation, refusal } = await readAll();
      expect({ graduation, deactivation, refusal }).toEqual({
        graduation: ['writer administration locked at 2026-01-02T03:04:05Z'], deactivation: ['set at 2026-01-02T03:04:05Z'], refusal: 'writer_admin_locked',
      });
      expect(seen.sql).not.toContain(RAW_CONFIG_READ);
      expect(seen.configKeys.filter(k => k === WRITER_ADMIN_LOCK_KEY)).toHaveLength(3);
    } finally { await engine.unsetConfig(WRITER_ADMIN_LOCK_KEY); }
  }, 60_000);

  test('a lock value that is not JSON stays locked', async () => {
    await engine.setConfig(WRITER_ADMIN_LOCK_KEY, 'not json');
    try {
      const { graduation, deactivation, refusal } = await readAll();
      expect({ graduation, deactivation, refusal }).toEqual({
        graduation: ['writer administration locked at unknown time'], deactivation: ['set at unknown'], refusal: 'writer_admin_locked',
      });
    } finally { await engine.unsetConfig(WRITER_ADMIN_LOCK_KEY); }
  }, 60_000);
});
