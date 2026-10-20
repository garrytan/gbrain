/**
 * F3 (O-CEO-8, O-DX-4): `gbrain auth rescope`, one grant editor for legacy
 * tokens and OAuth clients, run as a real CLI subprocess against a sandboxed
 * PGLite brain.
 *
 * Protects (spec 4.5): `auth create` births a unified token; `rescope-token`
 * and `permissions set-takes-holders` stay exact aliases of
 * `rescope --token`; `rescope --client` and `rescope-client` write identical
 * rows and `--sources none` and `--takes-holders` on a client succeed
 * (9); `--if-version` mismatch refuses with
 * the current revision on stdout under --json (8); a bare name that matches a
 * token and a client refuses; `--migrate-legacy --dry-run` writes nothing (10);
 * harness rotation mints a unified token that keeps explicit empty lists (7).
 * Serial: each CLI call is a subprocess that takes the PGLite lock, and the
 * rotation mint opens the brain through GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../src/core/sql-query.ts';
import { mintHarnessToken } from '../src/core/bootstrap/harness.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { grantFromTokenRow } from '../src/core/grants/model.ts';
import { resolveGrantProfile } from '../src/core/grants/profiles.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
let root: string, home: string, db: string;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0' };
}

async function cli(...args: string[]) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
}

const tokenRow = (name: string) => withBrain(async engine =>
  (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]))[0]);
const clientRow = (id: string) => withBrain(async engine =>
  (await engine.executeRaw<Record<string, unknown>>('SELECT scope, source_id, federated_read, allowed_operations, grant_revision FROM oauth_clients WHERE client_id = $1', [id]))[0]);

async function legacyToken(name: string, permissions: Record<string, unknown>) {
  await withBrain(engine => executeRawJsonb(engine, 'INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], $4::jsonb)',
    [name, `hash-${name}`, '{read,write}'], [permissions]));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-rescope-unified-'));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(async engine => {
    await engine.initSchema();
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','other') ON CONFLICT DO NOTHING");
  });
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('tokens', () => {
  test('auth create is born unified; rescope-token and permissions set-takes-holders are aliases of rescope --token', async () => {
    expect((await cli('auth', 'create', 'tok-a', '--scopes', 'read,write')).exitCode).toBe(0);
    expect((await cli('auth', 'create', 'tok-b', '--scopes', 'read,write')).exitCode).toBe(0);
    for (const name of ['tok-a', 'tok-b']) {
      expect(await tokenRow(name)).toMatchObject({ source_grant: 'default', takes_holders: ['world'], allowed_operations: null, grant_revision: 1, permissions: { takes_holders: ['world'] } });
    }
    const flags = ['--sources', 'other,default', '--operations', 'get_page,search', '--takes-holders', 'none'];
    const unified = await cli('auth', 'rescope', '--token', 'tok-a', ...flags);
    const alias = await cli('auth', 'rescope-token', 'tok-b', ...flags);
    expect(unified.exitCode).toBe(0);
    expect(alias.exitCode).toBe(0);
    expect(unified.stdout.replaceAll('tok-a', 'X').replace(/\([0-9a-f-]{36}\)/, '')).toBe(alias.stdout.replaceAll('tok-b', 'X').replace(/\([0-9a-f-]{36}\)/, ''));
    const pick = (r: Record<string, unknown>) => ({ source_grant: r.source_grant, source_id: r.source_id, federated_read: r.federated_read,
      allowed_operations: r.allowed_operations, takes_holders: r.takes_holders, grant_revision: r.grant_revision, permissions: r.permissions });
    expect(pick(await tokenRow('tok-a'))).toEqual(pick(await tokenRow('tok-b')));
    expect(pick(await tokenRow('tok-a'))).toEqual({ source_grant: 'federated', source_id: 'other', federated_read: ['other', 'default'],
      allowed_operations: ['get_page', 'search'], takes_holders: [], grant_revision: 2,
      permissions: { source_id: ['other', 'default'], takes_holders: [], allowed_operations: ['get_page', 'search'] } });

    expect((await cli('auth', 'permissions', 'tok-a', 'set-takes-holders', 'world,brain')).exitCode).toBe(0);
    expect((await cli('auth', 'rescope', 'tok-b', '--takes-holders', 'world,brain')).exitCode).toBe(0);
    expect(pick(await tokenRow('tok-a'))).toEqual(pick(await tokenRow('tok-b')));
    expect((await tokenRow('tok-a')).takes_holders).toEqual(['world', 'brain']);
  }, 180_000);

  test('8. --if-version mismatch refuses with the current revision, as JSON on stdout under --json', async () => {
    expect((await cli('auth', 'create', 'tok-cas')).exitCode).toBe(0);
    const stale = await cli('auth', 'rescope', '--token', 'tok-cas', '--sources', 'other', '--if-version', '0', '--json');
    expect(stale.exitCode).toBe(1);
    const body = JSON.parse(stale.stdout) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('grant_conflict');
    expect(body.error.message).toContain('grant revision 1');
    expect(body.error.message).toContain('--if-version 1');
    expect((await tokenRow('tok-cas')).source_grant).toBe('default');
    expect((await cli('auth', 'rescope', '--token', 'tok-cas', '--sources', 'other', '--if-version', '1')).exitCode).toBe(0);
    expect((await tokenRow('tok-cas')).grant_revision).toBe(2);
  }, 120_000);

  test('10. --migrate-legacy --dry-run lists without writing; the real run migrates', async () => {
    await legacyToken('tok-old', { takes_holders: ['world'], source_id: 'other' });
    const preview = await cli('auth', 'rescope', '--migrate-legacy', '--dry-run', '--json');
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout).migrated).toContainEqual(expect.objectContaining({ name: 'tok-old', grant: { sources: ['other'], takesHolders: ['world'], operations: 'unrestricted' } }));
    expect((await tokenRow('tok-old')).source_grant).toBeNull();
    const run = await cli('auth', 'rescope', '--migrate-legacy');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('no effective grant changes');
    expect(await tokenRow('tok-old')).toMatchObject({ source_grant: 'scalar', source_id: 'other', permissions: { takes_holders: ['world'], source_id: 'other' } });
  }, 120_000);

  test('7. rotation mints a unified token that keeps explicit empty lists', async () => {
    const prior = await withBrain(async engine => {
      const minted = await mintLegacyToken(engine, { name: 'bootstrap-harness', takesHolders: [], scopes: ['read', 'write'], sourceGrant: [], allowedOperations: [] });
      expect((await engine.executeRaw<{ source_grant: string }>('SELECT source_grant FROM access_tokens WHERE id = $1::uuid', [minted.id]))[0].source_grant).toBe('none');
      return minted;
    });
    const rotated = await withEnv({ GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined },
      () => mintHarnessToken({ name: 'bootstrap-harness', scopes: ['read', 'write'], allowedOperations: ['get_page', 'search'],
        carry: { fromId: prior.id, explicitSource: false, policyAdded: [] } }));
    const row = await withBrain(async engine => (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id = $1::uuid', [rotated.id]))[0]);
    expect(row).toMatchObject({ source_grant: 'none', source_id: null, federated_read: [], takes_holders: [], allowed_operations: [], grant_revision: 1,
      permissions: { source_id: [], takes_holders: [], allowed_operations: [] } });
    expect(grantFromTokenRow(row)).toMatchObject({ shape: 'unified', drift: [], sources: { kind: 'none' }, takesHolders: [], allowedOperations: [] });
  }, 120_000);
});

describe('9. OAuth clients', () => {
  test('rescope --client and rescope-client write identical rows; --sources none refuses', async () => {
    const [a, b] = await withBrain(async engine => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      return [await provider.registerClientManual('client-a-example', ['client_credentials'], 'read write'),
        await provider.registerClientManual('client-b-example', ['client_credentials'], 'read write')];
    });
    const unified = await cli('auth', 'rescope', '--client', a.clientId, '--sources', 'other,default', '--operations', 'get_page,search');
    const alias = await cli('auth', 'rescope-client', b.clientId, '--source', 'other', '--federated-read', 'other,default', '--allowed-operations', 'get_page,search');
    expect(unified.exitCode).toBe(0);
    expect(alias.exitCode).toBe(0);
    expect(await clientRow(a.clientId)).toEqual(await clientRow(b.clientId));
    expect(await clientRow(a.clientId)).toMatchObject({ source_id: 'other', federated_read: ['other', 'default'], allowed_operations: ['get_page', 'search'] });

    const none = await cli('auth', 'rescope', '--client', a.clientId, '--sources', 'none', '--json');
    expect(none.exitCode).toBe(0);
    expect(JSON.parse(none.stdout).principal_grant.sources).toEqual({ kind: 'none' });
    expect(await clientRow(a.clientId)).toMatchObject({ source_id: null, federated_read: [] });

    const holders = await cli('auth', 'rescope', '--client', a.clientId, '--takes-holders', 'world,brain');
    expect(holders.exitCode).toBe(0);
    expect(holders.stdout).toContain('Takes holders: world, brain');

    const reset = await cli('auth', 'rescope', '--client', a.clientId, '--reset-default', 'sources');
    expect(reset.exitCode).toBe(1);
    expect(reset.stderr).toContain('--reset-default applies to legacy tokens only');
  }, 180_000);

  test('--operations all drops a profile snapshot on both client spellings; a token refuses it', async () => {
    const [a, b] = await withBrain(async engine => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const register = (name: string) => provider.registerClientManual(name, ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
        resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }));
      return [await register('client-all-a-example'), await register('client-all-b-example')];
    });
    const grantRow = (id: string) => withBrain(async engine =>
      (await engine.executeRaw<Record<string, unknown>>('SELECT grant_profile, allowed_operations, scope FROM oauth_clients WHERE client_id = $1', [id]))[0]);
    expect((await grantRow(a.clientId)).grant_profile).toBe('memory-writer');
    expect((await cli('auth', 'rescope', '--client', a.clientId, '--operations', 'all')).exitCode).toBe(0);
    expect((await cli('auth', 'rescope-client', b.clientId, '--allowed-operations', 'all')).exitCode).toBe(0);
    for (const id of [a.clientId, b.clientId]) expect(await grantRow(id)).toEqual({ grant_profile: null, allowed_operations: null, scope: 'read write' });

    expect((await cli('auth', 'create', 'tok-all')).exitCode).toBe(0);
    const token = await cli('auth', 'rescope', '--token', 'tok-all', '--operations', 'all');
    expect(token.exitCode).toBe(1);
    expect(token.stderr).toContain('--reset-default operations');
    expect((await tokenRow('tok-all')).allowed_operations).toBeNull();
  }, 180_000);

  test('#6993 rescope --client with no grant flag prints the stored grants and writes nothing; an unknown id is client_not_found', async () => {
    const client = await withBrain(async engine => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      return provider.registerClientManual('client-print-example', ['client_credentials'], 'read write');
    });
    const before = await clientRow(client.clientId);
    const human = await cli('auth', 'rescope', '--client', client.clientId);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(`OAuth client grants: client-print-example (${client.clientId})`);
    expect(human.stdout).toContain('No change made.');
    const alias = await cli('auth', 'rescope-client', client.clientId, '--json');
    expect(alias.exitCode).toBe(0);
    const body = JSON.parse(alias.stdout) as { written: boolean; changed: boolean; revision: number; principal_grant: unknown };
    expect(body).toMatchObject({ written: false, changed: false, revision: before.grant_revision });
    expect(body.principal_grant).toBeDefined();
    expect(await clientRow(client.clientId)).toEqual(before);

    const missing = await cli('auth', 'rescope', '--client', 'client-missing-example', '--json');
    expect(missing.exitCode).toBe(1);
    const error = JSON.parse(missing.stdout) as { error: { code: string; fix: { argv: string[] } } };
    expect(error.error.code).toBe('client_not_found');
    expect(error.error.fix.argv.slice(0, 4)).toEqual(['gbrain', 'auth', 'clients', '--json']);
    expect(missing.stderr).toContain('Fix: Run gbrain auth clients --json');

    const repairOnly = await cli('auth', 'rescope', '--client', client.clientId, '--repair');
    expect(repairOnly.exitCode).toBe(1);
    expect(repairOnly.stderr).toContain('with --repair');
  }, 180_000);

  test('a bare name that matches both a token and a client refuses as ambiguous', async () => {
    const client = await withBrain(async engine => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      return provider.registerClientManual('shared-name-example', ['client_credentials'], 'read');
    });
    expect((await cli('auth', 'create', 'shared-name-example')).exitCode).toBe(0);
    const out = await cli('auth', 'rescope', 'shared-name-example', '--operations', 'search', '--json');
    expect(out.exitCode).toBe(1);
    const body = JSON.parse(out.stdout) as { error: { reasons: string[]; message: string } };
    expect(body.error.reasons).toEqual(['rescope_target_ambiguous']);
    expect(body.error.message).toContain(`--client ${client.clientId}`);
    expect((await cli('auth', 'rescope', '--token', 'shared-name-example', '--operations', 'search')).exitCode).toBe(0);
  }, 180_000);
});
