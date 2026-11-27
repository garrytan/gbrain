/**
 * Lane E grants end state: authorization reads the unified grant columns.
 *
 * Protects: the schema migration converts every well-formed legacy token in
 * bulk with the same effective grant (AuthInfo) before and after, leaves a
 * malformed one denied and listed by doctor, and a rerun changes nothing; a
 * token an older binary creates after the migration converts on its first
 * HTTP read; concurrent first reads convert exactly once; a read-only
 * database still authorizes with the identical grant; a malformed token is
 * denied on the HTTP path; minting never writes a JSONB-only grant; doctor
 * reports the grant-mirror window end date.
 */
import { readOnlySqlFor } from './helpers/read-only-sql.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine, executeRawJsonb, type SqlQuery } from '../src/core/sql-query.ts';
import { GRANT_MIRROR_WINDOW_ENDS, grantFromTokenRow } from '../src/core/grants/model.ts';
import { generateToken, hashToken } from '../src/core/utils.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { NO_SOURCES } from '../src/core/source-id.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { legacyTokenGrantsEntry } from '../src/commands/doctor/checks/legacy-token-grants.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','other') ON CONFLICT DO NOTHING");
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const provider = (sql: SqlQuery = sqlQueryForEngine(engine)) => new GBrainOAuthProvider({ sql, transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const rowOf = async (id: string) => (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id = $1::uuid', [id]))[0];
const verify = async (token: string, sql?: SqlQuery) => ({ ...(await provider(sql).verifyAccessToken(token) as unknown as AuthInfo), expiresAt: 0 });

/** A token exactly as an older binary writes it: JSONB grant only, no grant columns. */
async function olderBinaryToken(permissions: unknown, scopes: string | null = '{read,write}') {
  const name = `legacy-${randomUUID().slice(0, 8)}`;
  const token = generateToken('gbrain_');
  const [row] = typeof permissions === 'string'
    ? await engine.executeRaw<{ id: string }>('INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], to_jsonb($4::text)) RETURNING id', [name, hashToken(token), scopes, permissions])
    : await executeRawJsonb<{ id: string }>(engine, 'INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], $4::jsonb) RETURNING id', [name, hashToken(token), scopes], [permissions]);
  return { id: row.id, name, token };
}

async function doctor() {
  const checks = await legacyTokenGrantsEntry.run({ engine } as unknown as DoctorContext);
  if (!Array.isArray(checks)) throw new Error('doctor entry stopped');
  return Object.fromEntries(checks.map(c => [c.name, c]));
}

const WELL_FORMED: unknown[] = [
  { takes_holders: ['world'] },
  { takes_holders: ['world', 'brain'], source_id: ['other', 'default'], allowed_operations: ['get_page', 'search'] },
  { source_id: 'other' },
  { source_id: [], takes_holders: [], allowed_operations: [] },
  { source_id: ['default'], note: 'kept' },
  JSON.stringify({ takes_holders: ['world'], allowed_operations: ['search'] }),
];

describe('schema migration converts legacy grants in bulk', () => {
  test('every well-formed token converts with an unchanged effective grant; malformed stays denied; a rerun is a no-op', async () => {
    const tokens = [];
    for (const p of WELL_FORMED) tokens.push(await olderBinaryToken(p));
    tokens.push(await olderBinaryToken({ takes_holders: ['world'] }, null));
    const malformed = await olderBinaryToken('{not json');
    const before = new Map<string, unknown>();
    for (const t of tokens) before.set(t.id, grantFromTokenRow(await rowOf(t.id)));
    expect((await doctor()).legacy_token_grant_shape.details?.convertible_count).toBe(tokens.length);

    await engine.setConfig('version', '200');
    const applied = await runMigrations(engine);
    expect(applied.applied).toBeGreaterThan(0);

    for (const t of tokens) {
      const row = await rowOf(t.id);
      const after = grantFromTokenRow(row);
      expect({ id: t.id, shape: after.shape, drift: after.drift }).toEqual({ id: t.id, shape: 'unified', drift: [] });
      const { shape: _a, revision: _b, ...afterAxes } = after;
      const { shape: _c, revision: _d, ...beforeAxes } = before.get(t.id) as typeof after;
      expect(afterAxes).toEqual(beforeAxes);
    }
    expect((await rowOf(malformed.id)).source_grant).toBeNull();
    const shape = (await doctor()).legacy_token_grant_shape;
    expect(shape.details).toMatchObject({ convertible_count: 0, legacy_shape_count: 1, mirror_window_ends: GRANT_MIRROR_WINDOW_ENDS });
    expect(shape.status).toBe('warn');
    expect(shape.details?.malformed).toContainEqual({ name: malformed.name, id: malformed.id,
      argv: ['gbrain', 'auth', 'rescope', '--id', malformed.id, '--reset-default', 'sources,takes-holders,operations'] });
    expect(shape.fix).toMatchObject({ consent: ['credentials'], argv: ['gbrain', 'auth', 'rescope', '--id', malformed.id, '--reset-default', 'sources,takes-holders,operations'] });

    const revisions = await Promise.all(tokens.map(async t => (await rowOf(t.id)).grant_revision));
    await engine.setConfig('version', '200');
    await runMigrations(engine);
    expect(await Promise.all(tokens.map(async t => (await rowOf(t.id)).grant_revision))).toEqual(revisions);
    await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1::uuid', [malformed.id]);
  }, 120_000);
});

describe('on-read conversion fallback', () => {
  test('a token an older binary creates after the migration converts on its first HTTP read, with the same grant', async () => {
    const t = await olderBinaryToken({ takes_holders: ['world', 'brain'], source_id: ['other'] });
    const inMemory = grantFromTokenRow(await rowOf(t.id));
    const auth = await verify(t.token);
    expect(auth).toMatchObject({ sourceId: 'other', allowedSources: ['other'], hasSourceGrant: true, takesHoldersAllowList: ['world', 'brain'] });
    const row = await rowOf(t.id);
    expect(row).toMatchObject({ source_grant: 'federated', source_id: 'other', federated_read: ['other'], takes_holders: ['world', 'brain'], grant_revision: 1 });
    expect(grantFromTokenRow(row)).toMatchObject({ shape: 'unified', drift: [], sources: inMemory.sources, takesHolders: inMemory.takesHolders });
    expect((await doctor()).legacy_token_grant_shape.details?.convertible_count).toBe(0);
  });

  test('concurrent first reads convert the row exactly once', async () => {
    const t = await olderBinaryToken({ takes_holders: ['world'], allowed_operations: ['search'] });
    const results = await Promise.all(Array.from({ length: 6 }, () => verify(t.token)));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(await rowOf(t.id)).toMatchObject({ source_grant: 'default', allowed_operations: ['search'], grant_revision: 1 });
  });

  test('a read-only database still authorizes with the identical grant and leaves the row unconverted', async () => {
    const t = await olderBinaryToken({ takes_holders: ['world'], source_id: ['other', 'default'] });
    const readOnly = readOnlySqlFor(engine);
    const auth = await verify(t.token, readOnly);
    expect(auth).toMatchObject({ sourceId: 'other', allowedSources: ['other', 'default'], hasSourceGrant: true, takesHoldersAllowList: ['world'] });
    expect((await rowOf(t.id)).source_grant).toBeNull();
    expect(await verify(t.token)).toEqual(auth);
    expect((await rowOf(t.id)).source_grant).toBe('federated');
  });

  test('a malformed token is denied on the HTTP path and never converted', async () => {
    const t = await olderBinaryToken('[1,2]');
    const auth = await verify(t.token);
    expect(auth).toMatchObject({ sourceId: NO_SOURCES, allowedSources: [], hasSourceGrant: true, allowedOperations: [], takesHoldersAllowList: [] });
    expect((await rowOf(t.id)).source_grant).toBeNull();
  });
});

describe('doctor reports the mirror window', () => {
  test('legacy_token_grant_drift and legacy_token_grant_shape name the end date', async () => {
    const checks = await doctor();
    expect(checks.legacy_token_grant_drift.details?.mirror_window_ends).toBe(GRANT_MIRROR_WINDOW_ENDS);
    expect(checks.legacy_token_grant_shape.message).toContain(GRANT_MIRROR_WINDOW_ENDS);
  });
});
