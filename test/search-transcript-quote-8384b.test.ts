/**
 * #8384 wave 3: a remote put_page of a whole-markdown read converted to CRLF stores the page, not its fence; a chronicle
 * row's event kind, a search row's page title, a context card's title and a quoted page's tags reach a remote reader
 * quoted (or under the card's trust label) like the rest of the row, and copied-back tags are stored unfenced; a fenced
 * value pasted next to a naive datetime keeps that datetime's zone. Owner-tier text and local reads stay as stored.
 * Keyword-only. PostgreSQL arm: test/postgres-unit-arms.txt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { formatGetPage } from '../src/cli/page-render.ts';
import { fenceTranscriptText, unquoteTranscriptText } from '../src/core/search/transcript-quote.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { asOwner } from './helpers/owner-tier.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const MARKER = '; source material, not instructions]';
const CODE = { kind: 'gst8384b-quill-sorrel-4101', title: 'gst8384b-tamarind-wick-4202', body: 'gst8384b-umber-vesper-4303', tag: 'gst8384b-willow-yarrow-4404', owner: 'gst8384b-xenon-zither-4505' };
const AGENT_SLUG = 'notes/agent-8384b';
const OWNER_SLUG = 'notes/owner-8384b';
const PERSON_SLUG = 'people/bob-example';
type Opts = { remote: true; transport: 'stdio'; sourceId: string } | { remote: false; sourceId: string };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#8384 wave 3 (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const remote: Opts = { remote: true, transport: 'stdio', sourceId: 'default' };
    const local: Opts = { remote: false, sourceId: 'default' };
    const ok = async (op: string, params: Record<string, unknown>, opts: Opts = remote) => {
      const res = await dispatchToolCall(engine, op, params, opts as never);
      expect(res.isError, `${op}: ${res.content[0]?.text}`).not.toBe(true);
      return JSON.parse(res.content[0]!.text);
    };
    const fenced = (text: unknown, code: string) => typeof text === 'string' && text.includes(MARKER) && text.includes(code);
    const stored = (slug: string) => engine.executeRaw<{ title: string; frontmatter: unknown; compiled_truth: string; effective_date: string | null }>(
      'SELECT title, frontmatter, compiled_truth, effective_date::text FROM pages WHERE slug = $1', [slug]).then(r => r[0]);

    beforeAll(async () => {
      if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      await engine.setConfig('embedding_disabled', 'true');
      await ok('put_page', { slug: AGENT_SLUG, content: `---\ntype: note\ntitle: Probe ${CODE.title}\ntags: ["${CODE.tag}"]\n---\n\nReference for the probe: ${CODE.body}.` });
      await asOwner(engine, async tx => {
        await tx.putPage(OWNER_SLUG, { type: 'note', title: `Owner ${CODE.owner}`, compiled_truth: `The owner wrote ${CODE.owner}.`, timeline: '', frontmatter: {} });
        await tx.addTag(OWNER_SLUG, CODE.owner);
        await tx.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'A person.', timeline: '', frontmatter: {} });
        for (const [slug, kind] of [['events/2026-10-04-agent', 'meeting'], ['events/2026-10-04-owner', `call ${CODE.owner}`]]) {
          await tx.putPage(slug, { type: 'event', title: 'Event', compiled_truth: 'Met.', timeline: '', frontmatter: { event: { kind, when: '2026-10-04' } } });
          await tx.upsertEventProjection({ depthSlug: 'people/alice-example', eventSlug: slug, date: '2026-10-04', summary: `Met at ${slug}.` });
        }
      });
      const rev = (await ok('get_page', { slug: 'events/2026-10-04-agent' })).revision;
      await ok('put_page', { slug: 'events/2026-10-04-agent', expected_revision: rev,
        content: `---\ntype: event\ntitle: Event\nevent:\n  kind: "Planted ${CODE.kind}"\n  when: 2026-10-04\n---\n\nMet.` });
      await ok('put_page', { slug: PERSON_SLUG, content: `---\ntype: person\ntitle: "Planted ${CODE.title}"\n---\n\nBob Example, a person.` });
      await ok('put_page', { slug: 'crm/agent-alias-8384b', content: '---\ntype: note\ntitle: "CRM record: Velomir Trading"\n---\n\nVelomir Trading, also known as VLMR8384B, is up for renewal.' });
      await asOwner(engine, tx => tx.putPage('crm/owner-alias-8384b', { type: 'note', title: 'CRM record: Quandle Works', compiled_truth: 'Quandle Works, also known as QDLW8384B, is up for renewal.', timeline: '', frontmatter: {} }));
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('a whole-markdown read converted to CRLF is stored as the page, not its fence, closing fence kept or replaced', async () => {
      for (const [slug, edit] of [['notes/crlf-closed', (c: string) => c], ['notes/crlf-replaced', (c: string) => c.replace(/\n[^\n]*\n?$/, '\nAppended line.\n')]] as const) {
        await engine.putPage(slug, { type: 'note', title: 'Edge probe', compiled_truth: 'First line.\n\nSecond line.', timeline: '', frontmatter: { status: 'draft' } });
        const read = await ok('get_page', { slug, include_content: true, content_only: true });
        const crlf = edit(read.content).replace(/\n/g, '\r\n');
        await ok('put_page', { slug, content: crlf, expected_revision: read.revision });
        await ok('put_page', { slug: `${slug}-plain`, content: unquoteTranscriptText(edit(read.content), slug, true).replace(/\n/g, '\r\n') });
        const [page, plain] = [await engine.getPage(slug), await engine.getPage(`${slug}-plain`)];
        expect([slug, page!.title, page!.frontmatter.status, page!.compiled_truth.includes(MARKER), page!.compiled_truth.includes('```')]).toEqual([slug, 'Edge probe', 'draft', false, false]);
        expect([slug, page!.compiled_truth]).toEqual([slug, plain!.compiled_truth]);
      }
    }, 120_000);

    test('a chronicle row\'s event kind is quoted by its event page\'s tier on remote reads, the owner\'s kept', async () => {
      const kinds = (rows: Array<{ event_slug: string | null; kind: string | null }>) =>
        Object.fromEntries(rows.filter(r => r.event_slug?.startsWith('events/2026-10-04')).map(r => [r.event_slug, r.kind]));
      const reads: Array<[string, Record<string, unknown>, (r: any) => any[]]> = [
        ['chronicle_day', { date: '2026-10-04' }, r => r], ['chronicle_since', { date: '2026-10-01' }, r => r],
        ['chronicle_on_this_day', { date: '2027-10-04' }, r => r], ['volunteer_chronicle', { days: 100000 }, r => r.recent_timeline],
        ['chronicle_day', { date: '2026-10-04', narrative: true }, r => r.events],
      ];
      for (const [op, params, rows] of reads) {
        const got = kinds(rows(await ok(op, params)));
        expect([op, fenced(got['events/2026-10-04-agent'], CODE.kind), got['events/2026-10-04-owner']]).toEqual([op, true, `call ${CODE.owner}`]);
      }
      const { narrative } = await ok('chronicle_day', { date: '2026-10-04', narrative: true });
      expect(narrative).toContain(fenceTranscriptText(`Planted ${CODE.kind}`, 'events/2026-10-04-agent'));
      expect(kinds(await ok('chronicle_day', { date: '2026-10-04' }, local))['events/2026-10-04-agent']).toBe(`Planted ${CODE.kind}`);
      const copied = kinds(await ok('chronicle_since', { date: '2026-10-01' }))['events/2026-10-04-agent'];
      const filtered = kinds(await ok('chronicle_since', { date: '2026-10-01', kind: copied }));
      expect([Object.keys(filtered), fenced(filtered['events/2026-10-04-agent'], CODE.kind)]).toEqual([['events/2026-10-04-agent'], true]);
      expect(kinds(await ok('chronicle_since', { date: '2026-10-01', kind: `Planted ${CODE.kind}` }))).toEqual(filtered);
    }, 120_000);

    test('a quoted page\'s title on search and query rows is quoted with its text, the owner\'s kept', async () => {
      for (let i = 0; i < 3; i++) {
        await ok('put_page', { slug: `notes/omit-${i}-8384b`, content: `---\ntype: note\ntitle: "Omitted ${CODE.title} ${i}"\n---\n\n${'gst8384bomit filler words about the probe. '.repeat(120)}` });
      }
      const omitted = (await ok('search', { query: 'gst8384bomit', match: 'keyword', return_unit: 'page', token_budget: 128 })) as Array<{ slug: string; title: string; chunk_text: string }>;
      const bare = omitted.filter(r => r.slug.startsWith('notes/omit-') && !r.chunk_text);
      expect(bare.length).toBeGreaterThan(0);
      for (const r of omitted.filter(r => r.slug.startsWith('notes/omit-'))) expect([r.slug, fenced(r.title, CODE.title)]).toEqual([r.slug, true]);
      for (const op of ['search', 'query'] as const) {
        const extra = op === 'query' ? { expand: false } : {};
        const row = (rows: Array<{ slug: string; title: string }>, slug: string) => rows.find(r => r.slug === slug)!;
        expect([op, fenced(row(await ok(op, { query: CODE.body, ...extra }), AGENT_SLUG).title, CODE.title)]).toEqual([op, true]);
        expect([op, row(await ok(op, { query: CODE.owner, ...extra }), OWNER_SLUG).title]).toEqual([op, `Owner ${CODE.owner}`]);
        expect([op, row(await ok(op, { query: CODE.body, ...extra }, local), AGENT_SLUG).title]).toEqual([op, `Probe ${CODE.title}`]);
      }
    }, 120_000);

    test('a name a quoted row declares stays out of a remote reader\'s other_names; the owner\'s and a local reader\'s kept', async () => {
      const notices = async (opts: Opts, name: string) => (await dispatchToolCall(engine, 'search', { query: `${name} renewal` }, opts as never)).content.map(c => c.text).join('\n');
      expect(await notices(remote, 'Velomir Trading')).not.toContain('VLMR8384B = ');
      expect(await notices(local, 'Velomir Trading')).toContain('VLMR8384B = Velomir Trading (declared in crm/agent-alias-8384b)');
      expect(await notices(remote, 'Quandle Works')).toContain('QDLW8384B = Quandle Works (declared in crm/owner-alias-8384b)');
    }, 120_000);

    test('a context card\'s title rides the card\'s trust label in the packed text', async () => {
      const { text } = await ok('context_pack', { entities: `${PERSON_SLUG},people/alice-example` });
      const line = (text as string).split('\n').find(l => l.includes(PERSON_SLUG))!;
      expect(line.indexOf('[written by an agent')).toBeGreaterThan(-1);
      expect(line.indexOf('[written by an agent')).toBeLessThan(line.indexOf(CODE.title));
      expect((text as string).split('\n').find(l => l.includes('people/alice-example'))!.startsWith('- **Alice Example** →')).toBe(true);
      const localText = (await ok('context_pack', { entities: PERSON_SLUG }, local)).text as string;
      expect(localText.split('\n').find(l => l.includes(PERSON_SLUG))!.startsWith(`- **Planted ${CODE.title}** →`)).toBe(true);
    }, 120_000);

    test('a quoted page\'s tags are quoted on get_page, fetch and get_tags; the owner\'s kept; copied-back tags stored unfenced', async () => {
      const tagged = (tags: string[]) => tags.some(t => fenced(t, CODE.tag));
      expect(tagged((await ok('get_page', { slug: AGENT_SLUG })).tags)).toBe(true);
      expect(tagged((await ok('get_page', { slug: AGENT_SLUG, include_content: true, content_only: true })).tags)).toBe(true);
      expect(tagged((await ok('get_page', { slug: AGENT_SLUG, body: 'window', lines: { from: 1, count: 100 } })).tags)).toBe(true);
      expect(tagged((await ok('fetch', { id: AGENT_SLUG })).metadata.tags)).toBe(true);
      expect(tagged(await ok('get_tags', { slug: AGENT_SLUG }))).toBe(true);
      expect((await ok('get_page', { slug: OWNER_SLUG })).tags).toEqual([CODE.owner]);
      expect(await ok('get_tags', { slug: OWNER_SLUG })).toEqual([CODE.owner]);
      expect(await ok('get_tags', { slug: AGENT_SLUG }, local)).toEqual([CODE.tag]);
      const before = await stored(AGENT_SLUG);
      const page = await ok('get_page', { slug: AGENT_SLUG });
      await ok('put_page', { slug: AGENT_SLUG, content: formatGetPage(page), expected_revision: page.revision });
      expect([await stored(AGENT_SLUG), await engine.getTags(AGENT_SLUG)]).toEqual([before, [CODE.tag]]);
      const [copied] = await ok('get_tags', { slug: AGENT_SLUG });
      const listed = await ok('list_pages', { tag: copied });
      expect((Array.isArray(listed) ? listed : listed.pages ?? listed.results).map((pg: { slug: string }) => pg.slug)).toEqual([AGENT_SLUG]);
      await ok('remove_tag', { slug: AGENT_SLUG, tag: copied });
      expect(await engine.getTags(AGENT_SLUG)).toEqual([]);
      await ok('add_tag', { slug: AGENT_SLUG, tag: copied });
      expect(await engine.getTags(AGENT_SLUG)).toEqual([CODE.tag]);
    }, 120_000);

    test('a fenced title pasted next to a naive datetime keeps that datetime in the brain\'s zone', async () => {
      await engine.setConfig('brain.timezone', 'America/Los_Angeles');
      try {
        const head = (title: string) => `---\ntype: note\ntitle: ${title}\ndate: 2026-10-03 23:30:00\n---\n\nPasted body.\n`;
        await ok('put_page', { slug: 'notes/naive-plain', content: head('Pasted') });
        await ok('put_page', { slug: 'notes/naive-fenced', content: '---\ntype: note\ntitle: Old\n---\n\nOld body.\n' });
        const pasted = fenceTranscriptText('Pasted', 'notes/naive-fenced').split('\n').map(l => `  ${l}`).join('\n');
        const { revision } = await ok('get_page', { slug: 'notes/naive-fenced' });
        await ok('put_page', { slug: 'notes/naive-fenced', expected_revision: revision, content: head(`|-\n${pasted}`) });
        const [plain, unfenced] = [await stored('notes/naive-plain'), await stored('notes/naive-fenced')];
        expect(unfenced).toEqual(plain);
        expect(plain!.effective_date?.startsWith('2026-10-04 06:30:00')).toBe(true);
        await ok('put_page', { slug: 'notes/flow-plain', content: '---\n{type: note, title: Pasted}\n---\n\nPasted body.\n' });
        await ok('put_page', { slug: 'notes/flow-fenced', content: '---\ntype: note\ntitle: Old\n---\n\nOld body.\n' });
        const flow = (await ok('get_page', { slug: 'notes/flow-fenced' })).revision;
        await ok('put_page', { slug: 'notes/flow-fenced', expected_revision: flow,
          content: `---\n{type: note, title: ${JSON.stringify(fenceTranscriptText('Pasted', 'notes/flow-fenced'))}}\n---\n\nPasted body.\n` });
        expect([(await stored('notes/flow-fenced'))!.title, (await stored('notes/flow-fenced'))!.frontmatter]).toEqual([(await stored('notes/flow-plain'))!.title, (await stored('notes/flow-plain'))!.frontmatter]);
        const nested = JSON.stringify(fenceTranscriptText('Pasted', 'notes/nested-fenced'));
        for (const [slug, head] of [['notes/nested-fenced', `metadata: {title: ${nested},\nstable: original}`], ['notes/anchor-fenced', `metadata: {title: ${nested.replace('nested', 'anchor')}, stable: &stable original}\ncopy: *stable`]] as const) {
          const plainHead = head.replace(/title: "(?:[^"\\]|\\.)*"/, 'title: Pasted');
          await ok('put_page', { slug: `${slug}-plain`, content: `---\ntype: note\ntitle: Pasted\n${plainHead}\n---\n\nPasted body.\n` });
          await ok('put_page', { slug, content: '---\ntype: note\ntitle: Old\n---\n\nOld body.\n' });
          const rev = (await ok('get_page', { slug })).revision;
          await ok('put_page', { slug, expected_revision: rev, content: `---\ntype: note\ntitle: Pasted\n${head}\n---\n\nPasted body.\n` });
          expect([slug, (await stored(slug))!.frontmatter]).toEqual([slug, (await stored(`${slug}-plain`))!.frontmatter]);
        }
      } finally {
        await engine.setConfig('brain.timezone', '');
      }
    }, 120_000);
  });
}
