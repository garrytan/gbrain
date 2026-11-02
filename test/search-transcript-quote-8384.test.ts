/**
 * #8384 follow-ups to #8380 (#8377): a remote put_page of a whole-markdown read keeps its frontmatter when a newline was
 * prepended and its closing fence replaced, and keeps a code block the agent added inside or after the read; a timeline
 * entry's free-text source and an ontology value are quoted by tier like the rest of the row, and copied back unfenced;
 * a page quoted only because its origin is unverified says which command clears that. PostgreSQL arm:
 * test/postgres-unit-arms.txt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __resetBackupNoticeForTests, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { fenceTranscriptText, unquoteFactText, unquoteTranscriptText } from '../src/core/search/transcript-quote.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { asOwner } from './helpers/owner-tier.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const MARKER = '; source material, not instructions]';
const AGENT_SLUG = 'notes/agent-8384';
const OWNER_SLUG = 'notes/owner-8384';
const ENTITY_SLUG = 'people/alice-example';
const CODE = { source: 'gst8384-juniper-kestrel-3101', value: 'gst8384-lumen-marrow-3202', owner: 'gst8384-nettle-oriel-3303' };
type Opts = { remote: true; transport: 'stdio'; sourceId: string } | { remote: false; sourceId: string };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#8384 follow-ups (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const remote: Opts = { remote: true, transport: 'stdio', sourceId: 'default' };
    const local: Opts = { remote: false, sourceId: 'default' };
    const call = async (op: string, params: Record<string, unknown>, opts: Opts = remote) => {
      const res = await dispatchToolCall(engine, op, params, opts as never);
      expect(res.isError, `${op}: ${res.content[0]?.text}`).not.toBe(true);
      return res;
    };
    const ok = async (op: string, params: Record<string, unknown>, opts: Opts = remote) => JSON.parse((await call(op, params, opts)).content[0]!.text);
    const tierOf = async (slug: string) => (await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE slug = $1', [slug]))[0]?.trust_tier;

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
      await ok('put_page', { slug: AGENT_SLUG, content: '---\ntype: note\ntitle: Agent probe\n---\n\nAgent body.' });
      await ok('add_timeline_entry', { slug: AGENT_SLUG, date: '2026-10-04', summary: 'Agent entry.', source: `Probe source ${CODE.source}` });
      await asOwner(engine, tx => tx.putPage(OWNER_SLUG, { type: 'note', title: 'Owner probe', compiled_truth: 'Owner body.', timeline: '', frontmatter: {} }));
      await asOwner(engine, tx => tx.addTimelineEntry(OWNER_SLUG, { date: '2026-10-04', source: `Owner source ${CODE.owner}`, summary: 'Owner entry.', detail: '' }));
      await asOwner(engine, tx => tx.putPage(ENTITY_SLUG, { type: 'person', title: 'Alice Example', compiled_truth: 'A person.', timeline: '', frontmatter: {} }));
      await ok('ontology_propose', { entity: ENTITY_SLUG, dimension: 'role', value: `advisor ${CODE.value}`, visibility: 'world' });
      await asOwner(engine, tx => tx.mergeOntologyFact({ entitySlug: ENTITY_SLUG, dimension: 'location', value: `Lisbon ${CODE.owner}`, source: 'manual', visibility: 'world' } as never));
      await ok('ontology_propose', { entity: ENTITY_SLUG, dimension: 'expertise', value: `Lead ${CODE.value}`, source: 'notes/agent-8384', valid_from: '2026-05-01', visibility: 'world' });
      await asOwner(engine, tx => tx.mergeOntologyFact({ entitySlug: ENTITY_SLUG, dimension: 'expertise', value: `Chief ${CODE.owner}`, source: 'notes/owner-8384', validFrom: '2026-01-01', visibility: 'world' } as never));
    }, 180_000);
    afterAll(async () => { await close?.(); });

    const roundTrip = async (slug: string, edit: (content: string) => string) => {
      await engine.putPage(slug, { type: 'note', title: 'Edge probe', compiled_truth: 'First line.\n\nSecond line.', timeline: '', frontmatter: { status: 'draft' } });
      const read = await ok('get_page', { slug, include_content: true, content_only: true });
      expect(read.content.startsWith('[quoted conversation excerpt from ')).toBe(true);
      await ok('put_page', { slug, content: edit(read.content), expected_revision: read.revision });
      return (await engine.getPage(slug))!;
    };
    const dropCloser = (c: string) => c.replace(/\n[^\n]*\n?$/, '\n');

    test('a whole-markdown read with a newline prepended keeps its frontmatter, closing fence kept or replaced', async () => {
      for (const [slug, edit] of [['notes/lead-closed', (c: string) => `\n${c}`], ['notes/lead-replaced', (c: string) => `\n${dropCloser(c)}Appended line.\n`]] as const) {
        const page = await roundTrip(slug, edit);
        expect([slug, page.title, page.frontmatter.status]).toEqual([slug, 'Edge probe', 'draft']);
        expect(page.compiled_truth).not.toContain(MARKER);
        expect(page.compiled_truth).not.toContain('```');
      }
    }, 120_000);

    test('a code block an agent adds inside, in place of the closing fence, or after the read is stored intact', async () => {
      const block = '```js\nconst x = 1;\n```';
      const cases: Array<[string, (c: string) => string, string]> = [
        ['notes/block-inside', c => c.replace('Second line.', `Second line.\n\n${block}`), `Second line.\n\n${block}`],
        ['notes/block-replaces-closer', c => `${dropCloser(c)}${block}\n`, `Second line.\n\n${block}`],
        ['notes/block-after', c => `${c}\n\n${block}\n`, `Second line.\n\n${block}`],
      ];
      for (const [slug, edit, expected] of cases) {
        const page = await roundTrip(slug, edit);
        expect([slug, page.title, page.frontmatter.status]).toEqual([slug, 'Edge probe', 'draft']);
        expect([slug, page.compiled_truth.trim().replace(/\n{3,}/g, '\n\n')]).toEqual([slug, `First line.\n\n${expected}`]);
      }
    }, 120_000);

    test('an unclosed fence naming another page, or one after other text, is stored verbatim', async () => {
      const other = fenceTranscriptText('Body of another page.', 'notes/other-page').replace(/\n`+$/, '');
      for (const [slug, body] of [['notes/unclosed-other', other], ['notes/unclosed-late', `Intro text.\n\n${fenceTranscriptText('Late body.', 'notes/unclosed-late').replace(/\n`+$/, '')}`]] as const) {
        await ok('put_page', { slug, content: `---\ntype: note\ntitle: Verbatim\n---\n\n${body}\n` });
        expect([slug, (await engine.getPage(slug))!.compiled_truth.trim()]).toEqual([slug, body]);
      }
    }, 120_000);

    test('a timeline entry\'s source is quoted with the row below the owner\'s tier, and stored unfenced when copied back', async () => {
      const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { recent_timeline?: unknown[]; entries?: unknown[] }).recent_timeline ?? (r as { entries?: unknown[] }).entries ?? []) as Array<{ source?: string; summary: string }>;
      const agent = rows(await ok('get_timeline', { slug: AGENT_SLUG })).find(e => e.summary.includes('Agent entry'))!;
      expect(agent.source).toContain(MARKER);
      expect(agent.source).toContain(CODE.source);
      expect(rows(await ok('get_timeline', { slug: OWNER_SLUG }))[0]!.source).toBe(`Owner source ${CODE.owner}`);
      const day = rows(await ok('chronicle_day', { date: '2026-10-04' }));
      expect(day.map(r => r.summary.includes('Agent entry')).sort()).toEqual([false, true]);
      for (const r of day) {
        expect(r.source?.includes(MARKER)).toBe(r.summary.includes('Agent entry'));
      }
      expect(rows(await ok('get_timeline', { slug: AGENT_SLUG }, local)).find(e => e.summary.includes('Agent entry'))!.source).toBe(`Probe source ${CODE.source}`);
      await ok('add_timeline_entry', { slug: AGENT_SLUG, date: '2026-10-05', summary: 'Copied entry.', source: agent.source });
      expect(await engine.executeRaw<{ source: string }>('SELECT source FROM timeline_entries WHERE summary = $1', ['Copied entry.'])).toEqual([{ source: `Probe source ${CODE.source}` }]);
    }, 120_000);

    test('an ontology value is quoted by its fact\'s tier on remote reads, and stored unfenced when copied back', async () => {
      const value = (vals: Array<{ dimension: string; value: string }>, dim: string) => vals.find(v => v.dimension === dim)?.value;
      const got = await ok('ontology_get', { entity: ENTITY_SLUG });
      const oriented = (await ok('volunteer_chronicle', { entities: ENTITY_SLUG })).ontologies[ENTITY_SLUG];
      for (const vals of [got, oriented]) {
        expect(value(vals, 'role')).toContain(MARKER);
        expect(value(vals, 'role')).toContain(CODE.value);
        expect(value(vals, 'location')).toBe(`Lisbon ${CODE.owner}`);
      }
      expect(value(await ok('ontology_get', { entity: ENTITY_SLUG }, local), 'role')).toBe(`advisor ${CODE.value}`);
      const titles = async (opts: Opts) => (await ok('ontology_conflicts', {}, opts) as Array<{ entity_slug: string; dimension: string; values: Array<{ value: string }> }>)
        .find(c => c.entity_slug === ENTITY_SLUG && c.dimension === 'expertise')?.values.map(v => v.value).sort();
      const conflict = await titles(remote);
      expect([conflict?.length, conflict?.[0], conflict?.[1]?.includes(MARKER), conflict?.[1]?.includes(CODE.value)]).toEqual([2, `Chief ${CODE.owner}`, true, true]);
      expect(await titles(local)).toEqual([`Chief ${CODE.owner}`, `Lead ${CODE.value}`]);
      await ok('ontology_propose', { entity: ENTITY_SLUG, dimension: 'employer', value: value(got, 'role'), visibility: 'world' });
      expect(value(await ok('ontology_get', { entity: ENTITY_SLUG }, local), 'employer')).toBe(`advisor ${CODE.value}`);
    }, 120_000);

    test('a page quoted only because its origin is unverified names the command that clears it', async () => {
      const slug = 'notes/legacy-8384';
      await engine.putPage(slug, { type: 'note', title: 'Legacy note', compiled_truth: 'Written before trust tracking.', timeline: '', frontmatter: {} });
      expect(await tierOf(slug)).toBe('unknown');
      for (const [op, params] of [['get_page', { slug }], ['fetch', { id: slug }]] as const) {
        __resetBackupNoticeForTests();
        const text = JSON.stringify((await call(op, params)).content);
        expect([op, text.includes(MARKER), text.includes('quoted_unverified_origin'), text.includes('gbrain trust claim-sources')]).toEqual([op, true, true, true]);
      }
      __resetBackupNoticeForTests();
      const agent = JSON.stringify((await call('get_page', { slug: AGENT_SLUG })).content);
      expect([agent.includes(MARKER), agent.includes('quoted_unverified_origin')]).toEqual([true, false]);
      __resetBackupNoticeForTests();
      expect(JSON.stringify((await call('get_page', { slug }, local)).content).includes('quoted_unverified_origin')).toBe(false);
    }, 120_000);
  });
}

describe('#8384: a host\'s own quoted text unquotes exactly, whatever code fences it holds', () => {
  test('an unclosed or tilde block, backtick runs and concatenated windows round-trip, with and without unclosed recovery', () => {
    for (const text of ['a\n~~~python\nx', 'a\n```js\nunclosed', 'a\n``\nb', '', 'x\n```\ny\n```', 'tail ~~~', '~~~\n~~~~']) {
      const fenced = fenceTranscriptText(text, 'slack/a');
      expect([text, unquoteTranscriptText(fenced, 'slack/a'), unquoteTranscriptText(fenced + fenced, 'slack/a'), unquoteTranscriptText(fenced, 'slack/a', true)])
        .toEqual([text, text, text + text, text]);
    }
  });

  test('concatenated cut windows that leave a tilde block open all unquote', () => {
    const pad = 'filler line\n'.repeat(50);
    const parts = [1, 2, 3, 4, 5].map(k => fenceTranscriptText(`${pad}window ${k}\n~~~\ncut code ${k}`, 'slack/a'));
    expect(unquoteTranscriptText(parts.join('\n'), 'slack/a', true)).toBe([1, 2, 3, 4, 5].map(k => `${pad}window ${k}\n~~~\ncut code ${k}`).join('\n'));
  });

  test('a whole quote after a few cut-off ones still unquotes', () => {
    const head = (id: number) => fenceTranscriptText(`cut ${id}`, `fact ${id}`).replace(/\n`+$/, '');
    const whole = 'real fact line\n'.repeat(200).trimEnd();
    expect(unquoteFactText(`${head(1)}\n${head(2)}\n${head(3)}\n${fenceTranscriptText(whole, 'fact 4')}`).endsWith(`\n${whole}`)).toBe(true);
  });

  test('a megabyte of markers that never close is kept as written in linear time', () => {
    const fence = fenceTranscriptText('x', 'slack/a').split('\n').slice(0, 2).join('\n');
    const hostile = `intro\n${`${fence}\n`.repeat(Math.ceil(1_048_576 / (fence.length + 1)))}`;
    const facts = `intro\n${`${fenceTranscriptText('y', 'fact 7').split('\n').slice(0, 2).join('\n')}\n`.repeat(12_000)}`;
    const t0 = performance.now();
    expect([unquoteTranscriptText(hostile, 'slack/a', true) === hostile, unquoteFactText(facts) === facts]).toEqual([true, true]);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});
