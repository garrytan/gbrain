/**
 * Follow-ups to GST-687 (#8377): the reads #8367 left raw (chronicle, takes, page title and frontmatter, the thin
 * client's paged read, the per-turn push hook) quote text below the owner's tier for an agent reader; quoted text an
 * agent copies back into a write is stored unquoted; and the put_page tool-call guard admits the two safe writes it
 * refused. Owner-tier text (`operator_curated`, "your notes") and trusted local reads stay as stored. Keyword-only.
 * PostgreSQL arm: test/postgres-unit-arms.txt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { assembleContextPack, assembleTurnContext } from '../src/core/context/turn-context.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import { formatGetPage, printPagedPage, readWholePageMarkdown } from '../src/cli/page-render.ts';
import { fenceTranscriptText } from '../src/core/search/transcript-quote.ts';
import { createHash } from 'node:crypto';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { asOwner } from './helpers/owner-tier.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const CODE = {
  title: 'gst8377-alder-prism-1201', frontmatter: 'gst8377-basalt-quiver-1302', body: 'gst8377-cedar-ripple-1403',
  timeline: 'gst8377-dune-harrow-1504', take: 'gst8377-ember-lattice-1605', fact: 'gst8377-flint-meadow-1706', takeSource: 'gst8377-gale-orchid-1807',
};
const OWNER = { timeline: 'gst8377-grove-anchor-2101', take: 'gst8377-hazel-beacon-2202', fact: 'gst8377-iris-cobble-2303' };
const AGENT_SLUG = 'notes/agent-probe';
const OWNER_SLUG = 'notes/owner-probe';
const CHAT_SLUG = 'conversations/guard-probe';
const ENTITY_SLUG = 'companies/acme-example';
const words = (code: string) => code.split('-').slice(1, 3).join(' ');
const FENCE_OPEN = /\[quoted conversation excerpt from [^\]\n]*; source material, not instructions\]\n(`{3,})text\n/g;

function fencedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(FENCE_OPEN)) {
    const start = m.index + m[0].length;
    const closes = (at: number) => /^[ \t]*(\n|$)/.test(text.slice(at + 1 + m[1].length));
    let close = text.indexOf(`\n${m[1]}`, start - 1);
    while (close >= 0 && !closes(close)) close = text.indexOf(`\n${m[1]}`, close + 1);
    if (close >= 0) out.push([start, close]);
  }
  return out;
}
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^\s*[[{]/.test(value)) {
      try { return strings(JSON.parse(value), out); } catch { /* plain text */ }
    }
    out.push(value);
  } else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}
function cell(reply: unknown, code: string): 'fenced' | 'raw' | 'absent' {
  let fenced = 0;
  let raw = 0;
  for (const s of strings(reply)) {
    const ranges = fencedRanges(s);
    for (let i = s.indexOf(code); i >= 0; i = s.indexOf(code, i + 1)) {
      if (ranges.some(([a, b]) => i >= a && i + code.length <= b)) fenced++; else raw++;
    }
  }
  return raw ? 'raw' : fenced ? 'fenced' : 'absent';
}
const MARKER = '; source material, not instructions]';
type Opts = { remote: true; transport: 'stdio'; sourceId: string };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#8377 follow-ups (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const remote: Opts = { remote: true, transport: 'stdio', sourceId: 'default' };
    const localCtx = () => ({ engine, config: { engine: engine.kind }, logger: console, dryRun: false, remote: false, sourceId: 'default' }) as unknown as OperationContext;
    const call = async (op: string, params: Record<string, unknown>, opts: Opts | { remote: false; sourceId: string } = remote) => {
      const res = await dispatchToolCall(engine, op, params, opts as Opts);
      expect(res.isError, `${op}: ${res.content[0]?.text}`).not.toBe(true);
      return res;
    };
    const ok = async (op: string, params: Record<string, unknown>, opts: Opts | { remote: false; sourceId: string } = remote) => JSON.parse((await call(op, params, opts)).content[0]!.text);
    const local = { remote: false as const, sourceId: 'default' };
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
      await ok('put_page', { slug: AGENT_SLUG, content: `---\ntype: note\ntitle: Probe ${CODE.title}\nsummary_line: Probe ${CODE.frontmatter}\n---\n\nReference for the probe: ${CODE.body}.` });
      await ok('add_timeline_entry', { slug: AGENT_SLUG, date: '2026-10-02', summary: `Probe entry ${CODE.timeline}.` });
      await ok('takes_add', { slug: AGENT_SLUG, claim: `Probe claim ${CODE.take}`, kind: 'take', holder: 'world', source: `Probe source ${CODE.takeSource}` });
      await ok('remember', { fact: `Probe fact about acme-example: ${CODE.fact}.`, entity: ENTITY_SLUG, provenance: 'follow-up probe' });
      await asOwner(engine, tx => tx.putPage(OWNER_SLUG, { type: 'note', title: 'Owner probe', compiled_truth: 'The owner wrote this.', timeline: '', frontmatter: {} }));
      await asOwner(engine, tx => tx.addTimelineEntry(OWNER_SLUG, { date: '2026-10-02', source: 'owner', summary: `Owner entry ${OWNER.timeline}.`, detail: '' }));
      await ok('takes_add', { slug: OWNER_SLUG, claim: `Owner claim ${OWNER.take}`, kind: 'take', holder: 'world' }, local);
      await engine.transaction(tx => withTrustPromotion(tx, 'operator_curated', () => tx.executeRaw("UPDATE takes SET trust_tier = 'operator_curated' WHERE claim LIKE $1", [`%${OWNER.take}%`])));
      await asOwner(engine, tx => tx.putPage(ENTITY_SLUG, { type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example is a company.', timeline: '', frontmatter: {} }));
      await asOwner(engine, tx => tx.insertFact({ fact: `The owner's acme-example codename is ${OWNER.fact}.`, source: 'cli:remember', visibility: 'world', embedding: null, entity_slug: ENTITY_SLUG } as never, { source_id: 'default' }));
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('fixtures: the probes are agent-written, the owner rows your notes', async () => {
      expect(await tierOf(AGENT_SLUG)).toBe('agent_written');
      expect(await tierOf(OWNER_SLUG)).toBe('operator_curated');
      const takes = await engine.executeRaw<{ claim: string; trust_tier: string }>('SELECT claim, trust_tier FROM takes');
      for (const t of takes) expect([t.claim, t.trust_tier]).toEqual([t.claim, t.claim.includes(OWNER.take) ? 'operator_curated' : 'agent_written']);
    });

    test('item 1: remote chronicle reads quote an agent-written timeline entry, not the owner\'s', async () => {
      const reads: Array<[string, Record<string, unknown>]> = [
        ['chronicle_day', { date: '2026-10-02' }], ['chronicle_day', { date: '2026-10-02', narrative: true }],
        ['chronicle_since', { date: '2026-10-01' }], ['chronicle_on_this_day', { date: '2027-10-02' }], ['volunteer_chronicle', { days: 100000 }],
      ];
      for (const [op, params] of reads) {
        const reply = await call(op, params);
        expect([op, JSON.stringify(params), cell(reply, CODE.timeline)]).toEqual([op, JSON.stringify(params), 'fenced']);
        expect([op, cell(reply, OWNER.timeline)]).toEqual([op, 'raw']);
      }
      expect(cell(await call('chronicle_day', { date: '2026-10-02' }, local), CODE.timeline)).toBe('raw');
    }, 120_000);

    test('item 2: remote takes_list and takes_search quote an agent-written claim, not the owner\'s', async () => {
      const list = await call('takes_list', {});
      expect(cell(list, CODE.take)).toBe('fenced');
      expect(cell(list, CODE.takeSource)).toBe('fenced');
      expect(cell(list, OWNER.take)).toBe('raw');
      expect(cell(await call('takes_search', { query: words(CODE.take) }), CODE.take)).toBe('fenced');
      expect(cell(await call('takes_list', {}, local), CODE.take)).toBe('raw');
      expect(cell(await call('takes_list', {}, local), CODE.takeSource)).toBe('raw');
    }, 120_000);

    test('item 3: remote get_page and fetch quote a quoted page\'s title and frontmatter; the round trip stores the page unchanged', async () => {
      const before = await engine.getPage(AGENT_SLUG);
      for (const params of [{ slug: AGENT_SLUG }, { slug: AGENT_SLUG, include_content: true }, { slug: AGENT_SLUG, include_content: true, content_only: true }]) {
        const page = await ok('get_page', params);
        expect([JSON.stringify(params), cell(page, CODE.title), cell(page, CODE.frontmatter), cell(page, CODE.body)]).toEqual([JSON.stringify(params), 'fenced', 'fenced', 'fenced']);
      }
      const fetched = await call('fetch', { id: AGENT_SLUG });
      expect([cell(fetched, CODE.title), cell(fetched, CODE.frontmatter)]).toEqual(['fenced', 'fenced']);
      const owner = await ok('get_page', { slug: OWNER_SLUG });
      expect(owner.title).toBe('Owner probe');
      const read = await ok('get_page', { slug: AGENT_SLUG, include_content: true, content_only: true });
      await ok('put_page', { slug: AGENT_SLUG, content: read.content, expected_revision: read.revision });
      const after = await engine.getPage(AGENT_SLUG);
      expect([after!.title, after!.compiled_truth, after!.frontmatter]).toEqual([before!.title, before!.compiled_truth, before!.frontmatter]);
      expect(cell(await ok('get_page', { slug: AGENT_SLUG }, local), CODE.title)).toBe('raw');
    }, 120_000);

    test('item 3: a thin client\'s get then put of a quoted page stores its title and frontmatter unfenced', async () => {
      const before = await engine.getPage(AGENT_SLUG);
      const page = await ok('get_page', { slug: AGENT_SLUG });
      const printed = formatGetPage(page);
      await ok('put_page', { slug: AGENT_SLUG, content: printed, expected_revision: page.revision });
      const after = await engine.getPage(AGENT_SLUG);
      expect([after!.title, after!.compiled_truth, after!.frontmatter]).toEqual([before!.title, before!.compiled_truth, before!.frontmatter]);
    }, 120_000);

    test('item 4: a reading shape of a chat page holding a call and a literal summary of it is refused as a write', async () => {
      const slug = 'conversations/guard-count';
      const call1 = JSON.stringify({ type: 'tool_use', id: 'toolu_c', name: 'search', input: { query: 'ledger' } });
      await ok('put_page', { slug, content: `---\ntype: conversation\ntitle: Guard count\n---\n\n**alice-example** (2026-10-01 9:00 AM): earlier [tool call: search, arguments omitted]\n\n**bob-example** (2026-10-01 9:02 AM): ${call1}\n` });
      const stored = await engine.getPage(slug);
      const fetched = await call('fetch', { id: slug });
      const text = JSON.parse(fetched.content[0]!.text).text as string;
      expect(text).not.toContain('"toolu_c"');
      const page = await ok('get_page', { slug, include_content: true, content_only: true });
      const res = await dispatchToolCall(engine, 'put_page', { slug, content: text, expected_revision: page.revision }, remote);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain('edit_page');
      expect((await engine.getPage(slug))!.compiled_truth).toBe(stored!.compiled_truth);
    }, 120_000);

    test('item 5: a page read at a low tier, then raised to the owner\'s, takes the read content back byte-exact', async () => {
      const slug = 'notes/claimed-later';
      await ok('put_page', { slug, content: '---\ntype: note\ntitle: Claimed later\n---\n\nWritten before the claim.' });
      const read = await ok('get_page', { slug, include_content: true, content_only: true });
      expect(read.quoted).toBe('transcript');
      const stored = await engine.getPage(slug);
      await engine.transaction(tx => withTrustPromotion(tx, 'operator_curated', () => tx.executeRaw("UPDATE pages SET trust_tier = 'operator_curated' WHERE slug = $1", [slug])));
      expect(await tierOf(slug)).toBe('operator_curated');
      await ok('put_page', { slug, content: read.content, expected_revision: (await ok('get_page', { slug, content_only: true, include_content: true })).revision });
      const after = await engine.getPage(slug);
      expect(after!.compiled_truth).toBe(stored!.compiled_truth);
      expect(after!.compiled_truth).not.toContain(MARKER);
    }, 120_000);

    test('item 8: quoted text copied back into remember and add_timeline_entry is stored unquoted, and the entry is not duplicated', async () => {
      const timeline = await ok('get_timeline', { slug: AGENT_SLUG });
      const entry = (timeline as Array<{ summary: string; date: string }>).find(e => e.summary.includes(CODE.timeline))!;
      expect(entry.summary).toContain(MARKER);
      await ok('add_timeline_entry', { slug: AGENT_SLUG, date: '2026-10-02', summary: entry.summary });
      const rows = await engine.executeRaw<{ summary: string }>('SELECT te.summary FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE p.slug = $1', [AGENT_SLUG]);
      expect(rows.length).toBe(1);
      expect(rows[0]!.summary).not.toContain(MARKER);

      const recall = await ok('recall', { entity: ENTITY_SLUG });
      const quoted = (recall.facts as Array<{ fact: string }>).find(f => f.fact.includes(CODE.fact))!;
      expect(quoted.fact).toContain(MARKER);
      await ok('remember', { fact: quoted.fact, entity: ENTITY_SLUG, provenance: 'copied back' });
      const facts = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE fact LIKE $1', [`%${CODE.fact}%`]);
      for (const f of facts) expect(f.fact).not.toContain(MARKER);
    }, 120_000);

    test('item 9: remote recall stays within an explicit token budget once facts and results are quoted', async () => {
      for (const budget of [40, 80, 160]) {
        const reply = await ok('recall', { query: 'probe', budget_tokens: budget });
        expect([budget, reply.budget_used <= budget]).toEqual([budget, true]);
      }
    }, 120_000);

    test('item 11: the per-turn push hook and the pushed context pack quote an agent-written fact and leave the owner\'s raw', async () => {
      const res = await assembleTurnContext(engine, { sourceId: 'default', window: [{ role: 'user', text: 'What is new with acme-example?' }] });
      expect(cell(res.text, CODE.fact)).toBe('fenced');
      expect(cell(res.text, OWNER.fact)).not.toBe('fenced');
      const pack = await makeContextPackIpcHandler(engine, 'default')({ kind: 'context_pack', protocol: 2, secret: 's', entities: [ENTITY_SLUG] } as never);
      expect(cell(pack?.text, CODE.fact)).toBe('fenced');
      expect(cell(pack?.text, OWNER.fact)).toBe('raw');
    }, 120_000);

    test('item 10: context_pack counts entity facts it withholds when quoting fails, instead of dropping them silently', async () => {
      const failing = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop === 'executeRaw') {
            return (sql: string, params?: unknown[]) => /FROM facts WHERE id = ANY\(\$1::bigint\[\]\) AND/.test(sql)
              ? Promise.reject(new Error('probe: quote lookup failed')) : target.executeRaw(sql, params as never);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as BrainEngine;
      const healthy = await assembleContextPack(engine, { sourceId: 'default', entities: [ENTITY_SLUG], untrusted: true });
      expect((healthy.entityFacts ?? []).length).toBeGreaterThan(0);
      const res = await assembleContextPack(failing, { sourceId: 'default', entities: [ENTITY_SLUG], untrusted: true });
      expect(res.entityFacts ?? []).toEqual([]);
      expect(res.suppressed?.withheld ?? 0).toBeGreaterThanOrEqual((healthy.entityFacts ?? []).length);
    }, 120_000);

    test('item 12: the tool-call guard admits a round trip of a call whose arguments hold a summary, and a new turn quoting one', async () => {
      const call1 = JSON.stringify({ type: 'tool_use', id: 'toolu_a', name: 'put_page', input: { content: 'note: [tool call: search, arguments omitted]' } });
      const content = `---\ntype: conversation\ntitle: Guard probe\n---\n\n**alice-example** (2026-10-01 9:00 AM): hello\n\n**bob-example** (2026-10-01 9:02 AM): ${call1}\n`;
      await ok('put_page', { slug: CHAT_SLUG, content });
      const stored = await engine.getPage(CHAT_SLUG);
      const read = await ok('get_page', { slug: CHAT_SLUG, include_content: true, content_only: true });
      await ok('put_page', { slug: CHAT_SLUG, content: read.content, expected_revision: read.revision });
      expect((await engine.getPage(CHAT_SLUG))!.compiled_truth).toBe(stored!.compiled_truth);
      const turn = `${read.content}\n**alice-example** (2026-10-01 9:05 AM): earlier you wrote [tool call: lookup, arguments omitted] there.\n`;
      await ok('put_page', { slug: CHAT_SLUG, content: turn, expected_revision: (await ok('get_page', { slug: CHAT_SLUG, content_only: true, include_content: true })).revision });
      expect((await engine.getPage(CHAT_SLUG))!.compiled_truth).toContain('[tool call: lookup, arguments omitted] there.');
      expect((await engine.getPage(CHAT_SLUG))!.compiled_truth).toContain('"name":"put_page"');
    }, 120_000);

    test('item 3: a whole-markdown round trip keeps a frontmatter value that quotes the page itself', async () => {
      const slug = 'notes/quote-example';
      const example = fenceTranscriptText('a quoted sample', slug);
      await engine.putPage(slug, { type: 'note', title: 'Quote example', compiled_truth: 'Body.', timeline: '', frontmatter: { example } });
      const read = await ok('get_page', { slug, include_content: true, content_only: true });
      expect(read.content).toContain(MARKER);
      await ok('put_page', { slug, content: read.content, expected_revision: read.revision });
      expect((await engine.getPage(slug))!.frontmatter.example).toBe(example);
    }, 120_000);

    test('item 3: a whole-markdown read edited past its closing fence (last line replaced, or text appended after it) is stored unfenced', async () => {
      for (const [slug, edit] of [['notes/tail-replaced', (c: string) => c.replace(/\n[^\n]*\n?$/, '\nAppended line.\n')], ['notes/tail-appended', (c: string) => `${c}\nAppended line.\n`]] as const) {
        await engine.putPage(slug, { type: 'note', title: 'Tail edit', compiled_truth: 'First line.\n\nSecond line.', timeline: '', frontmatter: { status: 'draft' } });
        const read = await ok('get_page', { slug, include_content: true, content_only: true });
        expect(read.content).toContain(MARKER);
        await ok('put_page', { slug, content: edit(read.content), expected_revision: read.revision });
        const page = await engine.getPage(slug);
        expect([page!.title, page!.frontmatter.status]).toEqual(['Tail edit', 'draft']);
        expect(page!.compiled_truth).not.toContain('quoted conversation excerpt');
        expect(page!.compiled_truth).not.toContain('```');
        expect(page!.compiled_truth).toMatch(/Second line\.\n+Appended line\.$/);
      }
    }, 120_000);

    test('item 3: a fenced title pasted into hand-written frontmatter is stored unfenced, every other value unchanged', async () => {
      const head = (title: string) => `---\ntype: note\ntitle: ${title}\nwhen: 2024-06-01\ncode: 0123\n---\n\nPasted body.\n`;
      for (const slug of ['notes/pasted-plain', 'notes/pasted-fenced']) await ok('put_page', { slug, content: head('Pasted') });
      const fenced = fenceTranscriptText('Pasted', 'notes/pasted-fenced').split('\n').map(l => `  ${l}`).join('\n');
      const { revision } = await ok('get_page', { slug: 'notes/pasted-fenced' });
      await ok('put_page', { slug: 'notes/pasted-fenced', expected_revision: revision, content: head(`|-\n${fenced}`) });
      const [plain, unfenced] = [await engine.getPage('notes/pasted-plain'), await engine.getPage('notes/pasted-fenced')];
      expect([unfenced!.title, unfenced!.frontmatter, unfenced!.compiled_truth]).toEqual([plain!.title, plain!.frontmatter, plain!.compiled_truth]);
    }, 120_000);

    test('item 3: a CRLF reading shape with a fenced last key keeps its frontmatter', async () => {
      const slug = 'notes/pasted-fenced';
      const fenced = fenceTranscriptText('Crlf title', slug).split('\n').map(l => `  ${l}`);
      const { revision } = await ok('get_page', { slug });
      await ok('put_page', { slug, expected_revision: revision, content: ['---', 'type: note', 'title: |-', ...fenced, '---', '', 'Body line one.'].join('\r\n') });
      const page = await engine.getPage(slug);
      expect([page!.type, page!.title, page!.compiled_truth.trim()]).toEqual(['note', 'Crlf title', 'Body line one.']);
    }, 120_000);

    test('item 3: an owner-tier page\'s frontmatter value that quotes the page itself survives a round trip', async () => {
      const slug = 'notes/owner-quote-example';
      const example = fenceTranscriptText('an owner sample', slug);
      await asOwner(engine, tx => tx.putPage(slug, { type: 'note', title: 'Owner quote example', compiled_truth: 'Owner body.', timeline: '', frontmatter: { example } }));
      const read = await ok('get_page', { slug, include_content: true, content_only: true });
      await ok('put_page', { slug, content: read.content, expected_revision: read.revision });
      expect((await engine.getPage(slug))!.frontmatter.example).toBe(example);
    }, 120_000);

    test('item 8: add_timeline_entry unquotes by the page slug however the caller cased it', async () => {
      const text = `Cased entry ${CODE.timeline}-cased`;
      await ok('add_timeline_entry', { slug: AGENT_SLUG.toUpperCase(), date: '2026-10-03', summary: fenceTranscriptText(text, AGENT_SLUG) });
      expect(await engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries WHERE summary LIKE $1', ['%-cased%'])).toEqual([{ summary: text }]);
    }, 120_000);

    test('item 2: a claim and source copied out of a quoted takes read are written unfenced', async () => {
      const take = (await ok('takes_list', { page_slug: AGENT_SLUG }) as Array<{ claim: string; source: string; row_num: number }>).find(t => t.claim.includes(CODE.take))!;
      expect([take.claim, take.source]).toEqual([expect.stringContaining(MARKER), expect.stringContaining(MARKER)]);
      const rows = () => engine.executeRaw<{ claim: string; source: string | null }>('SELECT t.claim, t.source FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 ORDER BY t.row_num', [AGENT_SLUG]);
      await ok('takes_update', { slug: AGENT_SLUG, row_num: take.row_num, source: take.source });
      expect((await rows())[0]!.source).toBe(`Probe source ${CODE.takeSource}`);
      await ok('takes_supersede', { slug: AGENT_SLUG, row_num: take.row_num, claim: take.claim });
      expect((await rows()).map(r => r.claim)).toEqual([`Probe claim ${CODE.take}`, `Probe claim ${CODE.take}`]);
    }, 120_000);
  });
}

describe('item 6: the thin client\'s paged read of a quoted page prints it inside the quote fence', () => {
  const slug = 'notes/large-agent-page';
  const window = (i: number) => `window ${i} of the agent page ${CODE.body}\n`.repeat(4);
  const total = [0, 1, 2].map(window).join('');
  const host = async (p: Record<string, unknown>) => {
    const i = p.cursor === undefined ? 0 : Number(p.cursor);
    return { slug, revision: 'rev-1', quoted: 'transcript', size: { total_bytes: Buffer.byteLength(total), sha256: createHash('sha256').update(total).digest('hex') },
      window: { byte_start: 0, text: fenceTranscriptText(window(i), slug) }, ...(i < 2 ? { next_cursor: String(i + 1) } : {}) };
  };
  test('printed text and --json content hold the page once, fenced', async () => {
    let out = '';
    await printPagedPage(host, { slug }, async text => { out += text; });
    expect(cell(out, CODE.body)).toBe('fenced');
    expect(out).toBe(fenceTranscriptText(total, slug));
    let json = '';
    await printPagedPage(host, { slug, json: true }, async text => { json += text; });
    expect(JSON.parse(json).content).toBe(fenceTranscriptText(total, slug));
    expect((await readWholePageMarkdown(host, { slug })).markdown).toBe(total);
  });

  test('a read through an alias prints the fence naming the page the host returned', async () => {
    let out = '';
    await printPagedPage(host, { slug: 'notes/old-name-alias' }, async text => { out += text; });
    expect(out).toBe(fenceTranscriptText(total, slug));
  });
  test('a text with a million backtick runs is fenced without overflowing the stack', () => {
    expect(fenceTranscriptText('`x'.repeat(1_000_000), slug).endsWith('\n```')).toBe(true);
  });
});
