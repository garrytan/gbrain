/**
 * #9708: on a managed brain, `dream --phase patterns` grounds every leftover pattern page (generated, not yet
 * quote-verified) and published them as one maintenance batch, admitted in one transaction. A backlog larger than
 * `persistence.limits.principal_outstanding` was refused at the cap, nothing committed, and the phase failed the same
 * way on every run. A batch is now admitted in parts that each fit the cap: the backlog drains in one run, and a part
 * that fails leaves the parts before it committed, so the next run verifies only the pages still left.
 * Runs on PGLite, and on Postgres through test/e2e/dream-patterns-leftover-cap-9708-postgres.test.ts. The model is a
 * mocked chat transport; synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import * as journal from '../src/core/persistence/journal.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const PREFIX = 'wiki/personal/patterns';
const REFLECTIONS = [0, 1, 2].map(i => 'wiki/personal/reflections/source-a-' + i);
const CAP = 8;
const LEFTOVER = Array.from({ length: 20 }, (_, i) => PREFIX + '/leftover-' + String(i).padStart(2, '0'));
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, slug: string, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } });

/** Reflections, the leftover backlog (generated, never quote-verified) and a cap below the backlog. */
async function seed(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  for (const [i, slug] of REFLECTIONS.entries()) {
    await put(ctx, slug, '---\ntype: note\ntitle: Reflection ' + i + '\n---\nI keep saying "ship smaller pieces". Entry ' + i + ' from source-a.\n');
  }
  for (const [i, slug] of LEFTOVER.entries()) {
    await put(ctx, slug, "---\ntype: note\ntitle: Leftover pattern " + i + "\ndream_generated: true\ndream_cycle_date: '2026-01-01'\n---\nYou repeat \"ship smaller pieces\" ([[" + REFLECTIONS[0] + ']]).\n');
  }
  await settleManagedGitEffects(engine);
  await engine.setConfig('dream.patterns.enabled', 'true');
  await engine.setConfig('dream.quote_verify', 'true');
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
  await engine.setConfig('agent.use_gateway_loop', 'true');
  await engine.setConfig('persistence.limits.principal_outstanding', String(CAP));
}

/** One patterns run whose child reads one reflection and writes nothing, so only the leftover backlog is published. */
async function runPatterns(engine: BrainEngine, root: string, cycleDate: string) {
  let calls = 0;
  __setChatTransportForTests(async opts => {
    const read = calls++ === 0;
    return { text: read ? '' : 'No new patterns.', blocks: read ? [{ type: 'tool-call', toolCallId: 'reflection-read', toolName: 'brain_get_page', input: { slug: REFLECTIONS[0] } }]
      : [{ type: 'text', text: 'No new patterns.' }], stopReason: read ? 'tool_calls' : 'end',
      usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: opts.model!, providerId: 'anthropic' };
  });
  try {
    return await withEnv({ ANTHROPIC_API_KEY: 'sk-test-9708' }, () =>
      runPhasePatterns(engine, { brainDir: root, sourceId: 'default', dryRun: false, once: true, cycleDate }));
  } finally { __setChatTransportForTests(null); }
}

/**
 * Records every leftover page admission by its admission transaction; `refuse` makes chosen admissions fail as a full cap
 * would, and a refused transaction (rolled back) is dropped from the record.
 */
function watchAdmissions(refuse: (slug: string, call: number) => boolean = () => false) {
  const original = journal.admitWriteInTransaction;
  const groups = new Map<unknown, string[]>();
  let calls = 0;
  const spy = spyOn(journal, 'admitWriteInTransaction').mockImplementation(async (tx, input, overrides) => {
    if (LEFTOVER.includes(input.slug)) {
      if (refuse(input.slug, calls++)) { groups.delete(tx); throw new Error('Write capacity exhausted: principal outstanding requests (test refusal).'); }
      groups.set(tx, [...groups.get(tx) ?? [], input.slug]);
    }
    return original(tx, input, overrides);
  });
  return { sizes: () => [...groups.values()].map(slugs => slugs.length), admitted: () => [...groups.values()].flat(), restore: () => spy.mockRestore() };
}

async function verified(engine: BrainEngine): Promise<string[]> {
  const out: string[] = [];
  for (const slug of LEFTOVER) {
    const fm = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.frontmatter as Record<string, unknown>;
    if (fm.quote_verified_at) out.push(slug);
  }
  return out;
}

beforeAll(() => { configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }); });
afterAll(() => { __setChatTransportForTests(null); resetGateway(); });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe('[' + backend + '] #9708: a leftover quote-verify backlog larger than the outstanding cap', () => {
    test('drains in one run, in admission transactions that each fit the cap', () => managedBrain(async ({ engine, ctx, root }) => {
      await seed(engine, ctx);
      const watch = watchAdmissions();
      let result: Awaited<ReturnType<typeof runPatterns>>;
      try { result = await runPatterns(engine, root, '2026-02-03'); } finally { watch.restore(); }
      expect({ status: result.status, error: result.error?.message ?? null, grounded: (result.details?.quote_verify as { pages?: number } | undefined)?.pages })
        .toEqual({ status: 'ok', error: null, grounded: LEFTOVER.length });
      expect(await verified(engine)).toEqual(LEFTOVER);
      expect(watch.admitted().sort()).toEqual(LEFTOVER);
      expect(watch.sizes().length).toBeGreaterThan(1);
      expect(Math.max(...watch.sizes())).toBeLessThanOrEqual(CAP);
    }, { databaseUrl, setup }), 180_000);

    test('a refused part leaves the parts before it committed, and the next run verifies only the pages still left', () => managedBrain(async ({ engine, ctx, root }) => {
      await seed(engine, ctx);
      let firstRefused: number | null = null;
      const failing = watchAdmissions((_slug, call) => {
        if (firstRefused === null && call >= CAP) firstRefused = call;
        return firstRefused !== null;
      });
      let first: Awaited<ReturnType<typeof runPatterns>>;
      try { first = await runPatterns(engine, root, '2026-02-03'); } finally { failing.restore(); }
      expect(first.status).not.toBe('ok');
      const afterFirst = await verified(engine);
      expect(afterFirst).toEqual(failing.admitted().sort());
      expect(afterFirst.length).toBeGreaterThan(0);
      expect(afterFirst.length).toBeLessThan(LEFTOVER.length);

      const watch = watchAdmissions();
      let second: Awaited<ReturnType<typeof runPatterns>>;
      try { second = await runPatterns(engine, root, '2026-02-04'); } finally { watch.restore(); }
      expect(second.status).toBe('ok');
      expect(await verified(engine)).toEqual(LEFTOVER);
      expect(watch.admitted().sort()).toEqual(LEFTOVER.filter(slug => !afterFirst.includes(slug)));
      expect(Math.max(...watch.sizes())).toBeLessThanOrEqual(CAP);
    }, { databaseUrl, setup }), 180_000);
  });
}
