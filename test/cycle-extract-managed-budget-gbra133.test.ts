/**
 * GBRA-133: a managed brain's cycle extract with no changed-slug list (sync left out of the phases, or sync failed)
 * ran its targeted pass over every stale page of the source with no deadline, so a source left wholly stale by a
 * full re-import outran the cycle job's timeout every cycle while the budgeted drain behind it never ran.
 * The targeted pass now honours the cycle's stale-drain budget.
 */
import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { CYCLE_STALE_DRAIN_BUDGET_MS, runCycle } from '../src/core/cycle.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';

const PAGES = 6;
const put = (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: concept\ntitle: "${slug}"\n---\n\n${body}\n` } });

test('managed cycle extract without changed slugs stops its targeted pass at the stale-drain budget', async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    for (let i = 0; i < PAGES; i++) await put(ctx, `notes/n${i}`, `See [[notes/n${(i + 1) % PAGES}]].`);
    await settleManagedGitEffects(engine);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE pages SET links_extracted_at = NULL WHERE source_id = 'default'");
    // The first page read moves the clock past the budget, as a page late in a long pass would.
    let offset = 0;
    const realNow = Date.now.bind(Date);
    const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const read = engine.readPageSnapshot;
    const snapshot = spyOn(engine, 'readPageSnapshot').mockImplementation(function (this: typeof engine, ...args: Parameters<typeof engine.readPageSnapshot>) {
      offset ||= CYCLE_STALE_DRAIN_BUDGET_MS + 60_000;
      return read.apply(this, args);
    });
    try {
      const report = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract'] });
      const details = report.phases.find(phase => phase.phase === 'extract')?.details ?? {};
      expect(details.incremental).toBe(false);
      expect(details.pages_processed as number).toBeLessThan(PAGES);
      expect((details.pages_processed as number) + (details.stale_pages_drained as number)).toBe(PAGES);
    } finally { clock.mockRestore(); snapshot.mockRestore(); }
  });
}, 120_000);
