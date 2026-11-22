/**
 * GBRA-574 F, part A: conversation facts about a full name with no page keep a name key (facts.unbacked_entity_keys).
 *
 * Protects: a two-word name with no page keeps the bare basename key (three spellings collapse; a first name or a topic
 * keeps none; the setting off keeps today's NULL) and gets a slot from the tagging call; no page is ever created; a page
 * written later adopts the key's facts on reads, and `gbrain facts relink --conversation --unbacked` moves them durably
 * (alias, merged and suffix pages; the preview writes nothing; a world fact never lands on a private page); keys stay
 * per source; a remote caller never reads a private key fact; a forgotten or purged claim never comes back, whether it
 * was forgotten under the key, source-wide before this change, or under a page that is gone; consolidate never reads a
 * bucket whose entity has no page.
 * Seams: injected extractor or the gateway chat transport stub (no provider call); PGLite with no git repository, and
 * Postgres through test/e2e/conversation-unbacked-keys-gbra574-postgres.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { runFactsCommand } from '../src/commands/facts.ts';
import { __setChatTransportForTests, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { unbackedEntityKey } from '../src/core/entities/resolve-on-save.ts';
import { runConversationRelink } from '../src/core/facts/conversation-relink.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { SLOT_TAG_SYSTEM } from '../src/core/facts/slot-tagging.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { factEntitySlugs } from '../src/core/mentions/siblings.ts';
import { operations } from '../src/core/operations.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const CONVO = 'conversations/2026-03-10/alice-chat';
const JOINED = 'Alice Example joined Acme Example as head of design.';
const home = mkdtempSync(join(tmpdir(), 'gbrain-unbacked-keys-'));
let engine: BrainEngine;

const fact = (text: string, entity: string | null, kind = 'fact'): ExtractedFact =>
  ({ fact: text, kind, entity_slug: entity, confidence: 0.9, source: 'test', notability: 'high' }) as ExtractedFact;
const reply = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:stub', providerId: 'test',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } }) as ChatResult;
const body = [
  '**user** (2026-03-10 9:00 AM): Alice Example joined Acme Example as head of design.',
  '**assistant** (2026-03-10 9:01 AM): Noted.',
  '**user** (2026-03-10 9:02 AM): She likes the new studio.',
].join('\n');

async function conversation(slug = CONVO, sourceId = 'default', frontmatter: Record<string, unknown> = { date: '2026-03-10' }) {
  await engine.putPage(slug, { type: 'conversation' as never, title: 'Conversation 2026-03-10', compiled_truth: body, timeline: '', frontmatter }, { sourceId });
}
async function page(slug: string, type: string, title: string, frontmatter: Record<string, unknown> = {}, sourceId = 'default') {
  await engine.putPage(slug, { type: type as never, title, compiled_truth: `# ${title}`, timeline: '', frontmatter }, { sourceId });
}
async function extract(facts: ExtractedFact[], opts: { slug?: string; sourceId?: string; force?: boolean } = {}) {
  await disposePersistenceConsumer(engine);
  const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await runExtractConversationFactsCore(engine, { sourceId: opts.sourceId ?? 'default', slugs: [opts.slug ?? CONVO], sleepMs: 0,
      overrideDisabled: true, workers: 1, force: opts.force, extractor: async () => facts.map(f => ({ ...f })) });
  } finally { spy.mockRestore(); }
}
async function rows(where = "source_markdown_slug = '" + CONVO + "'") {
  return engine.executeRaw<{ id: number; fact: string; entity_slug: string | null; expired: boolean; dimension: string | null; value: string | null; context: string | null; source_id: string }>(
    `SELECT id, fact, entity_slug, expired_at IS NOT NULL AS expired, dimension, value, context, source_id FROM facts
      WHERE ${where} AND source LIKE 'cli:extract-conversation-facts%' AND fact NOT LIKE 'EXTRACTION_%' ORDER BY id`);
}
async function active(claim: string, sourceId = 'default') {
  return (await rows(`source_id = '${sourceId}' AND fact = '${claim.replace(/'/g, "''")}'`)).filter(r => !r.expired);
}
const relink = (opts: { dryRun?: boolean; sourceId?: string; slugs?: string[] } = {}) =>
  runConversationRelink(engine, { engine: engine.kind } as GBrainConfig, { sourceId: opts.sourceId ?? 'default', unbacked: true, dryRun: opts.dryRun, slugs: opts.slugs });

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { await template?.dispose(); await pglite?.disconnect(); rmSync(home, { recursive: true, force: true }); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await resetPgliteState(pglite); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
      await engine.setConfig('facts.extraction_enabled', 'true');
      await engine.setConfig('facts.default_visibility', 'world');
      await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
      await conversation();
    }, 60_000);
    afterEach(async () => {
      __setChatTransportForTests(null); resetGateway();
      if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; }
    });

    test('a full name with no page keeps its name key and a slot; no page is created', async () => {
      const seen: ChatOpts[] = [];
      __setChatTransportForTests(async opts => {
        seen.push(opts);
        return opts.system === SLOT_TAG_SYSTEM ? reply('{"slots":[{"i":1,"dimension":"role","value":"head of design"}]}')
          : reply(JSON.stringify({ facts: [{ fact: JOINED, kind: 'event', entity: 'Alice Example', confidence: 1, notability: 'high' }] }));
      });
      const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
      let result;
      try { result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [CONVO], sleepMs: 0, overrideDisabled: true }); }
      finally { spy.mockRestore(); }
      expect(result.unbacked_keys).toBe(1);
      expect((await rows()).map(r => [r.fact, r.entity_slug, r.dimension, r.value])).toEqual([[JOINED, 'alice-example', 'role', 'head of design']]);
      const tags = seen.filter(o => o.system === SLOT_TAG_SYSTEM);
      expect(tags).toHaveLength(1);
      expect(tags[0]!.messages).toEqual([{ role: 'user', content: `1. [Alice Example] ${JOINED}` }]);
      expect(await engine.executeRaw(`SELECT slug FROM pages WHERE slug LIKE '%alice-example%' OR type IN ('person', 'company')`)).toEqual([]);
    });

    test('three spellings collapse to one key; a first name and a topic keep none; the setting off keeps NULL', async () => {
      expect(['Alice Example', 'alice-example', 'people/alice-example', 'Alice', 'travel'].map(n => unbackedEntityKey(n.toLowerCase().replace(/ /g, '-'))))
        .toEqual(['alice-example', 'alice-example', 'alice-example', null, null]);
      const facts = [fact('Alice Example moved to Lisbon.', 'Alice Example'), fact('Alice Example likes tea.', 'alice-example'),
        fact('Alice Example bikes to work.', 'people/alice-example'), fact('Alice called.', 'Alice'), fact('Travel is booked.', 'travel')];
      await extract(facts);
      expect((await rows()).map(r => r.entity_slug)).toEqual(['alice-example', 'alice-example', 'alice-example', null, null]);
      await engine.setConfig('facts.unbacked_entity_keys', 'off');
      await extract(facts, { force: true });
      expect((await rows()).filter(r => !r.expired).map(r => r.entity_slug)).toEqual([null, null, null, null, null]);
    });

    test('a key never lands on an unrelated page that sits at the bare slug', async () => {
      await page('alice-example', 'note', 'Notes named alice-example');
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example')]);
      expect((await rows()).map(r => r.entity_slug)).toEqual([null]);
    });

    test('a page written later adopts the key\'s facts on reads; keys stay per source', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT (id) DO NOTHING");
      await conversation(CONVO, 'source-b');
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example')]);
      await extract([fact('Alice Example moved to Porto.', 'Alice Example')], { sourceId: 'source-b' });
      await page('people/alice-example', 'person', 'Alice Example');
      expect(await factEntitySlugs(engine, 'default', 'people/alice-example')).toContain('alice-example');
      const res = await dispatchToolCall(engine, 'recall', { entity: 'people/alice-example', source_id: 'default' }, { remote: false });
      const facts = (JSON.parse(res.content[0]!.text!) as { facts: Array<{ fact: string }> }).facts.map(f => f.fact);
      expect(facts).toContain('Alice Example moved to Lisbon.');
      expect(facts).not.toContain('Alice Example moved to Porto.');
      expect((await relink()).linked).toBe(1);
      expect((await active('Alice Example moved to Lisbon.')).map(r => r.entity_slug)).toEqual(['people/alice-example']);
      expect((await active('Alice Example moved to Porto.', 'source-b')).map(r => r.entity_slug)).toEqual(['alice-example']);
    });

    test('a remote caller never reads a private key fact', async () => {
      await engine.setConfig('facts.default_visibility', 'private');
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example')]);
      expect((await rows()).map(r => r.entity_slug)).toEqual(['alice-example']);
      const read = async (remote: boolean) => (JSON.parse((await dispatchToolCall(engine, 'recall', { entity: 'alice-example' }, { remote })).content[0]!.text!) as
        { facts?: Array<{ fact: string }> }).facts?.map(f => f.fact) ?? [];
      expect(await read(false)).toEqual(['Alice Example moved to Lisbon.']);
      expect(await read(true)).toEqual([]);
    });

    test('relink --unbacked: the preview writes nothing; alias, merged and suffix pages take their keys; no page keeps the key', async () => {
      await page('people/alice-q', 'person', 'Alice Q');
      await engine.setPageAliases('people/alice-q', 'default', ['alice example']);
      await page('people/bob-example', 'person', 'Bob Example', { superseded_by: 'people/robert-example' });
      await page('people/robert-example', 'person', 'Robert Example');
      await page('companies/acme-example-inc', 'company', 'Acme Example Inc');
      await page('people/dana-example', 'person', 'Dana Example', { visibility: 'private' });
      // Keys are kept at extraction time, before the pages exist: re-key them as an older extraction left them.
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example'), fact('Bob Example joined Acme Example.', 'Bob Example'),
        fact('Acme Example raised a round.', 'Acme Example'), fact('Carol Example likes tea.', 'Carol Example'), fact('Dana Example moved to Oslo.', 'Dana Example')]);
      await engine.executeRaw(`UPDATE facts SET entity_slug = lower(replace(split_part(fact, ' ', 1) || '-' || split_part(fact, ' ', 2), '.', ''))
        WHERE source_markdown_slug = $1 AND fact NOT LIKE 'EXTRACTION_%'`, [CONVO]);
      const keyed = (await rows()).map(r => r.entity_slug);
      expect(keyed).toEqual(['alice-example', 'bob-example', 'acme-example', 'carol-example', 'dana-example']);
      const preview = await relink({ dryRun: true });
      expect(preview).toMatchObject({ dry_run: true, unbacked: true, linked: 3, unresolved: 2 });
      expect((await rows()).map(r => r.entity_slug)).toEqual(keyed);
      const out: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
      try { expect(await runFactsCommand(engine, ['relink', '--conversation', '--unbacked'], { engine: engine.kind } as GBrainConfig, 'default')).toBe(0); }
      finally { log.mockRestore(); }
      expect(out.join('\n')).toContain('Linked 3 conversation fact(s)');
      const after = await rows();
      expect(after.map(r => r.entity_slug)).toEqual(['people/alice-q', 'people/robert-example', 'companies/acme-example-inc', 'carol-example', 'dana-example']);
      expect(after[0]!.context).toContain('entity relinked from unbacked');
      // A re-extraction now resolves the name to the page itself.
      await extract([fact('Bob Example joined Acme Example.', 'Bob Example')], { force: true });
      expect((await active('Bob Example joined Acme Example.')).map(r => r.entity_slug)).toEqual(['people/robert-example']);
    });

    test('a claim forgotten under the key stays forgotten after a page is written and the page is re-extracted', async () => {
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example')]);
      const [row] = await rows();
      expect(row!.entity_slug).toBe('alice-example');
      expect((await recordFactWithdrawal(engine, Number(row!.id), 'default')).withdrawn).toBe(true);
      expect(await engine.executeRaw<{ subject: string }>('SELECT subject FROM fact_withdrawals')).toEqual([{ subject: '*' }]);
      await page('people/alice-example', 'person', 'Alice Example');
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example')], { force: true });
      expect(await active('Alice Example moved to Lisbon.')).toEqual([]);
    });

    test('a claim withdrawn source-wide, or under a page that is gone, never comes back under a key', async () => {
      const visibility = 'world';
      await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash) VALUES
        ('default', $1, '*', gbrain_fact_fingerprint('Alice Example moved to Lisbon.')),
        ('default', $1, 'people/alice-example', gbrain_fact_fingerprint('Alice Example likes tea.'))`, [visibility]);
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example'), fact('Alice Example likes tea.', 'Alice Example'),
        fact('Alice Example bikes to work.', 'Alice Example')]);
      expect((await rows()).map(r => [r.entity_slug, r.expired])).toEqual([['alice-example', true], ['alice-example', true], ['alice-example', false]]);
      // A page-scoped withdrawal still leaves another page's same claim alone.
      await page('people/bob-example', 'person', 'Bob Example');
      await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, entity_slug, visibility, source, confidence)
        VALUES ('default', 'Alice Example likes tea.', 'fact', 'people/bob-example', 'world', 'test', 1)`);
      expect(await engine.executeRaw(`SELECT expired_at IS NOT NULL AS expired FROM facts WHERE entity_slug = 'people/bob-example'`)).toEqual([{ expired: false }]);
    });

    test('a purged key fact is purged source-wide and stays out of a re-extraction after a page is written', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      await registerLocalWriter(engine, 'cli');
      const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind },
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const purge = operations.find(o => o.name === 'purge_fact')!;
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example'), fact('Alice Example likes tea.', 'Alice Example')]);
      const [row] = await rows();
      const dry = await purge.handler(ctx, { id: Number(row!.id), dry_run: true }) as Record<string, unknown>;
      await purge.handler(ctx, { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      expect(await engine.executeRaw<{ subject: string }>('SELECT DISTINCT subject FROM fact_purges')).toEqual([{ subject: '*' }]);
      // A tombstone under another subject also keeps the claim off a key.
      await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES ('default', 'world', 'people/bob-example', gbrain_fact_fingerprint('Alice Example likes tea.'))`);
      await page('people/alice-example', 'person', 'Alice Example');
      const again = await extract([fact('Alice Example moved to Lisbon.', 'Alice Example'), fact('Alice Example likes tea.', 'Carol Example'),
        fact('Alice Example bikes to work.', 'Alice Example')], { force: true });
      expect(again.pages_failed).toBe(0);
      expect(again.facts_skipped_purged).toBe(2);
      expect((await rows()).filter(r => !r.expired).map(r => r.fact)).toEqual(['Alice Example bikes to work.']);
    }));

    test('a member-page forget never reaches a key row, and a later extraction of the claim on a key stays active', async () => {
      await extract([fact('Likes sushi.', 'Carol Example')]);
      await page('memory/members/alice-example', 'note', 'Memory of alice-example', { readable_by: ['alice-example'] });
      const [member] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, fact, kind, visibility, source, confidence, source_markdown_slug)
        VALUES ('default', 'Likes sushi.', 'fact', 'world', 'test', 1, 'memory/members/alice-example') RETURNING id`);
      await recordFactWithdrawal(engine, Number(member!.id), 'default', true, { memberPage: 'memory/members/alice-example' });
      expect(await engine.executeRaw<{ subject: string }>('SELECT subject FROM fact_withdrawals')).toEqual([{ subject: 'memory/members/alice-example' }]);
      expect((await active('Likes sushi.')).map(r => r.entity_slug)).toEqual(['carol-example']);
      await extract([fact('Likes sushi.', 'Carol Example')], { force: true });
      expect((await active('Likes sushi.')).map(r => r.entity_slug)).toEqual(['carol-example']);
    });

    test('forgetting a key fact refuses while the same claim is active on a page, and withdraws nothing', async () => {
      await extract([fact('Prefers email over phone.', 'Carol Example')]);
      const [row] = await rows();
      await page('people/bob-example', 'person', 'Bob Example');
      await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, entity_slug, visibility, source, confidence)
        VALUES ('default', 'Prefers email over phone.', 'fact', 'people/bob-example', 'world', 'test', 1)`);
      const out = await dispatchToolCall(engine, 'forget_fact', { id: Number(row!.id) }, { remote: false, sourceId: 'default' });
      expect(out.isError).toBe(true);
      expect(out.content.map(c => (c as { text?: string }).text ?? '').join('\n')).toContain('claim_linked: fact #' + row!.id + ' was saved on the name tag carol-example');
      expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals')).toEqual([]);
      expect(await engine.executeRaw(`SELECT entity_slug FROM facts WHERE fact = 'Prefers email over phone.' AND expired_at IS NULL ORDER BY entity_slug`))
        .toEqual([{ entity_slug: 'carol-example' }, { entity_slug: 'people/bob-example' }]);
    });

    test('an owner-bound caller still reads a key fact after a private people/<key> page is written; a member the page does not name loses it', async () => {
      await extract([fact('Alice Example moved to Lisbon.', 'Alice Example')]);
      const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: (fn: never) => engine.transaction(tx => (fn as (s: unknown) => Promise<unknown>)(sqlQueryForEngine(tx))) } as never);
      for (const id of ['bob-example', 'carol-example']) await addMember(engine, id);
      await setOwner(engine, 'carol-example');
      const auths: Record<string, unknown> = {};
      for (const [name, member] of [['owner', 'carol-example'], ['bob', 'bob-example']] as const) {
        const c = await provider().registerClientManual('t-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], 'default');
        await bindCredential(engine, { kind: 'client', id: c.clientId }, { member });
        auths[name] = await provider().verifyAccessToken((await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token);
      }
      const recall = async (who: string) => {
        __resetPrivateVisibilityCacheForTests();
        const r = await dispatchToolCall(engine, 'recall', { entity: 'alice-example' }, { remote: true, transport: 'http', sourceId: 'default', auth: auths[who] as never,
          config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
        return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
      };
      expect(await recall('bob')).toContain('moved to Lisbon');
      await importFromContent(engine, 'people/alice-example', '---\ntype: person\ntitle: Alice Example\nvisibility: private\n---\n# Alice Example\n', { sourceId: 'default' });
      expect(await recall('owner')).toContain('moved to Lisbon');
      expect(await recall('bob')).not.toContain('moved to Lisbon');
    });

    test('consolidate reads no bucket whose entity has no page', async () => {
      const old = new Date(Date.now() - 10 * 86_400_000);
      for (let i = 0; i < 4; i++) await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, entity_slug, visibility, source, confidence, valid_from, source_markdown_slug, row_num)
        VALUES ('default', $1, 'fact', 'alice-example', 'world', 'cli:extract-conversation-facts:seg', 1, $2, $3, $4)`, [`Alice Example fact ${i}`, old, CONVO, i]);
      const reads = spyOn(engine, 'listFactsByEntity');
      try {
        const result = await runPhaseConsolidate(engine, { minOldestAgeMs: 0 });
        expect(reads).toHaveBeenCalledTimes(0);
        expect(result.details).toMatchObject({ buckets_processed: 0 });
      } finally { reads.mockRestore(); }
    });
  });
}
