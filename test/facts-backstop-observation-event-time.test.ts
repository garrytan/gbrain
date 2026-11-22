import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runFactsBackstop, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { prepareManagedFactsSession, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { durableGitRepo, gitAsync } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const OBSERVED = '2025-05-10';
const FENCE = '<!--- gbrain:facts:begin -->';
const output = {
  unknown: 'The synthetic device displays a white triangle when idle.',
  dated: 'The synthetic device was calibrated on 2025-04-28.',
  legacy: 'The previous synthetic prototype used a removable blue label.',
};

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`[${backend}] a page observation grounds extraction without becoming an event date or changing old receipt identity`, () => managedBrain(async ({engine, ctx, root}) => {
    let proposed: Array<{fact: string; valid_from?: string}> = [];
    const prompts: string[] = [];
    __setChatTransportForTests(async (request): Promise<ChatResult> => {
      prompts.push(JSON.stringify(request.messages));
      return {
        text: JSON.stringify({ facts: proposed.map(claim => ({...claim, entity: null, kind: 'fact', confidence: 1, notability: 'high'})) }),
        blocks: [], stopReason: 'end',
        usage: {input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0},
        model: 'test:stub', providerId: 'test',
      };
    });
    async function page(slug: string, body: string) {
      const write = await submitPageMutation(ctx, {operation: 'put_page', params: {
        slug,
        content: `---\ntype: note\ntitle: Synthetic fixture\ncreated: ${OBSERVED}\n---\n\n${body}\n`,
        request_id: randomUUID(),
      }});
      expect(write.state).toBe('committed');
      const stored = (await engine.getPage(slug, {sourceId: 'default'}))!;
      return {slug, type: stored.type, compiled_truth: stored.compiled_truth, frontmatter: stored.frontmatter};
    }
    const readDates = () => engine.executeRaw<{fact: string; event: string | null}>(
      `SELECT fact, to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS event FROM facts
        WHERE source_id='default' AND expired_at IS NULL ORDER BY fact`);
    const backstop: FactsBackstopCtx = {
      engine, sourceId: 'default', source: 'sync:import', sessionId: null,
      mode: 'inline', operationContext: ctx, remote: false, visibility: 'private',
    };

    try {
      const legacyPage = await page('notes/legacy-event-date-fixture',
        `Notes on an old revision of the demonstration prototype. ${output.legacy} This record contains a description of the former labeling scheme.`);
      proposed = [{fact: output.legacy}];
      // Reproduce the historical call shape after the old backstop promoted the observation.
      const legacy = await runFactsBackstop(legacyPage, {...backstop, validFrom: new Date(OBSERVED + 'T00:00:00.000Z')});
      if (legacy.mode !== 'inline') throw new Error('Expected an inline legacy extraction');
      expect(legacy.inserted).toBe(1);
      expect(await readDates()).toEqual([{fact: output.legacy, event: OBSERVED}]);
      expect(prompts).toHaveLength(1);
      // Exercise the stored receipt directly instead of relying on the page watermark's no-op.
      const replaySession = await prepareManagedFactsSession(backstop, {
        turnText: legacyPage.compiled_truth,
        pageSlug: legacyPage.slug,
        observationDate: {date: OBSERVED, source: 'created'},
      });
      if (!replaySession) throw new Error('Expected a managed replay session');
      const replay = await resumeManagedFacts(engine, replaySession);
      expect(replay?.fact_ids).toEqual(legacy.fact_ids);
      expect(replay?.write_requests.map(receipt => receipt.request_id)).toEqual(legacy.write_requests?.map(receipt => receipt.request_id));
      expect(prompts).toHaveLength(1);
      expect(await readDates()).toEqual([{fact: output.legacy, event: OBSERVED}]);

      const fresh = await page('notes/new-event-date-fixture',
        `Laboratory notes on the current demonstration device, including the idle indicator and a calibration event. ${output.unknown} ${output.dated}`);
      proposed = [{fact: output.unknown}, {fact: output.dated, valid_from: '2025-04-28'}];
      const result = await runFactsBackstop(fresh, backstop);
      expect(result).toMatchObject({mode: 'inline', inserted: 2});
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(`Observation date: ${OBSERVED}`);
      expect(await readDates()).toEqual([
        {fact: output.legacy, event: OBSERVED},
        {fact: output.unknown, event: null},
        {fact: output.dated, event: '2025-04-28'},
      ]);
      // Verify the serving fence keeps the intended meaning when it is later reconciled from canonical Markdown.
      await settleManagedGitEffects(engine);
      const holding = await gitAsync(root, 'show', 'HEAD:memory/unattributed.md');
      expect(holding).toContain(FENCE);
      expect(holding.split('\n').find(line => line.includes(output.unknown))).toContain('| unknown |');
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
  }, {
    databaseUrl,
    async setup({engine, root}) {
      writeFileSync(join(root, '.gitignore'), '\n');
      durableGitRepo(root, ['.gitignore']);
      await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    },
  }), 120_000);
}
