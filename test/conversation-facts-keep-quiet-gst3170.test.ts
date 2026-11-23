/**
 * GST-3170 item 1: a claim the speaker asks to keep quiet is stored private, never less private, with the extractor
 * prompt unchanged.
 *
 * Protects: keep-quiet.ts marks a fact private only when it restates the claim of a keep-quiet sentence in its own window
 * ("keep this quiet for now, but ...", "between us, ...", "off the record"), never from an assistant turn, a trailing
 * "between us" or another claim in the same window. On an unmanaged brain and in a managed batch, a marked fact on a
 * world page publishes private while the page's other facts stay world. A frozen row's `visibility` accepts only 'private': any other value blocks its page and is never coerced.
 * The brain owner's credential reads a marked fact exactly as it reads a fact from a private page today, and a member or
 * an unbound credential reads neither (R94). With GBRAIN_TEST_OLDER_CHECKOUT naming a checkout from before the key, an older
 * binary publishes a marked row at its page's visibility and does not fail.
 * Regression: a keep-quiet claim stored world, a row visibility that widens or is coerced, an owner read that loses one.
 * Seams: the gateway chat transport stub and the Core's injected extractor (no provider call), tokens minted by the token
 * service and dispatched through MCP dispatch; PGLite, and Postgres when a test database is configured.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { keepQuietClaims, keptQuiet } from '../src/core/facts/keep-quiet.ts';
import { runExtractConversationFactsCore, currentConversationVersionToken } from '../src/commands/extract-conversation-facts.ts';
import { CONVERSATION_FACTS_INTENT, buildConversationPage, conversationGeneration, submitConversationPages,
  type ConversationPageEntry } from '../src/core/facts/conversation-publication.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { SLOT_TAG_SYSTEM } from '../src/core/facts/slot-tagging.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { credentialHolders, setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'meetings/2026-09-28-plan-sync';
const PRIVATE_SLUG = 'meetings/2026-09-29-plan-sync';
const WORLD = 'Owner Example sends the quarterly plan on Thursday';
const QUIET = 'Acme Example raised a seed round of 2000000 USD otterquietcanary';
const TODAY = 'Owner Example moves to Lisbon in March molepagecanary';
const transcript = (title: string, frontmatter = '') => [
  '---', `title: ${title}`, 'type: meeting', 'date: 2026-09-28', ...(frontmatter ? [frontmatter] : []), '---',
  '**Alice Example:** Can you send me the quarterly plan before the review?',
  '**Owner Example:** Yes, on Thursday. Keep this quiet for now, but Acme Example closed its seed round.',
  '**Alice Example:** Good. I review plans on Mondays, so that works.', '',
].join('\n');

afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

describe('keep-quiet matching', () => {
  const said = (...lines: Array<[string, string]>) => lines.map(([speaker, text]) => ({ speaker, text }));
  const marks = (messages: Array<{ speaker: string; text: string }>, facts: string[]) => facts.filter(fact => keptQuiet(fact, keepQuietClaims(messages)));
  test('a fact restating the keep-quiet claim is marked, and another claim in the same window is not', () => {
    const window = said(['user', 'Got it. Keep this quiet for now, but Acme Example is merging with Beta Example. How often should I water basil?']);
    expect(marks(window, ['Acme Example is merging with Beta Example.', 'User asked that the Acme Example and Beta Example merger be kept quiet.',
      'User said work was busy and asked to keep the Acme Example merger with Beta Example quiet for now.', 'User waters basil twice a week.', 'Acme Example hired a new CFO.']))
      .toEqual(['Acme Example is merging with Beta Example.', 'User asked that the Acme Example and Beta Example merger be kept quiet.',
        'User said work was busy and asked to keep the Acme Example merger with Beta Example quiet for now.']);
  });
  test('other cues mark their claim; an assistant message, an idiom and a trailing "between us" name none', () => {
    const SEED = 'Acme Example closed its seed round.';
    expect(marks(said(['alice-example', 'Between us, Acme Example closed its seed round.']), [SEED])).toHaveLength(1);
    expect(marks(said(['alice-example', 'Between us. Acme Example closed its seed round.']), [SEED])).toHaveLength(1);
    expect(marks(said(['user', 'Off the record, the Lisbon office opens in March.']), ['The Lisbon office opens in March.'])).toHaveLength(1);
    expect(marks(said(['alice-example', 'Thanks. Between us and the competition, Acme Example closed its seed round.']), [SEED])).toHaveLength(0);
    expect(marks(said(['alice-example', 'Acme Example closed its seed round.'], ['bob-example', 'Don\'t mention it, Acme Example closed its seed round.']), [SEED])).toHaveLength(0);
    expect(marks(said(['user', 'Acme Example closed its seed round. Please don\'t share this.']), [SEED])).toHaveLength(0);
    expect(marks(said(['assistant', 'Understood, I will keep that quiet. Basil likes a half-strength liquid feed every three weeks.']),
      ['Basil likes a half-strength liquid feed every three weeks.'])).toHaveLength(0);
    expect(marks(said(['assistant', 'Off the record, Acme Example closed its seed round.']), [SEED])).toHaveLength(0);
    expect(marks(said(['user', 'I want our chats to stay friendly and respectful between us.']), ['User wants the chats to stay friendly and respectful.'])).toHaveLength(0);
    expect(marks(said(['user', 'Acme Example closed its seed round.']), [SEED])).toHaveLength(0);
  });
});

async function factRows(engine: BrainEngine, slug: string) {
  return engine.executeRaw<{ fact: string; visibility: string }>(`SELECT fact, visibility FROM facts WHERE source_id='default'
    AND source_markdown_slug=$1 AND source LIKE 'cli:extract-conversation-facts%' AND expired_at IS NULL ORDER BY row_num`, [slug]);
}

describe('an unmanaged brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  const BETWEEN = 'Beta Example opens a Lisbon office in March';
  const ASSISTANT = 'Basil likes a half-strength liquid feed every three weeks';
  /** Extract one world page through the production window path (gateway stub, real parser and renderer); its stored facts. */
  async function extractPage(page: string): Promise<Array<{ fact: string; visibility: string }>> {
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('facts.default_visibility', 'world');
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    await engine.putPage(page, { type: 'conversation' as never, title: 'Conversation 2026-03-10', timeline: '', frontmatter: { date: '2026-03-10' },
      compiled_truth: ['**user** (2026-03-10 9:00 AM): I send the quarterly plan on Thursday.',
        '**user** (2026-03-10 9:01 AM): Keep this quiet for now, but Acme Example closed its seed round.',
        '**user** (2026-03-10 9:02 AM): Between us, Beta Example opens a Lisbon office in March.',
        '**assistant** (2026-03-10 9:03 AM): Understood, I will keep that quiet. Basil likes a half-strength liquid feed every three weeks.'].join('\n') });
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      const text = opts.system === SLOT_TAG_SYSTEM ? '{"slots":[]}' : JSON.stringify({ facts: [WORLD, QUIET, BETWEEN, ASSISTANT]
        .map(fact => ({ fact, kind: 'fact', entity: null, confidence: 1, notability: 'high' })) });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
    });
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try { await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [page], sleepMs: 0, overrideDisabled: true }); }
    finally { spy.mockRestore(); }
    return (await factRows(engine, page)).filter(row => row.fact !== 'EXTRACTION_COMPLETE');
  }
  test('keep-quiet claims on a world page are stored private and the page\'s other facts stay world', async () => {
    expect(await extractPage('conversations/2026-03-10/chat-example')).toEqual([{ fact: WORLD, visibility: 'world' }, { fact: QUIET, visibility: 'private' },
      { fact: BETWEEN, visibility: 'private' }, { fact: ASSISTANT, visibility: 'world' }]);
  }, 60_000);
  test('a claim purged while it was world is never narrowed back into memory', async () => {
    await engine.executeRaw('DELETE FROM facts');
    await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, fact_hash) VALUES('default', 'world', gbrain_fact_fingerprint($1))`, [QUIET]);
    expect(await extractPage('conversations/2026-03-11/chat-example')).toEqual([{ fact: WORLD, visibility: 'world' },
      { fact: BETWEEN, visibility: 'private' }, { fact: ASSISTANT, visibility: 'world' }]);
  }, 60_000);
});

async function putPage(brain: ManagedBrain, slug: string, content: string): Promise<void> {
  await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } });
  await disposePersistenceConsumer(brain.engine);
}

function extract(engine: BrainEngine, slugs: string[], facts: (turnText: string) => Partial<ExtractedFact>[]) {
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs, sleepMs: 0, overrideDisabled: true,
    extractor: async ({ turnText }) => facts(turnText).map(f => ({ kind: 'fact', confidence: 0.9, entity_slug: null, source: 'test',
      notability: 'high', ...f }) as ExtractedFact) });
}

/** A world-page entry frozen by this binary: one fact marked private and one not. */
async function frozenEntry(engine: BrainEngine): Promise<{ entry: ConversationPageEntry; authority: NonNullable<Awaited<ReturnType<typeof maintenancePreflight>>> }> {
  const authority = (await maintenancePreflight(engine, 'default'))!;
  const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
  const versionToken = await currentConversationVersionToken(engine, page);
  const generation = await conversationGeneration(engine, authority, { slug: SLUG, page, versionToken, since: null, segmentLimit: 0 });
  const row = (n: number, fact: string, visibility: 'private' | 'world') =>
    ({ fact, kind: 'fact' as const, source: 'cli:extract-conversation-facts', row_num: n, source_markdown_slug: SLUG, visibility });
  const entry = await buildConversationPage(engine, { engine: engine.kind }, { slug: SLUG, generation, attempt: 0, versionToken, since: null, segmentLimit: 0 },
    [row(0, WORLD, 'world'), row(1, QUIET, 'private')], { newestEnd: null, visibility: 'world' });
  return { entry, authority };
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: a managed batch publishes a keep-quiet claim private on a world page, and the owner reads it exactly as a private page's fact (R94)`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await engine.setConfig('facts.default_visibility', 'world');
      await putPage(brain, SLUG, transcript('Plan sync'));
      await putPage(brain, PRIVATE_SLUG, transcript('Plan sync two', 'visibility: private'));
      const result = await extract(engine, [SLUG, PRIVATE_SLUG], turnText => turnText.includes('Plan sync two')
        ? [{ fact: TODAY }]
        : [{ fact: WORLD, kind: 'commitment' }, { fact: QUIET }]);
      expect(result).toMatchObject({ pages_failed: 0, pages_processed: 2 });
      expect((await factRows(engine, SLUG)).filter(row => row.fact !== 'EXTRACTION_COMPLETE'))
        .toEqual([{ fact: WORLD, visibility: 'world' }, { fact: QUIET, visibility: 'private' }]);
      expect((await factRows(engine, PRIVATE_SLUG)).filter(row => row.fact !== 'EXTRACTION_COMPLETE')).toEqual([{ fact: TODAY, visibility: 'private' }]);
      // The stored batch names a row visibility only on the narrowed row, and only as 'private'.
      const intents = await engine.executeRaw<{ intent: unknown }>("SELECT intent FROM persistence_requests WHERE intent->>'kind'=$1", [CONVERSATION_FACTS_INTENT]);
      const frozen = intents.flatMap(r => ((typeof r.intent === 'string' ? JSON.parse(r.intent) : r.intent) as { pages: ConversationPageEntry[] }).pages)
        .flatMap(entry => entry.rows.map(row => [entry.slug, row.fact, (row as { visibility?: string }).visibility ?? null]));
      expect(frozen.filter(([, fact]) => fact !== 'EXTRACTION_COMPLETE')).toEqual(expect.arrayContaining([
        [SLUG, WORLD, null], [SLUG, QUIET, 'private'], [PRIVATE_SLUG, TODAY, null]]));
      expect(frozen.filter(([, , visibility]) => visibility !== null)).toEqual([[SLUG, QUIET, 'private']]);

      const OWNER = 'owner-example', BOB = 'bob-example';
      for (const id of [OWNER, BOB]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const tokens: Record<string, string> = {};
      const mint = async (name: string, member: string | undefined) => {
        const m = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] });
        tokens[name] = m.token;
        if (member) await bindCredential(engine, { kind: 'token', id: m.id }, { member }); else await readsUnscopedOnPurpose(engine, m.id);
      };
      await mint('owner', OWNER); await mint('member', BOB); await mint('unbound', undefined);
      await setOwner(engine, OWNER);
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const reads = async (who: string) => {
        __resetPrivateVisibilityCacheForTests();
        const auth = await provider.verifyAccessToken(tokens[who]!) as unknown as AuthInfo & { takesHoldersAllowList?: string[] };
        const out = await dispatchToolCall(engine, 'recall', { since: '2000-01-01T00:00:00Z' }, { remote: true, transport: 'http', auth,
          sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: await credentialHolders(engine, auth.takesHoldersAllowList, auth.member?.id) });
        expect(out.isError, who).toBeFalsy();
        const text = out.content.map(c => c.text).join('\n');
        return { who, world: text.includes('quarterly plan'), quiet: text.includes('otterquietcanary'), today: text.includes('molepagecanary') };
      };
      expect(await reads('owner')).toEqual({ who: 'owner', world: true, quiet: true, today: true });
      expect(await reads('member')).toEqual({ who: 'member', world: true, quiet: false, today: false });
      expect(await reads('unbound')).toEqual({ who: 'unbound', world: true, quiet: false, today: false });
    }, { databaseUrl });
  }, 180_000);

  test(`${backend}: a frozen row naming any visibility but 'private' blocks its page instead of being coerced`, async () => {
    for (const bad of ['world', null, 'Private']) {
      await managedBrain(async brain => {
        const { engine } = brain;
        await putPage(brain, SLUG, transcript('Plan sync'));
        const { entry, authority } = await frozenEntry(engine);
        expect(entry.rows.map(row => (row as { visibility?: string }).visibility ?? null)).toEqual([null, 'private']);
        (entry.rows[1] as { visibility?: unknown }).visibility = bad;
        const receipt = await submitConversationPages(engine, authority, [entry]);
        expect({ bad, receipt }).toMatchObject({ bad, receipt: { state: 'committed', blocked: 1, committed: 0 } });
        expect((await factRows(engine, SLUG)).map(row => row.fact)).toEqual(['EXTRACTION_NOT_APPLICABLE']);
      }, { databaseUrl });
    }
  }, 180_000);

  const older = process.env.GBRAIN_TEST_OLDER_CHECKOUT;
  test.skipIf(!older)(`${backend}: an older binary publishes a marked row at its page's visibility and does not fail`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, SLUG, transcript('Plan sync'));
      const { entry, authority } = await frozenEntry(engine);
      const old = await import(join(older!, 'src/core/facts/conversation-publication.ts')) as { submitConversationPages: typeof submitConversationPages };
      const oldService = await import(join(older!, 'src/core/persistence/service.ts')) as { disposePersistenceConsumer: typeof disposePersistenceConsumer };
      try {
        const receipt = await old.submitConversationPages(engine, authority as never, [entry as never]);
        expect(receipt).toMatchObject({ state: 'committed', committed: 1, blocked: 0 });
      } finally { await oldService.disposePersistenceConsumer(engine as never); }
      expect(await factRows(engine, SLUG)).toEqual([{ fact: WORLD, visibility: 'world' }, { fact: QUIET, visibility: 'world' }]);
    }, { databaseUrl });
  }, 120_000);
}
