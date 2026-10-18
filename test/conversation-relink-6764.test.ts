/**
 * #6764 (d1b): the free conversation relink, `gbrain facts relink --conversation`.
 *
 * Protects: a conversation-extractor fact stored without an entity that names
 * exactly one live entity page is linked for free (write-mode inference, no
 * model), one write per page, on an unmanaged brain (maintenance
 * transaction) and a managed one (one receipted coordinator request); the dry
 * run writes nothing; an unresolvable fact gets a `conversation_unresolved`
 * memo and is named for the paid re-extraction; outcome rows and other pages
 * are untouched. Doctor `unlinked_facts` prescribes this free relink
 * (consent none, agent runs it) for untried rows and the paid re-extraction
 * only once relink tried and failed; the fixture renders the envelope, runs
 * the preview, the argv and the verify, and the finding moves on. The link
 * is stored on the derived row itself (`entity_slug`; conversation pages have
 * no fence, and fence projection skips extractor rows), so the extract_facts
 * reconcile keeps it, and `extract-conversation-facts --force` (unmanaged and
 * managed) carries it to the claim's new row with no second copy. Memoized
 * unresolved rows are left out of the 25% new-fact rule.
 * Regression: doctor prescribing paid re-extraction for rows a free pass links,
 * re-prescribing the free pass after it ran, and a re-extraction dropping a link.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsCommand } from '../src/commands/facts.ts';
import { runConversationRelink, CONVERSATION_RELINK_INTENT } from '../src/core/facts/conversation-relink.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { unlinkedFactsStats, unlinkedFactsVerdict } from '../src/commands/doctor/checks/unlinked-facts.ts';
import { cliRenderContext, renderAction } from '../src/core/agent-output.ts';
import * as inference from '../src/core/facts/conversation-subject-infer.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const MEETING = 'meetings/2026-08-12-lease-review';
const OTHER = 'meetings/2026-08-13-standup';
const LINKED = 'Alice Example signed the lease renewal';
const UNRESOLVED = 'The renewal starts in September';
const TRANSCRIPT = [
  '**Owner Example** (2026-08-12 10:00 AM): Alice Example signed the lease renewal yesterday.',
  '**Beta Example** (2026-08-12 10:01 AM): Good, the renewal starts in September.',
].join('\n');
const config = { engine: 'pglite', embedding_disabled: true } as unknown as GBrainConfig;

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function seed(db: BrainEngine): Promise<void> {
  for (const slug of [MEETING, OTHER]) {
    await db.putPage(slug, { type: 'meeting' as never, title: slug, compiled_truth: slug === MEETING ? TRANSCRIPT : 'notes', timeline: '', frontmatter: { date: '2026-08-12' } });
  }
  await db.putPage('people/alice-example', { type: 'person' as never, title: 'Alice Example', compiled_truth: '# Alice Example', timeline: '', frontmatter: {} });
  const row = (slug: string, n: number, fact: string, source = 'cli:extract-conversation-facts') => db.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from)
     VALUES ('default', NULL, $1, $2, $3, $4, $5, now(), now())`, [fact, source, `from ${slug} segment 2026-08-12`, n, slug]);
  await row(MEETING, 0, 'Alice Example signed the lease renewal');
  await row(MEETING, 1, 'The renewal starts in September');
  await row(MEETING, 2, 'EXTRACTION_COMPLETE', 'cli:extract-conversation-facts:terminal');
  await row(OTHER, 0, 'Alice Example will send the deck');
}

async function facts(db: BrainEngine, slug = MEETING) {
  return db.executeRaw<{ fact: string; entity_slug: string | null; context: string | null }>(
    'SELECT fact, entity_slug, context FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num', ['default', slug]);
}

/** Active rows of a claim anywhere in the source. */
const active = (db: BrainEngine, fact: string) => db.executeRaw<{ entity_slug: string | null; source_markdown_slug: string; context: string | null }>(
  'SELECT entity_slug, source_markdown_slug, context FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id', ['default', fact]);

/** `extract-conversation-facts --force` on MEETING, the extractor stubbed to return both claims unlinked. */
async function reextract(db: BrainEngine) {
  const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await runExtractConversationFactsCore(db, { sourceId: 'default', slugs: [MEETING], sleepMs: 0, overrideDisabled: true, force: true,
      extractor: async () => [LINKED, UNRESOLVED].map(fact => ({ fact, kind: 'event', confidence: 0.9, entity_slug: null, source: 'test', notability: 'high' }) as ExtractedFact) });
  } finally { spy.mockRestore(); }
}

/** One active copy of the linked claim: a derived row of MEETING carrying the entity and the relink note. */
async function expectKept(db: BrainEngine): Promise<void> {
  const rows = await active(db, LINKED);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ entity_slug: 'people/alice-example', source_markdown_slug: MEETING });
  expect(rows[0]!.context).toContain('entity relinked from mention');
  expect((await active(db, UNRESOLVED)).map(r => [r.entity_slug, r.source_markdown_slug])).toEqual([[null, MEETING]]);
}

async function cli(db: BrainEngine, argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((s: unknown) => { lines.push(String(s)); });
  try { return { code: await runFactsCommand(db, argv, config, 'default'), out: lines.join('\n') }; } finally { log.mockRestore(); }
}

describe('#6764 gbrain facts relink --conversation (unmanaged)', () => {
  beforeEach(async () => { await resetPgliteState(engine); await seed(engine); });

  test('the dry run writes nothing and names the paid fallback for the unresolved page', async () => {
    const { code, out } = await cli(engine, ['relink', '--conversation', '--slugs', MEETING, '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('DRY RUN: would link 1 conversation fact(s) on 1 page(s) in source default');
    expect(out).toContain(`gbrain extract-conversation-facts --source-id default --slugs ${MEETING} --force --dry-run`);
    expect((await facts(engine)).map(r => r.entity_slug)).toEqual([null, null, null]);
    expect(await engine.executeRaw('SELECT 1 FROM fact_relink_attempts')).toHaveLength(0);
  });

  test('apply links the provable fact on the named page only, memoizes the miss, leaves the outcome row', async () => {
    const { code } = await cli(engine, ['relink', '--conversation', '--slugs', MEETING]);
    expect(code).toBe(0);
    const rows = await facts(engine);
    expect(rows.map(r => r.entity_slug)).toEqual(['people/alice-example', null, null]);
    expect(rows[0]!.context).toBe(`from ${MEETING} segment 2026-08-12 — entity relinked from mention`);
    expect((await facts(engine, OTHER)).map(r => r.entity_slug)).toEqual([null]);
    const attempts = await engine.executeRaw<{ outcome: string; target_slug: string | null }>('SELECT outcome, target_slug FROM fact_relink_attempts ORDER BY outcome');
    expect(attempts).toEqual([{ outcome: 'conversation_unresolved', target_slug: null }, { outcome: 'linked', target_slug: 'people/alice-example' }]);
  });

  test('without --slugs it takes the pages with untried rows; a rerun finds nothing new', async () => {
    const first = await runConversationRelink(engine, config, { sourceId: 'default' });
    expect(first).toMatchObject({ linked: 2, unresolved: 1, reextract_slugs: [MEETING] });
    const again = await runConversationRelink(engine, config, { sourceId: 'default' });
    expect(again).toMatchObject({ linked: 0, unresolved: 0, pages: [] });
  });

  test('a row that moved after the plan is not linked; it is reported as changed', async () => {
    const real = inference.inferConversationSubject;
    const spy = spyOn(inference, 'inferConversationSubject').mockImplementation(async (db, sourceId, visibility, fact) => {
      const result = await real(db, sourceId, visibility, fact);
      if (result.slug) await db.executeRaw(`UPDATE facts SET fact = fact || ' (edited)' WHERE source_markdown_slug = $1 AND fact = $2`, [MEETING, fact]);
      return result;
    });
    try {
      const report = await runConversationRelink(engine, config, { sourceId: 'default', slugs: [MEETING] });
      expect(spy).toHaveBeenCalled();
      expect(report).toMatchObject({ linked: 0, changed: 1, unresolved: 1 });
    } finally { spy.mockRestore(); }
    expect((await facts(engine)).map(r => r.entity_slug)).toEqual([null, null, null]);
  });
});

describe('#6764 the link survives re-extraction and fence reconcile', () => {
  beforeEach(async () => { await resetPgliteState(engine); await seed(engine); });

  test('extract-conversation-facts --force (twice) and the extract_facts reconcile keep one linked copy', async () => {
    await engine.setConfig('facts.entity_inference', 'off'); // the carried link, not write-time inference, must keep it
    try {
      await runConversationRelink(engine, config, { sourceId: 'default', slugs: [MEETING] });
      await expectKept(engine);
      expect(await reextract(engine)).toMatchObject({ pages_processed: 1, pages_failed: 0 });
      await expectKept(engine);
      const reconcile = await runExtractFacts(engine, { sourceId: 'default' });
      expect(reconcile).toMatchObject({ guardTriggered: false, factsDeleted: 0 });
      await expectKept(engine);
      await reextract(engine);
      await expectKept(engine);
      const expired = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM facts WHERE fact=$1 AND expired_at IS NOT NULL`, [LINKED]);
      expect(expired[0]!.n).toBe(1);
    } finally { await engine.unsetConfig('facts.entity_inference'); }
  });
});

describe('#6764 doctor: free relink first, paid re-extraction only for rows it tried', () => {
  beforeEach(async () => { await resetPgliteState(engine); await seed(engine); });

  test('fixture: render the relink envelope, run its preview, its argv and the verify', async () => {
    const before = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
    const fix = before.fix!;
    expect(fix).toMatchObject({ consent: [], actor: 'agent', verify: { argv: ['gbrain', 'doctor', '--only', 'unlinked_facts', '--json'] } });
    expect(fix.argv).toEqual(['gbrain', 'facts', 'relink', '--conversation', '--source', 'default', '--slugs', `${MEETING},${OTHER}`]);
    expect(fix.preview_argv).toEqual([...fix.argv!, '--dry-run']);
    expect(renderAction(fix as never, cliRenderContext()).next).toBe('run');
    expect(before.message).toContain('link them for free (preview first): gbrain facts relink --conversation');
    expect((await cli(engine, fix.preview_argv!.slice(2))).code).toBe(0);
    expect((await unlinkedFactsStats(engine, ['default']))!.window.conversation).toBe(3);
    expect((await cli(engine, fix.argv!.slice(2))).code).toBe(0);
    const after = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
    expect(after.details).toMatchObject({ window: { conversation: 1 }, conversation: { fix: 'reextract', pages: 1, slugs: [MEETING] } });
    expect(after.fix).toMatchObject({ consent: ['paid', 'egress'], ask_user: true });
    expect(after.fix!.argv).toEqual(['gbrain', 'extract-conversation-facts', '--source-id', 'default', '--slugs', MEETING, '--force', '--max-cost-usd', '<N>']);
    expect(after.message).not.toContain('gbrain facts relink --conversation');
  });

  test('memoized unresolved rows are left out of the 25% new-fact rule and named in the paid fallback', async () => {
    for (let i = 0; i < 24; i++) {
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from)
        VALUES ('default', NULL, $1, 'cli:extract-conversation-facts', 'from x', $2, $3, now(), now())`, [`Unattributed remark ${i}`, 10 + i, MEETING]);
    }
    expect(unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default'])).status).toBe('warn');
    await runConversationRelink(engine, config, { sourceId: 'default' });
    const after = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']));
    expect(after.details).toMatchObject({ new_7d: { conversation_unresolved: 25, eligible: 2 }, conversation: { fix: 'reextract', slugs: [MEETING] } });
    expect(after.status).toBe('ok');
  });

  test('the remote report asks the brain host operator to run the relink', async () => {
    const verdict = unlinkedFactsVerdict(await unlinkedFactsStats(engine, ['default']), { thinClient: true });
    expect(verdict.fix).toMatchObject({ actor: 'host_admin', consent: [] });
  });
});

describe('#6764 gbrain facts relink --conversation (managed)', () => {
  test('one receipted coordinator request per page links the row', async () => {
    await managedBrain(async ({ engine: db }) => {
      const report = await runConversationRelink(db, config, { sourceId: 'default', slugs: [MEETING, OTHER] });
      expect(report).toMatchObject({ linked: 2, unresolved: 1, changed: 0 });
      await expectKept(db);
      expect((await facts(db)).map(r => r.entity_slug)).toEqual(['people/alice-example', null, null]);
      expect((await facts(db, OTHER)).map(r => r.entity_slug)).toEqual(['people/alice-example']);
      const requests = await db.executeRaw<{ state: string }>(`SELECT state FROM persistence_requests WHERE intent->>'kind' = $1`, [CONVERSATION_RELINK_INTENT]);
      expect(requests.map(r => r.state)).toEqual(['committed', 'committed']);
      await db.setConfig('facts.entity_inference', 'off'); // the carried link, not write-time inference, must keep it
      expect(await reextract(db)).toMatchObject({ pages_processed: 1, pages_failed: 0 });
      await expectKept(db);
    }, { setup: async ({ engine: db }) => { await seed(db); } });
  }, 120_000);
});
