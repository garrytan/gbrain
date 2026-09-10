import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { currentDelegationGrant, submissionSnapshot, snapshotFromJob, effectiveDelegation } from '../../src/core/minions/delegated-policy.ts';
import { rescopeClientGrant } from '../../src/core/grants/service.ts';
import { withDelegatedSpend, maximumInvocationCents, DelegationPricingError } from '../../src/core/minions/delegated-spend.ts';
import { invokeAI, sdkInvocationUsage, withAIInvocationGuard, hasAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';
import { makeSubagentHandler, type MessagesClient } from '../../src/core/minions/handlers/subagent.ts';
import { __setChatTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import type { MinionJobContext, ToolDef } from '../../src/core/minions/types.ts';
import { getJobClientId } from '../../src/core/minion-spend.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildBrainTools } from '../../src/core/minions/tools/brain-allowlist.ts';
import { guardDelegatedTools } from '../../src/core/minions/delegated-tools.ts';
import { LINK_CANDIDATES_HEADER } from '../../src/core/cycle/link-manifest.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';
const CALL = { operation: 'fixture', kind: 'chat' as const, model: MODEL, maxInputTokens: 1000, maxOutputTokens: 100 };
let engine: PGLiteEngine;
let auditDir: string;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-delegated-execution-'));
});
beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', '147'); });
afterEach(() => { __setChatTransportForTests(null); });
afterAll(async () => { await engine.disconnect(); rmSync(auditDir, { recursive: true, force: true }); });

async function ownedJob(budget: number | null = null, extra: Record<string, unknown> = {}, tools = ['get_page', 'put_page']): Promise<MinionJobContext> {
  await engine.executeRaw(`INSERT INTO oauth_clients
    (client_id, client_name, client_secret_hash, scope, grant_types, redirect_uris, token_endpoint_auth_method,
     source_id, bound_source_id, federated_read, bound_tools, delegated_namespace, delegated_slug_prefixes, budget_usd_per_day)
    VALUES ('owner','owner','','agent',ARRAY['client_credentials'],ARRAY[]::text[],'client_secret_post',
      'default','default',ARRAY['default'],$2::text[],'prefixes',ARRAY['wiki/agents/*'],$1)`, [budget, tools]);
  const snapshot = submissionSnapshot(await currentDelegationGrant(engine, 'owner'), {});
  const data = { prompt: 'fixture', model: MODEL, max_turns: 2,
    allowed_tools: snapshot.tools, allowed_slug_prefixes: snapshot.slugPrefixes, source_id: snapshot.sourceId,
    ...extra, __owner_client_id: 'owner', __delegation_grant: snapshot };
  const job = await new MinionQueue(engine).add('subagent', data, {}, { allowProtectedSubmit: true, delegatedClientId: 'owner' });
  return { id: job.id, name: job.name, data, attempts_made: 0,
    signal: new AbortController().signal, shutdownSignal: new AbortController().signal, deadlineAtMs: null,
    async updateProgress() {}, async updateTokens() {}, async log() {}, async isActive() { return true; }, async readInbox() { return []; } };
}
function owned<T>(ctx: MinionJobContext, run: () => Promise<T>) {
  return withDelegatedSpend(engine, ctx.data.__delegation_grant as any, ctx.id, run);
}
function result(text = 'done', blocks: ChatResult['blocks'] = [{ type: 'text', text }]): ChatResult {
  return { text, blocks, stopReason: 'end', model: MODEL, providerId: 'anthropic',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 } };
}
function rawClient(next: () => Promise<unknown>): MessagesClient {
  return { create: async () => await next() as any };
}
function rawMessage(content: unknown[] = [{ type: 'text', text: 'done' }]) {
  return { id: 'fixture-message', type: 'message', role: 'assistant', model: MODEL, stop_reason: 'end_turn', stop_sequence: null,
    content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
const tool = (execute: ToolDef['execute']): ToolDef => ({ name: 'brain_put_page', description: 'fixture write',
  input_schema: { type: 'object', properties: {} }, idempotent: true, execute });
const readTool: ToolDef = { ...tool(async () => ({})), name: 'brain_get_page' };
function runHandler(handler: ReturnType<typeof makeSubagentHandler>, ctx: MinionJobContext) {
  return withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => handler(ctx));
}

function productionTools(ctx: MinionJobContext) {
  const config = { engine: 'pglite' } as GBrainConfig;
  return guardDelegatedTools(engine, config, snapshotFromJob(ctx.data), ctx.id,
    buildBrainTools({ engine, config, subagentId: ctx.id }), false, true);
}
async function seedPage(slug: string, body: string, sourceId = 'default', privatePage = false) {
  await importFromContent(engine, slug, `---\ntitle: Fixture\ntype: note\n${privatePage ? 'visibility: private\nid: private-fixture-id\n' : ''}---\n${body}`, { noEmbed: true, sourceId });
}

describe('remote-owned production tool visibility', () => {
  it('every source-selecting read enforces the current grant including explicit overrides', async () => {
    const ctx = await ownedJob(null, {}, ['get_page', 'search', 'query', 'list_pages', 'resolve_slugs']);
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('other','Other fixture')");
    await seedPage('notes/shared', 'own-source-marker');
    await seedPage('notes/shared', 'foreign-source-marker', 'other');
    expect((await engine.getPage('notes/shared', { sourceId: 'other' }))?.compiled_truth).toContain('foreign-source-marker');
    const tools = productionTools(ctx);
    const invoke = (name: string, input: unknown) => tools.find(t => t.name === `brain_${name}`)!.execute(input, { engine, jobId: ctx.id, remote: true });
    for (const [name, input] of Object.entries({
      get_page: { slug: 'notes/shared' }, search: { query: 'marker' }, query: { query: 'marker' },
      list_pages: {}, resolve_slugs: { partial: 'shared' },
    })) await expect(invoke(name, { ...input, source_id: 'other' })).rejects.toThrow('outside your granted sources');
    for (const source_id of [undefined, '__all__', 'default']) {
      const read = await invoke('get_page', { slug: 'notes/shared', include_content: true, source_id, source_ids: ['other'] });
      expect(JSON.stringify(read)).toContain('own-source-marker');
      expect(JSON.stringify(read)).not.toContain('foreign-source-marker');
    }
  });
  it('agent-only bindings can write visible pages but cannot overwrite or append to private pages', async () => {
    const ctx = await ownedJob(null, {}, ['get_page', 'put_page', 'add_timeline_entry']);
    await seedPage('wiki/agents/hidden', 'private-body-marker', 'default', true);
    const tools = productionTools(ctx);
    const invoke = (name: string, input: unknown) => tools.find(t => t.name === `brain_${name}`)!.execute(input, { engine, jobId: ctx.id, remote: true });
    await expect(invoke('get_page', { slug: 'wiki/agents/hidden' })).rejects.toThrow('Page not found');
    for (const content of ['Replacement', '', '---\nvisibility: public\n---\nReplacement']) {
      await expect(invoke('put_page', { slug: 'wiki/agents/hidden', content, allow_empty: true })).rejects.toThrow('outside your write visibility');
    }
    await expect(invoke('put_page', { slug: 'wiki/agents/HIDDEN', content: 'Replacement' })).rejects.toThrow();
    await expect(invoke('add_timeline_entry', { slug: 'wiki/agents/hidden', date: '2026-08-01', summary: 'Unwanted entry' })).rejects.toThrow('outside your write visibility');
    await expect(invoke('put_page', { slug: 'wiki/agents/alias', content: '---\nid: private-fixture-id\n---\nReplacement' })).rejects.toThrow('outside your write visibility');
    expect((await engine.getPage('wiki/agents/hidden', { sourceId: 'default' }))?.compiled_truth).toContain('private-body-marker');
    expect(await engine.getTimeline('wiki/agents/hidden', { sourceId: 'default' })).toHaveLength(0);
    await engine.softDeletePage('wiki/agents/hidden', { sourceId: 'default' });
    await expect(invoke('put_page', { slug: 'wiki/agents/hidden', content: 'Unwanted restore' })).rejects.toThrow('outside your write visibility');
    const written = await invoke('put_page', { slug: 'wiki/agents/visible', content: 'Visible delegated memory' });
    expect((written as { status: string }).status).toBe('created_or_updated');
    expect((await currentDelegationGrant(engine, 'owner')).scopes).toEqual(['agent']);
  });
  it('delegated writes never expose private-target resolution counts or enable automatic links', async () => {
    const ctx = await ownedJob();
    await seedPage('wiki/agents/hidden', 'Private fixture', 'default', true);
    await seedPage('wiki/agents/public', 'Public fixture');
    const write = productionTools(ctx).find(t => t.name === 'brain_put_page')!;
    for (const target of ['hidden', 'missing']) {
      const value = await write.execute({ slug: `wiki/agents/ref-${target}`, content: `See [[wiki/agents/${target}]].` }, { engine, jobId: ctx.id, remote: true }) as any;
      expect(value.auto_links.skipped).toBe('remote');
      expect(value.auto_links.created).toBeUndefined();
      expect(value.auto_timeline.skipped).toBe('remote');
    }
    expect(await engine.executeRaw('SELECT * FROM links')).toHaveLength(0);
    const local = buildBrainTools({ engine, config: { engine: 'pglite' } as GBrainConfig, subagentId: ctx.id,
      sourceId: 'default', allowedSlugPrefixes: ['wiki/agents/*'], deferEmbeds: true }).find(t => t.name === 'brain_put_page')!;
    const value = await local.execute({ slug: 'wiki/agents/local', content: 'See [[wiki/agents/public]].' }, { engine, jobId: ctx.id, remote: true }) as any;
    expect(value.auto_links.created).toBe(1);
  });
  for (const gateway of [false, true]) it(`${gateway ? 'gateway' : 'legacy'} loop rejects a foreign source using real operation handlers`, async () => {
    const ctx = await ownedJob(); let calls = 0;
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('other','Other fixture')");
    await seedPage('notes/foreign', 'foreign-body-marker', 'other');
    await engine.setConfig('agent.use_gateway_loop', String(gateway));
    const input = { slug: 'notes/foreign', source_id: 'other', include_content: true };
    const handler = gateway ? makeSubagentHandler({ engine }) : makeSubagentHandler({ engine, client: rawClient(async () => ++calls === 1
      ? rawMessage([{ type: 'tool_use', id: 'foreign', name: 'brain_get_page', input }]) : rawMessage()) });
    if (gateway) __setChatTransportForTests(async () => ++calls === 1
      ? result('', [{ type: 'tool-call', toolCallId: 'foreign', toolName: 'brain_get_page', input }]) : result());
    await runHandler(handler, ctx);
    const rows = await engine.executeRaw<{ status: string; error: string; output: unknown }>('SELECT status,error,output FROM subagent_tool_executions WHERE job_id=$1', [ctx.id]);
    expect(rows).toHaveLength(1); expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('outside your granted sources');
    expect(JSON.stringify(rows)).not.toContain('foreign-body-marker');
  });
  it('oneshot treats private and missing link targets identically without running either auto-link pass', async () => {
    const ctx = await ownedJob(null, { mode: 'oneshot', prompt: `fixture ${LINK_CANDIDATES_HEADER}` });
    let calls = 0;
    await seedPage('wiki/agents/hidden', 'private-body-marker', 'default', true);
    const pages = [
      { slug: 'wiki/agents/private-ref', title: 'Private ref', body: 'See [[wiki/agents/hidden]].' },
      { slug: 'wiki/agents/missing-ref', title: 'Missing ref', body: 'See [[wiki/agents/missing]].' },
      { slug: 'wiki/agents/sibling-ref', title: 'Sibling ref', body: 'See [[wiki/agents/private-ref]].' },
    ];
    const handler = makeSubagentHandler({ engine, client: rawClient(async () => { throw new Error('Unexpected agentic fallback'); }),
      _chat: async () => { calls++; return result(JSON.stringify({ pages, skipped: false })); } });
    const output = await runHandler(handler, ctx);
    expect(output.synth_mode_used).toBe('oneshot'); expect(output.written_refs).toHaveLength(3);
    expect(output.written_refs?.every(ref => ref.status === 'complete')).toBe(true);
    expect(await engine.executeRaw('SELECT * FROM links')).toHaveLength(0);
    // Simulate a crash after writes but before the terminal transcript: the
    // production recovery path must not revive the local post-batch hook.
    await engine.executeRaw('DELETE FROM subagent_messages WHERE job_id=$1', [ctx.id]);
    expect((await runHandler(handler, ctx)).recovered).toBe(true);
    expect(calls).toBe(1);
    expect(await engine.executeRaw('SELECT * FROM links')).toHaveLength(0);
  });
  it('oneshot cannot overwrite a private page inside its allowed write prefix', async () => {
    const ctx = await ownedJob(null, { mode: 'oneshot' });
    await seedPage('wiki/agents/hidden', 'private-body-marker', 'default', true);
    const handler = makeSubagentHandler({ engine, client: rawClient(async () => { throw new Error('Unexpected agentic fallback'); }),
      _chat: async () => result(JSON.stringify({ pages: [{ slug: 'wiki/agents/hidden', title: 'Replacement', body: 'Changed [[wiki/agents/missing]].' }], skipped: false })) });
    const output = await runHandler(handler, ctx);
    expect(output.written_refs?.[0].status).toBe('failed');
    expect((await engine.getPage('wiki/agents/hidden', { sourceId: 'default' }))?.compiled_truth).toContain('private-body-marker');
  });
});

describe('durable delegated provider accounting', () => {
  it('reserves a priced maximum before IO and settles measured usage', async () => {
    const ctx = await ownedJob(1);
    expect(maximumInvocationCents(CALL)).toBe(0.75);
    await owned(ctx, () => invokeAI(CALL, async () => {
      const rows = await engine.executeRaw<{ status: string; actual_cents: unknown; estimated_cents: string }>('SELECT status,actual_cents,estimated_cents::text FROM mcp_spend_reservations');
      expect(rows).toHaveLength(1); expect(rows[0].status).toBe('pending'); expect(rows[0].actual_cents).toBeNull();
      expect(Number(rows[0].estimated_cents)).toBe(0.75);
      return result();
    }, sdkInvocationUsage));
    const rows = await engine.executeRaw<{ status: string; actual_cents: string }>('SELECT status,actual_cents::text FROM mcp_spend_reservations');
    expect(rows[0].status).toBe('settled'); expect(Number(rows[0].actual_cents)).toBeCloseTo(0.0105, 4);
  });
  it('finite caps refuse unknown prices or absent enforced bounds before IO', async () => {
    const ctx = await ownedJob(1); let calls = 0;
    for (const call of [{ ...CALL, model: 'custom:unpriced' }, { ...CALL, maxInputTokens: undefined }, { ...CALL, kind: 'rerank' as const }]) {
      await expect(owned(ctx, () => invokeAI(call, async () => { calls++; return result(); }, sdkInvocationUsage))).rejects.toThrow(DelegationPricingError);
    }
    expect(calls).toBe(0);
  });
  it('unlimited unknown pricing is explicit, never a fabricated zero-dollar result', async () => {
    const ctx = await ownedJob();
    await owned(ctx, () => invokeAI({ ...CALL, model: 'custom:unpriced' }, async () => result(), sdkInvocationUsage));
    const rows = await engine.executeRaw<{ estimate_known: boolean; actual_cents: unknown; usage_unknown_reason: string }>('SELECT estimate_known,actual_cents,usage_unknown_reason FROM mcp_spend_reservations');
    expect(rows[0]).toEqual({ estimate_known: false, actual_cents: null, usage_unknown_reason: 'pricing_unknown' });
    const logs = await engine.executeRaw('SELECT * FROM mcp_spend_log'); expect(logs).toHaveLength(0);
  });
  it('missing usage and ambiguous provider errors retain unresolved holds', async () => {
    const ctx = await ownedJob(1);
    await owned(ctx, () => invokeAI(CALL, async () => ({}), sdkInvocationUsage));
    await expect(owned(ctx, () => invokeAI(CALL, async () => { throw new Error('connection lost after request'); }, sdkInvocationUsage))).rejects.toThrow('connection lost');
    const holds = await engine.executeRaw<{ status: string; actual_cents: unknown; usage_unknown_reason: string }>('SELECT status,actual_cents,usage_unknown_reason FROM mcp_spend_reservations');
    expect(holds).toHaveLength(2);
    expect(holds.every(h => h.status === 'pending' && h.actual_cents === null && h.usage_unknown_reason === 'provider_usage_unknown')).toBe(true);
  });
  it('revocation stops the next provider attempt without another reservation', async () => {
    const ctx = await ownedJob(); let calls = 0;
    await owned(ctx, async () => {
      await invokeAI(CALL, async () => { calls++; return result(); }, sdkInvocationUsage);
      await engine.executeRaw("UPDATE oauth_clients SET deleted_at=now() WHERE client_id='owner'");
      await expect(invokeAI(CALL, async () => { calls++; return result(); }, sdkInvocationUsage)).rejects.toThrow('client_revoked');
    });
    expect(calls).toBe(1);
    expect(await engine.executeRaw('SELECT * FROM mcp_spend_reservations')).toHaveLength(1);
  });
  it('revocation between preflight and locked admission still prevents IO', async () => {
    const ctx = await ownedJob(); let calls = 0;
    const interrupted = Object.create(engine) as PGLiteEngine;
    Object.defineProperty(interrupted, 'transaction', { value: async (fn: any) => {
      await engine.executeRaw("UPDATE oauth_clients SET deleted_at=now() WHERE client_id='owner'");
      return engine.transaction(fn);
    } });
    await expect(withDelegatedSpend(interrupted, ctx.data.__delegation_grant as any, ctx.id,
      () => invokeAI(CALL, async () => { calls++; return result(); }, sdkInvocationUsage))).rejects.toThrow('client_revoked');
    expect(calls).toBe(0);
    expect(await engine.executeRaw('SELECT * FROM mcp_spend_reservations')).toHaveLength(0);
  });
  it('concurrent local work does not inherit a delegated owner or permit', async () => {
    let guarded = 0;
    await Promise.all([
      withAIInvocationGuard(async () => { guarded++; return { async settle() {} }; }, async () => {
        await Promise.resolve(); expect(hasAIInvocationGuard()).toBe(true);
        await invokeAI(CALL, async () => result(), sdkInvocationUsage);
      }),
      (async () => { await Promise.resolve(); expect(hasAIInvocationGuard()).toBe(false); await invokeAI(CALL, async () => result(), sdkInvocationUsage); })(),
    ]);
    expect(guarded).toBe(1);
  });
  it('an already-running legacy snapshot adopts the original cap frozen during rescope', async () => {
    const ctx = await ownedJob(1);
    delete ctx.data.__delegation_grant;
    await engine.executeRaw("UPDATE minion_jobs SET data=data-'__delegation_grant',status='paused' WHERE id=$1", [ctx.id]);
    const legacy = snapshotFromJob(ctx.data)!;
    await rescopeClientGrant(engine, 'owner', { budgetUsdPerDay: null }, { actor: 'fixture' });
    const effective = await effectiveDelegation(engine, legacy, ctx.id);
    expect(Number(effective.budgetUsdPerDay)).toBe(1);
    expect(effective.tools).toEqual(['get_page','put_page']);
  });
  it('protected ownership wins over caller-selected accounting fields', () => {
    expect(getJobClientId({ id: 1, data: { __owner_client_id: 'owner', client_id: 'spoof' } })).toBe('owner');
    expect(getJobClientId({ id: 1, data: { __owner_client_id: null, client_id: 'spoof' } })).toBeUndefined();
  });
  it('SDK total input and raw Anthropic uncached input settle to the same usage', () => {
    const raw = sdkInvocationUsage({ usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } });
    const sdk = sdkInvocationUsage({ usage: { inputTokens: 35, outputTokens: 2, inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 } } });
    expect(raw).toEqual(sdk);
    expect(sdk?.inputTokens).toBe(10);
    expect(sdkInvocationUsage({ usage: { inputTokens: 10 } })).toBeNull();
  });
});

describe('delegated execution across loop and recovery paths', () => {
  it('replay rejects forged identity and changes to original delegated bounds', async () => {
    const ctx = await ownedJob(1); const queue = new MinionQueue(engine);
    await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [ctx.id]);
    for (const overrides of [
      { __owner_client_id: null }, { __delegation_grant: { ...ctx.data.__delegation_grant as object, budgetUsdPerDay: null } },
      { client_id: 'another' }, { allowed_tools: ['search'] }, { allowed_slug_prefixes: [] },
      { source_id: 'another' }, { brain_id: 'another' }, { max_turns: 100 }, { max_tokens: 999999 },
    ]) await expect(queue.replayJob(ctx.id, overrides)).rejects.toThrow('override_forbidden');
    expect(await engine.executeRaw('SELECT * FROM minion_jobs')).toHaveLength(1);
  });
  it('replay preserves the original owner and finite ceiling and atomically consumes a slot', async () => {
    const ctx = await ownedJob(1); const queue = new MinionQueue(engine);
    await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [ctx.id]);
    await engine.executeRaw("UPDATE oauth_clients SET budget_usd_per_day=NULL WHERE client_id='owner'");
    const attempts = await Promise.allSettled([queue.replayJob(ctx.id, { prompt: 'Retry the task' }), queue.replayJob(ctx.id)]);
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1);
    const replay = (attempts.find(attempt => attempt.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof queue.replayJob>>>).value!;
    expect(replay.data.__owner_client_id).toBe('owner');
    expect(replay.data.__delegation_grant).toEqual(ctx.data.__delegation_grant);
    expect(Number((await effectiveDelegation(engine, snapshotFromJob(replay.data)!, replay.id)).budgetUsdPerDay)).toBe(1);
  });
  it('retry admission shares the same client cap and preserves data', async () => {
    const ctx = await ownedJob(); const queue = new MinionQueue(engine);
    await engine.executeRaw("UPDATE minion_jobs SET status='dead' WHERE id=$1", [ctx.id]);
    const second = await queue.add('subagent', ctx.data, {}, { allowProtectedSubmit: true, delegatedClientId: 'owner' });
    await engine.executeRaw("UPDATE minion_jobs SET status='failed' WHERE id=$1", [second.id]);
    const originals = await engine.executeRaw<{ id: number; data: unknown }>('SELECT id,data FROM minion_jobs');
    const attempts = await Promise.allSettled([queue.retryJob(ctx.id), queue.retryJob(second.id)]);
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1);
    const rows = await engine.executeRaw<{ id: number; data: unknown }>("SELECT id,data FROM minion_jobs WHERE status='waiting'");
    expect(rows).toHaveLength(1); expect(rows[0].data).toEqual(originals.find(row => row.id === rows[0].id)!.data);
  });
  it('legacy terminal jobs without an original ceiling require fresh authenticated submission', async () => {
    const ctx = await ownedJob(); const queue = new MinionQueue(engine);
    await engine.executeRaw("UPDATE minion_jobs SET data=data-'__delegation_grant',status='dead' WHERE id=$1", [ctx.id]);
    await expect(queue.replayJob(ctx.id)).rejects.toThrow('replay_original_snapshot_missing');
    await expect(queue.retryJob(ctx.id)).rejects.toThrow('replay_original_snapshot_missing');
  });
  it('nondelegated replay also forbids caller-selected spend attribution', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('fixture', { prompt: 'fixture' });
    await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [job.id]);
    await expect(queue.replayJob(job.id, { client_id: 'spoof' })).rejects.toThrow('replay_identity_override_forbidden');
  });
  it('queued jobs stop before provider IO when submit_agent authority is removed', async () => {
    const ctx = await ownedJob(); let calls = 0;
    await engine.executeRaw("UPDATE oauth_clients SET allowed_operations=ARRAY['get_page','put_page'] WHERE client_id='owner'");
    const handler = makeSubagentHandler({ engine, client: rawClient(async () => { calls++; return rawMessage(); }), toolRegistry: [readTool] });
    await expect(runHandler(handler, ctx)).rejects.toThrow('delegation_operation_withdrawn');
    expect(calls).toBe(0);
    expect(await engine.executeRaw('SELECT * FROM mcp_spend_reservations')).toHaveLength(0);
  });
  it('running jobs stop at the next model boundary after submit_agent is removed', async () => {
    const ctx = await ownedJob(); let calls = 0; let reads = 0;
    const handler = makeSubagentHandler({ engine, client: rawClient(async () => {
      calls++; return rawMessage([{ type: 'tool_use', id: 'read', name: 'brain_get_page', input: {} }]);
    }), toolRegistry: [{ ...readTool, async execute() {
      reads++; await engine.executeRaw("UPDATE oauth_clients SET allowed_operations=ARRAY['get_page'] WHERE client_id='owner'");
      return {};
    } }, tool(async () => ({}))] });
    await expect(runHandler(handler, ctx)).rejects.toThrow('delegation_operation_withdrawn');
    expect(calls).toBe(1); expect(reads).toBe(1);
    expect(await engine.executeRaw('SELECT * FROM mcp_spend_reservations')).toHaveLength(1);
  });
  it('running jobs cannot invoke a tool removed only from operation authority', async () => {
    const ctx = await ownedJob(); let calls = 0; let writes = 0;
    const handler = makeSubagentHandler({ engine, client: rawClient(async () => {
      if (++calls > 1) return rawMessage();
      await engine.executeRaw("UPDATE oauth_clients SET allowed_operations=ARRAY['submit_agent','get_page'] WHERE client_id='owner'");
      return rawMessage([{ type: 'tool_use', id: 'write', name: 'brain_put_page', input: {} }]);
    }), toolRegistry: [readTool, tool(async () => { writes++; return {}; })] });
    await runHandler(handler, ctx);
    expect(calls).toBe(2); expect(writes).toBe(0);
    const rows = await engine.executeRaw<{ status: string; error: string }>('SELECT status,error FROM subagent_tool_executions WHERE job_id=$1', [ctx.id]);
    expect(rows[0].status).toBe('failed'); expect(rows[0].error).toContain('delegated_tool_withdrawn');
  });
  it('nested paid tool work uses the same trusted owner and reserves separately', async () => {
    const ctx = await ownedJob(); let calls = 0; let paidTools = 0;
    const handler = makeSubagentHandler({ engine, toolRegistry: [readTool, tool(async () => {
      return invokeAI(CALL, async () => { paidTools++; return result(); }, sdkInvocationUsage);
    })], client: rawClient(async () => ++calls === 1
      ? rawMessage([{ type: 'tool_use', id: 'paid-write', name: 'brain_put_page', input: { client_id: 'spoof' } }])
      : rawMessage()) });
    await runHandler(handler, ctx);
    expect(calls).toBe(2); expect(paidTools).toBe(1);
    const holds = await engine.executeRaw<{ client_id: string; status: string }>('SELECT client_id,status FROM mcp_spend_reservations');
    expect(holds).toHaveLength(3); expect(holds.every(h => h.client_id === 'owner' && h.status === 'settled')).toBe(true);
  });
  it('legacy Anthropic loop rechecks grant before a returned tool call', async () => {
    const ctx = await ownedJob(); let writes = 0; let calls = 0;
    const handler = makeSubagentHandler({ engine, toolRegistry: [readTool, tool(async () => { writes++; return {}; })], client: rawClient(async () => {
      calls++; await engine.executeRaw("UPDATE oauth_clients SET deleted_at=now() WHERE client_id='owner'");
      return rawMessage([{ type: 'tool_use', id: 'write', name: 'brain_put_page', input: {} }]);
    }) });
    await expect(runHandler(handler, ctx)).rejects.toThrow('client_revoked');
    expect(writes).toBe(0); expect(calls).toBe(1);
  });
  it('gateway loop rechecks a withdrawn tool and accounts its model call', async () => {
    const ctx = await ownedJob(null, { max_turns: 1 }); let writes = 0; let calls = 0;
    await engine.setConfig('agent.use_gateway_loop', 'true');
    __setChatTransportForTests(async () => {
      calls++; await engine.executeRaw("UPDATE oauth_clients SET bound_tools=ARRAY['get_page'] WHERE client_id='owner'");
      return result('', [{ type: 'tool-call', toolCallId: 'write', toolName: 'brain_put_page', input: {} }]);
    });
    const handler = makeSubagentHandler({ engine, toolRegistry: [readTool, tool(async () => { writes++; return {}; })] });
    await runHandler(handler, ctx);
    expect(writes).toBe(0); expect(calls).toBe(1);
    const holds = await engine.executeRaw<{ status: string }>('SELECT status FROM mcp_spend_reservations');
    expect(holds).toHaveLength(1); expect(holds[0].status).toBe('settled');
  });
  it('replay cannot dispatch a stored tool call after its grant was narrowed', async () => {
    const ctx = await ownedJob(); let writes = 0;
    await engine.executeRaw(`INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks)
      VALUES ($1,0,'user',$2::jsonb),($1,1,'assistant',$3::jsonb)`, [ctx.id,
      JSON.stringify([{ type: 'text', text: 'fixture' }]),
      JSON.stringify([{ type: 'tool_use', id: 'replay-write', name: 'brain_put_page', input: {} }])]);
    await engine.executeRaw("UPDATE oauth_clients SET bound_tools=ARRAY['get_page'] WHERE client_id='owner'");
    const handler = makeSubagentHandler({ engine, client: rawClient(async () => rawMessage()), toolRegistry: [readTool, tool(async () => { writes++; return {}; })] });
    await runHandler(handler, ctx);
    expect(writes).toBe(0);
  });
  it('oneshot honors revocation between model completion and writes', async () => {
    const ctx = await ownedJob(null, { mode: 'oneshot', oneshot_slug_suffix: 'abc123' }); let writes = 0; let calls = 0;
    const handler = makeSubagentHandler({ engine, toolRegistry: [readTool, tool(async () => { writes++; return {}; })],
      _chat: async () => {
        calls++; await engine.executeRaw("UPDATE oauth_clients SET deleted_at=now() WHERE client_id='owner'");
        return result(JSON.stringify({ pages: [{ slug: 'wiki/agents/example-abc123', body: 'See [[wiki/agents/example-abc123]].' }], skipped: false }));
      } });
    await expect(runHandler(handler, ctx)).rejects.toThrow('client_revoked');
    expect(writes).toBe(0); expect(calls).toBe(1);
    expect(await engine.executeRaw('SELECT * FROM mcp_spend_reservations')).toHaveLength(1);
  });
});
