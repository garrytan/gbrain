/**
 * D4: new memory-writer, memory-reader and coding-agent grants are callable and
 * advertised on the full surface, so a fresh writer reaches put_pages while a
 * reader still has no write scope. Existing grants never widen by migration or
 * repair; an explicit profile application is the only widening path. Catalog
 * provenance is recorded when a snapshot is written and never synthesized.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { catalogProvenance, grantCatalog, readClientCatalogProvenance, readClientGrant, rescopeClientGrant, resolveGrantProfile } from '../src/core/grants/service.ts';
import { repairLegacyClientGrants } from '../src/core/grants/migration.ts';
import { provisionHarnessGrant } from '../src/commands/mcp-provision.ts';
import { resolveAuthCapabilities } from '../src/core/harness/capabilities.ts';
import { effectiveSurfaceForClient, isMcpSurface } from '../src/mcp/surface.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
let home: string;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-profile-surface-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
}, 60_000);
afterAll(async () => { await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); }, 15_000);

/** Provisioning retains a private credential delivery under GBRAIN_HOME; keep it in a temp home. */
const provision = (input: Parameters<typeof provisionHarnessGrant>[1]) => withEnv({ GBRAIN_HOME: home }, () => provisionHarnessGrant(engine, input, 'test'));

/** A verified token's AuthInfo with the effective surface serve --http computes (ceiling full, no DCR default). */
async function verifiedAuth(clientId: string, secret: string): Promise<AuthInfo> {
  const token = await provider.exchangeClientCredentials(clientId, secret);
  const auth = await provider.verifyAccessToken(token.access_token) as unknown as AuthInfo;
  auth.effectiveSurface = effectiveSurfaceForClient({ ceiling: 'full', clientSurface: isMcpSurface(auth.surface) ? auth.surface : null, defaultSurface: null });
  return auth;
}

async function capabilities(auth: AuthInfo) {
  return await resolveAuthCapabilities(auth, engine, { engine: 'pglite' } as any, { surfaceCeiling: 'full' });
}

describe('profile surface defaults', () => {
  test('memory-writer and coding-agent resolve to an operator-set full surface with put_pages in the snapshot', () => {
    const writer = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' });
    const coding = resolveGrantProfile({ profile: 'coding-agent', sourceId: 'default', boundSlugPrefixes: ['agents/example/'] });
    for (const grant of [writer, coding]) {
      expect(grant.surface).toBe('full');
      expect(grant.surfaceSetBy).toBe('operator');
      expect(grant.allowedOperations).toContain('put_pages');
    }
  });

  test('memory-reader resolves to full but holds no write scope and no put_pages', () => {
    const reader = resolveGrantProfile({ profile: 'memory-reader', sourceId: 'default' });
    expect(reader.surface).toBe('full');
    expect(reader.scopes).toEqual(['read']);
    expect(reader.allowedOperations).not.toContain('put_pages');
    expect(reader.allowedOperations).not.toContain('put_page');
  });

  test('delegating-agent keeps its starter pin', () => {
    expect(resolveGrantProfile({ profile: 'delegating-agent', sourceId: 'default', boundTools: ['search'] }).surface).toBe('starter');
  });

  test('a fresh provisioned memory-writer can call put_pages and its diagnosis shows no blocker', async () => {
    const created = await provision({ name: 'fresh-writer-example', harness: 'generic', url: 'https://brain.example.com/mcp', profile: 'memory-writer' });
    expect(created.grant.surface).toBe('full');
    const caps = await capabilities(await verifiedAuth(created.grant.clientId, created.credentials!.client_secret!));
    expect(caps.surface).toBe('full');
    expect(caps.available_operations).toContain('put_pages');
    expect(caps.grant_diagnosis.blockers).toEqual([]);
    expect(caps.grant_diagnosis.unreachable_count).toBe(0);
    expect(caps.grant_diagnosis.grant_age).toEqual({ state: 'snapshot_complete', excluded_count: 0 });
    expect(caps.grant_diagnosis.fix).toBeNull();
  });

  test('a fresh memory-reader cannot call put_pages, and the diagnosis names the scope blocker without counting write operations', async () => {
    const created = await provision({ name: 'fresh-reader-example', harness: 'generic', url: 'https://brain.example.com/mcp', profile: 'memory-reader' });
    const caps = await capabilities(await verifiedAuth(created.grant.clientId, created.credentials!.client_secret!));
    expect(caps.available_operations).not.toContain('put_pages');
    expect(caps.grant_diagnosis.blockers).toEqual([{ blocker: 'scope', missing_scopes: ['write'] }]);
    expect(caps.grant_diagnosis.unreachable_count).toBe(0);
    expect(caps.grant_diagnosis.fix).toBeNull();
  });
});

describe('existing grants widen only through an explicit profile application', () => {
  async function preD4Writer(name: string) {
    // The shape every pre-D4 memory-writer was minted with: operator-pinned starter.
    const created = await provider.registerClientManual(name, ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
      { ...resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }), surface: 'starter' });
    return { created, grant: await readClientGrant(engine, created.clientId) };
  }

  test('migration repair and an ordinary harness update keep the starter pin and the snapshot', async () => {
    const { created, grant } = await preD4Writer('pre-d4-writer-example');
    await repairLegacyClientGrants(engine);
    expect(await readClientGrant(engine, created.clientId)).toEqual(grant);
    await rescopeClientGrant(engine, created.clientId, { surface: 'full' }, { actor: 'test', repair: true });
    expect((await readClientGrant(engine, created.clientId)).surface).toBe('starter');
    const updated = await provision({ name: grant.clientName, harness: 'generic', url: 'https://brain.example.com/mcp',
      clientId: created.clientId, expectedRevision: grant.revision, patch: { tokenTtlSeconds: 7200 } });
    expect(updated.grant.surface).toBe('starter');
    expect(updated.grant.allowedOperations).toEqual(grant.allowedOperations);
    const caps = await capabilities(await verifiedAuth(created.clientId, created.clientSecret!));
    expect(caps.available_operations).not.toContain('put_pages');
    expect(caps.grant_diagnosis.blockers).toEqual([expect.objectContaining({ blocker: 'client_pin', surface: 'starter', set_by: 'operator' })]);
  });

  test('an explicit memory-writer profile application regrants the full surface', async () => {
    const { created, grant } = await preD4Writer('reprofile-writer-example');
    const regrant = await provision({ name: grant.clientName, harness: 'generic', url: 'https://brain.example.com/mcp',
      clientId: created.clientId, expectedRevision: grant.revision, profile: 'memory-writer' });
    expect(regrant.grant.surface).toBe('full');
    expect(regrant.grant.allowedOperations).toContain('put_pages');
    const caps = await capabilities(await verifiedAuth(created.clientId, created.clientSecret!));
    expect(caps.available_operations).toContain('put_pages');
  });
});

describe('catalog provenance', () => {
  test('a new grant records the catalog its snapshot was written against', async () => {
    const created = await provider.registerClientManual('provenance-example', ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
      resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }));
    const grant = await readClientGrant(engine, created.clientId);
    const provenance = await readClientCatalogProvenance(engine, created.clientId, grant.allowedOperations!);
    expect(provenance).toEqual(catalogProvenance());
    expect(provenance!.operations).toEqual([...grantCatalog().operationNames].sort());
  });

  test('a grant without provenance never gains it from a write that leaves its snapshot alone', async () => {
    const created = await provider.registerClientManual('legacy-provenance-example', ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
      resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }));
    await engine.executeRaw("UPDATE oauth_grant_audit SET after_grant = after_grant - 'catalogProvenance' WHERE client_id = $1", [created.clientId]);
    await rescopeClientGrant(engine, created.clientId, { tokenTtlSeconds: 7200 }, { actor: 'test' });
    await rescopeClientGrant(engine, created.clientId, { surface: 'full' }, { actor: 'test' });
    const grant = await readClientGrant(engine, created.clientId);
    expect(await readClientCatalogProvenance(engine, created.clientId, grant.allowedOperations!)).toBeNull();
  });

  test('provenance applies only while its snapshot is the current one, and a new snapshot write records its own', async () => {
    const created = await provider.registerClientManual('snapshot-change-example', ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
      resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }));
    const minted = await readClientGrant(engine, created.clientId);
    const narrowed = minted.allowedOperations!.filter(name => name !== 'put_pages');
    await engine.executeRaw("UPDATE oauth_clients SET allowed_operations = $2::text[] WHERE client_id = $1", [created.clientId, `{${narrowed.join(',')}}`]);
    expect(await readClientCatalogProvenance(engine, created.clientId, narrowed)).toBeNull();
    await engine.executeRaw("UPDATE oauth_clients SET allowed_operations = $2::text[] WHERE client_id = $1", [created.clientId, `{${minted.allowedOperations!.join(',')}}`]);
    await rescopeClientGrant(engine, created.clientId, { allowedOperations: narrowed }, { actor: 'test' });
    expect(await readClientCatalogProvenance(engine, created.clientId, narrowed)).toEqual(catalogProvenance());
  });
});
