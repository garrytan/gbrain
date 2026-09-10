import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { currentDelegationGrant, submissionSnapshot } from '../../src/core/minions/delegated-policy.ts';
import { reserve, BudgetExceededError } from '../../src/core/minions/budget-meter.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  for (const table of ['mcp_spend_reservations', 'mcp_spend_log', 'oauth_clients']) {
    await engine.executeRaw(`DELETE FROM ${table} WHERE client_id IN ('pg-agent-fixture','pg-budget-fixture')`);
  }
});
afterAll(async () => { if (RUN) await teardownDB(); });

d('Postgres delegated admission and durable withdrawal', () => {
  test('concurrent queue submissions share one client row lock across queues', async () => {
    const engine = getEngine();
    await engine.executeRaw(`INSERT INTO oauth_clients
      (client_id,client_name,client_secret_hash,scope,grant_types,redirect_uris,token_endpoint_auth_method,
       source_id,bound_source_id,federated_read,bound_tools,delegated_namespace,bound_max_concurrent)
      VALUES ('pg-agent-fixture','fixture','','agent',ARRAY['client_credentials'],ARRAY[]::text[],'client_secret_post',
       'default','default',ARRAY['default'],ARRAY['get_page'],'job',2)`);
    const snapshot = submissionSnapshot(await currentDelegationGrant(engine, 'pg-agent-fixture'), {});
    const queue = new MinionQueue(engine);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => queue.add('subagent', {
      prompt: `fixture ${i}`, model: 'anthropic:claude-sonnet-4-6', source_id: 'default',
      allowed_tools: snapshot.tools, allowed_slug_prefixes: snapshot.slugPrefixes,
      __owner_client_id: snapshot.clientId, __delegation_grant: snapshot,
    }, { queue: `pg-queue-${i}` }, { allowProtectedSubmit: true, delegatedClientId: snapshot.clientId })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(10);
  });

  test('concurrent paid admissions reserve at most the finite cap', async () => {
    const engine = getEngine();
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,budget_usd_per_day)
      VALUES ('pg-budget-fixture','fixture','','read',1)`);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserve(engine, {
      clientId: 'pg-budget-fixture', estimatedCents: 20, capCents: 100, model: 'fixture:model', provider: 'fixture',
    })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(BudgetExceededError);
  });

  test('concurrent retries re-enter the same delegated client capacity limit', async () => {
    const engine = getEngine(); const queue = new MinionQueue(engine);
    await engine.executeRaw("UPDATE minion_jobs SET status='dead' WHERE data->>'__owner_client_id'='pg-agent-fixture'");
    const snapshot = submissionSnapshot(await currentDelegationGrant(engine, 'pg-agent-fixture'), {});
    for (let i = 0; i < 2; i++) await queue.add('subagent', {
      prompt: `retry fixture ${i}`, source_id: 'default', allowed_tools: snapshot.tools,
      allowed_slug_prefixes: snapshot.slugPrefixes, __owner_client_id: snapshot.clientId, __delegation_grant: snapshot,
    }, { queue: `pg-retry-${i}` }, { allowProtectedSubmit: true, delegatedClientId: snapshot.clientId });
    await engine.executeRaw("UPDATE minion_jobs SET status='dead' WHERE data->>'__owner_client_id'='pg-agent-fixture'");
    const jobs = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE data->>'__owner_client_id'='pg-agent-fixture'");
    expect(jobs).toHaveLength(4);
    const attempts = await Promise.allSettled(jobs.map(job => queue.retryJob(job.id)));
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(2);
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(2);
    const rows = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE status='waiting' AND data->>'__owner_client_id'='pg-agent-fixture'");
    expect(rows[0].n).toBe(2);
  });

  test('a stale renamed import cannot revive a DB-only forgotten claim', async () => {
    const engine = getEngine();
    const fact = await engine.insertFact({ fact: 'Uses a dark editor', source: 'fixture', visibility: 'world' }, { source_id: 'default' });
    await forgetFactInFence(engine, fact.id);
    await engine.executeRaw('DELETE FROM facts WHERE id=$1', [fact.id]);
    const body = `---\ntitle: Example\ntype: person\n---\n## Facts\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Uses a dark editor | fact | 1 | world | medium | 2026-01-01 | | fixture | |
<!--- gbrain:facts:end -->`;
    await importFromContent(engine, 'people/renamed-fixture', body, { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: ['people/renamed-fixture'] });
    const rows = await engine.executeRaw<{ expired_at: unknown }>("SELECT expired_at FROM facts WHERE source_markdown_slug='people/renamed-fixture'");
    expect(rows).toHaveLength(1); expect(rows[0].expired_at).not.toBeNull();
    expect((await engine.getPage('people/renamed-fixture', { sourceId: 'default' }))!.compiled_truth).toContain('~~Uses a dark editor~~');
  });

  test('an insert waits for an uncommitted withdrawal and sees it after commit', async () => {
    const engine = getEngine();
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(r => { ready = r; });
    const committed = new Promise<void>(r => { release = r; });
    const withdraw = engine.transaction(async tx => {
      await tx.executeRaw("SELECT id FROM sources WHERE id='default' FOR UPDATE");
      await tx.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
        VALUES ('default','world',gbrain_fact_fingerprint('Concurrent fixture claim'))`);
      ready(); await committed;
    });
    await started;
    const insert = engine.executeRaw<{ expired_at: unknown }>(`/* test-withdrawal-race */ INSERT INTO facts(source_id,visibility,fact,source)
      VALUES ('default','world','Concurrent fixture claim','fixture') RETURNING expired_at`);
    let waiting = false;
    try {
      for (let i = 0; i < 100; i++) {
        const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE query LIKE '/* test-withdrawal-race */%' AND wait_event_type='Lock'`);
        if (rows[0].n > 0) { waiting = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
    } finally { release(); }
    await withdraw;
    const rows = await insert;
    expect(waiting).toBe(true);
    expect(rows[0].expired_at).not.toBeNull();
  });
});
