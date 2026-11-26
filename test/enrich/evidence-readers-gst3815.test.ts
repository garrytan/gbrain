/**
 * GST-3815: enrich fills a page only with evidence every reader of that page already reads.
 *
 * Pre-fix, retrieveEvidence read every fact about the entity (private ones and ones held on pages that name fewer
 * readers included), every backlink context and every hybrid-search chunk with no reader check, and the synthesized
 * text was written onto the page under the page's own readable_by / visibility. Hermetic PGLite with no repository
 * (the default keyless brain) and a prompt-capturing synthesizeFn, so the test sees exactly what reached the model.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runEnrichCore, type SynthesizeFn } from '../../src/commands/enrich.ts';
import { importFromContent } from '../../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const TARGET = 'people/alice-example';

async function seedPage(slug: string, type: string, frontmatter: Record<string, unknown>, body = `Notes about ${slug}.`) {
  await engine.putPage(slug, { type: type as never, title: slug === TARGET ? 'Alice Example' : slug, compiled_truth: body, timeline: '', frontmatter });
}

/** A page through the real import path, so its chunks are indexed for search. */
async function importPage(slug: string, frontmatter: string, body: string) {
  await importFromContent(engine, slug, `---\ntype: note\ntitle: ${slug}\n${frontmatter}---\n${body}\n`, { sourceId: 'default' });
}

async function seedFact(fact: string, visibility: 'world' | 'private', holding: string | null) {
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, valid_from)
     VALUES ('default', $1, $2, 'fact', $3, 'test', $4, now())`,
    [TARGET, fact, visibility, holding],
  );
}

/** A facts fence with one world row per claim, as a page body holds it. */
const worldFence = (claims: string[]) => ['<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  ...claims.map((claim, i) => `| ${i + 1} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |`),
  '<!--- gbrain:facts:end -->'].join('\n');

async function enrichPrompt(thinThreshold = 400): Promise<string> {
  let captured = '';
  const synth: SynthesizeFn = async ({ user }) => {
    captured = user;
    return '## Overview\nAlice Example leads design at Acme Example. [Source: meetings/open-m1]';
  };
  const r = await runEnrichCore(engine, {
    sourceId: 'default',
    types: ['person'] as never[],
    order: 'inbound-links',
    thinThreshold,
    model: 'test:model',
    workers: 1,
    minContextChars: 20,
    synthesizeFn: synth,
  });
  expect(r.pages_failed ?? 0).toBe(0);
  return captured;
}

describe('enrich evidence stays within the page readers (GST-3815)', () => {
  test('a world-readable page gets no private fact and no fact from a page that names readers', async () => {
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await seedPage('meetings/open-m1', 'note', {});
    await seedPage('notes/team-a-only', 'note', { readable_by: ['group:team-a'] });
    await seedPage('notes/private-note', 'note', { visibility: 'private' });

    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', 'meetings/open-m1');
    await seedFact('own-page-fact-marker: Alice Example joined Acme Example in 2025', 'world', TARGET);
    await seedFact('unpaged-fact-marker: Alice Example speaks at the design summit', 'world', null);
    await seedFact('private-fact-marker: Alice Example is changing jobs', 'private', TARGET);
    await seedFact('narrow-fact-marker: Alice Example salary band', 'world', 'notes/team-a-only');
    await seedFact('private-page-fact-marker: Alice Example health note', 'world', 'notes/private-note');

    const prompt = await enrichPrompt();
    expect(prompt).toContain('open-fact-marker');
    expect(prompt).toContain('own-page-fact-marker');
    expect(prompt).toContain('unpaged-fact-marker');
    expect(prompt).not.toContain('private-fact-marker');
    expect(prompt).not.toContain('narrow-fact-marker');
    expect(prompt).not.toContain('private-page-fact-marker');
  }, 30000);

  test('a page that names readers gets facts from pages that name all of its readers, and nothing a labelled-only member could not read', async () => {
    const wider = 'wider-fact-marker: Alice Example mentors the design guild';
    const ownPage = 'own-page-fact-marker: Alice Example joined Acme Example in 2025';
    await seedPage(TARGET, 'person', { readable_by: ['group:team-a'] }, `Stub page.\n\n${worldFence([ownPage])}`);
    await seedPage('meetings/open-m1', 'note', {});
    const held = 'held-wider-fact-marker: Alice Example medical leave';
    await seedPage('notes/team-a-and-b', 'note', { readable_by: ['group:team-a', 'group:team-b'] }, `Team notes.\n\n${worldFence([wider, held])}`);
    await seedPage('notes/team-b-only', 'note', { readable_by: ['group:team-b'] });
    await seedPage('notes/private-note', 'note', { visibility: 'private' });

    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', 'meetings/open-m1');
    await seedFact(wider, 'world', 'notes/team-a-and-b');
    // A labelled-only member reads a fact only as a row of a page body labelled for it, so a fact no body shows stays out.
    await seedFact('bodyless-fact-marker: Alice Example review score', 'world', 'notes/team-a-and-b');
    await seedFact('bodyless-own-fact-marker: Alice Example badge number', 'world', TARGET);
    // Fence row 2 shows world in the body while its stored row is private: remote readers never see it, so its world copy stays out.
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, row_num, valid_from)
       VALUES ('default', $1, $2, 'fact', 'private', 'test', 'notes/team-a-and-b', 2, now()), ('default', $1, $2, 'fact', 'world', 'test', 'notes/team-a-and-b', 3, now())`,
      [TARGET, held],
    );
    await seedFact('other-team-fact-marker: Alice Example review outcome', 'world', 'notes/team-b-only');
    await seedFact('private-page-fact-marker: Alice Example health note', 'world', 'notes/private-note');
    await seedFact('private-fact-marker: Alice Example is changing jobs', 'private', TARGET);

    await seedFact(ownPage, 'world', TARGET);
    await seedFact('unpaged-fact-marker: Alice Example speaks at the design summit', 'world', null);

    const prompt = await enrichPrompt(1200);
    expect(prompt).toContain('wider-fact-marker');
    expect(prompt).not.toContain('held-wider-fact-marker');
    expect(prompt).not.toContain('bodyless-fact-marker');
    expect(prompt).not.toContain('bodyless-own-fact-marker');
    expect(prompt).toContain('own-page-fact-marker');
    // A labelled-only member of team-a reads the page but not an unlabelled page or a fact with no page.
    expect(prompt).not.toContain('open-fact-marker');
    expect(prompt).not.toContain('unpaged-fact-marker');
    expect(prompt).not.toContain('other-team-fact-marker');
    expect(prompt).not.toContain('private-page-fact-marker');
    expect(prompt).not.toContain('private-fact-marker');
  }, 30000);

  test('backlink context and search chunks from pages that name readers or are private stay out', async () => {
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await importPage('meetings/open-m1', '', 'Alice Example presented the open-chunk-marker design system.');
    await importPage('notes/team-a-only', 'readable_by: [group:team-a]\n', 'Alice Example narrow-chunk-marker compensation notes.');
    await importPage('notes/private-note', 'visibility: private\n', 'Alice Example private-chunk-marker health notes.');
    await engine.addLink('meetings/open-m1', TARGET, 'open-link-marker: Alice Example ran the summit session.', 'mentions', 'manual');
    await engine.addLink('notes/team-a-only', TARGET, 'narrow-link-marker: Alice Example compensation review.');
    await engine.addLink('notes/private-note', TARGET, 'private-link-marker: Alice Example medical leave.');

    const prompt = await enrichPrompt();
    expect(prompt).toContain('open-link-marker');
    expect(prompt).not.toContain('narrow-link-marker');
    expect(prompt).not.toContain('private-link-marker');
    expect(prompt).toContain('open-chunk-marker');
    expect(prompt).not.toContain('narrow-chunk-marker');
    expect(prompt).not.toContain('private-chunk-marker');
  }, 30000);

  test('a link from an open page whose origin page names readers stays out', async () => {
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await seedPage('meetings/open-m1', 'note', {});
    await seedPage('notes/team-a-only', 'note', { readable_by: ['group:team-a'] });
    await engine.addLink('meetings/open-m1', TARGET, 'open-link-marker: Alice Example ran the summit session.', 'mentions', 'manual');
    await engine.addLink('meetings/open-m1', TARGET, 'origin-link-marker: Alice Example compensation review.', 'mentions', 'frontmatter', 'notes/team-a-only', 'attendees');

    const prompt = await enrichPrompt();
    expect(prompt).toContain('open-link-marker');
    expect(prompt).not.toContain('origin-link-marker');
  }, 30000);

  test('a fact on a page under a folder rule fills only a page that rule also covers', async () => {
    const rule = async (prefix: string) => {
      await engine.executeRaw(`INSERT INTO access_policy_state(source_id) VALUES('default') ON CONFLICT DO NOTHING`);
      await engine.executeRaw(`INSERT INTO access_rules(source_id,rule_id,prefix,readable_by,revision) VALUES('default','r1',$1,ARRAY['member:alice-example'],1)`, [prefix]);
    };
    await rule('ruled/');
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await seedPage('ruled/note', 'note', {});
    await seedFact('ruled-fact-marker: Alice Example board seat', 'world', 'ruled/note');
    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', null);
    const [stamped] = await engine.executeRaw<{ ids: string[] | null }>(`SELECT folder_rule_ids AS ids FROM pages WHERE slug = 'ruled/note'`);
    expect(stamped!.ids?.length).toBe(1);
    const narrower = await enrichPrompt();
    expect(narrower).toContain('open-fact-marker');
    expect(narrower).not.toContain('ruled-fact-marker');

    await resetPgliteState(engine);
    await rule('people/');
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await seedPage('people/ruled-note', 'note', {}, `Ruled notes.\n\n${worldFence(['ruled-fact-marker: Alice Example board seat'])}`);
    await seedFact('ruled-fact-marker: Alice Example board seat', 'world', 'people/ruled-note');
    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', null);
    expect(await enrichPrompt()).toContain('ruled-fact-marker');
  }, 30000);

  test('a search chunk from a page whose chunks are not sealed for private fence rows stays out', async () => {
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await importPage('meetings/open-m1', '', 'Alice Example presented the open-chunk-marker design system.');
    await importPage('meetings/unsealed-m2', '', 'Alice Example unsealed-chunk-marker notes from the offsite.');
    await engine.executeRaw(`UPDATE pages SET chunker_version = 3 WHERE slug = 'meetings/unsealed-m2'`);

    const prompt = await enrichPrompt();
    expect(prompt).toContain('open-chunk-marker');
    expect(prompt).not.toContain('unsealed-chunk-marker');
  }, 30000);

  test('private fence rows and takes on the page being filled never reach the prompt', async () => {
    const fence = ['## Facts', '<!--- gbrain:facts:begin -->',
      '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
      '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
      '| 1 | world-row-marker Alice Example leads design | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |',
      '| 2 | private-row-marker Alice Example is changing jobs | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |',
      '<!--- gbrain:facts:end -->'].join('\n');
    await importFromContent(engine, TARGET, `---\ntype: person\ntitle: Alice Example\n---\nStub page.\n\n${fence}\n`, { sourceId: 'default' });
    await seedPage('meetings/open-m1', 'note', {});
    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', 'meetings/open-m1');

    const prompt = await enrichPrompt(4000);
    expect(prompt).toContain('open-fact-marker');
    expect(prompt).toContain('world-row-marker');
    expect(prompt).not.toContain('private-row-marker');
  }, 30000);

  test('evidence whose readers narrow while the model runs is not published', async () => {
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await seedPage('meetings/open-m1', 'note', {});
    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', 'meetings/open-m1');
    const r = await runEnrichCore(engine, {
      sourceId: 'default', types: ['person'] as never[], order: 'inbound-links', thinThreshold: 400, model: 'test:model', workers: 1, minContextChars: 20,
      synthesizeFn: async () => {
        await seedPage('meetings/open-m1', 'note', { readable_by: ['group:team-a'] });
        return '## Overview\nAlice Example leads design at Acme Example. [Source: meetings/open-m1]';
      },
    });
    expect(r.pages_enriched).toBe(0);
    expect(r.pages_skipped_evidence_narrowed).toBe(1);
    const page = await engine.getPage(TARGET, { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe('Stub page.');
  }, 30000);

  test('a page that is owner-only by lineage does not fill a page that is not', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('held-once', 'held-once', '{"owner_only":true}'::jsonb)`);
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'held-once'`);
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await seedPage('meetings/open-m1', 'note', {});
    await seedPage('notes/from-owner-only', 'note', {});
    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', 'meetings/open-m1');
    await seedFact('owner-only-fact-marker: Alice Example message thread', 'world', 'notes/from-owner-only');
    const [held] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'notes/from-owner-only'`);
    await engine.executeRaw(`INSERT INTO owner_only_marks (row_table, row_id) VALUES ('pages', $1)`, [String(held!.id)]);

    const prompt = await enrichPrompt();
    expect(prompt).toContain('open-fact-marker');
    expect(prompt).not.toContain('owner-only-fact-marker');
  }, 30000);

  test('a link context cut next to a private fence row loses that row', async () => {
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    const fence = ['<!--- gbrain:facts:begin -->',
      '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
      '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
      '| 1 | private-row-marker Alice Example is changing jobs | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |',
      '<!--- gbrain:facts:end -->'].join('\n');
    await importFromContent(engine, 'meetings/open-m1', `---\ntype: note\ntitle: m1\n---\nMet [Alice Example](people/alice-example).\n\n${fence}\n`, { sourceId: 'default' });
    await engine.addLink('meetings/open-m1', TARGET, `Met Alice Example. ${fence.split('\n')[3]}`, 'mentions', 'markdown');
    await seedPage('meetings/open-m2', 'note', {});
    await engine.addLink('meetings/open-m2', TARGET, 'open-link-marker: Alice Example ran the summit session.', 'mentions', 'manual');

    const prompt = await enrichPrompt();
    expect(prompt).toContain('open-link-marker');
    expect(prompt).not.toContain('private-row-marker');
  }, 30000);

  test('a fact that turns private while the model runs is not published', async () => {
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await seedPage('meetings/open-m1', 'note', {});
    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', 'meetings/open-m1');
    const r = await runEnrichCore(engine, {
      sourceId: 'default', types: ['person'] as never[], order: 'inbound-links', thinThreshold: 400, model: 'test:model', workers: 1, minContextChars: 20,
      synthesizeFn: async () => {
        await engine.executeRaw(`UPDATE facts SET visibility = 'private' WHERE fact LIKE 'open-fact-marker%'`);
        return '## Overview\nAlice Example leads design at Acme Example. [Source: meetings/open-m1]';
      },
    });
    expect(r.pages_enriched).toBe(0);
    expect(r.pages_skipped_evidence_narrowed).toBe(1);
  }, 30000);

  test('a fact normal reads hide (its holding page quarantined or deleted) never fills a page', async () => {
    await seedPage(TARGET, 'person', {}, 'Stub page.');
    await seedPage('meetings/open-m1', 'note', {});
    await seedPage('notes/quarantined-note', 'note', { quarantine: { reason: 'test' } });
    await seedPage('notes/deleted-note', 'note', {});
    await seedFact('open-fact-marker: Alice Example leads design at Acme Example', 'world', 'meetings/open-m1');
    await seedFact('quarantined-fact-marker: Alice Example home address', 'world', 'notes/quarantined-note');
    await seedFact('deleted-fact-marker: Alice Example old phone', 'world', 'notes/deleted-note');
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/deleted-note'`);

    const prompt = await enrichPrompt();
    expect(prompt).toContain('open-fact-marker');
    expect(prompt).not.toContain('quarantined-fact-marker');
    expect(prompt).not.toContain('deleted-fact-marker');
  }, 30000);
});
