/**
 * #6764: conversation-extractor facts and the unlinked_facts doctor check.
 *
 * Protects: (1) write-time free subject inference on the conversation
 * extractor's bulk path: a fact the extractor returned with no entity that
 * names exactly one live entity page in full is linked to it with the
 * `entity inferred from mention` note (unmanaged and managed), the
 * `facts.entity_inference` kill switch stops it, an extractor-named entity is
 * never overridden, and a private entity page never links a world fact.
 * (2) doctor `unlinked_facts` labels those rows origin `conversation`,
 * counts them apart from fence rows, and for rows the free conversation
 * relink could not resolve prescribes a bounded, source-qualified, capped
 * re-extraction (preview first) instead of plain `gbrain facts relink`,
 * which never examines derived rows. (3) a
 * `remember --replaces` aimed at a conversation-derived fact names
 * re-extraction instead of forget-then-remember.
 * Regression: the bulk path skipping inference; the doctor mislabeling the
 * origin as remember and prescribing relink for rows relink cannot touch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { parseArgs, runExtractConversationFacts, runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { unlinkedFactsStats, unlinkedFactsVerdict } from '../src/commands/doctor/checks/unlinked-facts.ts';
import { cliRenderContext, renderAction } from '../src/core/agent-output.ts';
import { dispatchRenderContext, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const MEETING = 'meetings/2026-08-12-lease-review';
const TRANSCRIPT = [
  '**Owner Example** (2026-08-12 10:00 AM): Alice Example signed the lease renewal yesterday.',
  '**Beta Example** (2026-08-12 10:01 AM): Good, the renewal starts in September.',
].join('\n');

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function seedPages(db: BrainEngine, aliceFrontmatter: Record<string, unknown> = {}): Promise<void> {
  await db.putPage(MEETING, { type: 'meeting' as never, title: 'Lease review', compiled_truth: TRANSCRIPT, timeline: '', frontmatter: { date: '2026-08-12' } });
  await db.putPage('people/alice-example', { type: 'person' as never, title: 'Alice Example', compiled_truth: '# Alice Example', timeline: '', frontmatter: aliceFrontmatter });
  await db.putPage('people/bob-example', { type: 'person' as never, title: 'Bob Example', compiled_truth: '# Bob Example', timeline: '', frontmatter: {} });
}

async function extract(db: BrainEngine, fact: Partial<ExtractedFact> = {}) {
  const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await runExtractConversationFactsCore(db, { sourceId: 'default', slugs: [MEETING], sleepMs: 0, overrideDisabled: true, force: true,
      extractor: async () => [{ fact: 'Alice Example signed the lease renewal', kind: 'event', confidence: 0.9, entity_slug: null,
        source: 'test', notability: 'high', ...fact } as ExtractedFact] });
  } finally { spy.mockRestore(); }
}

async function extracted(db: BrainEngine) {
  return db.executeRaw<{ entity_slug: string | null; context: string | null }>(
    `SELECT entity_slug, context FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND source='cli:extract-conversation-facts' AND expired_at IS NULL`, [MEETING]);
}

describe('#6764 write-time inference on conversation facts', () => {
  beforeEach(async () => { await resetPgliteState(engine); await seedPages(engine); });

  test('a fact naming one entity page in full links to it, with the inference note', async () => {
    await extract(engine);
    const [row] = await extracted(engine);
    expect(row!.entity_slug).toBe('people/alice-example');
    expect(row!.context).toContain(' — entity inferred from mention');
    expect(row!.context!.startsWith(`from ${MEETING} segment `)).toBe(true);
  });

  test('the kill switch stops it, and an extractor-named entity is kept', async () => {
    await engine.setConfig('facts.entity_inference', 'off');
    await extract(engine);
    expect((await extracted(engine)).map(r => r.entity_slug)).toEqual([null]);
    await engine.unsetConfig('facts.entity_inference');
    await extract(engine, { entity_slug: 'people/bob-example' });
    expect((await extracted(engine)).map(r => r.entity_slug)).toEqual(['people/bob-example']);
  });

  test('a private entity page never links a world fact; it links a private one', async () => {
    await resetPgliteState(engine);
    await seedPages(engine, { visibility: 'private' });
    await engine.setConfig('facts.default_visibility', 'world');
    await extract(engine);
    expect((await extracted(engine)).map(r => r.entity_slug)).toEqual([null]);
    await engine.unsetConfig('facts.default_visibility');
    await extract(engine);
    expect((await extracted(engine)).map(r => r.entity_slug)).toEqual(['people/alice-example']);
  });

  test('managed brain: the published batch carries the inferred entity', async () => {
    await managedBrain(async ({ engine: db }) => {
      const result = await extract(db);
      expect(result).toMatchObject({ pages_processed: 1, pages_failed: 0 });
      const [row] = await extracted(db);
      expect(row!.entity_slug).toBe('people/alice-example');
      expect(row!.context).toContain('entity inferred from mention');
    }, { setup: async ({ engine: db }) => { await seedPages(db); } });
  }, 120_000);
});

describe('#6764 unlinked_facts names conversation rows and their real fix', () => {
  beforeEach(async () => { await resetPgliteState(engine); });

  async function seedDerived(slug: string, count: number, sourceId = 'default') {
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from)
       SELECT $1, NULL, 'derived ' || $2 || ' ' || g, 'cli:extract-conversation-facts', 'from ' || $2, g, $2, now(), now()
         FROM generate_series(1, $3::int) AS g`, [sourceId, slug, count]);
  }

  /** #6764 d1b: free relink tried every derived row and could not resolve it. */
  async function memoUnresolved() {
    await engine.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier)
      SELECT source_id, id, 'conversation_unresolved', 'no_mention', 'mention' FROM facts WHERE source LIKE 'cli:extract-conversation-facts%'`);
  }

  test('origin conversation, counted apart from fence rows; rows free relink could not resolve get a capped re-extraction for this source only', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`);
    await seedDerived('meetings/a', 6);
    await seedDerived('meetings/b', 3);
    await seedDerived('meetings/elsewhere', 4, 'other');
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source, row_num, source_markdown_slug, created_at, valid_from)
      VALUES ('default', NULL, 'fence fact', 'mcp:put_page', 1, 'notes/n1', now(), now())`);
    await memoUnresolved();
    const stats = await unlinkedFactsStats(engine, ['default']);
    expect(stats!.window).toMatchObject({ unlinked: 10, fence_owned: 1, conversation: 9 });
    expect(stats!.origins).toEqual([{ origin: 'conversation', unlinked: 9 }, { origin: 'mcp:put_page', unlinked: 1 }]);
    const verdict = unlinkedFactsVerdict(stats);
    expect(verdict.message).toContain('9 from conversation extraction');
    expect(verdict.details).toMatchObject({ conversation: { source_id: 'default', fix: 'reextract', pages: 2, slugs: ['meetings/a', 'meetings/b'] } });
    const fix = verdict.fix!;
    expect(fix).toMatchObject({ consent: ['paid', 'egress'], actor: 'agent', ask_user: true, verify: { argv: ['gbrain', 'doctor', '--only', 'unlinked_facts', '--json'] } });
    expect(fix.argv).toEqual(['gbrain', 'extract-conversation-facts', '--source-id', 'default', '--slugs', 'meetings/a,meetings/b', '--force', '--max-cost-usd', '<N>']);
    expect(fix.inputs).toEqual([{ name: 'N', how: expect.stringContaining('USD') }]);
    expect(fix.preview_argv).toEqual(['gbrain', 'extract-conversation-facts', '--source-id', 'default', '--slugs', 'meetings/a,meetings/b', '--force', '--dry-run']);
    expect(renderAction(fix as never, cliRenderContext()).next).toBe('ask_user');
    expect(renderAction(fix as never, dispatchRenderContext({ remote: true, transport: 'http' } as never)).next).toBe('ask_user');
  });

  test('at most 50 slugs in the argv; the total stays in details', async () => {
    // Untried rows: the free relink names the pages (test/conversation-relink-6764.test.ts covers that envelope).
    for (let i = 0; i < 55; i++) await seedDerived(`meetings/m${String(i).padStart(2, '0')}`, 1);
    const verdict = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
    const slugs = verdict.fix!.argv![verdict.fix!.argv!.indexOf('--slugs') + 1]!.split(',');
    expect(slugs).toHaveLength(50);
    expect(verdict.details).toMatchObject({ conversation: { pages: 55 } });
  });

  test('no conversation rows: the relink hint and no structured fix, as before', async () => {
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source, created_at, valid_from) VALUES ('default', NULL, 'free fact', 'cli:remember', now(), now())`);
    const verdict = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
    expect(verdict.fix).toBeUndefined();
    expect(verdict.message).toContain('gbrain facts relink --dry-run');
  });
});

describe('#6764 replacing a conversation-derived fact names re-extraction', () => {
  beforeEach(async () => { await disposePersistenceConsumer(engine); await resetPgliteState(engine); await seedPages(engine); });

  test('remember --replaces on an extracted conversation fact points at extract-conversation-facts', async () => {
    await extract(engine);
    const [row] = await engine.executeRaw<{ id: string }>(`SELECT id FROM facts WHERE source_markdown_slug=$1 AND source='cli:extract-conversation-facts'`, [MEETING]);
    const res = await dispatchToolCall(engine, 'remember', { fact: 'Alice Example renewed the lease for two years', provenance: 'test',
      entity: 'people/alice-example', visibility: 'private', replaces: String(row!.id) }, { remote: false });
    expect(res.isError).toBe(true);
    const body = res.content[0]!.text!;
    expect(body).toContain('replaces_cross_page');
    expect(body).toContain('gbrain extract-conversation-facts');
    expect(body).not.toContain('Forget the old fact, then remember the new one.');
  });
});

describe('#6764 fixture: the conversation fix envelope clears the finding', () => {
  beforeEach(async () => { await resetPgliteState(engine); await seedPages(engine); });

  test('render, run the free preview, run the capped argv with the extractor stubbed, verify cleared', async () => {
    // An older run stored the fact with no entity (no hints, no inference), and free relink could not resolve it then.
    const [old] = await engine.executeRaw<{ id: string }>(`INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from)
      VALUES ('default', NULL, 'Alice Example signed the lease renewal', 'cli:extract-conversation-facts', 'from ${MEETING}', 0, $1, now(), now()) RETURNING id`, [MEETING]);
    await engine.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier) VALUES ('default', $1, 'conversation_unresolved', 'no_mention', 'mention')`, [old!.id]);
    const before = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
    const fix = before.fix!;
    expect(renderAction(fix as never, cliRenderContext())).toMatchObject({ next: 'ask_user', preview_argv: fix.preview_argv });
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtractConversationFacts(engine, fix.preview_argv!.slice(2));
      expect((await unlinkedFactsStats(engine, ['default']))!.window.conversation).toBe(1);
      const parsed = parseArgs(fix.argv!.slice(2).map(a => a === '<N>' ? '1' : a)); // the agent fills the approved amount
      expect(parsed).toMatchObject({ sourceId: 'default', slugs: [MEETING], force: true, maxCostUsd: 1 });
      await runExtractConversationFactsCore(engine, { sourceId: parsed.sourceId!, slugs: parsed.slugs, force: parsed.force, maxCostUsd: parsed.maxCostUsd,
        sleepMs: 0, overrideDisabled: true, extractor: async () => [{ fact: 'Alice Example signed the lease renewal', kind: 'event', confidence: 0.9,
          entity_slug: null, source: 'test', notability: 'high' } as ExtractedFact] });
    } finally { spy.mockRestore(); log.mockRestore(); }
    const after = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
    expect(after.fix).toBeUndefined();
    expect((after.details as any).conversation).toBeNull();
  });
});
