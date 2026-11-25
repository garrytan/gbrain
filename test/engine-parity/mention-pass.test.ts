/**
 * BrainEngine parity: the mention pass's members (engine-sql/mention-pass.ts) and the gazetteer, extract snapshot and
 * explain reads (engine-sql/mention-reads.ts), through the pass, the gazetteer build and explain, and called directly.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite always; Postgres with DATABASE_URL; Rust with GBRAIN_TEST_RUST_ARM=1) the pass
 *    reconciles the same plain mention links, records the same status (state, pending, generation, fingerprint) and
 *    page state, keeps derived aliases current, turns the index off and on, and the gazetteer and explain read the same
 *    names; each member called alone answers and writes what its SQL does.
 *  - Regression: an engine that keeps no mention state (every page due forever), marks a page current at the wrong
 *    revision, deletes a typed or explicit link, or reads a name the SQL does not changes which pages link to which
 *    entity and what `extract --stale` reports as left to do.
 *  - Why existing coverage misses it: the pass's statements ran through `executeRaw`, which the parity cases cannot
 *    call (D18), and the mention tests run on PGLite only.
 *  - Seam: none. Real engines, typed members only. Page and link ids are mapped to slugs before comparison; rows with
 *    no defined order are sorted.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runMentionPass } from '../../src/core/mentions/pass.ts';
import { ALIAS_DERIVATION_VERSION, MENTION_EXTRACTOR_VERSION } from '../../src/core/mentions/versions.ts';
import { buildGazetteer } from '../../src/core/by-mention.ts';
import { explainMention } from '../../src/commands/extract-mentions-explain.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

type PageInput = Parameters<BrainEngine['putPage']>[1];
const page = (type: string, title: string, body: string, frontmatter: Record<string, unknown> = {}): PageInput =>
  ({ type, title, compiled_truth: body, timeline: '', frontmatter }) as PageInput;

async function seed(engine: BrainEngine): Promise<void> {
  await engine.putPage('people/alice-example', page('person', 'Alice Example', 'Alice Example leads indexing.', { aliases: ['alice'] }));
  await engine.putPage('people/quill-example', page('person', 'Quill Example', 'Quill Example, also known as "Featherstone", leads design.'));
  await engine.putPage('companies/orbit-example', page('company', 'CRM record: Orbit Labs', 'Orbit Labs builds satellites.'));
  await engine.putPage('companies/widget-co', page('company', 'Widget Co', 'Widget Co makes widgets.'));
  await engine.putPage('notes/standup', page('note', 'Standup', 'Featherstone and Orbit Labs met with Alice Example and Widget Co.'));
  await engine.putPage('notes/retro', page('note', 'Retro', 'Widget Co shipped. Nothing else.'));
  await engine.addLink('notes/retro', 'companies/widget-co', '', 'mentions', 'manual');
}

/** Slug of each page id, to compare rows across arms whose ids differ. */
async function slugsById(engine: BrainEngine, slugs: readonly string[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const slug of slugs) {
    const p = await engine.getPage(slug);
    if (p) out.set(Number(p.id), slug);
  }
  return out;
}

const SLUGS = ['people/alice-example', 'people/quill-example', 'companies/orbit-example', 'companies/widget-co', 'notes/standup', 'notes/retro'];

async function linkView(engine: BrainEngine, names: Map<number, string>): Promise<string[]> {
  const rows = await engine.listPageOutLinks([...names.keys()]);
  return sorted(rows.map(r => `${names.get(Number(r.from_page_id))} -> ${r.to_source_id}:${r.to_slug} ${r.plain ? 'plain' : 'typed'}`));
}

async function stateView(engine: BrainEngine) {
  const [status] = await engine.readMentionStatusStates(['default']);
  const [fingerprint] = await engine.readMentionPolicyFingerprints(['default']);
  const [generation] = await engine.readMentionGenerations(['default'], false);
  return {
    state: status?.state ?? null, fingerprint: fingerprint?.policy_fingerprint ?? null, generation: generation?.generation ?? null,
    due: await engine.countPagesDueForMentions({ sourceId: 'default', mentionVersion: MENTION_EXTRACTOR_VERSION }),
    entries: sorted((await engine.listGazetteerEntryKeys('default')).map(k => `${k.name_norm}|${k.target_slug}|${k.case_sensitive}`)),
  };
}

describe('engine parity: the mention pass', () => {
  parityTest('the pass links named entities, keeps its state, and turns the index off and on',
    { methods: ['listMentionSourceIds', 'readMentionPolicyFingerprints', 'listStaleDerivedAliasSlugs', 'listAliasDuePages', 'listDerivedAliasRows',
      'listGazetteerEntryKeys', 'readMentionGenerations', 'listMentionDuePages', 'writeMentionIndexStatus', 'readMentionStatusStates',
      'listLivePageSourceIds', 'listGazetteerPages', 'listGazetteerAliases', 'listPageOutLinks'] },
    async (engine) => {
      await seed(engine);
      const names = await slugsById(engine, SLUGS);
      const first = await runMentionPass(engine);
      const afterFirst = { links: await linkView(engine, names), state: await stateView(engine) };
      const again = await runMentionPass(engine);
      await engine.putPage('notes/standup', page('note', 'Standup', 'Orbit Labs met with nobody.'));
      const edited = await runMentionPass(engine);
      const afterEdit = { links: await linkView(engine, names), state: await stateView(engine) };
      await engine.setConfig('mentions.auto_link', 'false');
      const off = await runMentionPass(engine);
      const afterOff = { links: await linkView(engine, names), state: await stateView(engine) };
      await engine.setConfig('mentions.auto_link', 'true');
      const on = await runMentionPass(engine);
      const afterOn = { links: await linkView(engine, names), state: await stateView(engine) };
      const result = { first, afterFirst, again, edited, afterEdit, off, afterOff, on, afterOn };
      expect(first.created).toBeGreaterThan(0);
      expect(afterFirst.links).toContain('notes/standup -> default:people/quill-example plain');
      expect(afterFirst.links).toContain('notes/retro -> default:companies/widget-co typed');
      expect(again).toMatchObject({ pages: 0, created: 0, removed: 0, state: 'complete' });
      expect(edited.removed).toBeGreaterThan(0);
      expect(off).toMatchObject({ state: 'disabled' });
      expect(afterOff.links.filter(l => l.endsWith('plain'))).toEqual([]);
      expect(afterOff.state).toMatchObject({ state: 'disabled', entries: [] });
      expect(afterOn.state.state).toBe('complete');
      return result;
    });

  parityTest('the gazetteer and explain read the same names',
    { methods: ['listLivePageSourceIds', 'listGazetteerPages', 'listGazetteerAliases', 'readExplainPage', 'readExplainScanPage', 'countMentionLinksTo',
      'readPageNameText', 'listFrontmatterAliasNorms', 'listRejectedDeclarationPages'] },
    async (engine) => {
      await seed(engine);
      await runMentionPass(engine);
      const gazetteer = await buildGazetteer(engine);
      const entries = sorted([...gazetteer.values()].flat().map(e => `${e.source_id}:${e.slug} ${e.tokens.join(' ')} ${e.origin ?? 'title'} ${!!e.caseTokens}`));
      const explain = {
        declared: await explainMention(engine, 'Featherstone'),
        onPage: await explainMention(engine, 'Featherstone', { page: 'notes/standup' }),
        bySlug: await explainMention(engine, 'people/alice-example'),
        subject: await explainMention(engine, 'Orbit Labs'),
        unknown: await explainMention(engine, 'Nobody Here'),
        rejected: await explainMention(engine, 'Q'),
      };
      expect(entries).toContain('default:people/quill-example featherstone declared true');
      expect(explain.onPage).toMatchObject({ reason: null, page: { slug: 'notes/standup', linked: true } });
      return { entries, explain };
    });

  parityTest('each member alone answers and writes what its statement does',
    { methods: ['readPageStampTimes', 'readPageRevisionForShare', 'listMentionCandidatePages', 'insertDerivedAliasRows', 'deleteDerivedAliasesForSlugs',
      'upsertPageAliasState', 'upsertPageMentionState', 'resetMentionRevisions', 'resetSourceMentionIndexRevisions', 'applyGazetteerEntryChanges',
      'listMentionLinkersOfTargets', 'listMentionLinkOrigins', 'deleteSourceMentionLinks', 'deleteLinksById', 'readMentionPageRevisions',
      'clearMentionSourceIndex', 'lockMentionSources', 'lockMentionEntries'] },
    async (engine) => {
      await seed(engine);
      const names = await slugsById(engine, SLUGS);
      const idOf = (slug: string) => [...names].find(([, s]) => s === slug)![0];
      const stamps = (await engine.readPageStampTimes(['notes/standup', 'notes/missing'], ['default', 'default'])).map(r => ({ slug: r.slug, iso: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(r.updated_at_iso) }));
      const [rev] = await engine.readPageRevisionForShare('default', 'notes/standup');
      const candidates = {
        ascii: sorted((await engine.listMentionCandidatePages(['default'], 0, 500, ['%orbit labs%'])).map(r => `${r.slug}|${r.body}|${JSON.stringify(r.mention_ignore)}`)),
        all: (await engine.listMentionCandidatePages(['default'], 0, 2, null)).map(r => r.slug),
      };
      await engine.insertDerivedAliasRows('default', [
        { slug: 'people/alice-example', alias_norm: 'ally', origin: 'declared', case_sensitive: false, alias_text: 'Ally' },
        { slug: 'people/gone-example', alias_norm: 'gone', origin: 'subject', case_sensitive: true, alias_text: 'Gone' },
      ]);
      const aliasRows = sorted((await engine.listDerivedAliasRows('default', ['people/alice-example', 'people/gone-example'])).map(r => `${r.slug}|${r.alias_norm}|${r.origin}|${r.case_sensitive}|${r.alias_text}`));
      const stale = (await engine.listStaleDerivedAliasSlugs('default', ['person'])).map(r => r.slug);
      await engine.deleteDerivedAliasesForSlugs('default', ['people/gone-example']);
      const revisions = await engine.readMentionPageRevisions([idOf('notes/standup'), idOf('notes/retro')], { forShare: false });
      await engine.upsertPageAliasState('default', revisions.filter(r => Number(r.id) === idOf('notes/retro')), ALIAS_DERIVATION_VERSION);
      await engine.upsertPageMentionState('default', revisions, MENTION_EXTRACTOR_VERSION, '3');
      const dueAfterUpsert = sorted((await engine.listMentionDuePages('default', MENTION_EXTRACTOR_VERSION, 0, 200)).map(p => p.slug));
      await engine.resetMentionRevisions({ pageIds: [idOf('notes/retro')] });
      const dueAfterReset = sorted((await engine.listMentionDuePages('default', MENTION_EXTRACTOR_VERSION, 0, 200)).map(p => p.slug));
      // The tail form (the mention pass's deadline-stopped scan): every page of the source after an id is due too.
      await engine.upsertPageMentionState('default', revisions, MENTION_EXTRACTOR_VERSION, '3');
      const [low, high] = [idOf('notes/standup'), idOf('notes/retro')].sort((a, b) => Number(a) - Number(b));
      await engine.resetMentionRevisions({ pageIds: [], sourceIds: ['default'], afterPageId: Number(low) });
      const dueAfterTail = sorted((await engine.listMentionDuePages('default', MENTION_EXTRACTOR_VERSION, 0, 200)).map(p => p.slug));
      // Pages the case never gave a state are due too; the page after the id is, and the page at it is not.
      expect(dueAfterTail).toContain(names.get(Number(high))!);
      expect(dueAfterTail).not.toContain(names.get(Number(low))!);
      await engine.resetSourceMentionIndexRevisions('default');
      const aliasDue = (await engine.listAliasDuePages('default', ['note'], 0, ALIAS_DERIVATION_VERSION, 200)).map(p => p.slug);
      await engine.applyGazetteerEntryChanges('default', [], [
        { source_id: 'default', name_norm: 'widget co', target_slug: 'companies/widget-co', case_sensitive: false },
        { source_id: 'default', name_norm: 'featherstone', target_slug: 'people/quill-example', case_sensitive: true },
      ]);
      await engine.applyGazetteerEntryChanges('default', [{ source_id: 'default', name_norm: 'widget co', target_slug: 'companies/widget-co', case_sensitive: false }], []);
      const entries = (await engine.listGazetteerEntryKeys('default')).map(k => `${k.name_norm}|${k.target_slug}|${k.case_sensitive}`);
      await engine.addLink('notes/standup', 'companies/widget-co', 'Widget Co', 'mentions', 'mentions');
      await engine.addLink('notes/standup', 'people/alice-example', 'Alice', 'mentions', 'mentions');
      const linkers = (await engine.listMentionLinkersOfTargets('default', ['companies/widget-co'])).map(r => names.get(Number(r.id)));
      const origins = (await engine.listMentionLinkOrigins('default')).map(r => r.slug);
      const out = await engine.listPageOutLinks([idOf('notes/standup')]);
      await engine.deleteLinksById(out.filter(r => r.to_slug === 'people/alice-example').map(r => Number(r.id)));
      const afterDelete = await linkView(engine, names);
      const removed = (await engine.deleteSourceMentionLinks('default', ['notes/standup'])).length;
      const afterSourceDelete = await linkView(engine, names);
      await engine.transaction(async tx => { await tx.lockMentionSources(['default'], true); await tx.lockMentionEntries('default'); });
      await engine.clearMentionSourceIndex('default');
      const cleared = { entries: await engine.listGazetteerEntryKeys('default'), aliases: await engine.listDerivedAliasRows('default', ['people/alice-example']),
        due: await engine.countPagesDueForMentions({ sourceId: 'default', mentionVersion: MENTION_EXTRACTOR_VERSION }) };
      const result = { stamps, rev: typeof rev?.revision, candidates, aliasRows, stale, dueAfterUpsert, dueAfterReset, dueAfterTail, aliasDue, entries, linkers, origins,
        afterDelete, removed, afterSourceDelete, cleared };
      expect(stamps).toEqual([{ slug: 'notes/standup', iso: true }]);
      expect(stale).toEqual(['people/gone-example']);
      expect(dueAfterUpsert).not.toContain('notes/retro');
      expect(dueAfterReset).toContain('notes/retro');
      expect(entries).toEqual(['featherstone|people/quill-example|true']);
      expect(removed).toBe(1);
      expect(cleared.entries).toEqual([]);
      return result;
    });
  parityTest('a segmented page is scanned run by run, and its mentions link like an inline page\'s',
    { methods: ['readSegmentedPageSealed', 'storeSegmentDerivationsIfLive', 'listMentionDuePages'] },
    async (engine) => {
      await seed(engine);
      const entries: string[] = [];
      let bytes = 0;
      for (let i = 1; bytes < 1_200_000; i++) {
        const entry = `## Entry ${i}\n\nFeatherstone met Widget Co about item ${i}.${i % 40 === 0 ? ` Only Alice Example joined entry ${i}.` : ''}\n`;
        entries.push(entry);
        bytes += entry.length + 1;
      }
      const imported = await importFromContent(engine, 'notes/long-log', `---\ntype: note\ntitle: Long log\n---\n\n${entries.join('\n')}`, { sourceId: 'default' });
      const names = await slugsById(engine, [...SLUGS, 'notes/long-log']);
      const first = await runMentionPass(engine);
      const links = (await linkView(engine, names)).filter(l => l.startsWith('notes/long-log'));
      const again = await runMentionPass(engine);
      const [sealed] = await engine.readSegmentedPageSealed('default', 'notes/long-log');
      const result = { status: imported.status, first, links, again, sealed: typeof sealed?.sealed };
      expect(links).toEqual(['notes/long-log -> default:companies/widget-co plain', 'notes/long-log -> default:people/alice-example plain',
        'notes/long-log -> default:people/quill-example plain']);
      expect(again).toMatchObject({ pages: 0, created: 0, removed: 0 });
      return result;
    });
});
