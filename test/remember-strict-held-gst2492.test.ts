/**
 * GST-2492: `remember` for an entity with no page, on a strict git-canonical source.
 *
 * 1. Protects: on a source whose pages are canonical in Git, a fact saved for an entity that has no page is written to
 *    Git before its database row, as a row of memory/unattributed whose `entity` cell names the entity. The reply,
 *    batch item and receipt say where it is (`page: memory/unattributed`, `write_through.held_for`). A rebuild from a
 *    clone of HEAD brings the fact back for its entity. Once the entity has a page, the extract_facts phase moves the
 *    row into that page in one commit and strikes the holding row; forget and supersede strike the held row, and purge
 *    removes it from the file. The brain owner's own credential (GST-2346 D1) holds such a fact the same way, shared,
 *    withdraws it, and the host's purge removes it.
 * 2. Fails when: a strict source keeps such a fact in the database alone (a rebuild loses it), a rebuild brings back a
 *    forgotten, superseded or purged held fact, a move duplicates or loses the fact, or a private entity page is named
 *    on the world-readable holding page.
 * 3. Existing coverage: test/remember-pageless-entity-gst2446.test.ts pins the non-strict and repo-less answers.
 * 4. Real seams: the coordinated write and the write door on PGLite and Postgres (DATABASE_URL), a managed Git checkout,
 *    the operation handler as the local CLI calls it, MCP dispatch as a remote, an owner-bound OAuth and a prefix-bound caller, and a rebuild
 *    of a fresh database from a clone of HEAD through sync and the facts step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { cliRenderContext, renderNotice, type Notice } from '../src/core/agent-output.ts';
import { renderCliNotices } from '../src/core/agent-markers.ts';
import { operationsByName, type AuthInfo } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { performSync } from '../src/commands/sync.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import * as fence from '../src/core/facts-fence.ts';
import { scanCanonicalFences } from '../src/core/fence-repair/refusal.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const HOLD_FILE = `${HOLD}.md`;
const PAGED = 'people/hana-example';
const PAGELESS = 'notes/kitchen-remodel';
const page = (title: string, extra = '') => `---\ntype: note\ntitle: ${title}\n${extra}---\n\nNotes about ${title}.\n`;
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const STDIO = { remote: true, transport: 'stdio', sourceId: 'default' } as const;

const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const remember = (ctx: OperationContext, fact: string, entity: string, extra: Record<string, unknown> = {}) =>
  call(ctx, 'remember', { fact, entity, provenance: 'chat 2026-11-11', ...extra });
const putPage = (ctx: OperationContext, slug: string, title: string, extra = '') => call(ctx, 'put_page', { slug, content: page(title, extra) });
const head = (root: string, file: string) => { try { return git(root, 'show', `HEAD:${file}`); } catch { return ''; } };
const lineOf = (text: string, claim: string) => text.split('\n').find(line => line.includes(claim)) ?? '';
const factRows = (engine: BrainEngine, claim: string) => engine.executeRaw<{ id: number; entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null; active: boolean; source: string }>(
  `SELECT id::int AS id, entity_slug, source_markdown_slug, row_num, (expired_at IS NULL) AS active, source FROM facts WHERE source_id='default' AND fact = $1 ORDER BY id`, [claim]);
async function overMcp(engine: BrainEngine, params: Record<string, unknown>, auth?: AuthInfo) {
  const out = await dispatchToolCall(engine, 'remember', { provenance: 'chat 2026-11-11', request_id: randomUUID(), ...params }, { ...STDIO, ...(auth ? { auth } : {}) });
  return { body: JSON.parse(out.content[0]!.text) as Record<string, any>, blocks: out.content.slice(1).map(block => block.text), isError: out.isError === true };
}

/** A real OAuth client-credentials token bound to the brain owner, verified the way the HTTP transport verifies it. */
async function ownerAuth(engine: BrainEngine): Promise<AuthInfo> {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  __resetPrivateVisibilityCacheForTests();
  await addMember(engine, 'carol-example');
  await setOwner(engine, 'carol-example');
  const client = await provider.registerClientManual('owner-example', ['client_credentials'], 'read write', [], 'default');
  await bindCredential(engine, { kind: 'client', id: client.clientId }, { member: 'carol-example' });
  const { access_token } = await provider.exchangeClientCredentials(client.clientId, client.clientSecret ?? '');
  return await provider.verifyAccessToken(access_token) as unknown as AuthInfo;
}
const asOwner = async (engine: BrainEngine, auth: AuthInfo, op: string, params: Record<string, unknown>) => {
  const out = await dispatchToolCall(engine, op, { request_id: randomUUID(), ...params }, { remote: true, transport: 'http', sourceId: 'default', auth });
  return { body: JSON.parse(out.content[0]!.text) as Record<string, any>, text: out.content.map(block => block.text).join('\n'), isError: out.isError === true };
};

/** A fresh database indexed from a clone of HEAD, with the facts step run, as a rebuild would: the rows of each claim. */
async function rebuild(root: string, databaseUrl: string | undefined, claims: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'gst2492-rebuild-'));
  try {
    const clone = join(home, 'content');
    git(home, 'clone', '--quiet', root, clone);
    const fresh = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await fresh.engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [clone]);
      await performSync(fresh.engine, { sourceId: 'default', repoPath: clone, noPull: true, noEmbed: true } as never);
      await runExtractFacts(fresh.engine, { sourceId: 'default' });
      const out: Record<string, Array<{ entity_slug: string | null; source_markdown_slug: string | null; active: boolean }>> = {};
      for (const claim of claims) out[claim] = (await factRows(fresh.engine, claim)).map(({ entity_slug, source_markdown_slug, active }) => ({ entity_slug, source_markdown_slug, active }));
      return out;
    } finally { await fresh.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const backend of testBackends()) describe(`[${backend}] a strict source holds a pageless fact in Git (GST-2492)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => installFaultHook(undefined));
  const strict = (run: (brain: ManagedBrain) => Promise<void>) => managedBrain(async brain => {
    await brain.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await putPage(brain.ctx, PAGED, 'Hana Example');
    await run(brain);
  }, { databaseUrl, setup: gitRepo });

  test('the fact is in Git before the reply, and the reply, batch, receipt and MCP say where', () => strict(async ({ engine, ctx, root }) => {
    const notices: Notice[] = [];
    const local = { ...ctx, emitNotice: (n: Notice | null | undefined) => { if (n) notices.push(n); } } as OperationContext;
    const claim = 'The kitchen remodel starts in March.';
    const single = await remember(local, claim, PAGELESS);
    expect(single).toMatchObject({ status: 'inserted', entity_slug: PAGELESS, page: HOLD, persistence: { mode: 'filesystem' },
      write_through: { written: true, held_for: PAGELESS } });
    // Committed through the door before the row: HEAD has it with no Git effect settled.
    expect(lineOf(head(root, HOLD_FILE), claim)).toContain(PAGELESS);
    const [notice] = notices.filter(n => n.code === 'entity_page_missing');
    expect(notice!.why).toContain(`held on ${HOLD} until ${PAGELESS} has a page`);
    expect(notice!.why).toContain('committed to Git');
    // Held in Git, the fact needs nothing: no step to run and nothing to ask, on any surface.
    expect(notice).toMatchObject({ kind: 'info' });
    expect(notice).not.toHaveProperty('fix');
    expect(notice).not.toHaveProperty('user_message');
    const agent = renderCliNotices([renderNotice(notice!, cliRenderContext())], { json: false, tty: false }).stdout!;
    expect(agent).toContain('held on memory/unattributed');
    expect(agent).not.toContain('next:');
    expect(agent).not.toContain('[SHOW USER]');
    const receipt = await call(ctx, 'get_write_request', { request_id: single.request_id });
    expect(receipt.outcome.write_through).toEqual({ written: true, held_for: PAGELESS });
    expect(await factRows(engine, claim)).toMatchObject([{ entity_slug: PAGELESS, source_markdown_slug: HOLD, active: true }]);

    const budget = 'The remodel budget is 40,000 USD.';
    const { items } = await call(local, 'remember', { provenance: 'chat 2026-11-11', items: [
      { fact: 'Hana Example cycles to work.', entity: PAGED }, { fact: budget, entity: PAGELESS }] });
    expect(items[0]).toMatchObject({ page: PAGED, write_through: { written: true } });
    expect(items[0].write_through).not.toHaveProperty('held_for');
    expect(items[1]).toMatchObject({ status: 'inserted', page: HOLD, persistence: { mode: 'filesystem' }, write_through: { written: true, held_for: PAGELESS } });
    expect(notices.filter(n => n.code === 'entity_page_missing')).toHaveLength(2);
    for (const n of notices.filter(n => n.code === 'entity_page_missing')) expect(n).not.toHaveProperty('fix');
    expect(lineOf(head(root, HOLD_FILE), budget)).toContain(PAGELESS);

    // MCP shows a notice once per entity per session, so this entity is new.
    const garden = `notes/garden-plan-${randomUUID().slice(0, 8)}`;
    const contractor = 'The garden plan adds two raised beds.';
    const mcp = await overMcp(engine, { fact: contractor, entity: garden });
    expect(mcp.isError).toBe(false);
    expect(mcp.body).toMatchObject({ status: 'inserted', page: HOLD, write_through: { written: true, held_for: garden } });
    const heldBlock = mcp.blocks.find(text => text.startsWith('[gbrain notice entity_page_missing kind=info]'))!;
    expect(heldBlock).toContain(`held on ${HOLD}`);
    expect(heldBlock).not.toContain('next:');
    expect(heldBlock).not.toContain('put_page');
    expect(lineOf(head(root, HOLD_FILE), contractor)).toContain(garden);

    const rebuilt = await rebuild(root, databaseUrl, [claim, budget, contractor]);
    for (const text of [claim, budget]) expect(rebuilt[text]).toEqual([{ entity_slug: PAGELESS, source_markdown_slug: HOLD, active: true }]);
    expect(rebuilt[contractor]).toEqual([{ entity_slug: garden, source_markdown_slug: HOLD, active: true }]);
  }), 240_000);

  test('a second save of the same fact for the entity is a duplicate of the held one', () => strict(async ({ engine, ctx, root }) => {
    const claim = 'The kitchen remodel starts in March.';
    const first = await remember(ctx, claim, PAGELESS);
    const second = await remember(ctx, claim, PAGELESS);
    expect(second).toMatchObject({ status: 'duplicate', id: first.id });
    expect(await factRows(engine, claim)).toHaveLength(1);
    expect(head(root, HOLD_FILE).split('\n').filter(line => line.includes(claim))).toHaveLength(1);
  }), 180_000);

  test('once the page exists, maintenance moves the fact into it in one commit and strikes the holding row', () => strict(async ({ engine, ctx, root }) => {
    const claim = 'The kitchen remodel starts in March.';
    const saved = await remember(ctx, claim, PAGELESS);
    await putPage(ctx, PAGELESS, 'Kitchen remodel');
    await settleManagedGitEffects(engine);
    const before = git(root, 'rev-parse', 'HEAD').trim();
    const result = await runExtractFacts(engine, { sourceId: 'default' });
    expect(result.heldFactsMoved).toBe(1);
    expect(result.warnings.filter(w => w.startsWith('HELD_FACT_UNMOVABLE'))).toEqual([]);
    await settleManagedGitEffects(engine);
    // One commit carries both files.
    const changed = git(root, 'diff', '--name-only', before, 'HEAD').trim().split('\n').sort();
    expect(changed).toEqual([HOLD_FILE, `${PAGELESS}.md`]);
    expect(git(root, 'rev-list', '--count', `${before}..HEAD`).trim()).toBe('1');
    expect(lineOf(head(root, `${PAGELESS}.md`), claim)).toContain(`| 1 | ${claim} |`);
    expect(lineOf(head(root, HOLD_FILE), claim)).toContain(`~~${claim}~~`);
    expect(lineOf(head(root, HOLD_FILE), claim)).toContain(`moved to ${PAGELESS}`);
    // The row moved in place: same id and provenance. (The struck holding row projects as an expired row, as a rebuild has it.)
    expect((await factRows(engine, claim)).filter(row => row.active)).toMatchObject([{ id: Number(saved.id), entity_slug: PAGELESS, source_markdown_slug: PAGELESS, row_num: 1, active: true, source: 'chat 2026-11-11' }]);
    // Nothing left to move: a second run is a no-op.
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBeUndefined();
    const rebuilt = await rebuild(root, databaseUrl, [claim]);
    expect(rebuilt[claim]!.filter(row => row.active)).toEqual([{ entity_slug: PAGELESS, source_markdown_slug: PAGELESS, active: true }]);
  }), 240_000);

  test('a move interrupted after its door commit replays cleanly: the commit is kept and the fact moves once', () => strict(async ({ engine, ctx, root }) => {
    const claim = 'The kitchen remodel starts in March.';
    const saved = await remember(ctx, claim, PAGELESS);
    await putPage(ctx, PAGELESS, 'Kitchen remodel');
    await settleManagedGitEffects(engine);
    let crash = '';
    installFaultHook(async point => {
      if (point === 'publication:before_commit' && !crash) {
        crash = git(root, 'rev-parse', 'HEAD').trim();
        throw Object.assign(new Error('database interruption CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' });
      }
    });
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBe(1);
    installFaultHook(undefined);
    await settleManagedGitEffects(engine);
    expect(crash).not.toBe('');
    expect(git(root, 'log', '-1', '--format=%H', '--', `${PAGELESS}.md`).trim()).toBe(crash);
    expect(git(root, 'show', '--name-only', '--format=', crash).trim().split('\n').sort()).toEqual([HOLD_FILE, `${PAGELESS}.md`]);
    expect(head(root, `${PAGELESS}.md`).split('\n').filter(line => line.includes(claim))).toHaveLength(1);
    expect((await factRows(engine, claim)).filter(row => row.active)).toMatchObject([{ id: Number(saved.id), source_markdown_slug: PAGELESS, row_num: 1 }]);
    const rebuilt = await rebuild(root, databaseUrl, [claim]);
    expect(rebuilt[claim]!.filter(row => row.active)).toEqual([{ entity_slug: PAGELESS, source_markdown_slug: PAGELESS, active: true }]);
  }), 240_000);

  test('a move into a restricted page leaves nothing of the fact on the holding page', () => strict(async ({ engine, ctx, root }) => {
    const secret = 'notes/surprise-party';
    const claim = 'The surprise party is on Saturday.';
    await remember(ctx, claim, secret);
    await putPage(ctx, secret, 'Surprise party', 'readable_by: [alice-example]\n');
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBe(1);
    await settleManagedGitEffects(engine);
    expect(head(root, HOLD_FILE)).not.toContain(claim);
    expect(head(root, HOLD_FILE)).not.toContain(secret);
    expect(lineOf(head(root, `${secret}.md`), claim)).toContain(claim);
    const holding = await call(ctx, 'get_page', { slug: HOLD });
    expect(JSON.stringify(holding)).not.toContain(claim);
    const rebuilt = await rebuild(root, databaseUrl, [claim]);
    expect(rebuilt[claim]).toEqual([{ entity_slug: secret, source_markdown_slug: secret, active: true }]);
  }), 240_000);

  test('an entity under a folder access rule is not held on the world-readable page', () => strict(async ({ engine, ctx, root }) => {
    await engine.executeRaw(`INSERT INTO access_policy_state(source_id) VALUES('default') ON CONFLICT DO NOTHING`);
    await engine.executeRaw(`INSERT INTO access_rules(source_id,rule_id,prefix,readable_by,revision) VALUES('default','r1','secret/',ARRAY['member:alice-example'],1)`);
    const claim = 'The secret plan has a codename.';
    const saved = await remember(ctx, claim, 'secret/plan-x');
    expect(saved.write_through).not.toHaveProperty('held_for');
    expect(saved.persistence).toEqual({ mode: 'database' });
    expect(head(root, HOLD_FILE)).not.toContain(claim);
  }), 180_000);

  test('a segmented holding page reads its entity column: forget strikes the row and a rebuild keeps the rest', () => strict(async ({ engine, ctx, root }) => {
    const prose = Array.from({ length: 16000 }, (_, i) => `Line ${i} of a long note kept on the holding page so it is stored in segments.`).join('\n');
    await call(ctx, 'put_page', { slug: HOLD, content: `---\ntype: note\ntitle: Unattributed memory\n---\n\n${prose}\n` });
    const [shape] = await engine.executeRaw<{ segmented: boolean }>("SELECT compiled_truth IS NULL AS segmented FROM pages WHERE source_id='default' AND slug=$1", [HOLD]);
    expect(shape!.segmented).toBe(true);
    const loose = 'The spare key is with the neighbour.';
    const kept = 'The garden plan adds two raised beds.';
    const gone = 'The kitchen remodel starts in March.';
    await call(ctx, 'remember', { fact: loose, provenance: 'chat 2026-11-11', infer_entity: false });
    await remember(ctx, kept, 'notes/garden-plan');
    const saved = await remember(ctx, gone, PAGELESS);
    expect(saved.write_through).toEqual({ written: true, held_for: PAGELESS });
    const result = await runExtractFacts(engine, { sourceId: 'default' });
    expect(result.warnings.join('\n')).not.toContain('FACTS_TABLE_MALFORMED');
    const forgot = await call(ctx, 'forget', { id: String(saved.id) });
    expect(forgot.error).toBeUndefined();
    await settleManagedGitEffects(engine);
    expect(lineOf(head(root, HOLD_FILE), gone)).toContain(`~~${gone}~~`);
    const rebuilt = await rebuild(root, databaseUrl, [loose, kept, gone]);
    expect(rebuilt[loose]).toEqual([{ entity_slug: null, source_markdown_slug: HOLD, active: true }]);
    expect(rebuilt[kept]).toEqual([{ entity_slug: 'notes/garden-plan', source_markdown_slug: HOLD, active: true }]);
    expect(rebuilt[gone]!.filter(row => row.active)).toEqual([]);
  }), 300_000);

  test('a page kept out of Git does not take the fact: it stays held in Git and the run says why', () => strict(async ({ engine, ctx, root }) => {
    const secret = 'notes/surprise-party';
    const claim = 'The surprise party is on Saturday.';
    await remember(ctx, claim, secret);
    await putPage(ctx, secret, 'Surprise party', 'visibility: private\n');
    const result = await runExtractFacts(engine, { sourceId: 'default' });
    expect(result.heldFactsMoved).toBeUndefined();
    expect(result.warnings.filter(w => w.startsWith('HELD_FACT_UNMOVABLE'))).toEqual([expect.stringContaining(`${secret} facts `)]);
    expect(result.warnings.join('\n')).toContain('entity_page_database_only');
    expect(lineOf(head(root, HOLD_FILE), claim)).not.toContain('~~');
    expect((await factRows(engine, claim)).filter(row => row.active)).toMatchObject([{ entity_slug: secret, source_markdown_slug: HOLD }]);
  }), 240_000);

  test('forget strikes the held row, so a rebuild does not bring the fact back', () => strict(async ({ engine, ctx, root }) => {
    const claim = 'The kitchen remodel starts in March.';
    const other = 'The garden plan adds two raised beds.';
    const saved = await remember(ctx, claim, PAGELESS);
    await remember(ctx, other, 'notes/garden-plan');
    const forgot = await call(ctx, 'forget', { id: String(saved.id) });
    expect(forgot.error).toBeUndefined();
    await settleManagedGitEffects(engine);
    expect(lineOf(head(root, HOLD_FILE), claim)).toContain(`~~${claim}~~`);
    expect(await factRows(engine, claim)).toMatchObject([{ active: false }]);
    const rebuilt = await rebuild(root, databaseUrl, [claim, other]);
    expect(rebuilt[claim]!.filter(row => row.active)).toEqual([]);
    expect(rebuilt[other]).toEqual([{ entity_slug: 'notes/garden-plan', source_markdown_slug: HOLD, active: true }]);
  }), 240_000);

  test('purge removes a held fact from the file, as it removes a fact with no entity, so a rebuild does not bring it back', () => strict(async ({ engine, ctx, root }) => {
    const held = 'The kitchen remodel starts in March.';
    const loose = 'The spare key is with the neighbour.';
    const a = await remember(ctx, held, PAGELESS);
    const b = await call(ctx, 'remember', { fact: loose, provenance: 'chat 2026-11-11', infer_entity: false });
    for (const saved of [a, b]) {
      await settleManagedGitEffects(engine);
      const dry = await call(ctx, 'purge_fact', { id: Number(saved.id), dry_run: true });
      expect(await call(ctx, 'purge_fact', { id: Number(saved.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision })).toMatchObject({ state: 'committed' });
    }
    await settleManagedGitEffects(engine);
    expect(head(root, HOLD_FILE)).not.toContain(held);
    expect(head(root, HOLD_FILE)).not.toContain(loose);
    expect(await factRows(engine, held)).toEqual([]);
    const rebuilt = await rebuild(root, databaseUrl, [held, loose]);
    expect(rebuilt[held]!.filter(row => row.active)).toEqual([]);
    expect(rebuilt[loose]!.filter(row => row.active)).toEqual([]);
  }), 240_000);

  test('supersede: held by held, and held by an entity page row before the move, each survive a rebuild', () => strict(async ({ engine, ctx, root }) => {
    const a = 'The kitchen remodel starts in March.';
    const b = 'The kitchen remodel starts in April.';
    const first = await remember(ctx, a, PAGELESS);
    expect(await remember(ctx, b, PAGELESS, { replaces: String(first.id) })).toMatchObject({ status: 'superseded', page: HOLD });
    const c = 'The pond plan needs a liner.';
    const d = 'The pond plan needs a pump.';
    const pond = 'notes/pond-plan';
    const third = await remember(ctx, c, pond);
    await putPage(ctx, pond, 'Pond plan');
    expect(await remember(ctx, d, pond, { replaces: String(third.id) })).toMatchObject({ status: 'superseded', page: pond });
    await settleManagedGitEffects(engine);
    const rebuilt = await rebuild(root, databaseUrl, [a, b, c, d]);
    expect(rebuilt[a]!.filter(row => row.active)).toEqual([]);
    expect(rebuilt[b]).toEqual([{ entity_slug: PAGELESS, source_markdown_slug: HOLD, active: true }]);
    expect(rebuilt[c]!.filter(row => row.active)).toEqual([]);
    expect(rebuilt[d]).toEqual([{ entity_slug: pond, source_markdown_slug: pond, active: true }]);
  }), 240_000);

  test('a prefix-bound caller saves a held fact for an entity inside its prefix; with no entity it is refused as before', () => strict(async ({ engine, root }) => {
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,bound_slug_prefixes)
      VALUES ('bound-example','Synthetic bound client','read write','default',$1::text[])`, [['notes/']]);
    const auth = { token: 't', clientId: 'bound-example', principal: { kind: 'oauth_client', id: 'bound-example' },
      scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes/'] } as unknown as AuthInfo;
    const claim = 'The kitchen remodel starts in March.';
    const inside = await overMcp(engine, { fact: claim, entity: PAGELESS }, auth);
    expect(inside.isError).toBe(false);
    expect(inside.body).toMatchObject({ status: 'inserted', page: HOLD, write_through: { written: true, held_for: PAGELESS } });
    expect(lineOf(head(root, HOLD_FILE), claim)).toContain(PAGELESS);
    const outside = await overMcp(engine, { fact: 'Someone likes hiking.', entity: 'people/someone-example' }, auth);
    expect(outside.body.error).toBe('scope_denied');
    const none = await overMcp(engine, { fact: 'A stray thought.' }, auth);
    expect(none.body.error).toBe('scope_denied');
    expect(none.body.message).toContain(`slug '${HOLD}' is not under`);
  }), 180_000);

  test("the owner's own credential holds a pageless fact shared in Git, its forget strikes it, and the host's purge removes it", () => strict(async ({ engine, ctx, root }) => {
    const owner = await ownerAuth(engine);
    const forgotten = 'The kitchen remodel starts in March.';
    const purged = 'The kitchen remodel needs a permit.';
    const saved = await asOwner(engine, owner, 'remember', { fact: forgotten, entity: PAGELESS, provenance: 'chat 2026-11-11' });
    expect(saved.isError ? saved.text : 'ok').toBe('ok');
    expect(saved.body).toMatchObject({ status: 'inserted', page: HOLD, visibility: 'world', persistence: { mode: 'filesystem' },
      write_through: { written: true, held_for: PAGELESS } });
    expect(lineOf(head(root, HOLD_FILE), forgotten)).toContain(PAGELESS);
    expect(await factRows(engine, forgotten)).toMatchObject([{ entity_slug: PAGELESS, source_markdown_slug: HOLD, active: true }]);
    const forgot = await asOwner(engine, owner, 'forget', { id: String(saved.body.id) });
    expect(forgot.isError ? forgot.text : 'ok').toBe('ok');
    await settleManagedGitEffects(engine);
    expect(lineOf(head(root, HOLD_FILE), forgotten)).toContain(`~~${forgotten}~~`);
    expect(await factRows(engine, forgotten)).toMatchObject([{ active: false }]);

    const second = await asOwner(engine, owner, 'remember', { fact: purged, entity: PAGELESS, provenance: 'chat 2026-11-11' });
    expect(second.body).toMatchObject({ page: HOLD, write_through: { written: true, held_for: PAGELESS } });
    const remote = await asOwner(engine, owner, 'purge_fact', { id: Number(second.body.id), dry_run: true });
    expect([remote.isError, remote.text.includes('trusted_local_only')]).toEqual([true, true]);
    await settleManagedGitEffects(engine);
    const dry = await call(ctx, 'purge_fact', { id: Number(second.body.id), dry_run: true });
    expect(await call(ctx, 'purge_fact', { id: Number(second.body.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision })).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    expect(head(root, HOLD_FILE)).not.toContain(purged);
    expect(await factRows(engine, purged)).toEqual([]);
    const rebuilt = await rebuild(root, databaseUrl, [forgotten, purged]);
    expect(rebuilt[forgotten]!.filter(row => row.active)).toEqual([]);
    expect(rebuilt[purged]!.filter(row => row.active)).toEqual([]);
  }), 300_000);

  test("the owner's forget strikes a private fact the brain host saved for a pageless entity, and a rebuild keeps it withdrawn", () => strict(async ({ engine, ctx, root }) => {
    const owner = await ownerAuth(engine);
    const kept = 'The kitchen remodel budget is private.';
    const saved = await call(ctx, 'remember', { fact: kept, entity: PAGELESS, provenance: 'chat 2026-11-11', visibility: 'private', request_id: randomUUID() });
    expect(saved).toMatchObject({ status: 'inserted', write_through: { written: true, held_for: PAGELESS } });
    await settleManagedGitEffects(engine);
    expect(lineOf(head(root, HOLD_FILE), kept)).toContain('| private |');
    expect(await factRows(engine, kept)).toMatchObject([{ entity_slug: PAGELESS, source_markdown_slug: HOLD, active: true }]);
    const forgot = await asOwner(engine, owner, 'forget', { id: String(saved.id) });
    expect(forgot.isError ? forgot.text : 'ok').toBe('ok');
    await settleManagedGitEffects(engine);
    expect(lineOf(head(root, HOLD_FILE), kept)).toContain(`~~${kept}~~`);
    expect(await factRows(engine, kept)).toMatchObject([{ active: false }]);
    expect((await rebuild(root, databaseUrl, [kept]))[kept]!.filter(row => row.active)).toEqual([]);
  }), 300_000);
});

describe('the entity column of the facts fence (GST-2492)', () => {
  const table = (entity: string) => [
    '## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | entity |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------|',
    `| 1 | The remodel starts in March. | fact | 1.0 | world | medium | 2026-11-11 |  | chat |  | ${entity} |`,
    '<!--- gbrain:facts:end -->', ''].join('\n');
  test('memory/unattributed reads the entity; an invalid entity cell makes the fence malformed', () => {
    const ok = fence.parseFactsFenceFor(table(PAGELESS), { slug: HOLD });
    expect(ok.warnings).toEqual([]);
    expect(ok.facts[0]).toMatchObject({ rowNum: 1, entity: PAGELESS });
    for (const bad of ['Not A Slug!', HOLD]) {
      const parsed = fence.parseFactsFenceFor(table(bad), { slug: HOLD });
      expect(parsed.warnings.join('\n')).toContain('FACTS_TABLE_MALFORMED');
      // The canonical scan import and sync run holds such a page as a fence defect.
      expect(scanCanonicalFences({ compiled_truth: table(bad), timeline: '', slug: HOLD }).defects).toMatchObject([{ fence: 'facts' }]);
    }
  });
  test('an entity header on any other page parses exactly as before', () => {
    const body = table(PAGELESS);
    expect(fence.parseFactsFenceFor(body, { slug: PAGED })).toEqual(fence.parseFactsFence(body));
    expect(fence.parseFactsFenceFor(body, {})).toEqual(fence.parseFactsFence(body));
    expect(fence.parseFactsFence(body).facts.some(f => 'entity' in f && f.entity !== undefined)).toBe(false);
    expect(scanCanonicalFences({ compiled_truth: body, timeline: '', slug: PAGED })).toEqual(scanCanonicalFences({ compiled_truth: body, timeline: '' }));
  });
});
