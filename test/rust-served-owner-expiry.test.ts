/**
 * Owner server token expiry (src/core/rust-engine/served/auth.ts `rust_server.owner_token_expires`).
 *
 * Authoring gate (docs/TESTING.md): (1) protects a multi-user Rust brain from a short-lived owner token (the engine
 * swap's probe token, engine-swap/probe-token.ts) that keeps working after its time. (2) Fails when a listed expiry is
 * ignored, when an unreadable expiry list lets owner tokens in, or when a token with no listed expiry stops working.
 * (3) The served wire tests cover the bearer check itself; none covers the config expiry. (4) Seams: the bearer check,
 * the owner list, the expiry list and the clock are injected; the decision code is real.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { authenticateToken, ownerTokenExpiries, OWNER_TOKEN_EXPIRES_CONFIG_KEY } from '../src/core/rust-engine/served/auth.ts';

const ENGINE = {} as BrainEngine;
const NOW = 1_800_000_000_000;
const ownerInfo = async () => ({ principal: { kind: 'legacy_token', id: 'probe-1' }, scopes: ['read', 'write', 'admin'], hasSourceGrant: false,
  expiresAt: Math.floor(NOW / 1000) + 365 * 24 * 3600 });
const deps = (expiries: Map<string, number> | null) => ({
  verify: ownerInfo, ownerIds: async () => new Set(['probe-1']), ownerExpiries: async () => expiries, now: () => NOW,
});
const reasonOf = (p: Promise<unknown>) => p.then(() => 'accepted', (e: { reason?: string }) => e.reason);

describe('owner token expiry', () => {
  test('a listed expiry in the future is accepted and becomes the principal expiry', async () => {
    const principal = await authenticateToken(ENGINE, 'tok', deps(new Map([['probe-1', NOW + 60_000]])));
    expect(principal).toMatchObject({ kind: 'owner_token', key: 'owner_token:probe-1', expiresAt: NOW + 60_000 });
  });

  test('a listed expiry that has passed refuses token_expired', async () => {
    expect(await reasonOf(authenticateToken(ENGINE, 'tok', deps(new Map([['probe-1', NOW - 1]]))))).toBe('token_expired');
  });

  test('a token with no listed expiry keeps working as before', async () => {
    const principal = await authenticateToken(ENGINE, 'tok', deps(new Map([['other', NOW - 1]])));
    expect(principal.expiresAt).toBe((Math.floor(NOW / 1000) + 365 * 24 * 3600) * 1000);
  });

  test('an unreadable expiry list refuses every owner token (fail closed)', async () => {
    expect(await reasonOf(authenticateToken(ENGINE, 'tok', deps(null)))).toBe('token_expired');
  });

  test('the config reader: missing is empty, a malformed value is null', async () => {
    const reading = (raw: string | null) => ownerTokenExpiries({ getConfig: async (key: string) => (key === OWNER_TOKEN_EXPIRES_CONFIG_KEY ? raw : null) } as never);
    expect(await reading(null)).toEqual(new Map());
    expect(await reading('{"a":5}')).toEqual(new Map([['a', 5]]));
    expect(await reading('[1]')).toBeNull();
    expect(await reading('{"a":"soon"}')).toBeNull();
    expect(await reading('not json')).toBeNull();
    expect(await ownerTokenExpiries({ getConfig: async () => { throw new Error('down'); } } as never)).toBeNull();
  });
});
