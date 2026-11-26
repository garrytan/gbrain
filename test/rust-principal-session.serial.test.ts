/**
 * Multi-user lane L4 (principal-session.ts, rust/crates/gbrain-store/src/scope.rs, napi families/access_scope.rs): a
 * session for one authenticated connection on a real Rust store. Fail closed: only the owner's own key opens one; a
 * read-only key cannot run a write member; a change committed after the session opened refuses its next call; with
 * multi-user mode off no session opens at all. The mode is the store's own answer, fixed when the store opens
 * (I-0.v2, store.ts `openRustStore`): the cases open the brain with GBRAIN_RUST_MULTIUSER=1 set, and a store opened
 * without it refuses sessions even when the switch is set afterwards.
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
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';

const SWITCHES = ['GBRAIN_RUST_MULTIUSER'] as const;
const saved: Record<string, string | undefined> = {};
let engine: RustEngine;
let addon: Awaited<ReturnType<typeof loadRustAddon>>;
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
  addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: rustArmAddonPath() } });
  engine = openRustEngine({ addon, databasePath: join(dir, 'db') });
  // Single-user first: the brain is created and seeded with the switch off.
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

/** Reopens the brain with the multi-user switch set, so the store resolves multi-user mode at open. */
async function reopenMultiuser(): Promise<void> {
  await engine.disconnect();
  process.env.GBRAIN_RUST_MULTIUSER = '1';
  await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
  expect(store().multiuser).toBe(true);
}

afterAll(async () => {
  await engine?.disconnect();
  rmSync(dir, { recursive: true, force: true });
  for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const store = () => engine.openStore('principal-session-test');

describe('a multi-user session on a Rust store', () => {
  test('with multi-user mode off no session opens, even for the owner', async () => {
    expect(store().multiuser).toBe(false);
    expect(await code(openPrincipalSession(store(), 'secret-owner'))).toBe('permission_denied');
  });

  test('a store opened single-user stays single-user when the switch is set afterwards', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    try {
      expect(store().multiuser).toBe(false);
      expect(await code(openPrincipalSession(store(), 'secret-owner'))).toBe('permission_denied');
    } finally { delete process.env.GBRAIN_RUST_MULTIUSER; }
  });

  // Every case below runs on the brain reopened with the switch set (the store resolved multi-user mode at open).
  test('the brain reopens in multi-user mode', async () => {
    await reopenMultiuser();
  });

  test('the owner key opens a session that admits reads and writes', async () => {
    const session = await openPrincipalSession(store(), 'secret-owner');
    expect(session.grant.scopes).toContain('write');
    expect(await code(session.admit('getConfig'))).toBe('ok');
    expect(await code(session.admit('setConfig'))).toBe('ok');
    session.release();
    expect(await code(session.admit('getConfig'))).toBe('permission_denied');
  });

  test('every other credential is refused with one message', async () => {
    const msgs = await Promise.all(['secret-alice', 'secret-unbound', 'no-such-key', ''].map(k => message(openPrincipalSession(store(), k))));
    expect(new Set(msgs).size).toBe(1);
    expect(msgs[0]).toContain('only the brain owner');
  });

  test('an owner key without the write scope runs reads only; an unknown member counts as a write', async () => {
    const session = await openPrincipalSession(store(), 'secret-owner-read');
    expect(await code(session.admit('getConfig'))).toBe('ok');
    expect(await code(session.admit('setConfig'))).toBe('permission_denied');
    expect(await code(session.admit('noSuchMember'))).toBe('permission_denied');
    session.release();
  });

  test('a revoke committed after the session opened refuses its next call', async () => {
    const extra = await token('owner-key-2', 'secret-owner-2', 'owner-example', ['read', 'write']);
    const session = await openPrincipalSession(store(), 'secret-owner-2');
    expect(await code(session.admit('getConfig'))).toBe('ok');
    await (engine as unknown as { revokeAccessToken(id: string): Promise<unknown> }).revokeAccessToken(extra);
    expect(await code(session.admit('getConfig'))).toBe('permission_denied');
    expect(await code(openPrincipalSession(store(), 'secret-owner-2'))).toBe('permission_denied');
  });

  test('moving the owner to another member refuses the old owner session', async () => {
    const session = await openPrincipalSession(store(), 'secret-owner');
    await engine.setConfig('access.owner_member', 'alice-example');
    expect(await code(session.admit('getConfig'))).toBe('permission_denied');
    await engine.setConfig('access.owner_member', 'owner-example');
    expect(await code(session.admit('getConfig'))).toBe('permission_denied');
  });

  test('a session call reads under the record the store builds, not one the client set', async () => {
    await engine.putPage('notes/private-example', { type: 'note', title: 'P', compiled_truth: 'x', frontmatter: { visibility: 'private' } } as never);
    const read = () => engine.readPageHiddenFromCaller('default', 'notes/private-example', { policy: 'read' });
    // A remote client's own record (a stranger who may not read private pages) hides the page.
    expect(await withCallerAccess({ identity: ['member:mallory-example'], hidePrivate: true }, read)).toBe(true);
    let derived = 0;
    const addon = { deriveAccessPolicy: (ctx: unknown) => { derived++; return (engine.addon as unknown as { deriveAccessPolicy(c: unknown): unknown }).deriveAccessPolicy(ctx); } };
    const session = await openPrincipalSession(store(), 'secret-owner', addon);
    // The owner's session reads it, even inside the stranger's record, and every policy came from the store.
    // (A write-class call: an owner's read-only call carries member lineage, which neither the store nor TypeScript
    // models for a Rust brain yet, so both refuse it; the next lines pin that the two agree.)
    const seen = await withCallerAccess({ identity: ['member:mallory-example'], hidePrivate: true },
      () => session.run('readPageHiddenFromCaller', { readOnly: false }, read));
    expect(seen).toBe(false);
    expect(derived).toBeGreaterThan(0);
    const lineage = await session.run('readPageHiddenFromCaller', { readOnly: true }, read).catch(e => e);
    expect((lineage as { code?: string }).code).toBe('engine_capability_missing');
    const tsLineage = await withCallerAccess({ identity: ['member:owner-example'], owner: true, lineage: true, hidePrivate: false }, read).catch(e => e);
    expect((tsLineage as { code?: string }).code).toBe('engine_capability_missing');
    session.release();
  });

  test('in a session the store refusal stands: no TypeScript policy is used instead', async () => {
    const refusing = { deriveAccessPolicy: () => ({ $refuse: true, why: 'test refusal' }) };
    const session = await openPrincipalSession(store(), 'secret-owner', refusing);
    const err = await session.run('readPageHiddenFromCaller', { readOnly: true },
      () => engine.readPageHiddenFromCaller('default', 'notes/private-example', { policy: 'read' })).catch(e => e);
    expect((err as { code?: string }).code).toBe('engine_capability_missing');
    expect(String((err as Error).message)).toContain('test refusal');
    session.release();
  });

  test('the routed policy builders use the store derivation in a session call', async () => {
    let derived = 0;
    const addon = { deriveAccessPolicy: (ctx: unknown) => { derived++; return (engine.addon as unknown as { deriveAccessPolicy(c: unknown): unknown }).deriveAccessPolicy(ctx); } };
    const session = await openPrincipalSession(store(), 'secret-owner', addon);
    const local = await engine.listOriginClaimants('default', [1]);
    const before = derived;
    const remote = await session.run('listOriginClaimants', { readOnly: false }, () => engine.listOriginClaimants('default', [1]));
    expect(remote).toEqual(local);
    expect(derived).toBeGreaterThan(before);
    // A store that refuses the no-caller flags refuses the call: no TypeScript flags are used instead.
    const refusing = await openPrincipalSession(store(), 'secret-owner', { deriveAccessPolicy: () => ({ $refuse: true, why: 'test refusal' }) });
    const err = await refusing.run('listOriginClaimants', { readOnly: false }, () => engine.listOriginClaimants('default', [1])).catch(e => e);
    expect((err as { code?: string }).code).toBe('engine_capability_missing');
    session.release();
    refusing.release();
  });

  test('a session call on a read-only key cannot write, and a revoked session runs nothing', async () => {
    const session = await openPrincipalSession(store(), 'secret-owner-read');
    expect(await code(session.run('setConfig', { readOnly: false }, () => engine.setConfig('x', 'y')))).toBe('permission_denied');
    session.release();
    expect(await code(session.run('getConfig', { readOnly: true }, () => engine.getConfig('x')))).toBe('permission_denied');
  });

  test('a handle does not outlive the store that minted it', async () => {
    const session = await openPrincipalSession(store(), 'secret-owner');
    await engine.disconnect();
    await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
    const brain = store().brain;
    expect(await code(brain.checkScope(session.handle))).toBe('permission_denied');
    expect(await code(brain.scopeGrant(session.handle))).toBe('permission_denied');
  });
});
