/**
 * Entity mention index, the pass (mentions/pass.ts) as `gbrain extract
 * --stale` runs it on PGLite.
 *
 * Protects: default-on mention links from the stale sweep alone; incremental
 * convergence (later entity, edited page, deleted and recreated entity,
 * removed last entity) without rescanning unaffected pages; the reconcile
 * touching only plain mention rows (typed_ner survives, also across off/on);
 * the off switch; conditional publish (an edit during the scan leaves the
 * page due); fail-closed index builds; an upgraded brain whose links are
 * current; a slot-style build leaving 0 pages due; dry-run counts matching
 * the real run. Regression: a sweep that skips mentions when links are
 * current, a reconcile that deletes typed_ner rows, a pass that publishes
 * links computed from a stale page or gazetteer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { countMentionDuePages, runMentionPass } from '../src/core/mentions/pass.ts';
import { buildGazetteer } from '../src/core/by-mention.ts';
import { readMentionCoverage } from '../src/core/mentions/coverage.ts';
import { mentionIndexUpgradeNotice } from '../src/core/mentions/upgrade-notice.ts';
import { derivedAliases, mentionBrain, mentionLinks, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

const account = () => page(engine, 'crm/123', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO\nOwner: Dana Example');

describe('the stale sweep links mentions by default', () => {
  test('a fresh brain: an account page and a ticket naming it by code get a mention link from extract --stale alone', async () => {
    await account();
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO\nStatus: Open');
    const r = await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['tickets/t1 -> crm/123']);
    expect(await derivedAliases(engine, 'crm/123')).toEqual(['declared:quco (cs)', 'subject:quormiro capital']);
    expect(r.mentions).toMatchObject({ state: 'complete', remaining: 0 });
    expect(await countMentionDuePages(engine)).toBe(0);
  });

  test('page titles are scanned: a meeting titled with the code links', async () => {
    await account();
    await page(engine, 'meetings/m1', 'meeting', 'Meeting: QUCO renewal prep', 'Notes.');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['meetings/m1 -> crm/123']);
  });

  test('a code linked only as written: lowercase prose does not link', async () => {
    await account();
    await page(engine, 'notes/n1', 'note', 'n1', 'we used quco as a placeholder');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual([]);
  });

  test('an older page links to a later-added entity on the next sweep; unaffected pages are not rescanned', async () => {
    await page(engine, 'notes/n1', 'note', 'n1', 'Met Zebra Holdings today.');
    await page(engine, 'notes/n2', 'note', 'n2', 'Nothing relevant.');
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await sweep(engine);
    await page(engine, 'companies/zebra', 'company', 'Zebra Holdings', 'Another company.');
    const r = await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> companies/zebra']);
    // The new entity page itself plus the one page whose text names it.
    expect(r.mentions?.pages).toBe(2);
  });

  test('an edited page loses a mention it no longer contains', async () => {
    await account();
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO');
    await sweep(engine);
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer unknown.');
    const r = await sweep(engine);
    expect(await mentionLinks(engine)).toEqual([]);
    expect(r.mentions?.removed).toBe(1);
  });

  test('an entity deleted and recreated under another slug with the same title retargets older pages', async () => {
    await page(engine, 'companies/old', 'company', 'Acme Example', 'v1');
    await page(engine, 'notes/n1', 'note', 'n1', 'Talked to Acme Example.');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> companies/old']);
    await engine.softDeletePage('companies/old');
    await page(engine, 'companies/new', 'company', 'Acme Example', 'v2');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> companies/new']);
  });

  test('removing the last entity removes its links (an empty gazetteer still reconciles)', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'notes/n1', 'note', 'n1', 'Talked to Acme Example.');
    await sweep(engine);
    await engine.softDeletePage('companies/acme');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual([]);
  });

  test('Unicode and punctuation variants of a new name are found', async () => {
    await page(engine, 'companies/seed', 'company', 'Seed Company', 'x');
    await page(engine, 'notes/nfd', 'note', 'nfd', 'Visited Ha\u0300 Nô\u0323i Labs yesterday.');
    await page(engine, 'notes/dash', 'note', 'dash', 'The Widget-Works deal closed.');
    await sweep(engine);
    await page(engine, 'companies/hn', 'company', 'Hà Nội Labs', 'x');
    await page(engine, 'companies/ww', 'company', 'Widget Works', 'x');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/dash -> companies/ww', 'notes/nfd -> companies/hn']);
  });
});

describe('short codes the entity page declares for itself', () => {
  test('"Also called JOF in my notes" makes JOF a name: mails and note titles that say JOF link to the company, only as written', async () => {
    await page(engine, 'companies/joffrey-foods', 'company', 'Joffrey Foods', 'Also called JOF in my notes. Procurement: Arjun Example.');
    await page(engine, 'mail/m1', 'email', 'Re: pilot kickoff', 'From: Kofi Example (JOF)\nCould we push the pilot kickoff?');
    await page(engine, 'notes/call', 'note', 'Call with JOF', 'The right number is $26 per seat.');
    await page(engine, 'notes/lower', 'note', 'n2', 'we said jof as a joke');
    await page(engine, 'notes/other', 'note', 'n3', 'Widget Co, also called JOF by some, is unrelated.');
    await sweep(engine);
    expect(await derivedAliases(engine, 'companies/joffrey-foods')).toEqual(['declared:jof (cs)']);
    expect(await derivedAliases(engine, 'notes/other')).toEqual([]);
    expect(await mentionLinks(engine)).toEqual(['mail/m1 -> companies/joffrey-foods', 'notes/call -> companies/joffrey-foods', 'notes/other -> companies/joffrey-foods']);
  });

  test('a stoplisted code on the own page never becomes a name', async () => {
    await page(engine, 'companies/acme-example', 'company', 'Acme Example', 'Also called IT internally.');
    await page(engine, 'notes/n1', 'note', 'n1', 'Ask IT about the laptop.');
    await sweep(engine);
    expect(await derivedAliases(engine, 'companies/acme-example')).toEqual([]);
    expect(await mentionLinks(engine)).toEqual([]);
  });
});

describe('reconcile scope, off switch and failure', () => {
  test('typed_ner rows survive a reconcile and an off/on cycle while an obsolete plain mention goes', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'people/alice', 'person', 'Alice Example', 'Alice works at Acme Example.');
    await sweep(engine);
    await engine.addLinksBatch([{ from_slug: 'people/alice', to_slug: 'companies/acme', link_type: 'works_at', link_source: 'mentions', link_kind: 'typed_ner', context: 'works at' } as never]);
    await page(engine, 'people/alice', 'person', 'Alice Example', 'Alice moved on.');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['people/alice -> companies/acme (typed_ner)']);
    await engine.setConfig('mentions.auto_link', 'false');
    await sweep(engine);
    await engine.unsetConfig('mentions.auto_link');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['people/alice -> companies/acme (typed_ner)']);
  });

  test('enabled → disabled → enabled without page edits: links and derived aliases go, then come back', async () => {
    await account();
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO');
    await sweep(engine);
    await engine.setConfig('mentions.auto_link', 'false');
    const off = await sweep(engine);
    expect(off.mentions?.state).toBe('disabled');
    expect(await mentionLinks(engine)).toEqual([]);
    expect(await derivedAliases(engine, 'crm/123')).toEqual([]);
    expect((await readMentionCoverage(engine, ['default'])).state).toBe('disabled');
    await engine.setConfig('mentions.auto_link', 'true');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['tickets/t1 -> crm/123']);
    expect(await derivedAliases(engine, 'crm/123')).toEqual(['declared:quco (cs)', 'subject:quormiro capital']);
  });

  test('global auto_link=false also stops the pass', async () => {
    await account();
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO');
    await engine.setConfig('auto_link', 'false');
    expect((await sweep(engine)).mentions?.state).toBe('disabled');
    expect(await mentionLinks(engine)).toEqual([]);
  });

  test('an edit committed during the scan leaves the page due; the next pass publishes it', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'notes/n1', 'note', 'n1', 'Acme Example called.');
    let edited = false;
    const r = await runMentionPass(engine, { beforePublish: async () => {
      if (edited) return;
      edited = true;
      await page(engine, 'notes/n1', 'note', 'n1', 'Nobody called.');
    } });
    expect(r.skipped).toBeGreaterThan(0);
    expect(await mentionLinks(engine)).toEqual([]);
    expect(await countMentionDuePages(engine)).toBe(1);
    await runMentionPass(engine);
    expect(await mentionLinks(engine)).toEqual([]);
    expect(await countMentionDuePages(engine)).toBe(0);
  });

  test('a gazetteer change saved during the scan fails the publish (generation check)', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'notes/n1', 'note', 'n1', 'Acme Example and Zebra Holdings.');
    await runMentionPass(engine);
    await page(engine, 'notes/n2', 'note', 'n2', 'Acme Example again.');
    let raced = false;
    const r = await runMentionPass(engine, { beforePublish: async () => {
      if (raced) return;
      raced = true;
      await page(engine, 'companies/zebra', 'company', 'Zebra Holdings', 'x');
      await runMentionPass(engine);
    } });
    expect(r.skipped).toBeGreaterThan(0);
    await runMentionPass(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> companies/acme', 'notes/n1 -> companies/zebra', 'notes/n2 -> companies/acme']);
  });

  test('overlapping sweeps converge to one consistent result', async () => {
    await account();
    for (let i = 0; i < 30; i++) await page(engine, `tickets/t${i}`, 'ticket', `Ticket ${i}`, `Customer: QUCO, ticket ${i}`);
    await Promise.all([runMentionPass(engine), runMentionPass(engine)]);
    await runMentionPass(engine);
    expect((await mentionLinks(engine)).length).toBe(30);
    expect(await countMentionDuePages(engine)).toBe(0);
  });

  test('an alias read failure writes nothing and records failed', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'notes/n1', 'note', 'n1', 'Acme Example called.');
    await sweep(engine);
    await page(engine, 'notes/n1', 'note', 'n1', 'Nobody called.');
    const raw = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof raw }).executeRaw = (async (sql: string, params?: unknown[]) => {
      if (/FROM page_aliases pa\s+JOIN pages p/.test(sql)) throw new Error('simulated alias read failure');
      return raw(sql, params);
    }) as typeof raw;
    try {
      const r = await runMentionPass(engine);
      expect(r.state).toBe('failed');
      expect(r.error).toContain('simulated alias read failure');
    } finally {
      // Drop the own-property shadow: transaction clones must read the engine's own method again.
      delete (engine as unknown as { executeRaw?: typeof raw }).executeRaw;
    }
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> companies/acme']);
    expect((await readMentionCoverage(engine, ['default'])).state).toBe('failed');
    await runMentionPass(engine);
    expect(await mentionLinks(engine)).toEqual([]);
  });

  test('a retyped page loses its derived aliases; frontmatter aliases survive the cleanup', async () => {
    await page(engine, 'crm/123', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO', { frontmatter: { aliases: ['QC Holdings'] } });
    await engine.setPageAliases('crm/123', 'default', ['qc holdings']);
    await sweep(engine);
    expect(await derivedAliases(engine, 'crm/123')).toEqual(['declared:quco (cs)', 'frontmatter:qc holdings', 'subject:quormiro capital']);
    await page(engine, 'crm/123', 'note', 'CRM record: Quormiro Capital', 'Account code: QUCO', { frontmatter: { aliases: ['QC Holdings'] } });
    await sweep(engine);
    expect(await derivedAliases(engine, 'crm/123')).toEqual(['frontmatter:qc holdings']);
  });

  test('a contract that declares the same code contributes nothing', async () => {
    await account();
    await page(engine, 'contracts/c1', 'contract', 'Contract: Quormiro Capital MSA', 'Account code: QUCO');
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO');
    await sweep(engine);
    expect(await derivedAliases(engine, 'contracts/c1')).toEqual([]);
    expect(await mentionLinks(engine)).toEqual(['contracts/c1 -> crm/123', 'tickets/t1 -> crm/123']);
  });
});

describe('upgrade, slot builds and dry runs', () => {
  test('an upgraded brain whose links are current gets aliases and mention links from one sweep', async () => {
    await account();
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: Quormiro Capital');
    // The previous release: links extracted and stamped, no mention state.
    await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
    await engine.executeRaw('DELETE FROM links');
    await engine.executeRaw("DELETE FROM page_aliases WHERE origin <> 'frontmatter'");
    await engine.executeRaw('DELETE FROM page_mention_state');
    await engine.executeRaw('DELETE FROM mention_gazetteer_entries');
    await engine.executeRaw('DELETE FROM mention_index_status');
    expect(await engine.countStalePagesForExtraction({ versionTs: '1970-01-01T00:00:00Z' })).toBe(0);
    expect((await mentionIndexUpgradeNotice(engine))?.join('\n')).toContain('gbrain extract --stale --catch-up');
    const r = await sweep(engine);
    expect(r.pagesProcessed).toBe(0);
    expect(await mentionLinks(engine)).toEqual(['tickets/t1 -> crm/123']);
    expect(await mentionIndexUpgradeNotice(engine)).toBeNull();
  });

  test('a budgeted (cycle) sweep makes mention progress when links are current', async () => {
    await account();
    for (let i = 0; i < 5; i++) await page(engine, `tickets/t${i}`, 'ticket', `Ticket ${i}`, 'Customer: QUCO');
    await sweep(engine, { timeBudgetMs: 60_000 });
    expect((await mentionLinks(engine)).length).toBe(5);
  });

  test('a slot-style build (over 1,000 pages, then extract --stale) leaves 0 pages due and complete coverage', async () => {
    await account();
    for (let i = 0; i < 1_050; i++) await page(engine, `mail/m${i}`, 'email', `Mail ${i}`, i % 50 === 0 ? 'Re: QUCO renewal' : 'Weekly digest');
    const dry = await extractStaleFromDB(engine, { dryRun: true, jsonMode: false, quiet: true, catchUp: true });
    const r = await sweep(engine);
    expect(await countMentionDuePages(engine)).toBe(0);
    expect(r.mentions?.pages).toBe(1_051);
    expect(dry.staleRemaining - (r.pagesProcessed)).toBe(1_051);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete', pending_pages: 0 });
    expect((await mentionLinks(engine)).length).toBe(21);
  }, 180_000);

  test('coverage counts pages written since the last pass', async () => {
    await account();
    await sweep(engine);
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO');
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'pending', pending_pages: 1, degraded: true });
  });
});

describe('gazetteer guards', () => {
  test('two entities sharing a first word: the shared word alone never links', async () => {
    await page(engine, 'crm/a', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO');
    await page(engine, 'crm/b', 'crm', 'CRM record: Quormiro Labs', 'Account code: QULA');
    await page(engine, 'notes/n1', 'note', 'n1', 'Quormiro asked about pricing. Later Quormiro Labs replied.');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> crm/b']);
  });

  test('a code declared by two accounts is dropped as a collision', async () => {
    await page(engine, 'crm/a', 'crm', 'CRM record: Alpha Holdings', 'Account code: DUPE');
    await page(engine, 'crm/b', 'crm', 'CRM record: Beta Holdings', 'Account code: DUPE');
    await page(engine, 'notes/n1', 'note', 'n1', 'DUPE escalated.');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual([]);
  });

  test('an exact company title outranks a CRM subject in the gazetteer', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'crm/9', 'crm', 'CRM record: Acme Example', 'Account code: ACMX');
    await page(engine, 'notes/n1', 'note', 'n1', 'Acme Example signed. ACMX renewal.');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> companies/acme', 'notes/n1 -> crm/9']);
  });

  test('mentions.ignore drops a name; frontmatter mention_ignore drops it for one page', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'companies/zebra', 'company', 'Zebra Holdings', 'x');
    await page(engine, 'notes/n1', 'note', 'n1', 'Acme Example and Zebra Holdings.', { frontmatter: { mention_ignore: ['Zebra Holdings'] } });
    await page(engine, 'notes/n2', 'note', 'n2', 'Acme Example and Zebra Holdings.');
    await engine.setConfig('mentions.ignore', 'Acme Example');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n2 -> companies/zebra']);
  });

  test('mentions.entity_types opts a type in', async () => {
    await page(engine, 'projects/apollo', 'project', 'Project Apollo', 'x');
    await page(engine, 'notes/n1', 'note', 'n1', 'Project Apollo shipped.');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual([]);
    await engine.setConfig('mentions.entity_types', '+project');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> projects/apollo']);
  });

  test('independent fixture: status buried mid-body, duplicate records, undeclared aliases, people named Will and Grace', async () => {
    await page(engine, 'accounts/northwind', 'account', 'Northwind Traders', 'Primary account. Account code: NWTR');
    await page(engine, 'accounts/northwind-2', 'account', 'Northwind Traders', 'Duplicate record created by an import.');
    await page(engine, 'people/will', 'person', 'Will Turner', 'Sales lead.');
    await page(engine, 'people/grace', 'person', 'Grace Hopper-Example', 'Engineer.');
    await page(engine, 'tickets/x1', 'ticket', 'Escalation', 'Opened Monday.\nWe will follow up. Grace period ends Friday.\nStatus: Open\nNW asked again; NWTR is blocked.');
    await sweep(engine);
    const links = await mentionLinks(engine);
    expect(links).toContain('tickets/x1 -> accounts/northwind');
    expect(links.some(l => l.includes('people/will') || l.includes('people/grace'))).toBe(false);
    // Both duplicate records keep the same title; the scanner picks one deterministically, never both.
    expect(links.filter(l => l.startsWith('tickets/x1')).length).toBe(1);
  });

  test('extract-ner and meeting timeline extraction read the wider gazetteer', async () => {
    await account();
    const g = await buildGazetteer(engine);
    await sweep(engine);
    const g2 = await buildGazetteer(engine);
    // Before the sweep only the full title is a name; the sweep derives the subject and the code.
    expect([...g.keys()]).toEqual(['crm']);
    expect([...g2.keys()]).toEqual(expect.arrayContaining(['crm', 'quormiro', 'quco']));
    const { extractNerLinks } = await import('../src/core/extract-ner.ts');
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'Ticker: ACMX');
    await page(engine, 'people/dana', 'person', 'Dana Example', 'Dana works at ACMX.');
    await sweep(engine);
    const ner = await extractNerLinks(engine);
    expect(ner.created).toBe(1);
    expect(await mentionLinks(engine)).toContain('people/dana -> companies/acme (typed_ner)');
    const { extractTimelineFromMeetings } = await import('../src/core/extract-timeline-from-meetings.ts');
    await page(engine, 'meetings/2026-04-03', 'meeting', 'Renewal prep', 'Reviewed the QUCO renewal.', { frontmatter: { date: '2026-04-03' } });
    const meetings = await extractTimelineFromMeetings(engine, { dryRun: true });
    expect(meetings.entries_created).toBeGreaterThanOrEqual(1);
  });
});
