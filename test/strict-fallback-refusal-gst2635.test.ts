/**
 * GST-2635: on a strict git-canonical source, the attribute-fallback fact writer refuses a fact no holding page can carry.
 *
 * 1. Protects: on a source whose pages are canonical in Git (`canonical: git`), a fact for an entity with no page that an
 *    exact page rule names (`gbrain access rule add --slug people/bob-example`), written through the attribute fallback
 *    (writeSingleFact, the Google loops extraction's one call, then publishManagedEntityFacts and publishManagedFacts), is
 *    refused before anything reaches the database: `git_home_required` (`facts_lane`) naming the entity's page and the
 *    fix that creates it, as `remember` refuses. An access state this database role cannot read refuses
 *    `access_policy_pending` (retry). The loops job keeps its loop row and logs the refusal code with the entity's page.
 * 2. Fails when: the writer stores the fact in the database with no row in Git (master 1e2fdc28: `inserted`,
 *    source_markdown_slug and row_num null, no file, no commit), or refuses with a message that names memory/unattributed
 *    instead of the entity's page (master, once memory/unattributed exists), or when a source that is not strict, a brain
 *    with no Git repository, or a writer that does not pass the fallback stops behaving as before.
 * 3. Existing coverage: test/folder-holding-page-gst2492.test.ts pins the same refusals for `remember`;
 *    test/strict-background-writers-gst2492.test.ts pins the background writers for entities no page rule names.
 * 4. Real seams: the coordinated write and the write door on PGLite and Postgres (DATABASE_URL), a managed Git checkout,
 *    the page rule added the way an owner adds it (`gbrain access rule add --slug ... --yes`), member-bound MCP callers,
 *    and the loops job as the minion handler runs it, with the model behind the gateway's test transport.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { holdingPageFor } from '../src/core/facts/held-fact-move.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { publishManagedEntityFacts } from '../src/core/facts/managed-fact-write.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const ENTITY = 'people/bob-example';
const EMAIL = 'emails/invoice-thread';
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
let chatReply = '{"commitments":[],"decisions_pending":[]}';
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: chatReply, blocks: [], stopReason: 'end', usage,
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
});
afterAll(() => { __setChatTransportForTests(null); resetGateway(); });

const filesHolding = (root: string, claim: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (readFileSync(path, 'utf8').includes(claim)) out.push(relative(root, path));
    }
  };
  walk(root);
  return out;
};
const factRows = (engine: BrainEngine, claim: string) => engine.executeRaw<{ entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null }>(
  'SELECT entity_slug, source_markdown_slug, row_num FROM facts WHERE source_id=$1 AND fact=$2 ORDER BY id', ['default', claim]);
const factRequests = (engine: BrainEngine) => engine.executeRaw<{ slug: string; state: string }>(
  `SELECT slug, state FROM persistence_requests WHERE operation='extract_facts' AND source_id='default' ORDER BY sequence`);
const commitsHolding = (root: string, claim: string) => git(root, 'log', '--all', '--format=%h %s', '-S', claim).trim().split('\n').filter(Boolean);

async function addPageRule(engine: BrainEngine) {
  const spy = spyOn(console, 'log').mockImplementation(() => {});
  try { await runAccessRules(engine, 'rule', ['add', '--source', 'default', '--slug', ENTITY, '--readers', 'alice-example', '--yes', '--json'], true); }
  finally { spy.mockRestore(); }
}
const unreadableAccess = (engine: BrainEngine) =>
  engine.executeRaw('CREATE OR REPLACE FUNCTION gbrain_access_state_unreadable() RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$');
const seedHoldingPage = async (ctx: OperationContext) => {
  await operationsByName.remember!.handler(ctx, { fact: 'An ordinary unattributed note.', provenance: 'chat 2026-11-13', request_id: randomUUID() });
  await settleManagedGitEffects(ctx.engine);
  expect(await ctx.engine.getPage(HOLD, { sourceId: 'default' })).not.toBeNull();
};

type Refusal = { code?: string; canonical?: string; reason?: string; message: string; fix?: Record<string, unknown> };
async function loopsWrite(engine: BrainEngine, claim: string): Promise<{ reply: Awaited<ReturnType<typeof writeSingleFact>> | null; refusal: Refusal | null }> {
  try { return { reply: await writeSingleFact(engine, 'default', { fact: claim, entity: ENTITY, provenance: 'mail 2026-11-13', kind: 'commitment', visibility: 'private', remote: false }), refusal: null }; }
  catch (error) { return { reply: null, refusal: error as Refusal }; }
  finally { await settleManagedGitEffects(engine); }
}

/** Remote MCP callers bound to members, as test/folder-holding-page-gst2492.test.ts builds them. */
async function members(engine: BrainEngine) {
  const tokens: Record<string, string> = {};
  for (const id of ['alice-example', 'carol-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  for (const member of ['alice-example', 'carol-example']) {
    const minted = await mintLegacyToken(engine, { name: `${member}-${randomUUID().slice(0, 6)}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['default'] });
    tokens[member] = minted.token;
    await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
  }
  __resetPrivateVisibilityCacheForTests();
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  return async (who: string, op: string, params: Record<string, unknown>) => {
    const auth = await provider.verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, 'default');
    const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'],
      ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
  };
}

/** The loops job as its minion handler runs it, on one email page whose commitment names ENTITY. */
async function runLoopsJob({ engine, ctx }: ManagedBrain, claim: string) {
  await engine.setConfig('loops.extraction_enabled', 'true');
  await operationsByName.put_page!.handler(ctx, { slug: EMAIL, request_id: randomUUID(),
    content: `---\ntitle: Invoice thread\ntype: email\nthread_id: invoice-thread\nfrom: bob@example.invalid\n---\nI will send Bob the invoice summary by Friday.\n` });
  await settleManagedGitEffects(engine);
  chatReply = JSON.stringify({ commitments: [{ text: claim, direction: 'owed_by_me', counterparty_name: ENTITY, counterparty_email: '',
    due_iso: '2026-11-20', quote: 'I will send Bob the invoice summary by Friday.' }], decisions_pending: [] });
  const warned: string[] = [];
  const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
  try {
    const result = await runLoopsExtract(engine, { slug: EMAIL, sourceId: 'default' });
    await settleManagedGitEffects(engine);
    const loops = await engine.executeRaw<{ fact_id: number | null; summary: string }>('SELECT fact_id, summary FROM open_loops WHERE source_id=$1', ['default']);
    return { result, loops, log: warned.filter(line => line.startsWith('[loops_extract] fact projection failed')) };
  } finally { spy.mockRestore(); }
}

for (const backend of testBackends()) describe(`[${backend}] GST-2635: the attribute-fallback fact writer on a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const brain = (strict: boolean, run: (brain: ManagedBrain) => Promise<void>) => managedBrain(async b => {
    if (strict) await b.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await run(b);
  }, { databaseUrl, setup: gitRepo });

  test('missing arm: no memory/unattributed yet, the write refuses git_home_required naming the entity\'s page and writes nothing', () => brain(true, async b => {
    await addPageRule(b.engine);
    expect(await holdingPageFor(b.engine, 'default', ENTITY)).toEqual({ refused: 'page_rule' });
    expect(await b.engine.getPage(HOLD, { sourceId: 'default' })).toBeNull();
    const claim = 'Bob example prefers the quarterly invoice summary.';
    const { reply, refusal } = await loopsWrite(b.engine, claim);
    expect(reply).toBeNull();
    expect({ code: refusal?.code, reason: refusal?.reason }).toEqual({ code: 'git_home_required', reason: 'facts_lane' });
    expect(refusal!.message).toContain(ENTITY);
    expect(refusal!.message).not.toContain(HOLD);
    expect(refusal!.fix).toMatchObject({ ask_user: true, mcp: { tool: 'put_page', arguments: { slug: ENTITY } } });
    expect(await factRows(b.engine, claim)).toEqual([]);
    expect(await factRequests(b.engine)).toEqual([]);
    expect(filesHolding(b.root, claim)).toEqual([]);
    expect(commitsHolding(b.root, claim)).toEqual([]);
    expect(await b.engine.getPage(HOLD, { sourceId: 'default' })).toBeNull();
  }), 300_000);

  test('present arm: memory/unattributed exists, the write refuses naming the entity\'s page, not memory/unattributed', () => brain(true, async b => {
    await seedHoldingPage(b.ctx);
    await addPageRule(b.engine);
    expect(await holdingPageFor(b.engine, 'default', ENTITY)).toEqual({ refused: 'page_rule' });
    const before = readFileSync(join(b.root, `${HOLD}.md`), 'utf8');
    const claim = 'Bob example asked for the invoices in euros.';
    const { reply, refusal } = await loopsWrite(b.engine, claim);
    expect(reply).toBeNull();
    expect({ code: refusal?.code, reason: refusal?.reason }).toEqual({ code: 'git_home_required', reason: 'facts_lane' });
    expect(refusal!.message).toContain(ENTITY);
    expect(refusal!.message).not.toContain(HOLD);
    expect(refusal!.fix).toMatchObject({ mcp: { tool: 'put_page', arguments: { slug: ENTITY } } });
    expect(await factRows(b.engine, claim)).toEqual([]);
    expect(await factRequests(b.engine)).toEqual([]);
    expect(filesHolding(b.root, claim)).toEqual([]);
    expect(readFileSync(join(b.root, `${HOLD}.md`), 'utf8')).toBe(before);
  }), 300_000);

  test('an access state this role cannot read refuses access_policy_pending (retry) and writes nothing', () => brain(true, async b => {
    await unreadableAccess(b.engine);
    expect(await holdingPageFor(b.engine, 'default', ENTITY)).toEqual({ refused: 'access_unreadable' });
    const claim = 'Bob example moved the invoice due date.';
    const { reply, refusal } = await loopsWrite(b.engine, claim);
    expect(reply).toBeNull();
    expect(refusal?.code).toBe('access_policy_pending');
    expect(refusal!.message).toContain(ENTITY);
    expect(refusal!.fix).toMatchObject({ actor: 'provider', argv: ['gbrain', 'access', 'rule', 'status', '--source', 'default', '--json'] });
    expect(await factRows(b.engine, claim)).toEqual([]);
    expect(await factRequests(b.engine)).toEqual([]);
    expect(filesHolding(b.root, claim)).toEqual([]);
  }), 300_000);

  test('readers: carol-example, whom the page rule does not name, cannot read the fact; the owner\'s own reads are unchanged', () => brain(true, async b => {
    await addPageRule(b.engine);
    const kept = 'Bob example keeps the renewal terms confidential.';
    await loopsWrite(b.engine, kept);
    const as = await members(b.engine);
    const probe: Record<string, Record<string, boolean | string>> = {};
    for (const who of ['alice-example', 'carol-example']) {
      const out: Record<string, boolean | string> = {};
      for (const [op, params] of [['search', { query: kept, match: 'keyword', fields: 'full', limit: 20 }], ['recall', { entity: ENTITY }], ['recall', { query: 'renewal terms' }], ['memory_recall', { query: 'renewal terms confidential' }]] as const) {
        const got = await as(who, op, params as Record<string, unknown>);
        out[`${op} ${JSON.stringify(params)}`] = got.isError ? `error: ${got.text.slice(0, 160)}` : got.text.includes(kept);
      }
      probe[who] = out;
    }
    expect(Object.values(probe['carol-example']!).some(v => v === true)).toBe(false);
    // Once the owner creates the entity's page, the same write lands on it in Git and the owner reads it.
    await operationsByName.put_page!.handler(b.ctx, { slug: ENTITY, request_id: randomUUID(), content: '---\ntype: person\ntitle: Bob Example\n---\n\nNotes about Bob Example.\n' });
    await settleManagedGitEffects(b.engine);
    expect((await loopsWrite(b.engine, kept)).reply).toMatchObject({ status: 'inserted', entity_slug: ENTITY });
    expect(await factRows(b.engine, kept)).toMatchObject([{ entity_slug: ENTITY, source_markdown_slug: ENTITY, row_num: 1 }]);
    expect(git(b.root, 'show', `HEAD:${ENTITY}.md`)).toContain(kept);
    expect(JSON.stringify(await operationsByName.recall!.handler(b.ctx, { entity: ENTITY }))).toContain(kept);
  }), 300_000);

  test('a source that is not strict keeps the fact database-only, as before', () => brain(false, async b => {
    await addPageRule(b.engine);
    const claim = 'Bob example asked for paper invoices.';
    const { reply, refusal } = await loopsWrite(b.engine, claim);
    expect(refusal).toBeNull();
    expect(reply).toMatchObject({ status: 'inserted', entity_slug: ENTITY });
    expect(await factRows(b.engine, claim)).toEqual([{ entity_slug: ENTITY, source_markdown_slug: null, row_num: null }]);
    expect(filesHolding(b.root, claim)).toEqual([]);
  }), 300_000);

  test('a brain with no Git repository (the keyless default) stores the fact, never refused for lacking a repository', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gst2635-repoless-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          await addPageRule(engine);
          const claim = 'Bob example pays invoices on the first of the month.';
          const reply = await writeSingleFact(engine, 'default', { fact: claim, entity: ENTITY, provenance: 'mail 2026-11-13', kind: 'commitment', visibility: 'private', remote: false });
          expect(reply).toMatchObject({ status: 'inserted' });
          expect(await factRows(engine, claim)).toEqual([{ entity_slug: null, source_markdown_slug: null, row_num: null }]);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 300_000);

  test('a writer that does not pass the fallback still holds the fact on memory/unattributed with no entity, as before', () => brain(true, async b => {
    await addPageRule(b.engine);
    const claim = 'The invoice template gained a tax line.';
    const written = await publishManagedEntityFacts(b.engine, 'default', ENTITY, [{ fact: claim, kind: 'fact', notability: 'medium', source: 'extraction 2026-11-13',
      visibility: 'world', embedding: null, sessionId: null }]);
    await settleManagedGitEffects(b.engine);
    expect(written.inserted).toBe(1);
    expect(await factRows(b.engine, claim)).toMatchObject([{ entity_slug: null, source_markdown_slug: HOLD, row_num: 1 }]);
    expect(git(b.root, 'show', `HEAD:${HOLD}.md`)).toContain(claim);
  }), 300_000);

  for (const arm of ['page_rule', 'access_unreadable'] as const) {
    test(`${arm === 'page_rule' ? 'a page rule' : 'an unreadable access state'} that arrives after admission, before preparation, refuses there too and writes nothing`, () => brain(true, async b => {
      const claim = `Bob example wants the invoice summary split by project (${arm}).`;
      let armed = true;
      installFaultHook(async (point, detail) => {
        if (!armed || point !== 'consumer:preparing' || detail.operation !== 'extract_facts') return;
        armed = false;
        if (arm === 'page_rule') await addPageRule(b.engine); else await unreadableAccess(b.engine);
      });
      const { reply, refusal } = await loopsWrite(b.engine, claim).finally(() => installFaultHook(undefined));
      expect(armed).toBe(false);
      expect(reply).toBeNull();
      expect(refusal?.code).toBe(arm === 'page_rule' ? 'git_home_required' : 'access_policy_pending');
      expect(refusal!.message).toContain(ENTITY);
      expect(await factRows(b.engine, claim)).toEqual([]);
      expect(filesHolding(b.root, claim)).toEqual([]);
      expect(commitsHolding(b.root, claim)).toEqual([]);
    }), 300_000);
  }

  for (const arm of ['missing', 'present', 'access_unreadable'] as const) {
    test(`the loops job keeps the loop row and logs the refusal with the entity's page (${arm} arm)`, () => brain(true, async b => {
      if (arm === 'present') await seedHoldingPage(b.ctx);
      if (arm === 'access_unreadable') await unreadableAccess(b.engine); else await addPageRule(b.engine);
      const claim = `Send Bob the invoice summary by Friday (${arm}).`;
      const { result, loops, log } = await runLoopsJob(b, claim);
      expect(result).toMatchObject({ status: 'extracted', commitments: 1 });
      expect(loops).toEqual([{ fact_id: null, summary: claim }]);
      expect(await factRows(b.engine, claim)).toEqual([]);
      expect(filesHolding(b.root, claim).filter(path => !path.startsWith('emails/'))).toEqual([]);
      expect(log).toHaveLength(1);
      expect(log[0]).toContain(arm === 'access_unreadable' ? '(access_policy_pending)' : '(git_home_required)');
      expect(log[0]).toContain(ENTITY);
      expect(log[0]).not.toContain(claim);
    }), 300_000);
  }
});
