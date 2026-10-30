/**
 * #7270: relink never attaches what the assistant (or a named third party)
 * said to an entity page. The SessionEnd corpus sweep saves the assistant's
 * own report about a pinned core page as attributed facts; `gbrain facts
 * relink` and `gbrain facts relink --conversation` used to link every one
 * that named the page, so the core page filled up with the agent's
 * commentary on every run. Such a row now stays where it was saved, is
 * counted as not_user_attributed, and doctor unlinked_facts does not count it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { runConversationRelink } from '../src/core/facts/conversation-relink.ts';
import { unlinkedFactsStats } from '../src/commands/doctor/checks/unlinked-facts.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

const CORE = 'core/current-focus';
const MEETING = 'meetings/2026-10-20-focus-check';
const config = { engine: 'pglite', embedding_disabled: true } as unknown as GBrainConfig;

let engine: BrainEngine;

async function seedCorePage() {
  await importFromContent(engine, CORE, `---\ntitle: Current Focus\ntype: project\ncore: true\n---\n\n# Current Focus\n\nShip the launch.\n`, { noEmbed: true });
}
async function sweptFact(fact: string, attributed_to: 'user' | 'assistant' | 'other' | null): Promise<number> {
  const r = await engine.insertFact({ fact, kind: 'fact', entity_slug: null, visibility: 'world', source: 'sweep:corpus', attributed_to } as never, { source_id: 'default' });
  return r.id;
}
const factRow = async (id: number) => (await engine.executeRaw<{ entity_slug: string | null; source_markdown_slug: string | null; context: string | null }>(
  'SELECT entity_slug, source_markdown_slug, context FROM facts WHERE id = $1', [id]))[0]!;
async function coreFenceClaims(): Promise<string[]> {
  const page = await engine.getPage(CORE, { sourceId: 'default' });
  return parseFactsFence(page!.compiled_truth).facts.map(f => f.claim);
}

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await resetPgliteState(pglite); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
      await engine.setConfig('decide.slots.conflict.mode', 'off');
      await seedCorePage();
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    test('facts relink leaves assistant and third-party facts off the core page and counts them', async () => {
      const assistant = await sweptFact(`${CORE} says the launch is the priority; I recommend keeping it`, 'assistant');
      const other = await sweptFact(`Beta Example said ${CORE} should drop the launch`, 'other');
      const user = await sweptFact(`${CORE} now includes the pricing review`, 'user');
      const report = await runFactsRelink(engine, { sourceId: 'default', config, llm: false });

      expect(await coreFenceClaims()).toEqual([`${CORE} now includes the pricing review`]);
      for (const id of [assistant, other]) expect(await factRow(id)).toEqual({ entity_slug: null, source_markdown_slug: null, context: null });
      expect((await factRow(user)).entity_slug).toBe(CORE);
      expect(report.linked).toBe(1);
      expect(report.skipped.not_user_attributed).toBe(2);

      const again = await runFactsRelink(engine, { sourceId: 'default', config, llm: false });
      expect(again.linked).toBe(0);
      expect(await coreFenceClaims()).toEqual([`${CORE} now includes the pricing review`]);
    });

    test('conversation relink leaves an assistant-attributed derived row unlinked and counts it', async () => {
      await engine.putPage(MEETING, { type: 'meeting' as never, title: 'Focus check', compiled_truth: 'notes', timeline: '', frontmatter: { date: '2026-10-20' } });
      const row = (n: number, fact: string, attributed: string | null) => engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from, attributed_to)
         VALUES ('default', NULL, $1, 'cli:extract-conversation-facts', $2, $3, $4, now(), now(), $5)`, [fact, `from ${MEETING} segment 2026-10-20`, n, MEETING, attributed]);
      await row(0, `${CORE} is on track, the assistant reported`, 'assistant');
      await row(1, `The owner moved ${CORE} to the pricing review`, 'user');
      const report = await runConversationRelink(engine, config, { sourceId: 'default' });

      const rows = await engine.executeRaw<{ fact: string; entity_slug: string | null }>(
        'SELECT fact, entity_slug FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num', [MEETING]);
      expect(rows.map(r => r.entity_slug)).toEqual([null, CORE]);
      expect(report).toMatchObject({ linked: 1, unresolved: 0, not_user_attributed: 1 });

      const rerun = await runConversationRelink(engine, config, { sourceId: 'default' });
      expect(rerun.pages).toEqual([]);
    });

    test('doctor unlinked_facts does not count facts relink will never link', async () => {
      await sweptFact(`${CORE} says the launch is the priority; I recommend keeping it`, 'assistant');
      await sweptFact(`Beta Example said ${CORE} should drop the launch`, 'other');
      await sweptFact('An unattributed note with no entity', null);
      const stats = await unlinkedFactsStats(engine, ['default']);
      expect(stats!.new_7d).toMatchObject({ facts: 1, unlinked: 1 });
    });
  });
}
