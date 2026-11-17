/**
 * F3 (O-CEO-8, O-DX-4, O-ENG-7): one grant shape for legacy bearer tokens,
 * lazily migrated from `access_tokens.permissions` JSONB to the unified
 * columns, with a JSONB mirror and fail-closed drift.
 *
 * Protects (spec 4.5): a pre-F3 token authenticates identically on both HTTP
 * paths and its first read converts the row to the columns (2); the unified
 * reader equals lane F's parsers for any well-formed stored JSONB, before and
 * after migration, and a malformed one denies every axis (3); `--sources none` after lazy migration denies
 * reads, writes and publication (4); a rescope writes the columns, bumps the
 * revision and leaves the JSONB lane F would have written (5); an older
 * binary's JSONB edit makes that axis deny until an adopt flag resolves it (6);
 * `--if-version` compare-and-set (8); `--migrate-legacy` previews without
 * writing and never changes an effective grant (10). Doctor counts both.
 * The CLI aliases, client path and rotation live in
 * test/auth-rescope-unified.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../src/core/sql-query.ts';
import { coerceLegacyPermissions, parseLegacyOperationGrant, parseLegacyTokenScope, parseTakesHoldersAllowList } from '../src/core/legacy-token-scope.ts';
import { authSourcesFromGrant, grantFromTokenRow } from '../src/core/grants/model.ts';
import { migrateLegacyTokens, parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { NO_SOURCES } from '../src/core/source-id.ts';
import { generateToken, hashToken } from '../src/core/utils.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { authorizeStoredRequest, submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { describeAuthCapabilities } from '../src/core/harness/capabilities.ts';
import { legacyTokenGrantsEntry } from '../src/commands/doctor/checks/legacy-token-grants.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','other') ON CONFLICT DO NOTHING");
  await engine.putPage('notes/f3', { type: 'note', title: 'F3', compiled_truth: 'f3-marker prose', timeline: '', frontmatter: {} }, { sourceId: 'default' });
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const rescope = (...args: string[]) => rescopeLegacyToken(engine, parseRescopeTokenArgs(args));
const rowOf = async (id: string) => (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id = $1::uuid', [id]))[0];

/** A token exactly as a pre-F3 binary wrote it: JSONB grant, no grant columns. */
async function legacyToken(permissions: unknown, scopes: string | null = '{read,write}'): Promise<{ id: string; name: string; token: string }> {
  const name = `f3-${randomUUID().slice(0, 8)}`;
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

/** Lane F's AuthInfo source fields, computed with lane F's parsers only. */
function laneFSources(raw: unknown) {
  const permissions = coerceLegacyPermissions(raw);
  const { sourceId, allowedSources } = parseLegacyTokenScope(permissions?.source_id);
  return { sourceId, ...(allowedSources ? { allowedSources } : {}), hasSourceGrant: permissions?.source_id != null };
}

function grantFields(row: Record<string, unknown>) {
  const g = grantFromTokenRow(row);
  return { sources: authSourcesFromGrant(g), operations: g.allowedOperations, takes: g.takesHolders };
}

describe('2. a pre-F3 token authenticates identically on both HTTP paths', () => {
  test('oauth-provider fallback and the legacy HTTP transport derive the same grant; the first read converts the row', async () => {
    const t = await legacyToken({ takes_holders: ['world', 'brain'], source_id: ['default', 'other'], allowed_operations: ['get_page', 'search', 'query'] });
    const oauth = await provider().verifyAccessToken(t.token) as unknown as AuthInfo;
    expect(oauth).toMatchObject({ scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default', 'other'], hasSourceGrant: true,
      allowedOperations: ['get_page', 'search', 'query'], takesHoldersAllowList: ['world', 'brain'] });
    const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
      ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }), token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }) } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST',
        headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'gbrain://capabilities' } }) });
      const body = await response.json() as { result: { contents: Array<{ text: string }> } };
      const http = JSON.parse(body.result.contents[0].text);
      const pick = (c: Record<string, unknown>) => ({ scopes: c.scopes, source_id: c.source_id, federated_read: c.federated_read, allowed_operations: c.allowed_operations });
      expect(pick(http)).toEqual(pick(describeAuthCapabilities(oauth)));
    } finally { server.stop?.(true); }
    const row = await rowOf(t.id);
    expect(row).toMatchObject({ source_grant: 'federated', source_id: 'default', federated_read: ['default', 'other'],
      allowed_operations: ['get_page', 'search', 'query'], takes_holders: ['world', 'brain'], grant_revision: 1 });
    expect(grantFromTokenRow(row)).toMatchObject({ shape: 'unified', drift: [] });
    const again = await provider().verifyAccessToken(t.token) as unknown as AuthInfo;
    expect({ ...again, expiresAt: 0 }).toEqual({ ...oauth, expiresAt: 0 });
    expect((await rowOf(t.id)).grant_revision).toBe(1);
  }, 60_000);
});

describe('3. equivalence: the unified reader equals lane F for any stored JSONB, before and after migration', () => {
  const sources: unknown[] = [undefined, null, [], ['default'], ['other', 'default'], ['', 'other'], [5, 'other'], ['__none__'], 'other', '', 5, { x: 1 }, true];
  const takes: unknown[] = [undefined, [], ['world'], ['world', '', 3], ['a,b', 'q"x', 'back\\slash'], 'world', null];
  const ops: unknown[] = [undefined, [], ['get_page'], ['search', 'search'], ['Bad-Op'], 'get_page', null];
  const values: unknown[] = [];
  for (const s of sources) for (const h of takes) for (const o of ops) {
    const p: Record<string, unknown> = {};
    if (s !== undefined) p.source_id = s;
    if (h !== undefined) p.takes_holders = h;
    if (o !== undefined) p.allowed_operations = o;
    values.push(p);
  }
  const doubleEncoded = values.filter((_, i) => i % 7 === 0).map(v => JSON.stringify(v));
  const garbage = ['{not json', '[1,2]', '"world"'];

  test('legacy rows: authSourcesFromGrant(grantFromTokenRow(row)) equals parseLegacyTokenScope for every value; malformed rows deny every axis', () => {
    for (const raw of [...values, ...doubleEncoded, ...garbage, [1], 42, null]) {
      const row = { id: randomUUID(), permissions: raw, scopes: null };
      const g = grantFromTokenRow(row);
      const permissions = coerceLegacyPermissions(raw);
      if (raw != null && permissions === undefined) {
        expect({ raw, malformed: g.permissionsMalformed, sources: authSourcesFromGrant(g), ops: g.allowedOperations, takes: g.takesHolders })
          .toEqual({ raw, malformed: true, sources: { sourceId: NO_SOURCES, allowedSources: [], hasSourceGrant: true }, ops: [], takes: [] });
        continue;
      }
      expect({ raw, sources: authSourcesFromGrant(g) }).toEqual({ raw, sources: laneFSources(raw) });
      expect({ raw, ops: g.allowedOperations, takes: g.takesHolders }).toEqual({ raw,
        ops: parseLegacyOperationGrant(permissions?.allowed_operations) ?? null, takes: parseTakesHoldersAllowList(permissions?.takes_holders) ?? null });
    }
  });

  test('migrated rows equal both, with no drift; malformed rows are skipped, never guessed', async () => {
    await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE revoked_at IS NULL');
    const inserted: Array<{ id: string; raw: unknown }> = [];
    for (const raw of [...values, ...doubleEncoded, ...garbage]) inserted.push({ id: (await legacyToken(raw)).id, raw });
    const before = new Map<string, ReturnType<typeof grantFields>>();
    for (const t of inserted) before.set(t.id, grantFields(await rowOf(t.id)));
    const result = await migrateLegacyTokens(engine, { dryRun: false });
    expect(result.skipped.map(s => s.id).sort()).toEqual(inserted.filter(t => typeof t.raw === 'string' && garbage.includes(t.raw)).map(t => t.id).sort());
    expect(result.migrated).toHaveLength(inserted.length - garbage.length);
    for (const t of inserted) {
      const row = await rowOf(t.id);
      if (garbage.includes(t.raw as string)) { expect(row.source_grant).toBeNull(); continue; }
      const g = grantFromTokenRow(row);
      expect({ raw: t.raw, shape: g.shape, drift: g.drift }).toEqual({ raw: t.raw, shape: 'unified', drift: [] });
      expect({ raw: t.raw, after: grantFields(row) }).toEqual({ raw: t.raw, after: before.get(t.id)! });
      expect({ raw: t.raw, sources: authSourcesFromGrant(g) }).toEqual({ raw: t.raw, sources: laneFSources(t.raw) });
    }
  }, 120_000);
});

describe('4. O-ENG-7 after on-read conversion: --sources none denies reads, writes and publication', () => {
  test('a pre-F3 token rescoped to none keeps scopes and operations and is denied everywhere', async () => {
    const t = await legacyToken({ takes_holders: ['world'], allowed_operations: ['get_page', 'search', 'query', 'put_page'] });
    const before = await provider().verifyAccessToken(t.token) as unknown as AuthInfo;
    const ctx = { engine, config: { engine: 'pglite' }, sourceId: 'default', auth: before, remote: true, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/f3');
    const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source.incarnation, slug: 'notes/f3', requestId: randomUUID(), callerIntent: {}, intent: {} });
    await authorizeStoredRequest(engine, admitted);

    expect((await rowOf(t.id)).source_grant).toBe('default');
    const result = await rescope(t.name, '--sources', 'none');
    expect(result).toMatchObject({ migrated: false, written: true, shape: 'unified' });
    const row = await rowOf(t.id);
    expect(row).toMatchObject({ source_grant: 'none', source_id: null, federated_read: [], allowed_operations: ['get_page', 'search', 'query', 'put_page'], scopes: ['read', 'write'] });
    await expect(authorizeStoredRequest(engine, admitted)).rejects.toMatchObject({ code: 'permission_denied' });

    const auth = await provider().verifyAccessToken(t.token) as unknown as AuthInfo;
    expect(auth).toMatchObject({ sourceId: NO_SOURCES, allowedSources: [], hasSourceGrant: true, scopes: ['read', 'write'] });
    for (const [op, args] of [['search', { query: 'f3-marker' }], ['get_page', { slug: 'notes/f3' }], ['query', { query: 'f3-marker', source_id: 'other' }],
      ['put_page', { slug: 'notes/f3-new', content: 'x' }], ['put_page', { slug: 'notes/f3-new', content: 'x', source_id: 'other' }]] as const) {
      const out = await dispatchToolCall(engine, op, { ...args }, { remote: true, transport: 'http', sourceId: auth.sourceId, auth });
      expect(JSON.parse(out.content[0].text).error).toBe('permission_denied');
    }
    const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
      ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }), token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }) } });
    try {
      for (const [name, args] of [['search', { query: 'f3-marker' }], ['put_page', { slug: 'notes/f3-http', content: 'x', source_id: 'default' }]] as const) {
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST',
          headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
        const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
        expect(JSON.parse(body.result.content[0].text).error).toBe('permission_denied');
      }
    } finally { server.stop?.(true); }
  }, 120_000);
});

describe('5. lazy migration on rescope', () => {
  test('writes columns, source_grant and revision+1, mirrors JSONB as lane F would, and doctor count drops by one', async () => {
    const t = await legacyToken({ takes_holders: ['world'], source_id: ['default'], allowed_operations: ['get_page'], note: 'kept' });
    const countBefore = (await doctor()).legacy_token_grant_shape.details?.legacy_shape_count as number;
    expect(countBefore).toBeGreaterThan(0);
    const result = await rescope(t.name, '--takes-holders', 'world,brain');
    expect(result.revision).toEqual({ before: 0, after: 1 });
    const row = await rowOf(t.id);
    expect(row).toMatchObject({ source_grant: 'federated', source_id: 'default', federated_read: ['default'], takes_holders: ['world', 'brain'], allowed_operations: ['get_page'], grant_revision: 1 });
    expect(row.permissions).toEqual({ takes_holders: ['world', 'brain'], source_id: ['default'], allowed_operations: ['get_page'], note: 'kept' });
    expect((await doctor()).legacy_token_grant_shape.details?.legacy_shape_count).toBe(countBefore - 1);
  });

  test('inspection and dry-run never migrate', async () => {
    const t = await legacyToken({ takes_holders: ['world'] });
    await rescope(t.name);
    await rescope(t.name, '--sources', 'other', '--dry-run');
    expect((await rowOf(t.id)).source_grant).toBeNull();
  });

  test('--operations all is client-only and points a token at --reset-default operations', () => {
    expect(() => parseRescopeTokenArgs(['tok-example', '--operations', 'all'])).toThrow('--reset-default operations');
    expect(parseRescopeTokenArgs(['tok-example', '--reset-default', 'operations']).reset).toEqual(['operations']);
  });
});

describe('6. drift: an older binary edits the JSONB after migration', () => {
  test('the drifted axis denies, doctor warns, both adopt flags resolve it', async () => {
    const minted = await mintLegacyToken(engine, { name: `f3-drift-${randomUUID().slice(0, 8)}`, takesHolders: ['world'], scopes: ['read', 'write'], sourceGrant: ['default'], allowedOperations: ['get_page', 'search'] });
    expect((await rowOf(minted.id)).source_grant).toBe('federated');
    await engine.executeRaw(`UPDATE access_tokens SET permissions = jsonb_set(permissions, '{source_id}', '["other"]') WHERE id = $1::uuid`, [minted.id]);

    const auth = await provider().verifyAccessToken(minted.token) as unknown as AuthInfo;
    expect(auth).toMatchObject({ sourceId: NO_SOURCES, allowedSources: [], allowedOperations: ['get_page', 'search'], takesHoldersAllowList: ['world'] });
    const checks = await doctor();
    expect(checks.legacy_token_grant_drift.status).toBe('warn');
    expect(checks.legacy_token_grant_drift.details?.drift).toContainEqual({ name: minted.name, id: minted.id, axes: ['sources'] });
    expect(checks.legacy_token_grant_drift.message).toContain(`foresights auth rescope --token ${minted.name} --adopt-permissions`);
    await expect(rescope(minted.name, '--takes-holders', 'world,brain')).rejects.toMatchObject({ reasons: ['legacy_token_grant_drift'] });

    await rescope(minted.name, '--adopt-permissions');
    expect(await provider().verifyAccessToken(minted.token)).toMatchObject({ sourceId: 'other', allowedSources: ['other'] });
    expect((await rowOf(minted.id)).source_id).toBe('other');

    await engine.executeRaw(`UPDATE access_tokens SET permissions = jsonb_set(permissions, '{allowed_operations}', '["get_page","search","put_page"]') WHERE id = $1::uuid`, [minted.id]);
    expect(await provider().verifyAccessToken(minted.token)).toMatchObject({ allowedOperations: [] });
    await rescope(minted.name, '--adopt-columns');
    const healed = await rowOf(minted.id);
    expect((healed.permissions as Record<string, unknown>).allowed_operations).toEqual(['get_page', 'search']);
    expect(await provider().verifyAccessToken(minted.token)).toMatchObject({ allowedOperations: ['get_page', 'search'] });
    expect((await doctor()).legacy_token_grant_drift.details?.drift).not.toContainEqual(expect.objectContaining({ id: minted.id }));
  });
});

describe('8. --if-version', () => {
  test('a stale revision refuses with the current one; the current one succeeds', async () => {
    const t = await legacyToken({ takes_holders: ['world'] });
    await rescope(t.name, '--takes-holders', 'world,brain');
    await expect(rescope(t.name, '--takes-holders', 'world', '--if-version', '0')).rejects.toMatchObject({
      code: 'grant_conflict', message: expect.stringContaining('--if-version 1') });
    expect((await rescope(t.name, '--takes-holders', 'world', '--if-version', '1')).revision).toEqual({ before: 1, after: 2 });
  });
});

describe('10. --migrate-legacy', () => {
  test('--dry-run lists without writing; the real run changes no AuthInfo', async () => {
    const tokens = [
      await legacyToken({ takes_holders: ['world', 'brain'], source_id: ['other', 'default'] }),
      await legacyToken({ takes_holders: [], source_id: [], allowed_operations: [] }),
      await legacyToken({ source_id: 'other' }, null),
      await legacyToken(JSON.stringify({ takes_holders: ['world'], allowed_operations: ['search'] })),
    ];
    const preview = await migrateLegacyTokens(engine, { dryRun: true });
    expect(preview.migrated.map(m => m.id)).toEqual(expect.arrayContaining(tokens.map(t => t.id)));
    for (const t of tokens) expect((await rowOf(t.id)).source_grant).toBeNull();
    const before = await Promise.all(tokens.map(t => provider().verifyAccessToken(t.token)));
    await migrateLegacyTokens(engine, { dryRun: false });
    const after = await Promise.all(tokens.map(t => provider().verifyAccessToken(t.token)));
    const strip = (a: unknown) => ({ ...(a as Record<string, unknown>), expiresAt: 0 });
    expect(after.map(strip)).toEqual(before.map(strip));
    for (const t of tokens) expect((await rowOf(t.id)).source_grant).not.toBeNull();
    const shape = (await doctor()).legacy_token_grant_shape.details as { legacy_shape_count: number; malformed: unknown[] };
    expect(shape.legacy_shape_count).toBe(shape.malformed.length);
  });
});
