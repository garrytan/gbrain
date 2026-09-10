import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { operationsByName } from '../src/core/operations.ts';
import { currentDelegationGrant, submissionSnapshot, effectiveDelegation, snapshotFromJob } from '../src/core/minions/delegated-policy.ts';

let engine: PGLiteEngine;
let auditDir: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '147');
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-delegation-test-'));
});
afterEach(() => rmSync(auditDir, { recursive: true, force: true }));

async function seed(opts: { tools?: string[]; prefixes?: string[] | null; cap?: number; source?: string; budget?: number | null } = {}) {
  const source = opts.source ?? 'default';
  const prefixes = opts.prefixes === undefined ? ['wiki/agents/*'] : opts.prefixes;
  await engine.executeRaw(`INSERT INTO oauth_clients
    (client_id,client_name,client_secret_hash,scope,grant_types,redirect_uris,token_endpoint_auth_method,
     source_id,federated_read,bound_tools,bound_source_id,delegated_slug_prefixes,delegated_namespace,bound_max_concurrent,budget_usd_per_day)
    VALUES ('client','client','','agent',ARRAY['client_credentials'],ARRAY[]::text[],'client_secret_post',
     $1,ARRAY[$1]::text[],$2,$1,$3,$4,$5,$6)`,
    [source, opts.tools ?? ['get_page','put_page'], prefixes, prefixes === null ? 'job' : 'prefixes', opts.cap ?? 1, opts.budget ?? null]);
}
function ctx(extra: Record<string, unknown> = {}): any {
  return { engine, config: {}, logger: console, remote: true, dryRun: false,
    auth: { clientId: 'client', scopes: ['agent'], sourceId: 'default' }, ...extra };
}
async function submit(params: Record<string, unknown> = {}, context = ctx()): Promise<any> {
  return withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => operationsByName.submit_agent.handler(context, { prompt: 'read the fixture', ...params }));
}

describe('delegation admission and submitted permission ceiling', () => {
  it('requires an authenticated agent token, including direct handler calls', async () => {
    await seed();
    await expect(submit({}, ctx({ auth: { clientId: 'client', scopes: ['read'] } }))).rejects.toThrow('agent scope');
    await expect(submit({}, ctx({ auth: undefined }))).rejects.toThrow('OAuth client');
    await expect(submit({}, ctx({ remote: false }))).rejects.toThrow('local CLI');
  });
  it('refuses unknown and revoked clients', async () => {
    await expect(submit()).rejects.toThrow('No OAuth client found');
    await seed();
    await engine.executeRaw("UPDATE oauth_clients SET deleted_at=now() WHERE client_id='client'");
    await expect(submit()).rejects.toThrow('client_revoked');
  });
  it('database boundary rejects incomplete agent bindings', async () => {
    await expect(seed({ tools: [] })).rejects.toThrow('oauth_clients_complete_agent_grant');
  });
  it('rejects removed or unknown registry tools', async () => {
    await seed({ tools: ['invented_tool'] });
    await expect(submit()).rejects.toThrow('delegated_tools_unavailable');
  });
  it('preview validates source and model without inserting work', async () => {
    await seed();
    await expect(submit({ model: 'missing-provider:model' }, ctx({ dryRun: true }))).rejects.toThrow('supported agent');
    await expect(submit({}, ctx({ dryRun: true, auth: { clientId: 'client', scopes: ['agent'], sourceId: 'other' } }))).rejects.toThrow('authenticated_source_changed');
    const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs');
    expect(rows[0]?.n).toBe(0);
  });
  it('preview shows actual tools, source, paths and explicit unlimited spending', async () => {
    await seed();
    const result = await submit({ allowed_tools: ['get_page'] }, ctx({ dryRun: true }));
    expect(result.resolved_tools).toEqual(['get_page']);
    expect(result.bound_source).toBe('default');
    expect(result.spending).toEqual({ mode: 'unlimited' });
  });
  it('preview and enqueue enforce explicit operation authority without requiring direct scopes', async () => {
    await seed();
    await engine.executeRaw("UPDATE oauth_clients SET allowed_operations=ARRAY['submit_agent','get_page'] WHERE client_id='client'");
    const preview = await submit({}, ctx({ dryRun: true }));
    expect(preview.resolved_tools).toEqual(['get_page']);
    await expect(submit({ allowed_tools: ['put_page'] }, ctx({ dryRun: true }))).rejects.toThrow('delegated_tools_invalid');
    await engine.executeRaw("UPDATE oauth_clients SET allowed_operations=ARRAY['get_page'] WHERE client_id='client'");
    await expect(submit({}, ctx({ dryRun: true }))).rejects.toThrow('delegation_operation_withdrawn');
    await expect(submit()).rejects.toThrow('delegation_operation_withdrawn');
    expect(await engine.executeRaw('SELECT * FROM minion_jobs')).toHaveLength(0);
  });
  it('later operation widening cannot widen a submitted operation ceiling', async () => {
    await seed();
    await engine.executeRaw("UPDATE oauth_clients SET allowed_operations=ARRAY['submit_agent','get_page'] WHERE client_id='client'");
    const original = submissionSnapshot(await currentDelegationGrant(engine, 'client'), {});
    await engine.executeRaw("UPDATE oauth_clients SET allowed_operations=NULL WHERE client_id='client'");
    const effective = await effectiveDelegation(engine, original);
    expect(effective.tools).toEqual(['get_page']);
  });
  it('rejects empty or broadened tool and prefix overrides', async () => {
    await seed();
    for (const params of [{ allowed_tools: [] }, { allowed_tools: ['search'] }, { allowed_slug_prefixes: [] }, { allowed_slug_prefixes: ['wiki/'] }]) {
      await expect(submit(params, ctx({ dryRun: true }))).rejects.toThrow('agent_bindings_invalid');
    }
  });
  it('checks namespace boundaries, including sibling names', async () => {
    await seed({ prefixes: ['wiki/agents/one/'] });
    await expect(submit({ allowed_slug_prefixes: ['wiki/agents/one-two/'] })).rejects.toThrow('delegated_prefixes_invalid');
    const result = await submit({ allowed_slug_prefixes: ['wiki/agents/one/sub/'] }, ctx({ dryRun: true }));
    expect(result.resolved_slug_prefixes).toEqual(['wiki/agents/one/sub/*']);
  });
  it('refuses archived sources before preview or enqueue', async () => {
    await seed();
    await engine.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
    await expect(submit({}, ctx({ dryRun: true }))).rejects.toThrow('source_inactive');
    await expect(submit()).rejects.toThrow('source_inactive');
  });
  it('rejects invalid turn limits', async () => {
    await seed();
    for (const max_turns of [0, -1, 1.5, 101, NaN]) await expect(submit({ max_turns })).rejects.toThrow('max_turns');
  });
  it('atomically admits exactly the configured count across queues', async () => {
    await seed({ cap: 2 });
    const results = await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => operationsByName.submit_agent.handler(ctx(), { prompt: `request ${i}`, queue: `queue-${i}` }))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    const jobs = await engine.executeRaw<{ data: any }>("SELECT data FROM minion_jobs WHERE name='subagent'");
    expect(jobs).toHaveLength(2);
    expect(jobs[0].data.__delegation_grant.tools).toEqual(['get_page','put_page']);
  });
  it('counts delayed and paused jobs against the same owner cap', async () => {
    await seed();
    const first = await submit();
    for (const status of ['delayed','paused','waiting-children','active']) {
      await engine.executeRaw('UPDATE minion_jobs SET status=$1 WHERE id=$2', [status, first.id]);
      await expect(submit({ prompt: 'another request' })).rejects.toThrow();
    }
  });
  it('uses an explicit job namespace and refuses prefix overrides', async () => {
    await seed({ prefixes: null });
    await expect(submit({ allowed_slug_prefixes: ['wiki/'] })).rejects.toThrow('job_namespace_cannot_be_overridden');
    const result = await submit();
    const rows = await engine.executeRaw<{ data: any }>('SELECT data FROM minion_jobs WHERE id=$1',[result.id]);
    const effective = await effectiveDelegation(engine, snapshotFromJob(rows[0].data)!, result.id);
    expect(effective.slugPrefixes).toEqual([`wiki/agents/${result.id}/*`]);
  });
  it('current tools and paths intersect the original snapshot', async () => {
    await seed({ tools: ['get_page','put_page'], prefixes: ['wiki/'] });
    const original = submissionSnapshot(await currentDelegationGrant(engine,'client'), { allowed_slug_prefixes: ['wiki/project/'] });
    await engine.executeRaw("UPDATE oauth_clients SET bound_tools=ARRAY['get_page','search'], delegated_slug_prefixes=ARRAY['wiki/project/narrow/'] WHERE client_id='client'");
    const effective = await effectiveDelegation(engine, original);
    expect(effective.tools).toEqual(['get_page']);
    expect(effective.slugPrefixes).toEqual(['wiki/project/narrow/*']);
  });
  it('grant widening does not widen submitted tools, paths or finite budget', async () => {
    await seed({ tools: ['get_page'], prefixes: ['wiki/one/'], budget: 3 });
    const original = submissionSnapshot(await currentDelegationGrant(engine,'client'), {});
    await engine.executeRaw("UPDATE oauth_clients SET bound_tools=ARRAY['get_page','put_page'], delegated_slug_prefixes=ARRAY['wiki/'], budget_usd_per_day=NULL WHERE client_id='client'");
    const effective = await effectiveDelegation(engine, original);
    expect(effective.tools).toEqual(['get_page']);
    expect(effective.slugPrefixes).toEqual(['wiki/one/*']);
    expect(Number(effective.budgetUsdPerDay)).toBe(3);
  });
  it('source changes invalidate a job instead of retargeting it', async () => {
    await seed();
    const original = submissionSnapshot(await currentDelegationGrant(engine,'client'), {});
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('another','another')");
    await engine.executeRaw("UPDATE oauth_clients SET source_id='another', bound_source_id='another', federated_read=ARRAY['another'] WHERE client_id='client'");
    await expect(effectiveDelegation(engine,original)).rejects.toThrow('submitted_source_or_brain_changed');
  });
  it('removing delegated read authority invalidates an existing job and preview', async () => {
    await seed();
    const original = submissionSnapshot(await currentDelegationGrant(engine, 'client'), {});
    await expect(engine.executeRaw("UPDATE oauth_clients SET federated_read=ARRAY[]::text[] WHERE client_id='client'")).rejects.toThrow('oauth_clients_complete_agent_grant');
    await engine.executeRaw("UPDATE oauth_clients SET scope='read',federated_read=ARRAY[]::text[] WHERE client_id='client'");
    await expect(effectiveDelegation(engine, original)).rejects.toThrow('delegated_read_source_missing');
    await expect(submit({}, ctx({ dryRun: true }))).rejects.toThrow('delegated_read_source_missing');
  });
  it('legacy or forged job payloads never turn empty tools into a full registry', () => {
    expect(() => snapshotFromJob({ __owner_client_id: 'client', allowed_tools: [], source_id: 'default' })).toThrow('legacy_snapshot_missing');
    expect(() => snapshotFromJob({ __owner_client_id: 'client', __delegation_grant: {} })).toThrow('snapshot_invalid');
  });
  it('legacy host/current brain aliases resolve to the serving brain', async () => {
    await seed();
    await engine.executeRaw("UPDATE oauth_clients SET bound_brain_id='host' WHERE client_id='client'");
    const legacy = snapshotFromJob({ __owner_client_id: 'client', allowed_tools: ['get_page'], source_id: 'default', brain_id: 'current' })!;
    const effective = await effectiveDelegation(engine, legacy, 42);
    expect(effective.brainId).toBeNull();
    expect(effective.slugPrefixes).toEqual(['wiki/agents/42/*']);
  });
});
