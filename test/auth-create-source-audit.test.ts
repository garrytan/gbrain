// Coverage audit for #4780 (`gbrain auth create <name> --source <id>`).
// Fills the branches test/auth-create-args.test.ts leaves open:
//   - parser: position-based value exclusion for --takes-holders (only
//     --source / --scopes were covered), a positional AFTER the inline form,
//     `=` inside an inline value, whitespace-only / padded bare values;
//   - mint → transport: the row insertLegacyToken writes is read by the REAL
//     legacy-token verifier (GBrainOAuthProvider.verifyAccessToken), so
//     `hasSourceGrant` / `allowedSources` / the scopes TEXT[] column are
//     asserted on the consumer, not re-derived in the test.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { parseAuthCreateArgs, insertLegacyToken } from '../src/commands/auth.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { hashToken, generateToken } from '../src/core/utils.ts';
import type { AuthInfo as CoreAuthInfo } from '../src/core/operations.ts';

describe('parseAuthCreateArgs --source (#4780 audit)', () => {
  test('a name equal to a flag VALUE survives for every flag, in either order (position-based exclusion)', () => {
    // --takes-holders is the one flag the review-fix regression test skipped.
    expect(parseAuthCreateArgs(['world', '--takes-holders', 'world'])).toEqual({ name: 'world', takesHolders: ['world'] });
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'world'])).toEqual({ name: 'world', takesHolders: ['world'] });
    expect(parseAuthCreateArgs(['--scopes', 'read', 'read'])).toMatchObject({ name: 'read', scopes: ['read'] });
    // The inline form reserves no value slot, so a positional AFTER it is the name.
    expect(parseAuthCreateArgs(['--source=workspace', 'mybot'])).toMatchObject({ name: 'mybot', source: 'workspace' });
    // Every flag value equal to the name at once.
    expect(parseAuthCreateArgs(['x', '--takes-holders', 'x', '--scopes', 'read', '--source', 'x']))
      .toEqual({ name: 'x', takesHolders: ['x'], scopes: ['read'], source: 'x' });
  });

  test('--source value edges: first `=` is the separator, whitespace-only fails closed, padding is trimmed', () => {
    // slice('--source='.length): everything past the FIRST `=` is the value.
    // Validity is insertLegacyToken's job (assertValidSourceId rejects `a=b`).
    expect(parseAuthCreateArgs(['n', '--source=a=b']).source).toBe('a=b');
    // The existing suite covers only the inline empty form (`--source=`).
    expect(parseAuthCreateArgs(['n', '--source', '   ']).error).toContain('non-empty value');
    expect(parseAuthCreateArgs(['n', '--source=  ']).error).toContain('non-empty value');
    expect(parseAuthCreateArgs(['n', '--source', ' workspace ']).source).toBe('workspace');
  });
});

describe('insertLegacyToken → legacy verifier round-trip (PGLite)', () => {
  let engine: PGLiteEngine;
  let provider: GBrainOAuthProvider;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('workspace-a', 'workspace-a')`);
    // A federated sibling gives the no-grant floor something to widen INTO
    // (localFederatedSourceIds returns undefined for a one-element set).
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('fed-b', 'fed-b', '{"federated": true}'::jsonb)`,
    );
    // Verification needs only `sql` (transaction is for grant issuance).
    provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('a --source token verifies as GRANTED and never widens; a no-source token is the widening no-grant floor', async () => {
    const granted = generateToken('gbrain_');
    await insertLegacyToken(engine, {
      name: 'granted-scoped', hash: hashToken(granted), takesHolders: ['world'], scopes: ['read', 'write'], source: 'workspace-a',
    });
    const grantedFull = generateToken('gbrain_');
    await insertLegacyToken(engine, {
      name: 'granted-full', hash: hashToken(grantedFull), takesHolders: ['world'], source: 'workspace-a',
    });
    const plain = generateToken('gbrain_');
    await insertLegacyToken(engine, { name: 'plain', hash: hashToken(plain), takesHolders: ['world'] });

    // with-scopes INSERT shape + source: both columns land and read back.
    const g = await provider.verifyAccessToken(granted) as CoreAuthInfo;
    expect(g.hasSourceGrant).toBe(true);
    expect(g.sourceId).toBe('workspace-a');
    expect(g.allowedSources).toEqual(['workspace-a']);
    expect(g.scopes).toEqual(['read', 'write']); // scopes TEXT[] column round-trips
    expect(g.takesHoldersAllowList).toEqual(['world']);

    // no-scopes INSERT shape + source: source_id lands, scopes NULL → grandfathered.
    const gf = await provider.verifyAccessToken(grantedFull) as CoreAuthInfo;
    expect(gf.hasSourceGrant).toBe(true);
    expect(gf.allowedSources).toEqual(['workspace-a']);
    expect(gf.scopes).toEqual(['read', 'write', 'admin']);

    // omitted source: the historical floor, byte-identical legacy behaviour.
    const p = await provider.verifyAccessToken(plain) as CoreAuthInfo;
    expect(p.hasSourceGrant).toBe(false);
    expect(p.sourceId).toBe('default');
    expect(p.allowedSources).toBeUndefined();

    // The gate the flag exists for (#3242): a granted token keeps its scalar
    // scope even though fed-b is federated; only the no-grant floor widens.
    expect(await noGrantFederatedScope(engine, g.hasSourceGrant, g.sourceId)).toBeUndefined();
    expect(await noGrantFederatedScope(engine, gf.hasSourceGrant, gf.sourceId)).toBeUndefined();
    expect(await noGrantFederatedScope(engine, p.hasSourceGrant, p.sourceId)).toEqual(['default', 'fed-b']);
  });
});
