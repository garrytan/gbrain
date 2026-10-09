/**
 * D4 `grant_new_ops_available` doctor check: grants that cannot call operations
 * their scopes allow, with proven blockers kept apart from inferred grant age.
 * The fix asks the user, carries rescope commands that differ by credential
 * type, never defaults to `--operations all`, and changes nothing itself.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { readClientGrant, rescopeClientGrant, resolveGrantProfile } from '../src/core/grants/service.ts';
import { parseClientRescopeArgs, splitRescopeTarget } from '../src/core/grants/cli.ts';
import { parseRescopeTokenArgs } from '../src/core/grants/legacy-token.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { checkGrantNewOps, grantNewOpsEntry } from '../src/commands/doctor/checks/grant-new-ops.ts';
import { legacyTokenGrantsEntry } from '../src/commands/doctor/checks/legacy-token-grants.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { cliRenderContext, deriveNext, type Action } from '../src/core/agent-output.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
const cfg = { engine: 'pglite' } as any;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 15_000);
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM oauth_grant_audit');
  await engine.executeRaw('DELETE FROM oauth_clients');
  await engine.executeRaw('DELETE FROM access_tokens');
});

const writerProfile = () => resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' });

/** The shape every pre-D4 memory-writer has: operator-pinned starter, a snapshot without put_pages, no catalog provenance. */
async function legacyWriter(name: string): Promise<string> {
  const profile = writerProfile();
  const created = await provider.registerClientManual(name, ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
    { ...profile, surface: 'starter', allowedOperations: profile.allowedOperations!.filter(op => op !== 'put_pages') });
  await engine.executeRaw("UPDATE oauth_grant_audit SET after_grant = after_grant - 'catalogProvenance' WHERE client_id = $1", [created.clientId]);
  return created.clientId;
}

type Finding = { kind: string; id: string; name: string; blockers: any[]; grant_age: any; preview_argv: string[]; argv: string[]; all_operations_argv: string[]; excluded_operations: any };
const grants = (details: Record<string, unknown> | undefined) => (details?.grants ?? []) as Finding[];

describe('grant_new_ops_available', () => {
  test('a brain without grants, or with only fresh full-surface grants, is ok', async () => {
    expect((await checkGrantNewOps(engine, { cfg })).status).toBe('ok');
    await provider.registerClientManual('fresh-writer', ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined, writerProfile());
    const check = await checkGrantNewOps(engine, { cfg });
    expect(check.status).toBe('ok');
    expect(check.fix).toBeUndefined();
    expect(categorizeCheck('grant_new_ops_available')).toBe('ops');
  });

  test('an operator-pinned old client is reported with both blockers and intent unknown, and is not widened', async () => {
    const clientId = await legacyWriter('old-writer');
    const before = await readClientGrant(engine, clientId);
    const check = await checkGrantNewOps(engine, { cfg });
    expect(check.status).toBe('warn');
    const [f] = grants(check.details);
    expect(f).toMatchObject({ kind: 'oauth_client', id: clientId, name: 'old-writer' });
    expect(f.blockers.map(b => b.blocker)).toEqual(['operation_snapshot', 'client_pin']);
    expect(f.blockers[0]).toEqual({ blocker: 'operation_snapshot', excluded_count: 1 });
    expect(f.blockers[1]).toMatchObject({ blocker: 'client_pin', surface: 'starter', set_by: 'operator' });
    expect(f.excluded_operations.operation_snapshot).toEqual(['put_pages']);
    expect(f.grant_age).toEqual({ state: 'intent_unknown', excluded_count: 1,
      statement: "This grant's snapshot excludes 1 currently eligible operation; original intent unknown." });
    expect(check.message).toContain('original intent unknown');
    expect(check.message).not.toContain('predates');
    expect(await readClientGrant(engine, clientId)).toEqual(before);
  });

  test('client argv: an explicit --operations list plus --surface full, previewed with --dry-run, that the client parser accepts', async () => {
    const clientId = await legacyWriter('argv-writer');
    const snapshot = (await readClientGrant(engine, clientId)).allowedOperations!;
    const [f] = grants((await checkGrantNewOps(engine, { cfg })).details);
    const list = [...snapshot, 'put_pages'].sort().join(',');
    expect(f.preview_argv).toEqual(['gbrain', 'auth', 'rescope', '--client', clientId, '--operations', list, '--surface', 'full', '--dry-run']);
    expect(f.argv).toEqual(f.preview_argv.slice(0, -1));
    const target = splitRescopeTarget(f.preview_argv.slice(3));
    expect(target).toMatchObject({ kind: 'client', clientId });
    const parsed = parseClientRescopeArgs(clientId, (target as { args: string[] }).args);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.patch.allowedOperations).toContain('put_pages');
    expect(parsed.patch.surface).toBe('full');
  });

  test('token argv: --refresh-operations preview, then --add put_pages; it differs from the client argv', async () => {
    const ops = writerProfile().allowedOperations!.filter(op => op !== 'put_pages');
    await mintLegacyToken(engine, { name: 'old-token', scopes: ['read', 'write'], takesHolders: ['world'], allowedOperations: ops });
    const clientId = await legacyWriter('pair-writer');
    const found = grants((await checkGrantNewOps(engine, { cfg })).details);
    const token = found.find(f => f.kind === 'legacy_token')!;
    const client = found.find(f => f.id === clientId)!;
    expect(token.preview_argv).toEqual(['gbrain', 'auth', 'rescope', '--token', 'old-token', '--refresh-operations']);
    expect(token.argv).toEqual(['gbrain', 'auth', 'rescope', '--token', 'old-token', '--refresh-operations', '--add', 'put_pages']);
    expect(token.argv).not.toContain('--client');
    expect(client.argv).not.toContain('--refresh-operations');
    expect(token.blockers).toEqual([{ blocker: 'operation_snapshot', excluded_count: 1 }]);
    expect(token.grant_age.state).toBe('intent_unknown');
    const parsed = parseRescopeTokenArgs(token.argv.slice(4));
    expect(parsed.refreshOperations).toBe(true);
    expect(parsed.add).toEqual(['put_pages']);
  });

  test('duplicate token names fall back to the row id', async () => {
    const ops = writerProfile().allowedOperations!.filter(op => op !== 'put_pages');
    const first = await mintLegacyToken(engine, { name: 'twin-token', scopes: ['read', 'write'], takesHolders: ['world'], allowedOperations: ops });
    await mintLegacyToken(engine, { name: 'twin-token', scopes: ['read', 'write'], takesHolders: ['world'], allowedOperations: ops });
    const found = grants((await checkGrantNewOps(engine, { cfg })).details);
    expect(found.find(f => f.id === first.id)!.preview_argv).toEqual(['gbrain', 'auth', 'rescope', '--id', first.id, '--refresh-operations']);
  });

  test('the fix asks the user, previews first, and never defaults to --operations all', async () => {
    await legacyWriter('fix-writer');
    const check = await checkGrantNewOps(engine, { cfg });
    const fix = check.fix as Action;
    expect(deriveNext(fix, cliRenderContext())).toBe('ask_user');
    expect(fix.preview_argv).toContain('--dry-run');
    expect(fix.argv).not.toContain('all');
    expect(fix.preview_argv).not.toContain('all');
    const [f] = grants(check.details);
    expect(f.all_operations_argv).toEqual(['gbrain', 'auth', 'rescope', '--client', f.id, '--operations', 'all', '--surface', 'full', '--dry-run']);
    expect(fix.user_message).toContain('including ones later upgrades add');
    expect(check.message).toContain('not the default repair');
  });

  test('two identically shaped grants get identical output and the same uncertainty', async () => {
    const a = await legacyWriter('shape-a');
    const b = await legacyWriter('shape-b');
    const found = grants((await checkGrantNewOps(engine, { cfg })).details);
    const strip = (f: Finding) => JSON.parse(JSON.stringify(f).replaceAll(f.id, '<ID>').replaceAll(f.name, '<NAME>'));
    const fa = found.find(f => f.id === a)!;
    const fb = found.find(f => f.id === b)!;
    expect(strip(fa)).toEqual(strip(fb));
    expect(fa.grant_age.state).toBe('intent_unknown');
  });

  test('post-D4 wording: a snapshot written with provenance says which operations it predates', async () => {
    const created = await provider.registerClientManual('new-writer', ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined, writerProfile());
    const minted = await readClientGrant(engine, created.clientId);
    await rescopeClientGrant(engine, created.clientId, { allowedOperations: minted.allowedOperations!.filter(op => op !== 'put_pages') }, { actor: 'test' });
    let [f] = grants((await checkGrantNewOps(engine, { cfg })).details);
    expect(f.grant_age).toMatchObject({ state: 'provenance_recorded', predates_count: 0, excluded_at_snapshot_count: 1 });
    expect(f.blockers).toEqual([{ blocker: 'operation_snapshot', excluded_count: 1 }]);
    await engine.executeRaw(`UPDATE oauth_grant_audit SET after_grant = jsonb_set(after_grant, '{catalogProvenance,operations}', (after_grant->'catalogProvenance'->'operations') - 'put_pages')
      WHERE client_id = $1 AND after_grant->'catalogProvenance' IS NOT NULL`, [created.clientId]);
    const check = await checkGrantNewOps(engine, { cfg });
    [f] = grants(check.details);
    expect(f.grant_age).toMatchObject({ state: 'provenance_recorded', predates_count: 1, excluded_at_snapshot_count: 0 });
    expect(check.message).toContain('This grant predates 1 currently eligible operation');
  });

  test('a restricted reader is not offered write operations', async () => {
    const reader = resolveGrantProfile({ profile: 'memory-reader', sourceId: 'default' });
    await provider.registerClientManual('restricted-reader', ['client_credentials'], 'read', [], 'default', undefined, undefined, undefined, { ...reader, surface: 'starter' });
    const [f] = grants((await checkGrantNewOps(engine, { cfg })).details);
    expect(f.blockers[0]).toEqual({ blocker: 'scope', missing_scopes: ['write'] });
    expect([...f.excluded_operations.client_pin, ...f.excluded_operations.operation_snapshot]).not.toContain('put_pages');
  });

  test('registered after the legacy token checks', () => {
    const index = DOCTOR_CHECK_REGISTRY.indexOf(grantNewOpsEntry);
    expect(index).toBeGreaterThan(-1);
    expect(DOCTOR_CHECK_REGISTRY[index - 1]).toBe(legacyTokenGrantsEntry);
    expect(grantNewOpsEntry.emits).toEqual(['grant_new_ops_available']);
  });
});
