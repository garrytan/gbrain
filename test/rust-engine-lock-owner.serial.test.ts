/**
 * The config plane's lock owner for a Rust brain (src/core/readiness.ts `lockOwnerFor`): the `gbrain serve` that
 * took a Rust brain's owner lock names itself, so an exclusive fix it offers starts by stopping that serve, as on
 * PGLite.
 *
 * Protects: an MCP `remember` on a Rust brain without embeddings rendered `gbrain embeddings enable` as its fix while the
 * serve answering it held the brain, where PGLite wraps that fix in the stop-the-serve step (the census's last
 * mcp remember difference).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { configReadiness } from '../src/core/readiness.ts';
import { electOwner, type OwnerRole } from '../src/core/rust-engine/owner-ipc/election.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
const roles: OwnerRole[] = [];
afterEach(async () => {
  for (const role of roles.splice(0)) {
    if (role.role === 'owner') { await role.server.close().catch(() => undefined); await role.lock.release().catch(() => undefined); }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function ownedBrain(): Promise<{ db: string; role: OwnerRole }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-lock-owner-'));
  dirs.push(dir);
  const db = join(dir, 'db');
  const role = await electOwner({ kind: 'rust' } as unknown as BrainEngine, db, { serve: true, waitMs: 1_000 });
  roles.push(role);
  return { db, role };
}

async function asServe<T>(fn: () => T | Promise<T>): Promise<T> {
  const argv = process.argv;
  process.argv = [argv[0]!, argv[1]!, 'serve'];
  try { return await fn(); } finally { process.argv = argv; }
}

const rust = (db: string) => ({ engine: 'rust', database_path: db }) as unknown as GBrainConfig;
const keys = { VOYAGE_API_KEY: 'v', GBRAIN_MODEL: undefined, GBRAIN_BRAIN_ID: undefined };

describe('lock owner of a Rust brain', () => {
  test('embedded, one owner: the serve that owns the brain names itself and wraps the exclusive embeddings fix', async () => {
    const { db, role } = await ownedBrain();
    expect(role.role).toBe('owner');
    const r = await withEnv(keys, () => asServe(() => configReadiness(rust(db), { transport: 'stdio' })));
    expect(r.lock_owner).toMatchObject({ pid: process.pid, transport: 'stdio', is_self: true });
    expect(typeof r.lock_owner?.started_at).toBe('string');
    const fix = r.entries.find(e => e.capability === 'embeddings')?.fix;
    expect(fix?.argv).toEqual(['kill', String(process.pid)]);
    expect(fix?.then?.argv?.slice(0, 3)).toEqual(['gbrain', 'embeddings', 'enable']);
  });
  test.todo('multi-writer (C17): every serve on the brain names itself, the server names the primary, and the embeddings fix does not need the brain to be exclusive', () => {});

  test('a process that is not a serve, or a released owner lock, names no owner', async () => {
    const { db, role } = await ownedBrain();
    expect((await withEnv(keys, () => configReadiness(rust(db), { transport: 'stdio' }))).lock_owner).toBeNull();
    if (role.role === 'owner') { await role.server.close(); await role.lock.release(); }
    expect((await withEnv(keys, () => asServe(() => configReadiness(rust(db), { transport: 'stdio' })))).lock_owner).toBeNull();
    expect((await withEnv(keys, () => asServe(() => configReadiness(rust(join(db, 'other')), { transport: 'stdio' })))).lock_owner).toBeNull();
  });
});
