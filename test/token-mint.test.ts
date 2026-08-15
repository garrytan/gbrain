/**
 * token-mint.test.ts — mintLegacyToken / revokeLegacyTokenById (#4043) +
 * the normalizeTokenScopes decode matrix. Pins the rotation contract: mint
 * validates scopes loudly, RETURNING id feeds revoke-by-id, and revoke-by-id
 * never touches same-name siblings (names are not unique).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine, type SqlQuery } from '../src/core/sql-query.ts';
import { mintLegacyToken, revokeLegacyTokenById } from '../src/core/token-mint.ts';
import { normalizeTokenScopes } from '../src/core/legacy-token-scope.ts';
import { hashToken } from '../src/core/utils.ts';

let engine: PGLiteEngine;
let sql: SqlQuery;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  sql = sqlQueryForEngine(engine);
  // Just the table under test — the migration v4 shape (scopes TEXT[] is
  // original schema) + the v38 permissions column.
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS access_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT[],
      permissions JSONB NOT NULL DEFAULT '{"takes_holders":["world"]}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )
  `);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('normalizeTokenScopes', () => {
  test('NULL / non-array → undefined (caller grandfathers)', () => {
    expect(normalizeTokenScopes(null)).toBeUndefined();
    expect(normalizeTokenScopes(undefined)).toBeUndefined();
  });

  test('non-NULL representation drift fails CLOSED (deny), never grandfathers', () => {
    // Only the never-written NULL earns the historical full-access grant — a
    // WRITTEN row whose value reads back in an unexpected shape must deny.
    expect(normalizeTokenScopes('read')).toEqual([]);
    expect(normalizeTokenScopes(42)).toEqual([]);
    expect(normalizeTokenScopes({ read: true })).toEqual([]);
  });

  test('undecoded Postgres array-literal strings parse like arrays', () => {
    expect(normalizeTokenScopes('{read,write}')).toEqual(['read', 'write']);
    expect(normalizeTokenScopes('{"read","write"}')).toEqual(['read', 'write']);
    expect(normalizeTokenScopes('{}')).toEqual([]);
    expect(normalizeTokenScopes('{read,bogus}')).toEqual(['read']);
  });

  test('array filtered to known scopes; [] and all-unknown preserved as deny', () => {
    expect(normalizeTokenScopes(['read', 'write'])).toEqual(['read', 'write']);
    expect(normalizeTokenScopes(['read', 'bogus', 7, null])).toEqual(['read']);
    expect(normalizeTokenScopes([])).toEqual([]);
    expect(normalizeTokenScopes(['bogus'])).toEqual([]);
    expect(normalizeTokenScopes(['admin', 'sources_admin'])).toEqual(['admin', 'sources_admin']);
  });
});

describe('mintLegacyToken', () => {
  test('round-trip: scopes column + permissions + RETURNING id', async () => {
    const minted = await mintLegacyToken(engine, {
      name: 'bootstrap-harness',
      takesHolders: ['world'],
      scopes: ['read', 'write'],
      sourceGrant: ['default', 'wiki'],
    });
    expect(minted.token).toMatch(/^gbrain_[0-9a-f]{64}$/);
    expect(minted.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await sql`
      SELECT name, scopes, permissions FROM access_tokens WHERE id = ${minted.id}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].scopes).toEqual(['read', 'write']);
    const perms = rows[0].permissions as { takes_holders: string[]; source_id: string[] };
    expect(perms.takes_holders).toEqual(['world']);
    expect(perms.source_id).toEqual(['default', 'wiki']);
    // stored hash matches the plaintext (verify-path contract)
    const hashRows = await sql`
      SELECT 1 AS ok FROM access_tokens WHERE token_hash = ${hashToken(minted.token)}
    `;
    expect(hashRows.length).toBe(1);
  });

  test('no sourceGrant → permissions carries takes_holders only (historical default floor)', async () => {
    const minted = await mintLegacyToken(engine, {
      name: 'floor-agent',
      takesHolders: ['world'],
      scopes: ['read'],
    });
    const rows = await sql`SELECT permissions FROM access_tokens WHERE id = ${minted.id}::uuid`;
    expect(rows[0].permissions).toEqual({ takes_holders: ['world'] });
  });

  test('unknown or empty scopes refused loudly at mint time', async () => {
    await expect(
      mintLegacyToken(engine, { name: 'x', takesHolders: ['world'], scopes: ['reed'] }),
    ).rejects.toThrow(/Unknown scope|scope/i);
    await expect(
      mintLegacyToken(engine, { name: 'x', takesHolders: ['world'], scopes: [] }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      mintLegacyToken(engine, { name: '  ', takesHolders: ['world'], scopes: ['read'] }),
    ).rejects.toThrow(/name/);
  });
});

describe('revokeLegacyTokenById [C7]', () => {
  test('revokes exactly one of two same-name rows; re-revoke reports already-done', async () => {
    const a = await mintLegacyToken(engine, { name: 'twin', takesHolders: ['world'], scopes: ['read', 'write'] });
    const b = await mintLegacyToken(engine, { name: 'twin', takesHolders: ['world'], scopes: ['read', 'write'] });

    expect(await revokeLegacyTokenById(sql, a.id)).toBe(true);

    const rows = await sql`
      SELECT id, revoked_at FROM access_tokens WHERE name = ${'twin'} ORDER BY created_at
    `;
    const revoked = rows.filter((r: Record<string, unknown>) => r.revoked_at !== null);
    expect(revoked.length).toBe(1);
    expect((revoked[0] as { id: string }).id).toBe(a.id);
    const alive = rows.filter((r: Record<string, unknown>) => r.revoked_at === null);
    expect((alive[0] as { id: string }).id).toBe(b.id);

    // second revoke of the same id → already-done, not an error
    expect(await revokeLegacyTokenById(sql, a.id)).toBe(false);
  });

  test('malformed id refused before touching the database', async () => {
    await expect(revokeLegacyTokenById(sql, 'not-a-uuid')).rejects.toThrow(/UUID/);
  });
});
