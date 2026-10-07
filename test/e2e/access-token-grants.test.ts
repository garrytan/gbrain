/**
 * F3 on real Postgres: the unified token grant columns (migration
 * f3_access_token_grants) bind text[] values through postgres.js with quoting
 * intact, the `permissions` mirror stays a JSONB object (double-encode class),
 * `--migrate-legacy` preserves every effective grant, and an older binary's
 * JSONB edit fails closed on the OAuth-provider path. PGLite coverage:
 * test/access-token-grants.test.ts and test/auth-rescope-unified.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { migrateLegacyTokens, parseRescopeTokenArgs, rescopeLegacyToken, touchTokenLastUsed } from '../../src/core/grants/legacy-token.ts';
import { grantFromTokenRow } from '../../src/core/grants/model.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { executeRawJsonb, sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { NO_SOURCES } from '../../src/core/source-id.ts';
import { generateToken, hashToken } from '../../src/core/utils.ts';
import { runMigrations } from '../../src/core/migrate.ts';

const d = hasDatabase() ? describe : describe.skip;

beforeAll(async () => {
  if (!hasDatabase()) return;
  const engine = await setupDB();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other-f3','other-f3') ON CONFLICT DO NOTHING");
});
afterAll(async () => { if (hasDatabase()) await teardownDB(); });

const provider = () => { const engine = getEngine(); return new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) }); };
const row = async (id: string) => (await getEngine().executeRaw<Record<string, unknown>>(
  "SELECT *, jsonb_typeof(permissions) AS kind FROM access_tokens WHERE id = $1::uuid", [id]))[0];

d('F3 token grant columns on Postgres', () => {
  test('the bulk grant migration converts legacy tokens with unchanged AuthInfo; concurrent first reads of a later one convert once', async () => {
    const engine = getEngine();
    const strip = (a: unknown) => ({ ...(a as Record<string, unknown>), expiresAt: 0 });
    const legacy = [];
    for (const permissions of [{ takes_holders: ['world', 'q"x'], source_id: ['other-f3', 'default'] }, { source_id: [], allowed_operations: [] }, { takes_holders: ['world'] }]) {
      const token = generateToken('gbrain_');
      const [inserted] = await executeRawJsonb<{ id: string }>(engine, 'INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], $4::jsonb) RETURNING id',
        [`lane-e-${randomUUID().slice(0, 8)}`, hashToken(token), '{read,write}'], [permissions]);
      legacy.push({ id: inserted.id, token, before: grantFromTokenRow(await row(inserted.id)) });
    }
    await engine.setConfig('version', '200');
    await runMigrations(engine);
    for (const t of legacy) {
      const after = await row(t.id);
      expect(after.source_grant).not.toBeNull();
      expect(after.kind).toBe('object');
      const { shape: _a, revision: _b, ...axes } = grantFromTokenRow(after);
      const { shape: _c, revision: _d, ...beforeAxes } = t.before;
      expect(axes).toEqual(beforeAxes);
    }

    const token = generateToken('gbrain_');
    const [late] = await executeRawJsonb<{ id: string }>(engine, 'INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], $4::jsonb) RETURNING id',
      [`lane-e-late-${randomUUID().slice(0, 8)}`, hashToken(token), '{read}'], [{ takes_holders: ['world'], source_id: 'other-f3' }]);
    const reads = await Promise.all(Array.from({ length: 8 }, () => provider().verifyAccessToken(token)));
    for (const r of reads) expect(strip(r)).toEqual(strip(reads[0]));
    expect(reads[0]).toMatchObject({ sourceId: 'other-f3', hasSourceGrant: true, scopes: ['read'] });
    expect(await row(late.id)).toMatchObject({ source_grant: 'scalar', source_id: 'other-f3', grant_revision: 1, kind: 'object' });
  });

  test('#6230: a last_used_at touch in flight never makes the first read skip converting a legacy row', async () => {
    const engine = getEngine();
    await engine.setConfig('version', '200');
    await runMigrations(engine);
    const token = generateToken('gbrain_');
    const [late] = await executeRawJsonb<{ id: string }>(engine, 'INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], $4::jsonb) RETURNING id',
      [`touch-${randomUUID().slice(0, 8)}`, hashToken(token), '{read}'], [{ takes_holders: ['world'], source_id: 'other-f3' }]);
    const before = await row(late.id);
    // Another request's touch holds its transaction open while this read converts.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let touched!: () => void;
    const touchedNow = new Promise<void>(resolve => { touched = resolve; });
    const touching = engine.transaction(async tx => { await touchTokenLastUsed(sqlQueryForEngine(tx), before); touched(); await held; });
    await touchedNow;
    try {
      const auth = await provider().verifyAccessToken(token);
      expect(auth).toMatchObject({ sourceId: 'other-f3', hasSourceGrant: true, scopes: ['read'] });
      expect(await row(late.id)).toMatchObject({ source_grant: 'scalar', source_id: 'other-f3', grant_revision: 1, kind: 'object' });
      expect((await row(late.id)).last_used_at).not.toBeNull();
    } finally { release(); await touching; }
  });

  test('mint and rescope write text[] columns with quoting intact and an object mirror', async () => {
    const engine = getEngine();
    const name = `f3-e2e-${randomUUID().slice(0, 8)}`;
    const minted = await mintLegacyToken(engine, { name, takesHolders: ['world'], scopes: ['read', 'write'], sourceGrant: ['default', 'other-f3'], allowedOperations: ['get_page'] });
    expect(await row(minted.id)).toMatchObject({ kind: 'object', source_grant: 'federated', source_id: 'default', federated_read: ['default', 'other-f3'], allowed_operations: ['get_page'], grant_revision: 1 });
    const holders = ['world', 'a,b', 'q"x', 'back\\slash', '{brace}'];
    const result = await rescopeLegacyToken(engine, parseRescopeTokenArgs([name, '--takes-holders', holders.join(','), '--if-version', '1']));
    expect(result.revision).toEqual({ before: 1, after: 2 });
    const after = await row(minted.id);
    expect(after.takes_holders).toEqual(['world', 'a', 'b', 'q"x', 'back\\slash', '{brace}']);
    expect(after.permissions).toEqual({ takes_holders: ['world', 'a', 'b', 'q"x', 'back\\slash', '{brace}'], source_id: ['default', 'other-f3'], allowed_operations: ['get_page'] });
    expect(grantFromTokenRow(after).drift).toEqual([]);
  });

  test('--migrate-legacy changes no AuthInfo; an older binary JSONB edit then fails closed', async () => {
    const engine = getEngine();
    const name = `f3-e2e-legacy-${randomUUID().slice(0, 8)}`;
    const token = generateToken('gbrain_');
    const [inserted] = await executeRawJsonb<{ id: string }>(engine, 'INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], $4::jsonb) RETURNING id',
      [name, hashToken(token), '{read,write}'], [{ takes_holders: ['world', 'brain'], source_id: 'other-f3', allowed_operations: ['search', 'search'], note: 'kept' }]);
    const preview = await migrateLegacyTokens(engine, { dryRun: true });
    expect(preview.migrated.map(m => m.id)).toContain(inserted.id);
    expect((await row(inserted.id)).source_grant).toBeNull();
    const readOnly = sqlQueryForEngine(engine);
    const before = await new GBrainOAuthProvider({ sql: (strings, ...values) => /^\s*UPDATE/i.test(strings[0]!) ? Promise.reject(new Error('read-only')) : readOnly(strings, ...values) })
      .verifyAccessToken(token);
    expect((await row(inserted.id)).source_grant).toBeNull();
    await migrateLegacyTokens(engine, { dryRun: false });
    const migrated = await row(inserted.id);
    expect(migrated).toMatchObject({ kind: 'object', source_grant: 'scalar', source_id: 'other-f3', federated_read: null, allowed_operations: ['search'], takes_holders: ['world', 'brain'] });
    expect(migrated.permissions).toEqual({ takes_holders: ['world', 'brain'], source_id: 'other-f3', allowed_operations: ['search'], note: 'kept' });
    const strip = (a: unknown) => ({ ...(a as Record<string, unknown>), expiresAt: 0 });
    expect(strip(await provider().verifyAccessToken(token))).toEqual(strip(before));

    await engine.executeRaw(`UPDATE access_tokens SET permissions = jsonb_set(permissions, '{source_id}', '"default"') WHERE id = $1::uuid`, [inserted.id]);
    expect(await provider().verifyAccessToken(token)).toMatchObject({ sourceId: NO_SOURCES, allowedSources: [] });
    await rescopeLegacyToken(engine, parseRescopeTokenArgs([name, '--adopt-columns']));
    expect(await provider().verifyAccessToken(token)).toMatchObject({ sourceId: 'other-f3', hasSourceGrant: true });
  });
});
