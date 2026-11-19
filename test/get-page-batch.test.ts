/**
 * GBRA-650: get_page `slugs` reads several pages in one call.
 *
 * 1. Protects: a page a remote caller cannot read (missing, soft-deleted, private, kept to other members, in a source
 *    outside the grant, below the trust floor) gives a batch entry identical to a missing slug's, in request order, with
 *    the error the single read returns; a readable page in a batch carries what the single read carries (fields:
 *    "full"), its markers included; a lean entry keeps the body and every marker; limits (51 slugs, slug plus slugs,
 *    refused selectors, the token budget and its `omitted.next`, the egress cap, a first page larger than the budget);
 *    an all-missing batch is an MCP error, a partial one is not and opens with a summary; the local CLI reads with no
 *    budget and gets full pages.
 * 2. Fails when: a hidden page's entry, order, count, summary or omitted list differs from a missing page's; a batch
 *    page differs from the single read; a call past a limit is not refused; `omitted.next` makes no progress.
 * 3. Real seams: legacy tokens minted and bound by the member functions, verified by the OAuth provider, dispatched
 *    through MCP dispatch on a repo-less brain; embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { EGRESS_CAP_MIN } from '../src/core/egress-budget.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const DIMS = 1536;
const SRC = 'batch-team';
const OTHER = 'batch-other';
const OPEN = 'notes/open-plan';
const SECOND = 'notes/second-plan';
const RESTRICTED = 'people/vesper-example';
const PRIVATE = 'notes/quiet-plan';
const DELETED = 'notes/old-plan';
const ELSEWHERE = 'notes/elsewhere-plan';
const BIG = 'notes/big-plan';
const ESCAPED_A = 'notes/escaped-a';
const ESCAPED_B = 'notes/escaped-b';
const QUARANTINED = 'notes/junk-plan';
const AMENDMENT = 'notes/lease-amendment';
const AMENDMENT_B = 'notes/office-amendment';
const THIRD = 'notes/third-plan';
const MISSING = 'notes/never-written';
const note = (title: string, body: string, extra: string[] = []) => ['---', 'type: note', ...extra, 'title: ' + title, '---', '# ' + title, '', body].join('\n');
const swap = <T,>(v: T, from: string): T => JSON.parse(JSON.stringify(v).replaceAll(from, MISSING));
const ENVELOPE_ONLY = ['contract_version', 'notices'];

type Call = { isError: boolean; json: Record<string, any> };

for (const kind of testBackends()) {
  describe('get_page slugs (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Call> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, 'get_page', { ...params }, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], ...extra } as never);
      return { isError: out.isError === true, json: JSON.parse(out.content[0]!.text) };
    }
    async function local(params: Record<string, unknown>): Promise<Call> {
      const out = await dispatchToolCall(engine, 'get_page', { ...params }, { remote: false, sourceId: SRC });
      return { isError: out.isError === true, json: JSON.parse(out.content[0]!.text) };
    }
    const bare = (envelope: Record<string, unknown>) => Object.fromEntries(Object.entries(envelope).filter(([k]) => !ENVELOPE_ONLY.includes(k)));

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } } as never);
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(DIMS).fill(1 / Math.sqrt(DIMS))) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const id of [SRC, OTHER]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      await importFromContent(engine, OPEN, note('Open plan', 'Open planning notes.'), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, SECOND, note('Second plan', 'Second planning notes.'), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, RESTRICTED, note('Vesper Example', 'Person notes.', ['readable_by: [alice-example]']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, PRIVATE, note('Quiet plan', 'Quiet planning notes.', ['visibility: private']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, DELETED, note('Old plan', 'Old planning notes.'), { sourceId: SRC, noEmbed: true });
      await engine.softDeletePage(DELETED, { sourceId: SRC });
      await importFromContent(engine, ELSEWHERE, note('Elsewhere plan', 'Notes in another source.'), { sourceId: OTHER, noEmbed: true });
      for (const slug of [ESCAPED_A, ESCAPED_B]) await importFromContent(engine, slug, note('Escaped ' + slug, '\\'.repeat(30_000)), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, BIG, note('Big plan', 'Long planning notes. '.repeat(4000)), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, QUARANTINED, note('Junk plan', 'Junk planning notes.'), { sourceId: SRC, noEmbed: true });
      const clauses = Array.from({ length: 30 }, (_, i) => `## Clause ${i + 1}\n\n` + `Clause ${i + 1} amends the lease terms. `.repeat(28)).join('\n\n');
      await importFromContent(engine, AMENDMENT, note('Lease amendment', clauses), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, AMENDMENT_B, note('Office amendment', clauses.replaceAll('lease', 'office')), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, THIRD, note('Third plan', 'Third planning notes.'), { sourceId: SRC, noEmbed: true });
      await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine":{"reason":"junk_pattern","detail":"test","assessed_at":"2026-10-07T00:00:00Z"}}'::jsonb WHERE slug = $1 AND source_id = $2`, [QUARANTINED, SRC]);
      for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
      for (const [name, member] of [['reader', null], ['bob', 'bob-example'], ['alice', 'alice-example']] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
        else await readsUnscopedOnPurpose(engine, minted.id);
      }
    }, 240_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); }, 60_000);

    test('a page the caller cannot read gives exactly a missing slug\'s entry, in request order', async () => {
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ['bob', RESTRICTED, {}], ['bob', PRIVATE, {}], ['reader', PRIVATE, {}], ['bob', DELETED, {}], ['reader', DELETED, {}],
        ['bob', ELSEWHERE, {}], ['reader', ELSEWHERE, {}], ['reader', OPEN, { min_trust: 'user_confirmed' }],
      ];
      for (const [who, hidden, extra] of cases) {
        const slugs = [SECOND, hidden, MISSING];
        const out = await call(who, { slugs, ...extra });
        const missing = await call(who, { slugs: [SECOND, MISSING, MISSING], ...extra });
        expect({ who, hidden, isError: out.isError, json: swap(out.json, hidden) }).toEqual({ who, hidden, isError: missing.isError, json: missing.json });
        expect(out.json.pages.map((e: { requested_slug: string }) => e.requested_slug)).toEqual(slugs);
        const single = await call(who, { slug: hidden, ...extra });
        expect({ who, hidden, single: single.isError, entry: out.json.pages[1] }).toEqual({ who, hidden, single: true, entry: { requested_slug: hidden, ...bare(single.json) } });
        expect(out.json.pages[1].room_access).toBeUndefined();
      }
    }, 240_000);

    test('a readable page in a batch carries what the single read carries; lean keeps the body and the markers', async () => {
      for (const who of ['reader', 'bob', 'alice']) {
        const slugs = who === 'alice' ? [OPEN, RESTRICTED] : [OPEN, SECOND];
        const full = await call(who, { slugs, fields: 'full' });
        for (const [i, slug] of slugs.entries()) {
          const single = await call(who, { slug });
          expect({ who, slug, page: full.json.pages[i].page }).toEqual({ who, slug, page: single.json });
        }
        const lean = await call(who, { slugs });
        for (const [i, slug] of slugs.entries()) {
          const page = lean.json.pages[i].page;
          const single = (await call(who, { slug })).json;
          for (const key of ['slug', 'title', 'type', 'compiled_truth', 'timeline', 'source_id', 'revision', 'trust_tier', 'origin']) {
            expect({ who, slug, key, value: page[key] }).toEqual({ who, slug, key, value: single[key] });
          }
          expect({ who, slug, frontmatter: page.frontmatter, id: page.id }).toEqual({ who, slug, frontmatter: undefined, id: undefined });
        }
        expect(JSON.stringify(lean.json).length).toBeLessThan(JSON.stringify(full.json).length);
      }
    }, 240_000);

    test('a marked page (quarantined) reads in a batch as it reads alone, and a lean entry keeps the marker', async () => {
      const single = await call('reader', { slug: QUARANTINED });
      expect(single.json.quarantined).toMatchObject({ reason: 'junk_pattern', body_omitted: true });
      const full = await call('reader', { slugs: [QUARANTINED], fields: 'full' });
      expect(full.json.pages[0].page).toEqual(single.json);
      const lean = await call('reader', { slugs: [QUARANTINED] });
      expect({ quarantined: lean.json.pages[0].page.quarantined, body: lean.json.pages[0].page.compiled_truth }).toEqual({ quarantined: single.json.quarantined, body: single.json.compiled_truth });
    }, 60_000);

    test('a repeated slug is read once and repeats its entry; a partial batch opens with a summary and is not an error', async () => {
      const out = await call('reader', { slugs: [OPEN, MISSING, OPEN] });
      expect(out.isError).toBe(false);
      expect(Object.keys(out.json)[0]).toBe('summary');
      expect(out.json.summary).toBe('2 of 3 pages read; 1 not found: ' + MISSING + '.');
      expect(out.json.pages[2]).toEqual(out.json.pages[0]);
      const whole = await call('reader', { slugs: [OPEN, SECOND] });
      expect({ isError: whole.isError, summary: whole.json.summary, omitted: whole.json.omitted }).toEqual({ isError: false, summary: undefined, omitted: undefined });
    }, 120_000);

    test('an all-missing batch is an MCP error, as one missed read is', async () => {
      const out = await call('bob', { slugs: [PRIVATE, MISSING] });
      expect(out.isError).toBe(true);
      expect(out.json.pages.length).toBe(2);
      expect((await call('bob', { slug: MISSING })).isError).toBe(true);
    }, 60_000);

    test('limits: 51 slugs, slug plus slugs, an empty list and per-page selectors are refused', async () => {
      const refusals: Array<[string, Record<string, unknown>]> = [
        ['51 slugs', { slugs: Array.from({ length: 51 }, (_, i) => 'notes/n' + i) }],
        ['slug and slugs', { slug: OPEN, slugs: [OPEN] }],
        ['empty', { slugs: [] }],
        ['fuzzy', { slugs: [OPEN], fuzzy: true }],
        ['as_of', { slugs: [OPEN], as_of: '2026-01-01' }],
        ['window', { slugs: [OPEN], lines: { from: 1, count: 5 } }],
        ['section', { slugs: [OPEN], section: 'Open plan' }],
        ['budget', { slugs: [OPEN], token_budget: 0 }],
      ];
      for (const [label, params] of refusals) {
        const out = await local(params);
        expect({ label, isError: out.isError, code: out.json.code }).toEqual({ label, isError: true, code: 'invalid_params' });
      }
      expect((await local({ slugs: Array.from({ length: 50 }, () => OPEN) })).json.pages.length).toBe(50);
    }, 120_000);

    test('slugs past what a minimum share can hold go to omitted, and every omitted.next makes progress', async () => {
      const out = await call('reader', { slugs: [BIG, OPEN, SECOND, MISSING], token_budget: 900 });
      expect(out.json.pages.map((e: { requested_slug: string }) => e.requested_slug)).toEqual([BIG]);
      expect(out.json.pages[0].page.auto_reason).toBe('batch_share');
      expect(out.json.omitted).toEqual({ slugs: [OPEN, SECOND, MISSING], reason: 'token_budget', token_budget: 900,
        next: { tool: 'get_page', args: { token_budget: 900, slugs: [OPEN, SECOND, MISSING] } } });
      const next = await call('reader', out.json.omitted.next.args);
      expect({ read: next.json.pages.map((e: { requested_slug: string }) => e.requested_slug), omitted: next.json.omitted }).toEqual({ read: [OPEN, SECOND, MISSING], omitted: undefined });
      const whole = await call('reader', { slugs: [OPEN, BIG], token_budget: 32_000 });
      expect(whole.json.pages[1].page.compiled_truth).toContain('Long planning notes.');
      const capped = await call('reader', { slugs: [OPEN], token_budget: 1_000_000 });
      expect(capped.json.pages.length).toBe(1);
    }, 120_000);

    test('one long page cannot fill the batch: it is cut to its fair share with an outline, and the small pages come back whole', async () => {
      const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);
      const single = await call('reader', { slug: AMENDMENT });
      expect(String(single.json.compiled_truth ?? '').length).toBeGreaterThan(28_000);
      const out = await call('reader', { slugs: [AMENDMENT, OPEN, SECOND, THIRD], token_budget: 4000 });
      expect(out.isError).toBe(false);
      expect(out.json.omitted).toBeUndefined();
      const [big, ...small] = out.json.pages as Array<{ requested_slug: string; page: Record<string, any> }>;
      expect([big!.requested_slug, ...small.map(e => e.requested_slug)]).toEqual([AMENDMENT, OPEN, SECOND, THIRD]);
      for (const e of small) expect(e.page.compiled_truth).toContain('planning notes.');
      expect(tokens(out.json)).toBeLessThanOrEqual(4000);
      expect(big!.page.compiled_truth).toBeUndefined();
      expect(big!.page.truncated).toBe(true);
      expect(big!.page.outline.entries.map((h: { heading: string }) => h.heading)).toContain('Clause 30');
      expect(big!.page.window.text).toContain('Clause 1 amends');
      expect(big!.page.next).toMatchObject({ tool: 'get_page', arguments: { slug: AMENDMENT, source_id: SRC } });
      const on = await call('reader', big!.page.next.arguments);
      expect(on.isError).toBe(false);
      expect(on.json.window.byte_start).toBe(big!.page.window.byte_end);
    }, 120_000);

    test('several long pages share the budget evenly, each cut with its outline and a next that reads on', async () => {
      const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);
      const out = await call('reader', { slugs: [AMENDMENT, AMENDMENT_B, OPEN], token_budget: 6000 });
      expect(out.json.omitted).toBeUndefined();
      expect(tokens(out.json)).toBeLessThanOrEqual(6000);
      const [a, b, open] = out.json.pages as Array<{ requested_slug: string; page: Record<string, any> }>;
      expect(open!.page.compiled_truth).toContain('Open planning notes.');
      for (const e of [a!, b!]) {
        expect(e.page.truncated).toBe(true);
        expect(e.page.auto_reason).toBe('batch_share');
        expect(Math.abs(tokens(a) - tokens(b))).toBeLessThan(tokens(a) / 2);
      }
      expect(out.json.summary).toContain('2 cut');
    }, 120_000);

    test('a hidden page and a missing one leave the same omitted list and budget accounting', async () => {
      for (const hidden of [PRIVATE, RESTRICTED, ELSEWHERE]) {
        const out = await call('bob', { slugs: [OPEN, hidden, SECOND, BIG], token_budget: 400 });
        const missing = await call('bob', { slugs: [OPEN, MISSING, SECOND, BIG], token_budget: 400 });
        expect({ hidden, json: swap(out.json, hidden) }).toEqual({ hidden, json: missing.json });
      }
    }, 120_000);

    test('the egress cap moves the tail to omitted with reason egress_cap', async () => {
      await engine.setConfig('mcp.max_result_bytes_http', String(EGRESS_CAP_MIN));
      try {
        // Backslashes double at each JSON level, so two pages inside the token budget overflow a 256 KB frame.
        const out = await call('reader', { slugs: [ESCAPED_A, ESCAPED_B, OPEN], token_budget: 32_000 });
        expect(out.isError).toBe(false);
        expect(out.json.pages.map((e: { requested_slug: string }) => e.requested_slug)).toEqual([ESCAPED_A]);
        expect(out.json.omitted).toMatchObject({ slugs: [ESCAPED_B, OPEN], reason: 'egress_cap' });
        const next = await call('reader', out.json.omitted.next.args);
        expect(next.json.pages[0].requested_slug).toBe(ESCAPED_B);
      } finally {
        await engine.unsetConfig('mcp.max_result_bytes_http');
      }
    }, 120_000);

    test('an engine without the pages capability refuses a batch exactly as it refuses a single read', async () => {
      const refusing = new Proxy(engine, { get: (t, k, r) => k === 'readPageSnapshot' ? async () => { throw capabilityMissing('pages', 'readPageSnapshot'); } : Reflect.get(t, k, r) });
      const run = async (params: Record<string, unknown>) => {
        const out = await dispatchToolCall(refusing, 'get_page', params, { remote: false, sourceId: SRC });
        return { isError: out.isError === true, json: JSON.parse(out.content[0]!.text) };
      };
      const single = await run({ slug: OPEN });
      const batch = await run({ slugs: [OPEN, SECOND] });
      expect({ isError: single.isError, code: single.json.code }).toEqual({ isError: true, code: 'engine_capability_missing' });
      expect(batch).toEqual(single);
    }, 60_000);

    test('the trusted local caller reads with no budget and gets full pages', async () => {
      const out = await local({ slugs: [OPEN, BIG, SECOND] });
      expect(out.json.omitted).toBeUndefined();
      expect(out.json.pages.map((e: { page: { slug: string } }) => e.page.slug)).toEqual([OPEN, BIG, SECOND]);
      expect(out.json.pages[0].page.frontmatter).toBeDefined();
    }, 60_000);
  });
}
