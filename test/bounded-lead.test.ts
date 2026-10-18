/**
 * Large pages (Wave A, T28): leads, snippets and synopses read a bounded,
 * withdrawal-overlaid prefix and sanitize only that prefix.
 *
 * 1. Protects: the helpers that show a short lead (exact-slug and alias
 *    snippets, relational synopses, the reflex pointer synopsis, entity-name
 *    leads, think anchor rows) never sanitize or transfer a whole multi-MB
 *    body to show 160-240 characters, never show private text a protected
 *    fence cut at the 64 KiB boundary would expose, and never show a
 *    withdrawn world fact; for a page under 64 KiB their output is
 *    byte-identical to the whole-body formula they replaced.
 * 2. Fails when: a helper sanitizes or selects the whole body again, the cut
 *    exposes an open fence, the overlay is skipped for a prefix that holds a
 *    facts fence, or the small-page output drifts.
 * 3. No new seam: the real helpers over PGLite.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import { stripTakesFence } from '../src/core/takes-fence.ts';
import { stripFactsFence } from '../src/core/facts-fence.ts';
import { redactFindings } from '../src/core/secret-scan.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { BOUNDED_PREFIX_BYTES } from '../src/core/page-window/document.ts';
import { boundedBodyPrefixSql, boundedRawPrefix, overlaidBoundedRows, prefixNeedsOverlay, projectedLead } from '../src/core/page-window/bounded-lead.ts';
import { structuralExactLookup } from '../src/core/search/exact-lookup.ts';
import { applyAliasHop } from '../src/core/search/alias-hop.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { resolveEntitiesToPointers, safeSynopsis } from '../src/core/context/retrieval-reflex.ts';
import { extractCandidates } from '../src/core/context/entity-salience.ts';
import { lookupEntityNames, pageLead } from '../src/core/verbs/entity-names.ts';
import { runGather } from '../src/core/think/gather.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { cpuMs } from './helpers/cpu-time.ts';

const SENTINEL = 'PRIVATE-TAKE-SENTINEL';
const FACTS = renderFactsTable([
  { rowNum: 1, claim: 'Shared world claim about acme-example', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  { rowNum: 2, claim: 'Hidden private claim about acme-example', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
] as never);
const TAKES = `${TAKES_FENCE_BEGIN}\n| # | claim | kind | who |\n|---|---|---|---|\n| 1 | a private hunch | hunch | brain |\n${TAKES_FENCE_END}`;
/** A representative small page: prose, a facts fence with a private row, a takes fence. */
const small = (name: string) => `${name} leads product at acme-example. She joined in 2024 and runs the platform team.\n\n${FACTS}\n\n${TAKES}\n\nClosing prose.`;
/** A ~2 MB page whose takes fence opens before the 64 KiB cut and closes after it. */
function bigTakes(name: string): string {
  const rows: string[] = [];
  for (let i = 0, size = 0; size < 2 * 1024 * 1024; i++) { const row = `| ${i + 1} | ${SENTINEL} hunch number ${i} | hunch | brain |`; rows.push(row); size += row.length + 1; }
  return `${name} runs research at acme-example.\n\n${TAKES_FENCE_BEGIN}\n| # | claim | kind | who |\n|---|---|---|---|\n${rows.join('\n')}\n${TAKES_FENCE_END}\n\nAfter the fence.`;
}
/** A ~4 MB page that is expensive to sanitize whole (protected fences throughout, under the withdrawal marker limit; no facts fence in the 64 KiB prefix, so no overlay read). */
function fourMb(name: string): string {
  let body = `${name} chairs the board at acme-example.\n\n`;
  for (let i = 0; body.length < 4 * 1024 * 1024; i++) body += `Paragraph text.\n\n${i % 4 === 0 && body.length > 2 * BOUNDED_PREFIX_BYTES ? FACTS : TAKES}\n\n`;
  return body;
}
const WITHDRAWN = `Dana Example advises acme-example.\n\n${renderFactsTable([
  { rowNum: 1, claim: 'Withdrawn world claim', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  { rowNum: 2, claim: 'Kept world claim', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
] as never)}\n\nMore prose.`;

/** The whole-body formulas these helpers used before the bounded prefix. */
const oldSnippet = (body: string, n: number) => sanitizeRemoteBody(body).slice(0, n);
function oldSafeSynopsis(body: string): string {
  const stripped = redactFindings(stripFactsFence(stripTakesFence(body), { keepVisibility: ['world'] }), { highEntropy: true }).text;
  const first = stripped.replace(/^---[\s\S]*?---\s*/m, '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('<!--'));
  if (!first) return '';
  const s = first.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 159).trimEnd() + '…' : s;
}
function oldPageLead(body: string): string {
  const text = redactFindings(sanitizeRemoteBody(body), { highEntropy: true }).text.replace(/^---[\s\S]*?---\s*/m, '')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('<!--') && !l.startsWith('|')).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
}

/** Best of three runs, in ms. */
function bestMs(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t); }
  return best;
}

/** Best of three runs, in ms of process CPU time: it measures the work rather than how long the scheduler made it wait. */
function bestCpuMs(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) best = Math.min(best, cpuMs(fn));
  return best;
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: small('Alice Example') });
  await engine.setPageAliases('people/alice-example', 'default', [normalizeAlias('ali exemplar')]);
  await engine.putPage('people/carol-example', { type: 'person', title: 'Carol Example', compiled_truth: bigTakes('Carol Example') });
  await engine.setPageAliases('people/carol-example', 'default', [normalizeAlias('caro exemplar')]);
  await engine.putPage('people/dana-example', { type: 'person', title: 'Dana Example', compiled_truth: WITHDRAWN });
  await engine.executeRaw(
    "INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash) VALUES ('default', 'world', 'people/dana-example', gbrain_fact_fingerprint($1))",
    ['Withdrawn world claim']);
  await engine.putPage('people/erin-example', { type: 'person', title: 'Erin Example', compiled_truth: fourMb('Erin Example') });
  await engine.putPage('companies/widget-co', { type: 'company', title: 'Widget Co', compiled_truth: 'A payments company.' });
  for (const slug of ['people/alice-example', 'people/carol-example', 'people/erin-example']) {
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: `${slug} chunk` }]);
    await engine.addLink(slug, 'companies/widget-co', '', 'invested_in', 'manual');
  }
}, 180_000);
afterAll(async () => { await engine.disconnect(); });

const pageBody = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;

describe('bounded-lead building blocks', () => {
  test('boundedRawPrefix cuts on a code point within the byte budget; boundedBodyPrefixSql bounds the column or its lead', () => {
    const body = 'é'.repeat(BOUNDED_PREFIX_BYTES);
    const prefix = boundedRawPrefix(body);
    expect(Buffer.byteLength(prefix, 'utf8')).toBeLessThanOrEqual(BOUNDED_PREFIX_BYTES);
    expect(prefix).toBe('é'.repeat(prefix.length));
    expect(boundedRawPrefix('short')).toBe('short');
    expect(boundedBodyPrefixSql('p')).toBe(`left(coalesce(p.compiled_truth, p.truth_lead), ${BOUNDED_PREFIX_BYTES})`);
    expect(prefixNeedsOverlay('x <!--- gbrain:facts:begin -->')).toBe(true);
    expect(prefixNeedsOverlay(small('x').replace(FACTS, ''))).toBe(false);
  });

  test('a prefix with a facts fence is replaced by the overlaid prefix; one without is never re-read', async () => {
    const spy = spyOn(engine, 'readPageSnapshotsBatch');
    try {
      const noFence = 'plain prose '.repeat(10_000) + FACTS;
      const [plain] = await overlaidBoundedRows(engine, [{ slug: 'people/erin-example', source_id: 'default', compiled_truth: noFence }]);
      expect(spy).not.toHaveBeenCalled();
      expect(plain.compiled_truth).toBe(boundedRawPrefix(noFence));
      const lead = await projectedLead(engine, { slug: 'people/dana-example', source_id: 'default', compiled_truth: WITHDRAWN });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(lead).toContain('Kept world claim');
      expect(lead).not.toContain('Withdrawn world claim');
    } finally { spy.mockRestore(); }
  });

  test('a page the snapshot read no longer returns gets an empty lead (fail closed)', async () => {
    const [row] = await overlaidBoundedRows(engine, [{ slug: 'people/gone-example', source_id: 'default', compiled_truth: WITHDRAWN }]);
    expect(row.compiled_truth).toBe('');
  });
});

describe('small pages: output is byte-identical to the whole-body formula', () => {
  test('exact-slug and alias snippets', async () => {
    const body = await pageBody('people/alice-example');
    const [exact] = await structuralExactLookup(engine, 'people/alice-example', { sourceId: 'default' });
    expect(exact.chunk_text).toBe(oldSnippet(body, 200));
    const [alias] = await applyAliasHop(engine, [], 'ali exemplar', { sourceId: 'default' });
    expect(alias.slug).toBe('people/alice-example');
    expect(alias.chunk_text).toBe(oldSnippet(body, 200));
  });

  test('relational synopsis', async () => {
    const rows = await buildRelationalArm(engine, 'who invested in widget-co');
    const alice = rows.find(r => r.slug === 'people/alice-example');
    expect(alice?.chunk_text).toBe(oldSnippet(await pageBody('people/alice-example'), 240));
  });

  test('reflex synopsis, safeSynopsis and pageLead', async () => {
    const body = await pageBody('people/alice-example');
    const block = await resolveEntitiesToPointers(engine, 'default', extractCandidates('what do you think about Alice Example?'), {});
    expect(block?.pointers.find(p => p.slug === 'people/alice-example')?.synopsis).toBe(oldSafeSynopsis(body));
    expect(pageLead(body)).toBe(oldPageLead(body));
    const { results } = await lookupEntityNames(engine, 'default', ['Alice Example'], { remote: true });
    expect(results[0]).toMatchObject({ found: true, lead: oldPageLead(body) });
  });

  test('think anchor row (remote)', async () => {
    const r = await runGather(engine, { question: 'zzz-unrelated-nonsense-query-xqj', anchor: 'people/alice-example' });
    expect(r.pages.find(p => p.slug === 'people/alice-example')?.chunk_text).toBe(sanitizeRemoteBody(await pageBody('people/alice-example')));
  });
});

describe('a 2 MB page whose takes fence crosses the 64 KiB cut shows no private bytes', () => {
  const clean = (text: string | undefined) => {
    expect(text).toBeDefined();
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('gbrain:takes');
  };

  test('every helper', async () => {
    clean((await structuralExactLookup(engine, 'people/carol-example', { sourceId: 'default', excludePrivate: true }))[0]?.chunk_text);
    clean((await applyAliasHop(engine, [], 'caro exemplar', { sourceId: 'default', excludePrivate: true }))[0]?.chunk_text);
    clean((await buildRelationalArm(engine, 'who invested in widget-co', { excludePrivate: true })).find(r => r.slug === 'people/carol-example')?.chunk_text);
    const block = await resolveEntitiesToPointers(engine, 'default', extractCandidates('what do you think about Carol Example?'), {});
    clean(block?.pointers.find(p => p.slug === 'people/carol-example')?.synopsis);
    const { results } = await lookupEntityNames(engine, 'default', ['Carol Example'], { remote: true });
    clean((results[0] as { lead?: string }).lead);
    const r = await runGather(engine, { question: 'zzz-unrelated-nonsense-query-xqj', anchor: 'people/carol-example' });
    const anchor = r.pages.find(p => p.slug === 'people/carol-example');
    clean(anchor?.chunk_text);
    expect(anchor!.chunk_text).toContain('Carol Example runs research');
    expect(Buffer.byteLength(anchor!.chunk_text, 'utf8')).toBeLessThanOrEqual(BOUNDED_PREFIX_BYTES);
  }, 60_000);
});

describe('a withdrawn world fact in the prefix is not shown', () => {
  test('think anchor row (remote) reads the overlaid prefix', async () => {
    const r = await runGather(engine, { question: 'zzz-unrelated-nonsense-query-xqj', anchor: 'people/dana-example' });
    const text = r.pages.find(p => p.slug === 'people/dana-example')?.chunk_text ?? '';
    expect(text).toContain('Kept world claim');
    expect(text).not.toContain('Withdrawn world claim');
  });
});

describe('bounded work on a 4 MB page', () => {
  test('fan-out SQL transfers at most the bounded prefix and the lead stays short', async () => {
    const seen: number[] = [];
    const original = engine.executeRaw.bind(engine);
    const spy = spyOn(engine, 'executeRaw').mockImplementation((async (sql: string, params?: unknown[]) => {
      const rows = await original(sql, params);
      for (const row of rows as Array<Record<string, unknown>>) {
        for (const key of ['compiled_truth', 'synopsis']) if (typeof row?.[key] === 'string') seen.push((row[key] as string).length);
      }
      return rows;
    }) as never);
    try {
      const { results } = await lookupEntityNames(engine, 'default', ['Erin Example'], { remote: true });
      expect((results[0] as { lead: string }).lead.length).toBeLessThanOrEqual(200);
      const block = await resolveEntitiesToPointers(engine, 'default', extractCandidates('what do you think about Erin Example?'), {});
      expect(block?.pointers.find(p => p.slug === 'people/erin-example')?.synopsis.length).toBeLessThanOrEqual(160);
      const rel = await buildRelationalArm(engine, 'who invested in widget-co');
      expect(rel.find(r => r.slug === 'people/erin-example')?.chunk_text.length).toBeLessThanOrEqual(240);
    } finally { spy.mockRestore(); }
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(BOUNDED_PREFIX_BYTES);
  }, 60_000);

  test('the lead helpers cost a fraction of sanitizing the whole body', async () => {
    const body = await pageBody('people/erin-example');
    const row = { slug: 'people/erin-example', source_id: 'default', title: 'Erin Example', type: 'person', frontmatter: null, compiled_truth: body };
    const whole = bestMs(() => sanitizeRemoteBody(body));
    const wholeCpu = bestCpuMs(() => sanitizeRemoteBody(body));
    expect(bestCpuMs(() => safeSynopsis(row))).toBeLessThan(wholeCpu / 4);
    expect(bestCpuMs(() => pageLead(body))).toBeLessThan(wholeCpu / 4);
    expect(pageLead(body).length).toBeLessThanOrEqual(200);
    let lead = '';
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      lead = await projectedLead(engine, { slug: row.slug, source_id: 'default', compiled_truth: body });
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(whole / 4);
    expect(Buffer.byteLength(lead, 'utf8')).toBeLessThanOrEqual(BOUNDED_PREFIX_BYTES);
  }, 60_000);
});
