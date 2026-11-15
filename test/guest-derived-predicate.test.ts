/**
 * Guest notes (GBRA-504): every derived producer decides "guest source" with the read side's test (guestSourceSql): a
 * source is a guest source when its config says guest or guest_sources lists it, so losing one record never lets a
 * guest page feed derived rows. A lookup that fails, or a schema behind the guest-notes migration, counts as guest.
 *
 * Protects: (a) a source flagged guest in its config but missing from guest_sources gets no links, timeline rows,
 * facts or take proposals from the stale walk, the timeline walk, fact extraction, propose_takes or a scoped cycle,
 * while an owner page beside it still gets its link; (b) on a brain whose schema is behind the guest-notes migration
 * (the guest tables dropped) the skip holds or refuses, and never derives from the guest page. PGLite, repo-less.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { skipsGuestSource, withoutGuestSources } from '../src/core/guests/derived.ts';
import { GUEST_NOTES_MIGRATION } from '../src/core/guests/migration.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { runPhaseProposeTakes } from '../src/core/cycle/propose-takes.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const FLAGGED = 'source-a';
const GUEST_PAGE = 'notes/flagged-a';
const page = (title: string, body: string) => '---\ntype: note\ntitle: ' + title + '\n---\n# ' + title + '\n\n' + body + '\n';

async function seed(engine: PGLiteEngine): Promise<void> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [FLAGGED]);
  await importFromContent(engine, 'people/erin-example', page('Erin', 'A person.'), { sourceId: FLAGGED, noEmbed: true } as never);
  await importFromContent(engine, GUEST_PAGE, page('Visitor', 'Met [[people/erin-example]] about the ledger.\n\n## Timeline\n\n- **2026-11-01** | Met Erin'),
    { sourceId: FLAGGED, noEmbed: true } as never);
  await importFromContent(engine, 'people/dan-example', '---\ntype: person\ntitle: Dan\n---\n# Dan\n', { noEmbed: true } as never);
  await importFromContent(engine, 'notes/owner-a', page('Owner', 'Met [[people/dan-example]].'), { noEmbed: true } as never);
}

const flag = (engine: PGLiteEngine) => engine.executeRaw("UPDATE sources SET config = config || '{\"guest\": true}'::jsonb WHERE id = $1", [FLAGGED]);

async function flaggedRows(engine: PGLiteEngine) {
  return (await engine.executeRaw<{ links: number; timeline: number; facts: number; proposals: number }>(
    'SELECT (SELECT count(*)::int FROM links l JOIN pages p ON p.id = l.from_page_id WHERE p.source_id = $1) AS links, '
      + '(SELECT count(*)::int FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1) AS timeline, '
      + '(SELECT count(*)::int FROM facts f WHERE f.source_id = $1) AS facts, '
      + '(SELECT count(*)::int FROM take_proposals k WHERE k.source_id = $1) AS proposals', [FLAGGED]))[0]!;
}

const proposeCtx = (engine: PGLiteEngine) => ({ engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: undefined });

/** Runs a producer; a refusal (thrown error) is an acceptable outcome, deriving from the guest page is not. */
async function holdsOrRefuses(run: () => Promise<unknown>): Promise<void> {
  try { await run(); } catch { /* refused: nothing derived */ }
}

describe('a source flagged guest in its config but missing from guest_sources (pglite, repo-less)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await seed(engine);
    expect(await engine.countStalePagesForExtraction({ sourceId: FLAGGED })).toBeGreaterThan(0);
    await flag(engine);
    expect((await engine.executeRaw('SELECT 1 FROM guest_sources WHERE source_id = $1', [FLAGGED])).length).toBe(0);
  }, 180_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

  test('every skip helper treats it as a guest source', async () => {
    expect(await skipsGuestSource(engine, 'extract_facts', FLAGGED)).toBe(true);
    expect(await skipsGuestSource(engine, 'extract_atoms', FLAGGED)).toBe(true);
    expect(await withoutGuestSources(engine, 'chronicle', [FLAGGED, 'default'], id => id)).toEqual(['default']);
    expect(await engine.countStalePagesForExtraction({ sourceId: FLAGGED })).toBe(0);
  }, 60_000);

  test('the stale walk, the timeline walk and fact extraction derive nothing from it; the owner page still links', async () => {
    await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: false });
    await extractTimelineFromDB(engine, { dryRun: false, jsonMode: true, quiet: true });
    const facts = await runExtractFacts(engine, { sourceId: FLAGGED });
    expect({ scanned: facts.pagesScanned, failed: facts.pagesFailed }).toEqual({ scanned: 0, failed: 0 });
    expect(await flaggedRows(engine)).toEqual({ links: 0, timeline: 0, facts: 0, proposals: 0 });
    const [owner] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM links l JOIN pages p ON p.id = l.from_page_id WHERE p.slug = 'notes/owner-a'");
    expect(owner!.n).toBeGreaterThan(0);
  }, 120_000);

  test('an unscoped propose_takes run never reads its pages', async () => {
    const scanned: string[] = [];
    await runPhaseProposeTakes(proposeCtx(engine) as never, { extractor: async ({ pagePath }) => { scanned.push(pagePath); return []; } });
    expect(scanned).toContain('notes/owner-a');
    expect(scanned.filter(slug => slug === GUEST_PAGE || slug === 'people/erin-example')).toEqual([]);
  }, 120_000);

  test('a cycle scoped to it skips the derived phases', async () => {
    const report = await runCycle(engine, { sourceId: FLAGGED, phases: ['extract_facts', 'propose_takes', 'orphans'], brainDir: null } as never);
    const byPhase = Object.fromEntries(report.phases.map(p => [p.phase, (p.details as { reason?: string } | undefined)?.reason]));
    expect({ extract_facts: byPhase.extract_facts, propose_takes: byPhase.propose_takes }).toEqual({ extract_facts: 'guest_source', propose_takes: 'guest_source' });
  }, 120_000);
});

describe('a brain whose schema is behind the guest-notes migration (v' + GUEST_NOTES_MIGRATION + ')', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await seed(engine);
    await flag(engine);
    await engine.executeRaw('DROP TABLE guest_promotions, guest_marks, guest_sources CASCADE');
  }, 180_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

  test('the skip helpers count the source as guest instead of failing', async () => {
    expect(await skipsGuestSource(engine, 'extract_facts', FLAGGED)).toBe(true);
    expect(await withoutGuestSources(engine, 'chronicle', [FLAGGED, 'default'], id => id)).not.toContain(FLAGGED);
  }, 60_000);

  test('every producer holds or refuses, and none derives from the guest page', async () => {
    const scanned: string[] = [];
    await holdsOrRefuses(() => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: false }));
    await holdsOrRefuses(() => extractTimelineFromDB(engine, { dryRun: false, jsonMode: true, quiet: true }));
    await holdsOrRefuses(() => runExtractFacts(engine, { sourceId: FLAGGED }));
    await holdsOrRefuses(() => runPhaseProposeTakes(proposeCtx(engine) as never, { extractor: async ({ pagePath }) => { scanned.push(pagePath); return []; } }));
    await holdsOrRefuses(() => runCycle(engine, { sourceId: FLAGGED, phases: ['extract_facts', 'propose_takes'], brainDir: null } as never));
    expect(scanned.filter(slug => slug === GUEST_PAGE || slug === 'people/erin-example')).toEqual([]);
    expect(await flaggedRows(engine)).toEqual({ links: 0, timeline: 0, facts: 0, proposals: 0 });
  }, 180_000);

  test('a skip caused by the failed guest lookup says the lookup failed', async () => {
    const atoms = await runPhaseExtractAtoms(engine, { sourceId: FLAGGED });
    expect(atoms.details).toMatchObject({ reason: 'guest_source_lookup_failed', source_id: FLAGGED });
    expect(String((atoms.details as { error?: string }).error)).toContain('guest_sources');
    const report = await runCycle(engine, { sourceId: FLAGGED, phases: ['extract_facts'], brainDir: null } as never);
    expect(report.phases.find(p => p.phase === 'extract_facts')?.details).toMatchObject({ reason: 'guest_source_lookup_failed', source_id: FLAGGED });
  }, 120_000);

  test('a page write is refused migrations_pending, not with the missing-table error', async () => {
    const [version] = await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key = 'version'");
    await engine.executeRaw("UPDATE config SET value = $1 WHERE key = 'version'", [String(GUEST_NOTES_MIGRATION - 1)]);
    try {
      const out = await dispatchToolCall(engine, 'put_page', { slug: 'notes/behind-a', content: '---\ntype: note\ntitle: Behind\n---\n# Behind\n' }, { remote: false, sourceId: 'default' });
      const text = out.content.map(c => c.text).join('\n');
      expect({ isError: out.isError, migrationsPending: text.includes('migrations_pending'), raw: text.includes('does not exist') })
        .toEqual({ isError: true, migrationsPending: true, raw: false });
    } finally {
      await engine.executeRaw("UPDATE config SET value = $1 WHERE key = 'version'", [version!.value]);
    }
  }, 120_000);
});
