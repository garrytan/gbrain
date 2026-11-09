/**
 * Agent handoff on real Postgres. The PGLite suites (test/agent-handoff-*.test.ts)
 * pin the contract; this proves it where claims race over a connection pool:
 *   - agents racing for one task get exactly one winner (the revision-checked
 *     page write is the lock, across concurrent Postgres transactions);
 *   - an expired lease reopens; a task addressed to A is invisible to B;
 *   - fan_out + pick_result update routing_stats and route;
 *   - find_thread ranks the intended thread first; the pickup packet is whole
 *     and records grok-bot -> claude;
 *   - exporting the handoff pages with the canonical markdown render and
 *     importing them into a fresh Postgres brain rebuilds every handoff view.
 *
 * Gated by DATABASE_URL — skips gracefully without real Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { extractLinksForSlugs } from '../../src/commands/extract.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { __setHandoffClockForTests } from '../../src/core/handoff/store.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const SKIP = !hasDatabase();
const describePg = SKIP ? describe.skip : describe;

const ctxFor = (engine: BrainEngine): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false,
} as unknown as OperationContext);
const call = async (name: string, params: Record<string, unknown>, engine: BrainEngine = getEngine()) =>
  await operationsByName[name]!.handler(ctxFor(engine), params) as Record<string, any>;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof OperationError ? e.code : String(e)));

describePg('agent handoff on real Postgres', () => {
  beforeAll(async () => {
    await setupDB();
  }, 240_000);

  afterAll(async () => {
    __setHandoffClockForTests(null);
    await disposePersistenceConsumer(getEngine());
    await teardownDB();
  });

  test('agents racing for one task get exactly one winner', async () => {
    const agents = ['pg-claude-a', 'pg-claude-b', 'pg-claude-c', 'pg-claude-d'];
    for (const name of agents) await call('register_agent', { name, model: 'claude-opus-5-5' });
    for (let round = 0; round < 3; round++) {
      const d = await call('delegate', { from_agent: 'grok-bot', to_model: 'claude-opus-5-5', title: `PG race ${round}`, instructions: 'x' });
      const results = await Promise.all(agents.map(agent => call('claim_task', { task_id: d.task_id, agent }).then(
        r => ({ ok: true as const, holder: r.task.claimed_by as string }),
        (e: OperationError) => ({ ok: false as const, code: e.code }))));
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(results.filter(r => !r.ok).map(r => (r as { code: string }).code)).toEqual(['task_claimed', 'task_claimed', 'task_claimed']);
      const box = await call('inbox', { agent: (results.find(r => r.ok) as { holder: string }).holder });
      expect(box.claimed.map((t: any) => t.task_id)).toContain(d.task_id);
    }
  }, 120_000);

  test('an expired lease reopens; a task addressed to A is invisible to B', async () => {
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    __setHandoffClockForTests(() => t0);
    await call('register_agent', { name: 'pg-a', model: 'gpt-5' });
    await call('register_agent', { name: 'pg-b', model: 'gpt-5' });
    const mine = await call('delegate', { from_agent: 'grok-bot', to_agent: 'pg-a', title: 'Only for A', instructions: 'x' });
    expect((await call('inbox', { agent: 'pg-b' })).open.map((t: any) => t.task_id)).not.toContain(mine.task_id);
    expect(await refusal(call('claim_task', { task_id: mine.task_id, agent: 'pg-b' }))).toBe('task_not_addressed');

    const shared = await call('delegate', { from_agent: 'grok-bot', to_model: 'gpt-5', title: 'Lease on Postgres', instructions: 'x' });
    await call('claim_task', { task_id: shared.task_id, agent: 'pg-a' });
    expect(await refusal(call('claim_task', { task_id: shared.task_id, agent: 'pg-b' }))).toBe('task_claimed');
    __setHandoffClockForTests(() => t0 + 16 * 60_000);
    const box = await call('inbox', { agent: 'pg-b' });
    expect(box.open.find((t: any) => t.task_id === shared.task_id)).toMatchObject({ status: 'open', lease_expired: true });
    expect((await call('heartbeat', { name: 'pg-b' })).reopened).toContain(shared.task_id);
    expect((await call('claim_task', { task_id: shared.task_id, agent: 'pg-b' })).task).toMatchObject({ claimed_by: 'pg-b', attempts: 2 });
    __setHandoffClockForTests(null);
  }, 120_000);

  test('fan_out + pick_result update routing_stats and route', async () => {
    await call('register_agent', { name: 'pg-writer-1', model: 'claude-opus-5-5' });
    await call('register_agent', { name: 'pg-writer-2', model: 'gpt-5' });
    const fan = await call('fan_out', { from_agent: 'grok-bot', agents: ['pg-writer-1', 'pg-writer-2'], title: 'PG headline options', instructions: 'x' });
    for (const t of fan.tasks) {
      await call('claim_task', { task_id: t.task_id, agent: t.to_agent });
      await call('complete_task', { task_id: t.task_id, agent: t.to_agent, result: `${t.to_agent} headlines` });
    }
    await call('pick_result', { task_id: fan.tasks[1].task_id });
    const stats = await call('routing_stats', {});
    expect(stats.agents.find((a: any) => a.agent === 'pg-writer-2').fan_out).toMatchObject({ wins: 1, win_rate: 1 });
    expect(stats.agents.find((a: any) => a.agent === 'pg-writer-1').fan_out).toMatchObject({ wins: 0, win_rate: 0 });
    const routed = await call('route', { tags: ['headlines'], exclude: ['pg-claude-a', 'pg-claude-b', 'pg-claude-c', 'pg-claude-d', 'pg-a', 'pg-b'] });
    const order = routed.targets.map((t: any) => t.target);
    expect(order.indexOf('pg-writer-2')).toBeLessThan(order.indexOf('pg-writer-1'));
  }, 120_000);

  test('find_thread ranks the intended thread first; the pickup packet is whole and records grok-bot -> claude', async () => {
    await call('put_page', { slug: 'properties/12-oak-st', content: '---\ntype: note\ntitle: 12 Oak St\n---\n# 12 Oak St\n\nA listing.\n' });
    await call('log_turn', { agent: 'claude', title: 'PG Elm Ave listing deck', summary: 'Listing deck for Elm Ave.' });
    await call('log_turn', { agent: 'chatgpt', title: 'PG Oak furniture budget', summary: 'Oak tables for the office.' });
    await call('log_turn', { agent: 'grok-bot', model: 'grok-4', title: 'PG seller presentation', summary: 'Deck for the corner house.',
      decisions: ['Blue template'], open_questions: ['Which comps?'], entities: ['properties/12-oak-st'] });
    await call('checkpoint', { thread_id: 'pg-seller-presentation', agent: 'grok-bot', next_up: 'Hand off slides' });
    const found = await call('find_thread', { query: '12 Oak St', agent: 'grok-bot' });
    expect(found.matches[0].thread_id).toBe('pg-seller-presentation');
    expect(found.matches[0].why).toContain('links to [[properties/12-oak-st]]');

    const packet = await call('pickup', { thread_id: 'pg-seller-presentation', agent: 'claude' });
    expect(packet).toMatchObject({ history: 'grok-bot -> claude', next_up: 'Hand off slides', decisions: ['Blue template'], open_questions: ['Which comps?'], status: 'active' });
    expect(packet.summary).toBe('Deck for the corner house.');
    expect(packet.last_turns.map((t: any) => t.kind)).toEqual(['turn', 'checkpoint']);
    expect(packet.linked_pages).toContainEqual(expect.objectContaining({ slug: 'properties/12-oak-st', exists: true }));
  }, 120_000);

  test('exported handoff markdown imported into a fresh Postgres brain rebuilds every handoff view', async () => {
    const engine = getEngine();
    __setHandoffClockForTests(() => Date.parse('2026-11-08T12:00:00Z'));
    const d = await call('delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'PG deck task', instructions: 'Ten slides.',
      thread_id: 'pg-seller-presentation', tags: ['deck'], priority: 'high' });
    await call('claim_task', { task_id: d.task_id, agent: 'claude' });
    await call('complete_task', { task_id: d.task_id, agent: 'claude', result: 'Deck at decks/12-oak-st.' });

    const dir = mkdtempSync(join(tmpdir(), 'gbrain-handoff-pg-export-'));
    const fresh = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    try {
      const slugs: string[] = [];
      for (const prefix of ['threads/', 'delegations/', 'agents/', 'properties/']) {
        for (const page of await engine.listPages({ slugPrefix: prefix, sourceId: 'default', limit: 1000 })) {
          const file = join(dir, `${page.slug}.md`);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, serializePageToMarkdown(page, await engine.getTags(page.slug, { sourceId: 'default' })));
          slugs.push(page.slug);
        }
      }
      for (const slug of slugs) expect((await importFromFile(fresh.engine, join(dir, `${slug}.md`), `${slug}.md`, { noEmbed: true })).error ?? null).toBeNull();
      await extractLinksForSlugs(fresh.engine, dir, slugs, { sourceId: 'default' });

      const views = async (e: BrainEngine) => ({
        pickup: await call('pickup', { thread_id: 'pg-seller-presentation' }, e),
        inbox: await call('inbox', { agent: 'claude', include_closed: true }, e),
        stats: await call('routing_stats', {}, e),
        route: await call('route', { tags: ['deck'] }, e),
      });
      const before = await views(engine);
      const after = await views(fresh.engine);
      expect(after).toEqual(before);
      expect((after.inbox as any).closed.find((t: any) => t.task_id === d.task_id)).toMatchObject({ status: 'done', tags: ['deck'], priority: 'high' });
    } finally {
      await disposePersistenceConsumer(fresh.engine);
      await fresh.close();
      rmSync(dir, { recursive: true, force: true });
      __setHandoffClockForTests(null);
    }
  }, 240_000);
});
