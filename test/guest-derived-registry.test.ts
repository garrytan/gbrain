/**
 * Guest notes (GBRA-504, decision I1): guest pages feed no derived rows, and a registry says so for every producer.
 *
 * Protects: every cycle phase (and every extra producer) is classified in GUEST_DERIVED_PRODUCERS; each producer marked
 * skip has code at each named site that calls a guest helper with its own key (so the table drives the behavior), and a
 * cycle scoped to a guest source skips exactly the phases the table says. On a repo-less PGLite brain with a guest page
 * that links and dates things, stale link extraction, the timeline walk and fact extraction derive nothing from it and
 * report nothing for it, while an owner page beside it still gets its link.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ALL_PHASES, runCycle } from '../src/core/cycle.ts';
import { MANAGED_PHASE_TABLE } from '../src/core/cycle/phase-table.ts';
import { GUEST_DERIVED_PRODUCERS, guestSkippedPhases } from '../src/core/guests/derived.ts';
import { initGuestSource } from '../src/core/guests/sources.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { runPhaseProposeTakes } from '../src/core/cycle/propose-takes.ts';
import { withWriteAttribution } from '../src/core/persistence/context.ts';

const ROOT = join(import.meta.dir, '..');
const HELPERS = ['skipsGuestSource', 'skipsGuestNote', 'withoutGuestSources', 'guestSourceExclusionSql'];

describe('guest derived-producer registry', () => {
  test('every cycle phase is classified, and every none entry says why', () => {
    for (const phase of ALL_PHASES) expect({ phase, listed: Object.hasOwn(GUEST_DERIVED_PRODUCERS, phase) }).toEqual({ phase, listed: true });
    for (const phase of Object.keys(MANAGED_PHASE_TABLE)) expect({ phase, listed: Object.hasOwn(GUEST_DERIVED_PRODUCERS, phase) }).toEqual({ phase, listed: true });
    for (const [key, entry] of Object.entries(GUEST_DERIVED_PRODUCERS)) {
      if (entry.guest === 'none') expect({ key, reason: entry.reason.length > 20 }).toEqual({ key, reason: true });
      else expect({ key, sites: entry.sites.length > 0 }).toEqual({ key, sites: true });
    }
  });

  test('each skip site calls a guest helper with its own key; the cycle gate covers the cycle.ts sites', () => {
    const cycle = readFileSync(join(ROOT, 'src/core/cycle.ts'), 'utf8');
    expect(cycle).toContain('guestSkippedPhases()');
    const viaCycle: string[] = [];
    for (const [key, entry] of Object.entries(GUEST_DERIVED_PRODUCERS)) {
      if (entry.guest !== 'skip') continue;
      for (const site of entry.sites) {
        if (site === 'src/core/cycle.ts') { viaCycle.push(key); continue; }
        const text = readFileSync(join(ROOT, site), 'utf8');
        const called = HELPERS.some(helper => new RegExp(`${helper}\\([^;]*?'${key}'`, 's').test(text));
        expect({ key, site, called }).toEqual({ key, site, called: true });
      }
    }
    expect([...guestSkippedPhases()].sort()).toEqual(viaCycle.sort() as typeof ALL_PHASES);
  });
});

describe('guest pages feed no derived rows (pglite, repo-less)', () => {
  let engine: PGLiteEngine;
  const writer = { kind: 'oauth_client' as const, id: 'client-a' };
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await initGuestSource(engine, 'guests', [`${writer.kind}:${writer.id}`]);
    const asWriter = <T>(fn: (tx: PGLiteEngine) => Promise<T>) => engine.transaction(tx => withWriteAttribution(tx, { requestId: null, principal: writer,
      trust: { tier: 'external_untrusted', origin: { channel: 'test' } } }, () => fn(tx as PGLiteEngine)));
    await asWriter(tx => importFromContent(tx, 'people/carol-example', '---\ntype: note\ntitle: Carol\n---\n# Carol\n\nA guest page.', { sourceId: 'guests', noEmbed: true } as never));
    await asWriter(tx => importFromContent(tx, 'notes/guest-a', '---\ntype: note\ntitle: Guest\n---\n# Guest\n\nMet [[people/carol-example]] about the ledger.\n\n## Facts\n\n| fact | entity |\n|---|---|\n| Carol likes tea | people/carol-example |\n',
      { sourceId: 'guests', noEmbed: true } as never));
    await asWriter(tx => tx.executeRaw("UPDATE pages SET timeline = '- **2026-11-01** | Met Carol' WHERE source_id='guests' AND slug='notes/guest-a'"));
    await importFromContent(engine, 'people/dan-example', '---\ntype: person\ntitle: Dan\n---\n# Dan\n', { noEmbed: true } as never);
    await importFromContent(engine, 'notes/owner-a', '---\ntype: note\ntitle: Owner\n---\n# Owner\n\nMet [[people/dan-example]].\n', { noEmbed: true } as never);
  }, 180_000);
  afterAll(async () => { await engine.disconnect(); });

  const guestRows = async () => (await engine.executeRaw<{ links: number; timeline: number; facts: number }>(
    `SELECT (SELECT count(*)::int FROM links l JOIN pages p ON p.id = l.from_page_id WHERE p.source_id = 'guests') AS links,
            (SELECT count(*)::int FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.source_id = 'guests') AS timeline,
            (SELECT count(*)::int FROM facts f WHERE f.source_id = 'guests') AS facts`))[0]!;

  test('stale extraction never lists a guest page and links only the owner page', async () => {
    expect(await engine.countStalePagesForExtraction({ sourceId: 'guests' })).toBe(0);
    await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: false });
    expect(await guestRows()).toEqual({ links: 0, timeline: 0, facts: 0 });
    const [owner] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM links l JOIN pages p ON p.id = l.from_page_id WHERE p.slug = 'notes/owner-a'");
    expect(owner!.n).toBeGreaterThan(0);
  }, 120_000);

  test('the timeline walk and fact extraction skip the guest source', async () => {
    const timeline = await extractTimelineFromDB(engine, { dryRun: false, jsonMode: true, quiet: true });
    expect(timeline.refused).toBe(0);
    const facts = await runExtractFacts(engine, { sourceId: 'guests' });
    expect({ scanned: facts.pagesScanned, failed: facts.pagesFailed }).toEqual({ scanned: 0, failed: 0 });
    expect(await guestRows()).toEqual({ links: 0, timeline: 0, facts: 0 });
  }, 120_000);

  test('an unscoped propose_takes run never reads a guest page and proposes nothing from it', async () => {
    const scanned: string[] = [];
    const ctx = { engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: undefined };
    await runPhaseProposeTakes(ctx as never, { extractor: async ({ pagePath }) => { scanned.push(pagePath); return []; } });
    expect(scanned).toContain('notes/owner-a');
    expect(scanned.filter(slug => slug === 'notes/guest-a' || slug === 'people/carol-example')).toEqual([]);
    const [proposals] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM take_proposals WHERE source_id = 'guests'");
    expect(proposals!.n).toBe(0);
  }, 120_000);

  test('a cycle scoped to the guest source reports the derived phases skipped', async () => {
    const report = await runCycle(engine, { sourceId: 'guests', phases: ['extract_facts', 'propose_takes', 'orphans'], brainDir: null } as never);
    const byPhase = Object.fromEntries(report.phases.map(p => [p.phase, (p.details as { reason?: string } | undefined)?.reason]));
    expect({ extract_facts: byPhase.extract_facts, propose_takes: byPhase.propose_takes }).toEqual({ extract_facts: 'guest_source', propose_takes: 'guest_source' });
    expect(byPhase.orphans).not.toBe('guest_source');
  }, 120_000);
});
