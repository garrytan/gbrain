/**
 * Multi-user lane L4 (principal-session.ts, rust/crates/gbrain-store/src/scope.rs, napi families/access_scope.rs): a
 * session for one authenticated connection on a real Rust store. Fail closed: only the owner's own key opens one; a
 * read-only key cannot run a write member; a change committed after the session opened refuses its next call; with
 * multi-user mode off no session opens at all.
 *
 * Needs the addon `bun run rust:build` writes (or GBRAIN_TEST_RUST_ENGINE_ADDON).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { openPrincipalSession } from '../src/core/rust-engine/principal-session.ts';
import { hashToken } from '../src/core/utils.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';

const SWITCHES = ['GBRAIN_RUST_MULTIUSER'] as const;
const saved: Record<string, string | undefined> = {};
let engine: RustEngine;
let dir: string;
const ids: Record<string, string> = {};

async function token(name: string, secret: string, member: string | null, scopes: string[]): Promise<string> {
  const row = { name, token_hash: hashToken(secret), scopes, permissions: {}, member_id: member };
  const { id } = await (engine as unknown as { insertAccessToken(r: unknown): Promise<{ id: string }> }).insertAccessToken(row);
  return id;
}

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const message = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as Error).message; } };

beforeAll(async () => {
  for (const k of SWITCHES) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'gbrain-principal-session-'));
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: rustArmAddonPath() } });
  engine = openRustEngine({ addon, databasePath: join(dir, 'db') });
  await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
  await engine.initSchema();
  for (const id of ['owner-example', 'alice-example']) {
    await engine.insertAccessMember({ id, displayName: null, email: null, kind: 'person' as never, groups: [], bindTokenId: null });
  }
  await engine.setConfig('access.owner_member', 'owner-example');
  ids.owner = await token('owner-key', 'secret-owner', 'owner-example', ['read', 'write']);
  ids.ownerRead = await token('owner-read-key', 'secret-owner-read', 'owner-example', ['read']);
  ids.alice = await token('alice-key', 'secret-alice', 'alice-example', ['read', 'write']);
  ids.unbound = await token('unbound-key', 'secret-unbound', null, ['read', 'write']);
});

afterAll(async () => {
  await engine?.disconnect();
  rmSync(dir, { recursive: true, force: true });
  for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const store = () => engine.openStore('principal-session-test');

describe('a multi-user session on a Rust store', () => {
  test('with multi-user mode off no session opens, even for the owner', async () => {
    expect(await code(openPrincipalSession(store(), 'secret-owner'))).toBe('permission_denied');
  });

  test('the owner key opens a session that admits reads and writes', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    try {
      const session = await openPrincipalSession(store(), 'secret-owner');
      expect(session.grant.scopes).toContain('write');
      expect(await code(session.admit('getConfig'))).toBe('ok');
      expect(await code(session.admit('setConfig'))).toBe('ok');
      session.release();
      expect(await code(session.admit('getConfig'))).toBe('permission_denied');
    } finally { delete process.env.GBRAIN_RUST_MULTIUSER; }
  });

  test('every other credential is refused with one message', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    try {
      const msgs = await Promise.all(['secret-alice', 'secret-unbound', 'no-such-key', ''].map(k => message(openPrincipalSession(store(), k))));
      expect(new Set(msgs).size).toBe(1);
      expect(msgs[0]).toContain('only the brain owner');
    } finally { delete process.env.GBRAIN_RUST_MULTIUSER; }
  });

  test('an owner key without the write scope runs reads only; an unknown member counts as a write', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    try {
      const session = await openPrincipalSession(store(), 'secret-owner-read');
      expect(await code(session.admit('getConfig'))).toBe('ok');
      expect(await code(session.admit('setConfig'))).toBe('permission_denied');
      expect(await code(session.admit('noSuchMember'))).toBe('permission_denied');
      session.release();
    } finally { delete process.env.GBRAIN_RUST_MULTIUSER; }
  });

  test('a revoke committed after the session opened refuses its next call', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    try {
      const extra = await token('owner-key-2', 'secret-owner-2', 'owner-example', ['read', 'write']);
      const session = await openPrincipalSession(store(), 'secret-owner-2');
      expect(await code(session.admit('getConfig'))).toBe('ok');
      await (engine as unknown as { revokeAccessToken(id: string): Promise<unknown> }).revokeAccessToken(extra);
      expect(await code(session.admit('getConfig'))).toBe('permission_denied');
      expect(await code(openPrincipalSession(store(), 'secret-owner-2'))).toBe('permission_denied');
    } finally { delete process.env.GBRAIN_RUST_MULTIUSER; }
  });

  test('moving the owner to another member refuses the old owner session', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    try {
      const session = await openPrincipalSession(store(), 'secret-owner');
      await engine.setConfig('access.owner_member', 'alice-example');
      expect(await code(session.admit('getConfig'))).toBe('permission_denied');
      await engine.setConfig('access.owner_member', 'owner-example');
      expect(await code(session.admit('getConfig'))).toBe('permission_denied');
    } finally { delete process.env.GBRAIN_RUST_MULTIUSER; }
  });

  test('a handle does not outlive the store that minted it', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    try {
      const session = await openPrincipalSession(store(), 'secret-owner');
      await engine.disconnect();
      await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
      const brain = store().brain;
      expect(await code(brain.checkScope(session.handle))).toBe('permission_denied');
      expect(await code(brain.scopeGrant(session.handle))).toBe('permission_denied');
    } finally { delete process.env.GBRAIN_RUST_MULTIUSER; }
  });
});
