/**
 * G6 (git-canonical memory): the patterns phase (src/core/cycle/patterns.ts runPhasePatterns) and the claim-source
 * de-duplication it runs first (src/core/cycle/pattern-claim-sources.ts dedupePatternClaimSources) on a strict source.
 * On a managed brain the patterns child stages each page with put_page (SubagentHandlerData.stage_writes: nothing is
 * journaled), and the phase grounds the staged pages, folds in their provenance stamp and publishes them as one
 * maintenance batch (publishMaintenancePages); de-duplication publishes its rewritten pages as one batch too. Target for a batch
 * of three pages: every page at HEAD with the content its row holds, a clean tree, no git-gap census gap, and at most one
 * commit per publication group (test/helpers/strict-door-audit.ts). Runs on PGLite, and on Postgres through
 * test/e2e/git-door-g6-patterns-postgres.test.ts. The model is a mocked chat transport; synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import { dedupePatternClaimSources, resolveClaimSources } from '../src/core/cycle/pattern-claim-sources.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { auditDoor, expectDoorTarget, headCommit, strictSource, summarizeAudit } from './helpers/strict-door-audit.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const PREFIX = 'wiki/personal/patterns';
const REFLECTIONS = [0, 1, 2].map(i => 'wiki/personal/reflections/source-a-' + i);
const PATTERNS = ['ask-early', 'morning-focus', 'ship-smaller'].map(name => PREFIX + '/' + name);
const QUOTES = ['ask early', 'protect the morning', 'ship smaller pieces'];
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const put = (ctx: OperationContext, slug: string, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } });

/** The batch starts from a clean checkout and a census with no gap, so any gap after it is the writer's. */
async function expectCleanBaseline(engine: BrainEngine, root: string, since: string): Promise<void> {
  const baseline = await auditDoor(engine, root, { since, slugs: [] });
  expect(baseline.porcelain).toBe('');
  expect({ gaps: baseline.gaps, sample: baseline.gapSample }).toEqual({ gaps: { database_ahead: 0, worktree_only: 0, undeclared_database_only: 0 }, sample: [] });
}

beforeAll(() => { configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }); });
afterAll(() => { __setChatTransportForTests(null); resetGateway(); });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe('[' + backend + '] G6: patterns writers on a strict source write only through the door', () => {
    test('runPhasePatterns: three child-written pattern pages, grounded and stamped: at HEAD, clean, no census gap, one commit per group', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      for (const [i, slug] of REFLECTIONS.entries()) {
        await put(ctx, slug, '---\ntype: note\ntitle: Reflection ' + i + '\n---\nI keep saying "ship smaller pieces", "protect the morning" and "ask early". Entry ' + i + ' from source-a.\n');
      }
      await settleManagedGitEffects(engine);
      await engine.setConfig('dream.patterns.enabled', 'true');
      await engine.setConfig('dream.quote_verify', 'true');
      await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
      await engine.setConfig('agent.use_gateway_loop', 'true');
      const since = await headCommit(root);
      await expectCleanBaseline(engine, root, since);
      let calls = 0;
      __setChatTransportForTests(async opts => {
        const i = calls++;
        const write = i < PATTERNS.length;
        const links = REFLECTIONS.map(slug => '[[' + slug + ']]').join(', ');
        return { text: write ? '' : 'Saved the patterns.', blocks: write ? [{ type: 'tool-call', toolCallId: 'pattern-write-' + i, toolName: 'brain_put_page', input: {
          slug: PATTERNS[i], content: '---\ntitle: Pattern ' + i + '\ntype: note\n---\nAcross three reflections you repeat "' + QUOTES[i] + '" (' + links + ').\n',
        } }] : [{ type: 'text', text: 'Saved the patterns.' }], stopReason: write ? 'tool_calls' : 'end',
        usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: opts.model!, providerId: 'anthropic' };
      });
      try {
        await withEnv({ ANTHROPIC_API_KEY: 'sk-test-g6-patterns' }, async () => {
          const result = await runPhasePatterns(engine, { brainDir: root, sourceId: 'default', dryRun: false, once: true, cycleDate: '2026-02-03' });
          expect({ status: result.status, written: result.details.patterns_written, held: result.details.publish_deferred, child: result.details.child_outcome,
            grounded: (result.details.quote_verify as { pages?: number } | undefined)?.pages })
            .toEqual({ status: 'ok', written: 3, held: 0, child: 'completed', grounded: 3 });
        });
      } finally { __setChatTransportForTests(null); }
      for (const slug of PATTERNS) {
        expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.frontmatter)
          .toMatchObject({ dream_generated: true, dream_cycle_date: '2026-02-03', quote_verified_at: '2026-02-03', raw_trace_exempt: true });
      }
      await settleManagedGitEffects(engine);
      const audit = await auditDoor(engine, root, { since, slugs: PATTERNS });
      console.log(summarizeAudit('patterns phase ' + backend, audit));
      expectDoorTarget(audit, engine.kind);
    }, { databaseUrl, setup }), 180_000);

    test('dedupePatternClaimSources: three pattern pages with inline claim-source lists: at HEAD, clean, no census gap, one commit per group', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      const list = Array.from({ length: 20 }, (_, i) => 'wiki/personal/reflections/source-a-old-' + i);
      const claims = Array.from({ length: 3 }, (_, i) => '  - text: claim ' + i + ' about acme-example\n    reason: quote_not_in_source\n    sources:\n'
        + list.map(p => '      - ' + p).join('\n')).join('\n');
      for (const [i, slug] of PATTERNS.entries()) {
        await put(ctx, slug, '---\ntype: note\ntitle: Legacy pattern ' + i + "\ndream_generated: true\nquote_verified_at: '2026-01-01'\nunverified_claims:\n" + claims
          + '\n---\nA legacy pattern body ' + i + ' for alice-example.\n');
      }
      await settleManagedGitEffects(engine);
      const since = await headCommit(root);
      await expectCleanBaseline(engine, root, since);
      const maintenance = await maintenancePreflight(engine, 'default', root);
      expect(maintenance).not.toBeNull();
      const result = await dedupePatternClaimSources(engine, maintenance, PREFIX, 'default');
      expect(result).toEqual({ rewritten: PATTERNS, held: [] });
      for (const slug of PATTERNS) {
        const fm = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.frontmatter as Record<string, unknown>;
        for (const claim of fm.unverified_claims as Array<{ sources: string[] }>) {
          expect(claim.sources).toHaveLength(1);
          expect(resolveClaimSources(fm, claim)).toEqual(list);
        }
      }
      await settleManagedGitEffects(engine);
      const audit = await auditDoor(engine, root, { since, slugs: PATTERNS });
      console.log(summarizeAudit('pattern-claim-sources ' + backend, audit));
      expectDoorTarget(audit, engine.kind);
    }, { databaseUrl, setup }), 180_000);
  });
}
