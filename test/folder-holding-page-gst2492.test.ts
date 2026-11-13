/**
 * GST-2492 (last PR): the folder-rule holding page on a strict source.
 *
 * 1. Protects: on a source whose pages are canonical in Git, a fact for an entity with no page that a folder access rule
 *    covers is held on the holding page of the entity's own folder (partners/alice-example/deal-notes on
 *    partners/alice-example/memory/unattributed), committed through the door before its row, with exactly the entity's
 *    readers: every prefix rule covering the entity covers that page by path, a pending narrowing too. A rebuild from a
 *    clone of HEAD keeps it; the upkeep move takes it into the entity's page once that exists. A folder rule's own apply
 *    moves the held facts it starts covering off the shared memory/unattributed (its preview counts them), leaving nothing
 *    there but the note "moved". The owner reads every holding page as the product defines (the opt-in on, or named by
 *    the rules). A folder under storage.db_only or a path Git ignores gets a database-only holding page, never committed.
 *    An exact page rule on the entity refuses git_home_required (facts_lane) and an unreadable access state answers wait,
 *    never storage_error. gbrain repair facts-home moves older database-only facts of such entities to that page.
 * 2. Fails when: a ruled entity's fact stays database-only on a strict source, is named on the world-readable page, a
 *    caller outside the rules reads or learns of the holding page, a narrowing leaves a held row readable by a member it
 *    excludes, the owner is shut out, a database-only folder's holding page is committed, or a refusal reads storage_error.
 * 3. Existing coverage: test/remember-strict-held-gst2492.test.ts (the shared page), test/repair-facts-home-gst2492.test.ts.
 * 4. Real seams: the coordinated write and the write door on PGLite and Postgres (DATABASE_URL), a managed Git checkout, the
 *    operation handler as the local CLI calls it, MCP dispatch with member-bound and owner-bound tokens, the access rule CLI
 *    (git store), the policy engine (database store), and a rebuild of a fresh database from a clone of HEAD.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { performSync } from '../src/commands/sync.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFenceFor } from '../src/core/facts-fence.ts';
import { isFactEntityPage, isIdentityEntity } from '../src/core/entities/resolve.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { scanFactsHome } from '../src/core/facts/facts-home.ts';
import { folderRulesAllow, serializePolicyYaml, type FolderRule } from '../src/core/access/folder-rules.ts';
import { policySeams, proposeRevision, resumePolicy } from '../src/core/access/policy.ts';
import { commitPolicyFile, POLICY_FILE } from '../src/core/access/policy-git.ts';
import { identityFor } from '../src/core/access/principals.ts';
import { setOwner, setOwnerReadsRestricted } from '../src/core/access/owner.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const ENTITY = 'partners/alice-example/deal-notes';
const FOLDER_HOLD = 'partners/alice-example/memory/unattributed';
const page = (title: string, extra = '') => `---\ntype: note\ntitle: ${title}\n${extra}---\n\nNotes about ${title}.\n`;
const gitRepo = (ignored = '') => ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), `${ignored}\n`); durableGitRepo(root, ['.gitignore']); };
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const remember = (ctx: OperationContext, fact: string, entity: string) => call(ctx, 'remember', { fact, entity, provenance: 'chat 2026-11-12' });
const head = (root: string, file: string) => { try { return git(root, 'show', `HEAD:${file}`); } catch { return ''; } };
const everCommitted = (root: string, path: string) => git(root, 'log', '--all', '--format=%H', '--', path).trim() !== '';
const factRows = (engine: BrainEngine, claim: string) => engine.executeRaw<{ id: number; entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null }>(
  `SELECT id::int AS id, entity_slug, source_markdown_slug, row_num FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL ORDER BY id`, [claim]);
const rule = (id: string, prefix: string, readers: string[]): FolderRule => ({ id, prefix, readable_by: readers.map(r => (r.includes(':') ? r : `member:${r}`)).sort() });
const caught = <T>(p: Promise<T>) => p.then(() => null, (error: Record<string, any>) => error);

/** A fresh database indexed from a clone of HEAD, with the facts step run: the active rows of each claim. */
async function rebuild(root: string, databaseUrl: string | undefined, claims: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'gst2492-folder-rebuild-'));
  try {
    const clone = join(home, 'content');
    git(home, 'clone', '--quiet', root, clone);
    const fresh = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await fresh.engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [clone]);
      await performSync(fresh.engine, { sourceId: 'default', repoPath: clone, noPull: true, noEmbed: true } as never);
      await runExtractFacts(fresh.engine, { sourceId: 'default' });
      const out: Record<string, Array<{ entity_slug: string | null; source_markdown_slug: string | null }>> = {};
      for (const claim of claims) out[claim] = (await factRows(fresh.engine, claim)).map(({ entity_slug, source_markdown_slug }) => ({ entity_slug, source_markdown_slug }));
      return out;
    } finally { await fresh.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Members alice-example, bob-example and carol-example (bob and alice in group team-a), each with a remote token. */
async function members(engine: BrainEngine): Promise<(who: string, op: string, params: Record<string, unknown>) => Promise<{ isError: boolean; text: string; body: Record<string, any> }>> {
  const tokens: Record<string, string> = {};
  for (const id of ['alice-example', 'bob-example', 'carol-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  await engine.executeRaw("INSERT INTO access_groups (id) VALUES ('team-a') ON CONFLICT DO NOTHING");
  for (const m of ['alice-example', 'bob-example']) await engine.executeRaw("INSERT INTO access_group_members (group_id, member_id) VALUES ('team-a', $1) ON CONFLICT DO NOTHING", [m]);
  for (const [name, member] of [['alice', 'alice-example'], ['bob', 'bob-example'], ['carol', 'carol-example'], ['unbound', null]] as const) {
    const minted = await mintLegacyToken(engine, { name: `${name}-${randomUUID().slice(0, 6)}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['default'] });
    tokens[name] = minted.token;
    if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
    else await readsUnscopedOnPurpose(engine, minted.id);
  }
  __resetPrivateVisibilityCacheForTests();
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  return async (who, op, params) => {
    const auth = await provider.verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, 'default');
    const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'],
      ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    const text = out.content.map(c => c.text).join('\n');
    let body: Record<string, any> = {};
    try { body = JSON.parse(out.content[0]!.text); } catch { /* not JSON */ }
    return { isError: out.isError === true, text, body };
  };
}
type Reader = Awaited<ReturnType<typeof members>>;

/** Whether `who` reads page `slug` (get_page) and finds `claim` by keyword search. */
async function reads(as: Reader, who: string, slug: string, claim: string) {
  const got = await as(who, 'get_page', { slug });
  const found = await as(who, 'search', { query: claim, match: 'keyword', fields: 'full', limit: 20 });
  return { page: !got.isError && got.text.includes(slug), fact: JSON.stringify(found.body).includes(claim) };
}

async function cli(engine: BrainEngine, args: string[]): Promise<Record<string, any>> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runAccessRules(engine, args[0]!, args.slice(1), true); } finally { spy.mockRestore(); }
  return JSON.parse(lines.join('\n'));
}

describe('a folder holding page reads the entity column of its own folder only', () => {
  const row = (entity: string) => ['## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | entity |',
    '|---|---|---|---|---|---|---|---|---|---|---|', `| 1 | The deal closes in May. | fact | 1.0 | world | medium | 2026-11-12 |  | chat |  | ${entity} |`, '<!--- gbrain:facts:end -->', ''].join('\n');
  test('an entity of the folder parses; one of another folder is a fence problem', () => {
    expect(parseFactsFenceFor(row(ENTITY), { slug: FOLDER_HOLD })).toMatchObject({ warnings: [], facts: [{ entity: ENTITY }] });
    expect(parseFactsFenceFor(row('people/bob-example'), { slug: FOLDER_HOLD }).warnings.join(' ')).toContain('invalid entity');
    expect(parseFactsFenceFor(row('people/bob-example'), { slug: HOLD })).toMatchObject({ warnings: [], facts: [{ entity: 'people/bob-example' }] });
  });
  test('a holding page under an entity directory is never an entity page itself', () => {
    expect(isIdentityEntity('people/memory/unattributed')).toBe(false);
    expect(isFactEntityPage('deals/memory/unattributed', null)).toBe(false);
    expect(isIdentityEntity('people/alice-example')).toBe(true);
  });
});

for (const backend of testBackends()) describe(`[${backend}] the folder-rule holding page on a strict source (GST-2492)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => { policySeams.afterInstall = undefined; });
  const strict = (run: (brain: ManagedBrain) => Promise<void>, ignored = '') => managedBrain(async brain => {
    await brain.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await run(brain);
  }, { databaseUrl, setup: gitRepo(ignored) });
  const rules = (engine: BrainEngine, list: FolderRule[], approved = false) => proposeRevision(engine, 'default', list, { origin: 'cli', store: 'database', approved });

  test('a ruled entity is held on its folder\'s page in Git before the reply; a rebuild keeps it; the move takes it into the page', () => strict(async ({ engine, ctx, root }) => {
    await rules(engine, [rule('partners', 'partners/', ['alice-example'])]);
    const claim = 'The deal with acme-example closes in May.';
    const saved = await remember(ctx, claim, ENTITY);
    expect(saved).toMatchObject({ status: 'inserted', page: FOLDER_HOLD, persistence: { mode: 'filesystem' }, write_through: { written: true, held_for: ENTITY } });
    expect(head(root, `${FOLDER_HOLD}.md`).split('\n').find(line => line.includes(claim))).toContain(ENTITY);
    expect(head(root, `${HOLD}.md`)).not.toContain(claim);
    expect(await factRows(engine, claim)).toMatchObject([{ entity_slug: ENTITY, source_markdown_slug: FOLDER_HOLD }]);
    expect((await rebuild(root, databaseUrl, [claim]))[claim]).toEqual([{ entity_slug: ENTITY, source_markdown_slug: FOLDER_HOLD }]);
    await call(ctx, 'put_page', { slug: ENTITY, content: page('Deal notes') });
    await settleManagedGitEffects(engine);
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBe(1);
    await settleManagedGitEffects(engine);
    expect(head(root, `${ENTITY}.md`)).toContain(claim);
    expect(head(root, `${FOLDER_HOLD}.md`)).not.toContain(claim);
    expect(await factRows(engine, claim)).toMatchObject([{ id: Number(saved.id), entity_slug: ENTITY, source_markdown_slug: ENTITY }]);
    expect((await rebuild(root, databaseUrl, [claim]))[claim]).toEqual([{ entity_slug: ENTITY, source_markdown_slug: ENTITY }]);
  }), 300_000);

  test('the holding page has exactly the entity\'s would-be readers under three nested rules, and reads as nobody while a rule is pending', () => strict(async ({ engine, ctx }) => {
    const as = await members(engine);
    const nested = [rule('partners', 'partners/', ['group:team-a', 'carol-example']), rule('alice', 'partners/alice-example/', ['alice-example', 'bob-example']),
      rule('deals', 'partners/alice-example/deals/', ['alice-example'])];
    await rules(engine, nested);
    const entity = 'partners/alice-example/deals/q3-plan';
    const holding = 'partners/alice-example/deals/memory/unattributed';
    const claim = 'The q3 plan doubles the budget.';
    expect(await remember(ctx, claim, entity)).toMatchObject({ page: holding, write_through: { held_for: entity } });
    await call(ctx, 'put_page', { slug: 'partners/alice-example/deals/probe', content: page('Probe') });
    const groups: Record<string, string[]> = { 'alice-example': ['team-a'], 'bob-example': ['team-a'], 'carol-example': [] };
    for (const [who, member] of [['alice', 'alice-example'], ['bob', 'bob-example'], ['carol', 'carol-example']] as const) {
      const wouldRead = folderRulesAllow(entity, nested, identityFor(member, groups[member]!));
      const probe = await as(who, 'get_page', { slug: 'partners/alice-example/deals/probe' });
      expect(!probe.isError).toBe(wouldRead);
      expect(await reads(as, who, holding, claim)).toEqual({ page: wouldRead, fact: wouldRead });
    }
    // alice satisfies all three, bob two of three, carol only the outermost.
    expect([true, false, false]).toEqual(['alice-example', 'bob-example', 'carol-example'].map(m => folderRulesAllow(entity, nested, identityFor(m, groups[m]!))));

    policySeams.afterInstall = () => { throw new Error('interrupted'); };
    await expect(rules(engine, [...nested, rule('acme', 'clients/acme-example/', ['alice-example'])])).rejects.toThrow('interrupted');
    policySeams.afterInstall = undefined;
    const pending = 'The acme-example brief is due Friday.';
    expect(await remember(ctx, pending, 'clients/acme-example/brief')).toMatchObject({ page: 'clients/acme-example/memory/unattributed' });
    await call(ctx, 'put_page', { slug: 'clients/acme-example/probe', content: page('Probe') });
    for (const who of ['alice', 'bob', 'carol']) {
      expect((await as(who, 'get_page', { slug: 'clients/acme-example/probe' })).isError).toBe(true);
      expect(await reads(as, who, 'clients/acme-example/memory/unattributed', pending)).toEqual({ page: false, fact: false });
    }
    await resumePolicy(engine, 'default');
    for (const who of ['alice', 'bob', 'carol']) {
      const wouldRead = who === 'alice';
      expect(!(await as(who, 'get_page', { slug: 'clients/acme-example/probe' })).isError).toBe(wouldRead);
      expect(await reads(as, who, 'clients/acme-example/memory/unattributed', pending)).toEqual({ page: wouldRead, fact: wouldRead });
    }
  }), 300_000);

  test('a caller who cannot read the folder gets the answer of a page that does not exist, on every read path', () => strict(async ({ engine, ctx }) => {
    const as = await members(engine);
    await rules(engine, [rule('partners', 'partners/', ['alice-example'])]);
    const claim = 'The acme-example deal has a break fee.';
    expect(await remember(ctx, claim, ENTITY)).toMatchObject({ page: FOLDER_HOLD });
    const missing = 'partners/alice-example/nothing-here';
    for (const who of ['bob', 'unbound']) {
      const held = await as(who, 'get_page', { slug: FOLDER_HOLD });
      const none = await as(who, 'get_page', { slug: missing });
      expect(held.isError).toBe(true);
      expect(held.text.replaceAll(FOLDER_HOLD, '<slug>')).toBe(none.text.replaceAll(missing, '<slug>'));
      for (const [op, params] of [['search', { query: claim, match: 'keyword', fields: 'full' }], ['query', { query: claim }], ['recall', { query: 'acme-example deal break fee' }],
        ['list_pages', { slug_prefix: 'partners/' }], ['find_pages', { pattern: 'partners/**' }], ['find_pages', { pattern: 'unattributed' }]] as const) {
        const out = await as(who, op, params as Record<string, unknown>);
        expect(out.text).not.toContain(claim);
        expect(out.text).not.toContain(FOLDER_HOLD);
      }
    }
    const alice = await as('alice', 'find_pages', { pattern: 'partners/**' });
    expect(alice.text).toContain(FOLDER_HOLD);
    expect((await reads(as, 'alice', FOLDER_HOLD, claim)).fact).toBe(true);
  }), 300_000);

  test('a raw-only rule (covers_derived false) still hides the held facts on its folder\'s page, as the entity\'s own page would', () => strict(async ({ engine, ctx }) => {
    const as = await members(engine);
    await rules(engine, [{ ...rule('partners', 'partners/', ['alice-example']), covers_derived: false }]);
    const claim = 'The acme-example deal has a side letter.';
    expect(await remember(ctx, claim, ENTITY)).toMatchObject({ page: FOLDER_HOLD });
    for (const who of ['bob', 'unbound']) {
      expect(await reads(as, who, FOLDER_HOLD, claim)).toEqual({ page: false, fact: false });
      for (const [op, params] of [['query', { query: claim }], ['recall', { query: 'acme-example deal side letter' }]] as const) {
        expect((await as(who, op, params as Record<string, unknown>)).text).not.toContain(claim);
      }
    }
    expect(await reads(as, 'alice', FOLDER_HOLD, claim)).toEqual({ page: true, fact: true });
  }), 300_000);

  test('a rule applied without the CLI edit keeps a shared held fact row from non-readers until the move; resume moves it', () => strict(async ({ engine, ctx }) => {
    const as = await members(engine);
    const entity = 'clients/acme-example/brief';
    const claim = 'The acme-example brief has a hidden clause.';
    expect(await remember(ctx, claim, entity)).toMatchObject({ page: HOLD });
    policySeams.afterInstall = () => { throw new Error('interrupted'); };
    await expect(rules(engine, [rule('clients', 'clients/acme-example/', ['alice-example'])])).rejects.toThrow('interrupted');
    policySeams.afterInstall = undefined;
    __resetPrivateVisibilityCacheForTests();
    const recalls = async (who: string, text: string, query: string) => JSON.stringify((await as(who, 'recall', { query, question: query })).body.facts ?? []).includes(text);
    // The shared page's body keeps the row until the move; its fact row reads as the entity's page would (pending: nobody).
    for (const who of ['alice', 'bob', 'unbound']) expect([who, await recalls(who, claim, 'acme-example brief clause')]).toEqual([who, false]);
    const resumed = await cli(engine, ['resume', '--source', 'default', '--json']);
    expect(resumed.held_facts).toEqual({ moved: 1, unmovable: [] });
    expect(await factRows(engine, claim)).toMatchObject([{ entity_slug: entity, source_markdown_slug: 'clients/acme-example/memory/unattributed' }]);
    __resetPrivateVisibilityCacheForTests();
    const late = 'The acme-example brief names a second clause.';
    await call(ctx, 'put_page', { slug: 'notes/acme-example-late', content: page('Late') });
    expect(await remember(ctx, late, 'clients/acme-example/terms')).toMatchObject({ page: 'clients/acme-example/memory/unattributed' });
    const other = 'The beta-example plan has a hidden clause.';
    expect(await remember(ctx, other, 'clients/beta-example/plan')).toMatchObject({ page: HOLD });
    await rules(engine, [rule('clients', 'clients/acme-example/', ['alice-example']), rule('beta', 'clients/beta-example/', ['alice-example'])]);
    __resetPrivateVisibilityCacheForTests();
    expect(await recalls('bob', other, 'beta-example plan clause')).toBe(false);
    expect(await recalls('unbound', other, 'beta-example plan clause')).toBe(false);
    expect(await recalls('alice', other, 'beta-example plan clause')).toBe(true);
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBe(1);
    expect(await reads(as, 'bob', 'clients/beta-example/memory/unattributed', other)).toEqual({ page: false, fact: false });
    expect((await as('bob', 'get_page', { slug: HOLD })).text).not.toContain('beta-example');
  }), 300_000);

  const versionBodies = (engine: BrainEngine, slug: string) => engine.executeRaw<{ id: number; body: string }>(
    `SELECT v.id::int AS id, COALESCE(v.compiled_truth, '') || '\u0001' || COALESCE(v.timeline, '') AS body FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = 'default' AND p.slug = $1 ORDER BY v.id`, [slug]);
  const versionsText = async (as: Reader, who: string, slug: string) => (await as(who, 'get_versions', { slug, include_body: true, limit: 50 })).text;
  const auditRows = (engine: BrainEngine) => engine.executeRaw<{ audit: Record<string, unknown> }>(
    `SELECT outcome->'held_versions_edited' AS audit FROM persistence_requests WHERE outcome ? 'held_versions_edited' ORDER BY created_at`);

  test('a rule\'s apply removes the moved rows from the shared page\'s saved versions, byte for byte, once, with an audit record', () => strict(async ({ engine, ctx, root }) => {
    const as = await members(engine);
    await setOwner(engine, 'carol-example');
    const entity = 'clients/acme-example/brief';
    const holding = 'clients/acme-example/memory/unattributed';
    const claim = 'The acme-example brief carries a quiet clause.';
    const kept = 'The garden plan adds a third raised bed.';
    await remember(ctx, claim, entity);
    await remember(ctx, kept, 'notes/garden-plan');
    await remember(ctx, 'The garden plan needs more compost.', 'notes/garden-plan');
    await settleManagedGitEffects(engine);
    for (const who of ['bob', 'unbound']) expect(await versionsText(as, who, HOLD)).toContain(claim);
    // A saved version with no timeline keeps none (NULL, not an empty string) once its row is removed.
    await engine.executeRaw("UPDATE page_versions SET timeline = NULL WHERE page_id = (SELECT id FROM pages WHERE source_id = 'default' AND slug = $1)", [HOLD]);
    const nullTimelines = () => engine.executeRaw<{ id: number }>(`SELECT v.id::int AS id FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = 'default' AND p.slug = $1 AND v.timeline IS NULL ORDER BY v.id`, [HOLD]);
    const untimed = await nullTimelines();
    const before = await versionBodies(engine, HOLD);
    const preview = await cli(engine, ['rule', 'add', '--prefix', 'clients/acme-example/', '--readers', 'alice-example', '--source', 'default', '--json']);
    const carrying = before.filter(v => v.body.includes(claim)).length;
    expect(carrying).toBeGreaterThan(0);
    // The preview counts what the apply's receipt records: the versions carrying the row now, plus the one the move saves.
    expect(preview.held_versions_editing).toEqual({ rows: carrying + 1, versions: carrying + 1, pages: [{ slug: HOLD, rows: carrying + 1, versions: carrying + 1 }] });
    const applied = await cli(engine, ['rule', 'add', '--prefix', 'clients/acme-example/', '--readers', 'alice-example', '--source', 'default', '--yes', '--expect', String(preview.expect), '--json']);
    expect(applied.held_facts).toEqual({ moved: 1, unmovable: [] });
    await settleManagedGitEffects(engine);
    const after = new Map((await versionBodies(engine, HOLD)).map(v => [v.id, v.body]));
    for (const v of before) {
      expect(after.get(v.id)).toBe(v.body.split('\n').filter(line => !line.includes(claim)).join('\n'));
    }
    expect(untimed.length).toBe(before.length);
    expect((await nullTimelines()).filter(v => untimed.some(u => u.id === v.id))).toEqual(untimed);
    expect([...after.values()].some(body => body.includes(kept))).toBe(true);
    const [fact] = await factRows(engine, claim);
    // The audit counts the versions the preview listed plus the one the move itself saved (the shared page before the move).
    expect((await auditRows(engine)).map(r => r.audit)).toEqual([{ slug: HOLD, moved_to: holding, fact_ids: [fact!.id], rows: carrying + 1, versions: carrying + 1 }]);
    for (const who of ['bob', 'unbound']) {
      const text = await versionsText(as, who, HOLD);
      expect(text).not.toContain(claim);
      expect(text).not.toContain('clients/acme-example');
      expect(text).toContain(kept);
    }
    await setOwnerReadsRestricted(engine, true, { remote: false });
    __resetPrivateVisibilityCacheForTests();
    expect(await reads(as, 'carol', holding, claim)).toEqual({ page: true, fact: true });
    expect(await reads(as, 'alice', holding, claim)).toEqual({ page: true, fact: true });
    // Git history is never rewritten: the shared page's earlier commit still holds the row.
    expect(git(root, 'log', '-p', '--format=%H', '--', `${HOLD}.md`)).toContain(claim);
    // A second apply finds nothing to move and edits nothing.
    const again = await cli(engine, ['rule', 'add', '--prefix', 'clients/acme-example/', '--readers', 'alice-example', '--source', 'default', '--json']);
    expect(again.held_versions_editing).toEqual({ rows: 0, versions: 0 });
    expect((await cli(engine, ['resume', '--source', 'default', '--json'])).held_facts).toBeUndefined();
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved ?? 0).toBe(0);
    expect(new Map((await versionBodies(engine, HOLD)).map(v => [v.id, v.body]))).toEqual(after);
    expect(await auditRows(engine)).toHaveLength(1);
  }), 300_000);

  test('a rule that arrives by sync moves the held facts right after the sync, beside a write in flight; after a crash, maintenance moves them', () => strict(async ({ engine, ctx, root }) => {
    const as = await members(engine);
    const moveModule = await import('../src/core/facts/held-fact-move.ts');
    const original = moveModule.moveRuledSharedHeld;
    const claim = 'The acme-example brief carries a synced clause.';
    const crashed = 'The beta-example plan carries a synced clause.';
    await remember(ctx, claim, 'clients/acme-example/brief');
    await remember(ctx, crashed, 'clients/beta-example/plan');
    await settleManagedGitEffects(engine);
    const policy = (rules: FolderRule[]) => commitPolicyFile(root, POLICY_FILE, () => serializePolicyYaml(rules), 'access: rule');
    const sync = () => performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true } as never);
    // A write on the shared page is in flight while the post-sync move runs; both finish.
    const inFlight = 'The garden plan has a fourth bed.';
    let write: Promise<unknown> | null = null;
    const spy = spyOn(moveModule, 'moveRuledSharedHeld').mockImplementation(async (e, s) => { write = remember(ctx, inFlight, 'notes/garden-plan'); return original(e, s); });
    try {
      policy([rule('acme', 'clients/acme-example/', ['alice-example'])]);
      await sync();
      expect(write).not.toBeNull();
      await write;
    } finally { spy.mockRestore(); }
    expect(await factRows(engine, claim)).toMatchObject([{ source_markdown_slug: 'clients/acme-example/memory/unattributed' }]);
    expect(await factRows(engine, inFlight)).toMatchObject([{ source_markdown_slug: HOLD }]);
    for (const who of ['bob', 'unbound']) expect(await versionsText(as, who, HOLD)).not.toContain(claim);
    // The sync finishes and the process dies before the move: the rows wait on the shared page until maintenance moves them.
    const died = spyOn(moveModule, 'moveRuledSharedHeld').mockImplementation(async () => { throw new Error('process died'); });
    try {
      policy([rule('acme', 'clients/acme-example/', ['alice-example']), rule('beta', 'clients/beta-example/', ['alice-example'])]);
      await sync();
    } finally { died.mockRestore(); }
    expect(await factRows(engine, crashed)).toMatchObject([{ source_markdown_slug: HOLD }]);
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBe(1);
    expect(await factRows(engine, crashed)).toMatchObject([{ source_markdown_slug: 'clients/beta-example/memory/unattributed' }]);
    for (const who of ['bob', 'unbound']) {
      expect(await versionsText(as, who, HOLD)).not.toContain(crashed);
      expect((await as(who, 'get_page', { slug: HOLD })).text).not.toContain('beta-example');
    }
  }), 300_000);

  test('an exact page rule\'s apply creates the entity\'s page through the write door (Git before its row) and the preview names it', () => strict(async ({ engine, ctx, root }) => {
    const entity = 'notes/secret-brief';
    const claim = 'The secret brief names a launch date.';
    expect(await remember(ctx, claim, entity)).toMatchObject({ page: HOLD });
    await settleManagedGitEffects(engine);
    const preview = await cli(engine, ['rule', 'add', '--slug', entity, '--readers', 'alice-example', '--source', 'default', '--json']);
    expect(preview.held_facts_moving).toEqual([{ fact_id: expect.any(Number), entity_slug: entity, from: HOLD, to: entity }]);
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try { await runAccessRules(engine, 'rule', ['add', '--slug', entity, '--readers', 'alice-example', '--source', 'default'], false); } finally { spy.mockRestore(); }
    expect(lines.join('\n')).toContain(`to ${entity} (its page)`);
    const applied = await cli(engine, ['rule', 'add', '--slug', entity, '--readers', 'alice-example', '--source', 'default', '--yes', '--expect', String(preview.expect), '--json']);
    expect(applied.held_facts).toEqual({ moved: 1, unmovable: [] });
    expect(head(root, `${entity}.md`)).toContain(claim);
    const [created] = await engine.executeRaw<{ outcome: Record<string, any> }>(
      `SELECT outcome FROM persistence_requests WHERE slug = $1 AND operation = 'put_page' AND state = 'committed' ORDER BY created_at LIMIT 1`, [entity]);
    expect(created!.outcome.persistence).toMatchObject({ mode: 'filesystem', git_state: 'committed', git_commit: expect.any(String) });
    expect(await factRows(engine, claim)).toMatchObject([{ entity_slug: entity, source_markdown_slug: entity }]);
  }), 300_000);

  test('a folder rule\'s own apply moves the held facts it covers off the shared page, and its preview counts them', () => strict(async ({ engine, ctx, root }) => {
    const as = await members(engine);
    const entity = 'clients/acme-example/brief';
    const holding = 'clients/acme-example/memory/unattributed';
    const claim = 'The acme-example brief names a new budget.';
    const kept = 'The garden plan adds two raised beds.';
    expect(await remember(ctx, claim, entity)).toMatchObject({ page: HOLD });
    await remember(ctx, kept, 'notes/garden-plan');
    await settleManagedGitEffects(engine);
    expect(head(root, `${HOLD}.md`)).toContain(claim);
    expect((await reads(as, 'bob', HOLD, claim)).fact).toBe(true);
    const preview = await cli(engine, ['rule', 'add', '--prefix', 'clients/acme-example/', '--readers', 'alice-example', '--source', 'default', '--json']);
    expect(preview.held_facts_moving).toEqual([{ fact_id: expect.any(Number), entity_slug: entity, from: HOLD, to: holding }]);
    expect(head(root, `${HOLD}.md`)).toContain(claim);
    const applied = await cli(engine, ['rule', 'add', '--prefix', 'clients/acme-example/', '--readers', 'alice-example', '--source', 'default', '--yes', '--expect', String(preview.expect), '--json']);
    expect(applied).toMatchObject({ state: 'applied', held_facts: { moved: 1, unmovable: [] } });
    await settleManagedGitEffects(engine);
    const shared = head(root, `${HOLD}.md`);
    expect(shared).not.toContain(claim);
    expect(shared).not.toContain('clients/acme-example');
    expect(shared).toContain(kept);
    expect(head(root, `${holding}.md`)).toContain(claim);
    expect(await factRows(engine, claim)).toMatchObject([{ entity_slug: entity, source_markdown_slug: holding }]);
    for (const who of ['bob', 'unbound']) {
      expect(await reads(as, who, holding, claim)).toEqual({ page: false, fact: false });
      const sharedPage = await as(who, 'get_page', { slug: HOLD });
      expect(sharedPage.text).not.toContain(claim);
      expect(sharedPage.text).not.toContain('clients/acme-example');
    }
    expect(await reads(as, 'alice', holding, claim)).toEqual({ page: true, fact: true });
    expect((await rebuild(root, databaseUrl, [claim, kept]))).toEqual({ [claim]: [{ entity_slug: entity, source_markdown_slug: holding }],
      [kept]: [{ entity_slug: 'notes/garden-plan', source_markdown_slug: HOLD }] });
  }), 300_000);

  /** A saved version of `slug` stored in segments, with no body copy (as test/repair-unwithdrawn-facts-8819.test.ts seeds one). */
  const segmentedVersion = (engine: BrainEngine, slug: string) => engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, timeline, body_storage, body_generation)
    SELECT id, NULL, NULL, 'segmented', 1 FROM pages WHERE source_id = 'default' AND slug = $1`, [slug]);
  const humanLines = async (engine: BrainEngine, cmd: string, args: string[]) => {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try { await runAccessRules(engine, cmd, args, false); } finally { spy.mockRestore(); }
    return lines.join('\n');
  };
  const consequence = (n: number) => `Readers of ${HOLD}'s saved versions can still read the moved rows in up to ${n} of those version(s).`;

  test('a saved version stored in segments is named before the apply, and the apply reports itself incomplete with what stays readable', () => strict(async ({ engine, ctx }) => {
    const acme = 'The acme-example brief carries a segmented clause.';
    const beta = 'The beta-example plan carries a segmented clause.';
    await remember(ctx, acme, 'clients/acme-example/brief');
    await remember(ctx, beta, 'clients/beta-example/plan');
    await settleManagedGitEffects(engine);
    await segmentedVersion(engine, HOLD);
    const args = (prefix: string) => ['add', '--prefix', prefix, '--readers', 'alice-example', '--source', 'default'];
    const preview = await cli(engine, ['rule', ...args('clients/acme-example/'), '--json']);
    expect(preview.held_versions_editing).toMatchObject({ segmented_versions_not_edited: 1 });
    const words = await humanLines(engine, 'rule', args('clients/acme-example/'));
    expect(words).toContain(`Not edited: 1 saved version(s) of ${HOLD} are stored in segments, which this apply cannot edit. ${consequence(1)} The apply will report itself incomplete.`);
    const applied = await cli(engine, ['rule', ...args('clients/acme-example/'), '--yes', '--expect', String(preview.expect), '--json']);
    expect(applied.held_facts).toEqual({ moved: 1, unmovable: [], complete: false, segmented_versions_not_edited: 1, segmented_pages: [{ slug: HOLD, versions: 1 }] });
    const second = await cli(engine, ['rule', ...args('clients/beta-example/'), '--json']);
    expect(second.held_versions_editing).toMatchObject({ segmented_versions_not_edited: 1 });
    const done = await humanLines(engine, 'rule', [...args('clients/beta-example/'), '--yes', '--expect', String(second.expect)]);
    expect(done).toContain(`Incomplete: the held facts moved, but 1 saved version(s) of ${HOLD} are stored in segments and were not edited. ${consequence(1)}`);
    expect(await factRows(engine, beta)).toMatchObject([{ source_markdown_slug: 'clients/beta-example/memory/unattributed' }]);
  }), 300_000);

  test('the sync path and the maintenance fallback report a move that left a segmented saved version unedited as incomplete', () => strict(async ({ engine, ctx, root }) => {
    const moveModule = await import('../src/core/facts/held-fact-move.ts');
    const original = moveModule.moveRuledSharedHeld;
    const synced = 'The acme-example brief carries a segmented synced clause.';
    const crashed = 'The beta-example plan carries a segmented synced clause.';
    await remember(ctx, synced, 'clients/acme-example/brief');
    await remember(ctx, crashed, 'clients/beta-example/plan');
    await settleManagedGitEffects(engine);
    await segmentedVersion(engine, HOLD);
    const policy = (list: FolderRule[]) => commitPolicyFile(root, POLICY_FILE, () => serializePolicyYaml(list), 'access: rule');
    const sync = () => performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true } as never);
    let result: Awaited<ReturnType<typeof original>> = null;
    const errors: string[] = [];
    const spy = spyOn(moveModule, 'moveRuledSharedHeld').mockImplementation(async (e, s) => (result = await original(e, s)));
    const stderr = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    try {
      policy([rule('acme', 'clients/acme-example/', ['alice-example'])]);
      await sync();
    } finally { spy.mockRestore(); stderr.mockRestore(); }
    expect(result).toMatchObject({ rehomed: 1, segmented_versions_not_edited: 1 });
    expect(errors.join('\n')).toContain('held facts moved under a new folder rule, incomplete: 1 saved version(s) of memory/unattributed are stored in segments and were not edited; readers of its saved versions can still read the moved rows in up to 1 of them.');
    const died = spyOn(moveModule, 'moveRuledSharedHeld').mockImplementation(async () => { throw new Error('process died'); });
    try {
      policy([rule('acme', 'clients/acme-example/', ['alice-example']), rule('beta', 'clients/beta-example/', ['alice-example'])]);
      await sync();
    } finally { died.mockRestore(); }
    const upkeep = await runExtractFacts(engine, { sourceId: 'default' });
    expect(upkeep.heldFactsMoved).toBe(1);
    expect(upkeep.warnings).toContain('HELD_VERSIONS_NOT_EDITED: 1 saved version(s) of memory/unattributed are stored in segments and were not edited; readers of its saved versions can still read the moved rows in up to 1 of them.');
  }), 300_000);

  test('the preview names as each held row\'s destination the page the apply moves it to, for a row keyed by a bare name', () => strict(async ({ engine, ctx }) => {
    const claim = 'Kofi Example signs the acme-example lease.';
    const saved = await remember(ctx, claim, 'Kofi Example');
    expect(saved).toMatchObject({ entity_slug: 'kofi-example', page: HOLD });
    await call(ctx, 'put_page', { slug: 'people/kofi-example', content: '---\ntype: person\ntitle: Kofi Example\n---\n\nNotes about Kofi Example.\n' });
    await settleManagedGitEffects(engine);
    const args = ['add', '--prefix', 'people/', '--readers', 'alice-example', '--source', 'default'];
    const preview = await cli(engine, ['rule', ...args, '--json']);
    const applied = await cli(engine, ['rule', ...args, '--yes', '--expect', String(preview.expect), '--json']);
    expect(applied.held_facts).toMatchObject({ moved: 1 });
    const [after] = await factRows(engine, claim);
    expect(preview.held_facts_moving).toEqual([{ fact_id: Number(saved.id), entity_slug: 'kofi-example', from: HOLD, to: after!.source_markdown_slug }]);
    expect(after!.source_markdown_slug).toBe('people/kofi-example');
  }), 300_000);

  test('the owner reads every holding page before and after a re-home: with the opt-in on, and off where the rules name the owner', () => strict(async ({ engine, ctx }) => {
    const as = await members(engine);
    await setOwner(engine, 'carol-example');
    __resetPrivateVisibilityCacheForTests();
    const pages: Array<[string, string, string]> = [['partners/alice-example/deal-notes', FOLDER_HOLD, 'The deal notes mention a pilot.'],
      ['clients/acme-example/brief', 'clients/acme-example/memory/unattributed', 'The brief asks for a pilot.']];
    await rules(engine, [rule('partners', 'partners/', ['alice-example'])]);
    for (const [entity, , claim] of pages) await remember(ctx, claim, entity);
    const ownerReads = async () => Promise.all(pages.map(async ([, holding, claim]) => reads(as, 'carol', holding, claim)));
    const optIn = async (on: boolean) => { await setOwnerReadsRestricted(engine, on, { remote: false }); __resetPrivateVisibilityCacheForTests(); };
    // Before the re-home: the partners fact is on its folder's page, the clients fact on the shared one.
    await optIn(true);
    expect(await ownerReads()).toEqual([{ page: true, fact: true }, { page: false, fact: true }]);
    expect((await as('carol', 'get_page', { slug: HOLD })).text).toContain(pages[1]![2]);
    await optIn(false);
    expect((await ownerReads())[0]).toEqual({ page: false, fact: false });
    await rules(engine, [rule('partners', 'partners/', ['alice-example']), rule('clients', 'clients/', ['alice-example'])]);
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved).toBe(1);
    // After: both on their folders' pages. The opt-in on reads both; off, the owner reads them once the rules name it.
    await optIn(true);
    expect(await ownerReads()).toEqual([{ page: true, fact: true }, { page: true, fact: true }]);
    await optIn(false);
    expect(await ownerReads()).toEqual([{ page: false, fact: false }, { page: false, fact: false }]);
    await rules(engine, [rule('partners', 'partners/', ['alice-example', 'carol-example']), rule('clients', 'clients/', ['alice-example', 'carol-example'])], true);
    __resetPrivateVisibilityCacheForTests();
    expect(await ownerReads()).toEqual([{ page: true, fact: true }, { page: true, fact: true }]);
    // The local CLI (the host's owner) reads every holding page whatever the rules say.
    for (const [, holding, claim] of pages) expect(JSON.stringify(await call(ctx, 'get_page', { slug: holding }))).toContain(claim);
  }), 300_000);

  test('an exact page rule refuses git_home_required (facts_lane) and an unreadable access state answers wait, locally and over MCP', () => strict(async ({ engine, ctx, root }) => {
    const as = await members(engine);
    await rules(engine, [rule('secret-plan', 'notes/secret-plan', ['alice-example'])]);
    const claim = 'The secret plan has a codename.';
    const local = await caught(remember(ctx, claim, 'notes/secret-plan'));
    expect({ code: local!.code, canonical: local!.canonical, reason: local!.reason }).toEqual({ code: 'invalid_params', canonical: 'git_home_required', reason: 'facts_lane' });
    expect(local!.fix).toMatchObject({ mcp: { tool: 'put_page', arguments: { slug: 'notes/secret-plan' } }, ask_user: true });
    const remote = await as('alice', 'remember', { fact: claim, entity: 'notes/secret-plan', provenance: 'chat 2026-11-12', share: true, request_id: randomUUID() });
    expect(remote.isError).toBe(true);
    expect(remote.body).toMatchObject({ error: 'invalid_params', code: 'git_home_required', reason: 'facts_lane', fix: { mcp: { tool: 'put_page' }, next: 'ask_user' } });
    expect(remote.text).not.toContain('storage_error');
    expect(await factRows(engine, claim)).toEqual([]);
    expect(head(root, `${HOLD}.md`)).not.toContain(claim);

    await engine.executeRaw('CREATE OR REPLACE FUNCTION gbrain_access_state_unreadable() RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$');
    const unreadable = 'The kitchen remodel starts in March.';
    const waited = await caught(remember(ctx, unreadable, 'notes/kitchen-remodel'));
    expect({ code: waited!.code, canonical: waited!.canonical }).toEqual({ code: 'unavailable', canonical: 'access_policy_pending' });
    expect(waited!.fix).toMatchObject({ actor: 'provider' });
    const overMcp = await dispatchToolCall(engine, 'remember', { fact: unreadable, entity: 'notes/kitchen-remodel', provenance: 'chat 2026-11-12', request_id: randomUUID() },
      { remote: true, transport: 'stdio', sourceId: 'default' });
    const body = JSON.parse(overMcp.content[0]!.text);
    expect(overMcp.isError).toBe(true);
    expect(body).toMatchObject({ error: 'unavailable', code: 'access_policy_pending' });
    expect(JSON.stringify(body)).toContain('"next":"wait"');
    expect(await factRows(engine, unreadable)).toEqual([]);
  }), 300_000);

  test('a folder under storage.db_only or a path Git ignores gets a database-only holding page that is never committed', () => strict(async ({ engine, ctx, root }) => {
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - partners/\n');
    git(root, 'add', 'gbrain.yml'); git(root, 'commit', '-q', '-m', 'storage');
    await rules(engine, [rule('partners', 'partners/', ['alice-example']), rule('clients', 'clients/', ['alice-example'])]);
    for (const [entity, holding, claim] of [[ENTITY, FOLDER_HOLD, 'The deal notes are kept out of Git.'],
      ['clients/acme-example/brief', 'clients/acme-example/memory/unattributed', 'The brief is kept out of Git.']] as const) {
      const notices: Array<{ code: string; why?: string }> = [];
      const saved = await remember({ ...ctx, emitNotice: (n: { code: string; why?: string } | null | undefined) => { if (n) notices.push(n); } } as OperationContext, claim, entity);
      expect(saved).toMatchObject({ status: 'inserted', page: holding, persistence: { mode: 'database' }, write_through: { written: false, skipped: 'db_only', held_for: entity } });
      expect(notices.find(n => n.code === 'entity_page_missing')!.why).toContain('database only');
      expect(await factRows(engine, claim)).toMatchObject([{ entity_slug: entity, source_markdown_slug: holding, row_num: 1 }]);
      const second = await remember(ctx, `${claim} Again.`, entity);
      expect(second).toMatchObject({ page: holding });
    }
    await settleManagedGitEffects(engine);
    expect(everCommitted(root, 'partners')).toBe(false);
    expect(everCommitted(root, 'clients')).toBe(false);
    const scan = await scanFactsHome(engine, 'default');
    expect(scan.homeable).toEqual([]);
    expect(scan.rows).toEqual([]);
  }, 'clients/'), 300_000);

  test('the background fact writers hold a ruled entity\'s fact on its folder\'s page; gbrain repair facts-home moves older ones there', () => strict(async ({ engine, ctx, root }) => {
    await rules(engine, [rule('partners', 'partners/', ['alice-example']), rule('secret-plan', 'notes/secret-plan', ['alice-example'])]);
    const background = 'The deal notes were extracted from mail.';
    await writeSingleFact(engine, 'default', { fact: background, entity: ENTITY, provenance: 'mail 2026-11-12', remote: false } as never);
    await settleManagedGitEffects(engine);
    expect(await factRows(engine, background)).toMatchObject([{ entity_slug: ENTITY, source_markdown_slug: FOLDER_HOLD }]);
    expect(head(root, `${FOLDER_HOLD}.md`)).toContain(background);
    // Older database-only facts: one for the ruled entity, one for an entity an exact page rule names.
    const older = 'The deal notes predate the rule.';
    const pageRuled = 'The secret plan predates the rule.';
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      for (const [claim, entity] of [[older, 'partners/alice-example/old-notes'], [pageRuled, 'notes/secret-plan']]) {
        await engine.insertFact({ fact: claim, kind: 'fact', entity_slug: entity, visibility: 'world', source: 'legacy import' } as never, { source_id: 'default' });
      }
    } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    const logger = { info() {}, warn() {}, error() {} };
    const run = async (opts: { apply?: boolean; expect?: string } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
      .run('facts-home' as RepairKind, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', expect: opts.expect }) as Promise<Record<string, any>>;
    const preview = await run();
    expect(preview.listing.map((entry: { class: string; detail: string }) => [entry.class, entry.detail.includes(FOLDER_HOLD) || entry.detail.includes('page rule')]))
      .toEqual(expect.arrayContaining([['entity_page_missing', true], ['folder_restricted', true]]));
    expect((await run({ apply: true, expect: preview.preview_hash })).applied).toBe(1);
    await settleManagedGitEffects(engine);
    expect(await factRows(engine, older)).toMatchObject([{ entity_slug: 'partners/alice-example/old-notes', source_markdown_slug: FOLDER_HOLD }]);
    expect(head(root, `${FOLDER_HOLD}.md`)).toContain(older);
    expect(await factRows(engine, pageRuled)).toMatchObject([{ row_num: null }]);
    const after = await scanFactsHome(engine, 'default');
    expect(after.rows.map(r => [r.group, r.reason])).toEqual([['folder_restricted', 'page_rule']]);
    expect((await rebuild(root, databaseUrl, [older, background]))).toEqual({ [older]: [{ entity_slug: 'partners/alice-example/old-notes', source_markdown_slug: FOLDER_HOLD }],
      [background]: [{ entity_slug: ENTITY, source_markdown_slug: FOLDER_HOLD }] });
  }), 300_000);

  /** The held_versions_edited receipts, summed: what the preview's counts must equal. */
  const auditSum = async (engine: BrainEngine) => (await auditRows(engine)).reduce((n, r) => ({ rows: n.rows + Number(r.audit.rows), versions: n.versions + Number(r.audit.versions) }), { rows: 0, versions: 0 });

  test('an exact page rule over a row held on a folder holding page: the preview names what the apply does, and the row leaves that page\'s saved versions', () => strict(async ({ engine, ctx }) => {
    const as = await members(engine);
    const partners = ['add', '--prefix', 'partners/', '--readers', 'alice-example,bob-example', '--source', 'default'];
    await cli(engine, ['rule', ...partners, '--yes', '--expect', String((await cli(engine, ['rule', ...partners, '--json'])).expect), '--json']);
    const claim = 'The deal with acme-example has a secret side letter.';
    const kept = 'The old notes of alice-example stay with the partners.';
    expect(await remember(ctx, claim, ENTITY)).toMatchObject({ page: FOLDER_HOLD });
    expect(await remember(ctx, kept, 'partners/alice-example/old-notes')).toMatchObject({ page: FOLDER_HOLD });
    await settleManagedGitEffects(engine);
    __resetPrivateVisibilityCacheForTests();
    expect(await versionsText(as, 'bob', FOLDER_HOLD)).toContain(claim);
    const exact = ['add', '--slug', ENTITY, '--readers', 'alice-example', '--source', 'default'];
    const preview = await cli(engine, ['rule', ...exact, '--json']);
    const [fact] = await factRows(engine, claim);
    expect(preview.held_facts_moving).toEqual([{ fact_id: fact!.id, entity_slug: ENTITY, from: FOLDER_HOLD, to: ENTITY }]);
    const applied = await cli(engine, ['rule', ...exact, '--yes', '--expect', String(preview.expect), '--json']);
    expect(applied.held_facts).toEqual({ moved: preview.held_facts_moving.length, unmovable: [] });
    expect(preview.held_versions_editing.pages).toEqual([{ slug: FOLDER_HOLD, rows: preview.held_versions_editing.rows, versions: preview.held_versions_editing.versions }]);
    expect((await auditRows(engine)).map(r => r.audit)).toEqual([{ slug: FOLDER_HOLD, moved_to: ENTITY, fact_ids: [fact!.id], rows: preview.held_versions_editing.rows, versions: preview.held_versions_editing.versions }]);
    expect(await auditSum(engine)).toEqual({ rows: preview.held_versions_editing.rows, versions: preview.held_versions_editing.versions });
    expect(preview.held_versions_editing.versions).toBeGreaterThan(0);
    await settleManagedGitEffects(engine);
    __resetPrivateVisibilityCacheForTests();
    expect(await versionsText(as, 'bob', FOLDER_HOLD)).not.toContain(claim);
    expect(await factRows(engine, kept)).toMatchObject([{ source_markdown_slug: FOLDER_HOLD }]);
    expect((await engine.getPage(FOLDER_HOLD, { sourceId: 'default' }))?.compiled_truth).toContain(kept);
    expect((await as('bob', 'get_page', { slug: ENTITY })).isError).toBe(true);
    expect(await reads(as, 'alice', ENTITY, claim)).toEqual({ page: true, fact: true });
  }), 300_000);

  test('the preview lists every held row the apply moves, says why one moves only because its page exists, and counts what the receipts record', () => strict(async ({ engine, ctx }) => {
    const garden = 'The garden plan adds a pond.';
    const claim = 'The acme-example brief   carries  a spaced clause.';
    await remember(ctx, garden, 'notes/garden-plan');
    await remember(ctx, claim, 'clients/acme-example/brief');
    await settleManagedGitEffects(engine);
    await call(ctx, 'put_page', { slug: 'notes/garden-plan', content: page('Garden plan') });
    await settleManagedGitEffects(engine);
    const [g] = await factRows(engine, garden);
    const [a] = await engine.executeRaw<{ id: number }>("SELECT id::int AS id FROM facts WHERE source_id = 'default' AND entity_slug = 'clients/acme-example/brief' AND expired_at IS NULL");
    const args = ['add', '--prefix', 'clients/acme-example/', '--readers', 'alice-example', '--source', 'default'];
    const preview = await cli(engine, ['rule', ...args, '--json']);
    expect(preview.held_facts_moving).toEqual([
      { fact_id: a!.id, entity_slug: 'clients/acme-example/brief', from: HOLD, to: 'clients/acme-example/memory/unattributed' },
      { fact_id: g!.id, entity_slug: 'notes/garden-plan', from: HOLD, to: 'notes/garden-plan', because: 'its page exists' }]);
    expect(await humanLines(engine, 'rule', args)).toContain(`fact ${g!.id} for notes/garden-plan from ${HOLD} to notes/garden-plan (its page), because its page exists`);
    const applied = await cli(engine, ['rule', ...args, '--yes', '--expect', String(preview.expect), '--json']);
    expect(applied.held_facts).toEqual({ moved: preview.held_facts_moving.length, unmovable: [] });
    expect(await factRows(engine, garden)).toMatchObject([{ source_markdown_slug: 'notes/garden-plan' }]);
    expect(await auditSum(engine)).toEqual({ rows: preview.held_versions_editing.rows, versions: preview.held_versions_editing.versions });
    expect(preview.held_versions_editing.versions).toBeGreaterThan(0);
  }), 300_000);

  test('an exact page rule that arrives by sync over a folder-held row: the excluded member reads nothing of it right after the sync; nothing changed, nothing is due', () => strict(async ({ engine, ctx, root }) => {
    const as = await members(engine);
    const { moveRuledSharedHeld } = await import('../src/core/facts/held-fact-move.ts');
    const policy = (list: FolderRule[]) => commitPolicyFile(root, POLICY_FILE, () => serializePolicyYaml(list), 'access: rule');
    const sync = () => performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true } as never);
    policy([rule('partners', 'partners/', ['alice-example', 'bob-example'])]);
    await sync();
    const claim = 'The deal with acme-example has a synced side letter.';
    expect(await remember(ctx, claim, ENTITY)).toMatchObject({ page: FOLDER_HOLD });
    await settleManagedGitEffects(engine);
    expect(await moveRuledSharedHeld(engine, 'default')).toBeNull();
    __resetPrivateVisibilityCacheForTests();
    expect(await reads(as, 'bob', FOLDER_HOLD, claim)).toEqual({ page: true, fact: true });
    policy([rule('partners', 'partners/', ['alice-example', 'bob-example']), rule('deal', ENTITY, ['alice-example'])]);
    await sync();
    await settleManagedGitEffects(engine);
    __resetPrivateVisibilityCacheForTests();
    expect((await as('bob', 'get_page', { slug: FOLDER_HOLD })).text).not.toContain(claim);
    expect((await as('bob', 'search', { query: claim, match: 'keyword', fields: 'full', limit: 20 })).text).not.toContain(claim);
    expect((await as('bob', 'recall', { query: 'synced side letter' })).text).not.toContain(claim);
    expect(await reads(as, 'alice', ENTITY, claim)).toEqual({ page: true, fact: true });
    expect(await moveRuledSharedHeld(engine, 'default')).toBeNull();
  }), 300_000);

  test('struck held rows leave the holding page with their entity\'s live rows, and an entity with only struck rows leaves too', () => strict(async ({ engine, ctx }) => {
    const as = await members(engine);
    const gone = 'The acme-example brief once had a withdrawn clause.';
    const memo = 'The acme-example memo was withdrawn entirely.';
    const live = 'The acme-example brief carries a live clause.';
    const quote = 'The garden plan quotes: The acme-example brief carries a live clause.';
    for (const [claim, entity] of [[gone, 'clients/acme-example/brief'], [memo, 'clients/acme-example/memo']]) {
      const saved = await remember(ctx, claim, entity);
      await settleManagedGitEffects(engine);
      await call(ctx, 'forget', { id: String(saved.id) });
    }
    await remember(ctx, live, 'clients/acme-example/brief');
    await remember(ctx, quote, 'notes/garden-plan');
    await settleManagedGitEffects(engine);
    expect(await versionsText(as, 'bob', HOLD)).toContain(gone);
    const args = ['add', '--prefix', 'clients/acme-example/', '--readers', 'alice-example', '--source', 'default'];
    const preview = await cli(engine, ['rule', ...args, '--json']);
    expect(preview.held_struck_rows_leaving).toBe(2);
    const applied = await cli(engine, ['rule', ...args, '--yes', '--expect', String(preview.expect), '--json']);
    expect(applied.held_facts).toEqual({ moved: 1, unmovable: [] });
    expect(await auditSum(engine)).toEqual({ rows: preview.held_versions_editing.rows, versions: preview.held_versions_editing.versions });
    await settleManagedGitEffects(engine);
    __resetPrivateVisibilityCacheForTests();
    for (const text of [(await as('bob', 'get_page', { slug: HOLD })).text, await versionsText(as, 'bob', HOLD)]) {
      for (const hidden of [gone, memo, `| ${live} |`, 'clients/acme-example']) expect(text).not.toContain(hidden);
      expect(text).toContain(quote);
    }
    const { moveRuledSharedHeld } = await import('../src/core/facts/held-fact-move.ts');
    expect(await moveRuledSharedHeld(engine, 'default')).toBeNull();
    expect((await runExtractFacts(engine, { sourceId: 'default' })).heldFactsMoved ?? 0).toBe(0);
  }), 300_000);

  test('a held-fact move still pending when the write wait ends is reported incomplete with its request, not counted as moved', () => strict(async ({ engine, ctx }) => {
    await rules(engine, [rule('zz', 'zz-example/', ['alice-example'])]);
    const garden = 'The garden plan adds a pending pond.';
    await remember(ctx, garden, 'notes/garden-plan');
    await call(ctx, 'put_page', { slug: 'notes/garden-plan', content: page('Garden plan') });
    await settleManagedGitEffects(engine);
    __setMaintenanceWriteWaitForTests(600);
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, 'default'))!, 1000))!;
    let applied: Record<string, any>, words: string, upkeep: Awaited<ReturnType<typeof runExtractFacts>>;
    try {
      const args = (prefix: string) => ['add', '--prefix', prefix, '--readers', 'alice-example', '--source', 'default'];
      applied = await cli(engine, ['rule', ...args('yy-example/'), '--yes', '--expect', String((await cli(engine, ['rule', ...args('yy-example/'), '--json'])).expect), '--json']);
      words = await humanLines(engine, 'rule', [...args('xx-example/'), '--yes', '--expect', String((await cli(engine, ['rule', ...args('xx-example/'), '--json'])).expect)]);
      upkeep = await runExtractFacts(engine, { sourceId: 'default' });
    } finally { __setMaintenanceWriteWaitForTests(null); await lock.release(); }
    await runExtractFacts(engine, { sourceId: 'default' });
    const [pending] = await engine.executeRaw<{ request_id: string }>("SELECT request_id::text AS request_id FROM persistence_requests WHERE slug = 'notes/garden-plan' AND intent->>'kind' = 'managed_maintenance_move_held_fact' ORDER BY sequence");
    const request = pending!.request_id;
    expect(applied.held_facts).toEqual({ moved: 0, unmovable: [], complete: false, pending: [{ slug: 'notes/garden-plan', from: HOLD, request_id: request }] });
    expect(words).toContain(`Incomplete: the move of held facts off ${HOLD} to notes/garden-plan is accepted and still pending (request ${request}; gbrain write-request ${request} shows it)`);
    expect(upkeep.heldFactsMoved ?? 0).toBe(0);
    expect(upkeep.warnings.some(w => w.startsWith('HELD_FACT_PENDING: ') && w.includes(request))).toBe(true);
    await settleManagedGitEffects(engine);
    expect(await factRows(engine, garden)).toMatchObject([{ source_markdown_slug: 'notes/garden-plan' }]);
    // The request the apply named is the one that commits: the facts reconcile that ran between its acceptance and its commit
    // (it rewrites the new row's time to the second its fence cell keeps) does not strand it beside a second request.
    expect(await engine.executeRaw("SELECT request_id::text AS request_id, state FROM persistence_requests WHERE slug = 'notes/garden-plan' AND intent->>'kind' = 'managed_maintenance_move_held_fact' ORDER BY sequence"))
      .toEqual([{ request_id: request, state: 'committed' }]);
  }), 300_000);

  test('a sync that brings a rule, a maintenance pass and a save on the same holding page all finish, and every fact ends on one page', () => strict(async ({ engine, ctx, root }) => {
    const moveModule = await import('../src/core/facts/held-fact-move.ts');
    const acme = 'The acme-example brief is moved under contention.';
    const beta = 'The beta-example plan is moved under contention.';
    const late = 'The garden plan is saved under contention.';
    await remember(ctx, acme, 'clients/acme-example/brief');
    await remember(ctx, beta, 'clients/beta-example/plan');
    await settleManagedGitEffects(engine);
    const policy = (rules: FolderRule[]) => commitPolicyFile(root, POLICY_FILE, () => serializePolicyYaml(rules), 'access: rule');
    const sync = () => performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true } as never);
    // One rule is applied with its move lost, so maintenance has a move due; the second rule arrives with the contended sync.
    const died = spyOn(moveModule, 'moveRuledSharedHeld').mockImplementation(async () => { throw new Error('process died'); });
    try { policy([rule('beta', 'clients/beta-example/', ['alice-example'])]); await sync(); } finally { died.mockRestore(); }
    expect(await factRows(engine, beta)).toMatchObject([{ source_markdown_slug: HOLD }]);
    policy([rule('beta', 'clients/beta-example/', ['alice-example']), rule('acme', 'clients/acme-example/', ['alice-example'])]);
    // The sync holds its lease and then moves, the maintenance pass moves, and a save appends to the page both take rows off.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('a sync, a maintenance pass and a save on one holding page did not all finish within 120 s')), 120_000); });
    try {
      const [, , saved] = await Promise.race([Promise.all([sync(), runExtractFacts(engine, { sourceId: 'default' }), remember(ctx, late, 'notes/garden-plan')]), watchdog]);
      expect(saved).toMatchObject({ status: 'inserted', page: HOLD });
    } finally { clearTimeout(timer); }
    // Whatever the three left undone, the next passes finish it: nothing stays due and no request stays open.
    for (let pass = 0; (await moveModule.moveRuledSharedHeld(engine, 'default')) !== null; pass++) { expect(pass).toBeLessThan(4); await settleManagedGitEffects(engine); }
    await settleManagedGitEffects(engine);
    expect(await factRows(engine, acme)).toMatchObject([{ entity_slug: 'clients/acme-example/brief', source_markdown_slug: 'clients/acme-example/memory/unattributed' }]);
    expect(await factRows(engine, beta)).toMatchObject([{ entity_slug: 'clients/beta-example/plan', source_markdown_slug: 'clients/beta-example/memory/unattributed' }]);
    expect(await factRows(engine, late)).toMatchObject([{ source_markdown_slug: HOLD }]);
    expect(await engine.executeRaw("SELECT request_id::text AS request_id, state FROM persistence_requests WHERE completed_at IS NULL")).toEqual([]);
    const shared = head(root, `${HOLD}.md`);
    expect(shared).toContain(late);
    for (const moved of [acme, beta]) expect(shared).not.toContain(moved);
    expect(head(root, 'clients/acme-example/memory/unattributed.md')).toContain(acme);
    expect(head(root, 'clients/beta-example/memory/unattributed.md')).toContain(beta);
  }), 300_000);

  test('a source that is not strict, and a brain with no Git repository, keep a ruled entity\'s fact database-only as before', async () => {
    await managedBrain(async ({ engine, ctx, root }) => {
      await rules(engine, [rule('partners', 'partners/', ['alice-example'])]);
      const claim = 'The deal notes stay in the database here.';
      const saved = await remember(ctx, claim, ENTITY);
      expect(saved.persistence).toEqual({ mode: 'database' });
      expect(saved.write_through).not.toHaveProperty('held_for');
      expect(existsSync(join(root, `${FOLDER_HOLD}.md`))).toBe(false);
      expect(await factRows(engine, claim)).toMatchObject([{ entity_slug: ENTITY, source_markdown_slug: null, row_num: null }]);
    }, { databaseUrl, setup: gitRepo() });
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await rules(engine, [rule('partners', 'partners/', ['alice-example'])]);
      const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
      const claim = 'The deal notes live in a brain with no repository.';
      const saved = await remember(ctx, claim, ENTITY);
      expect(saved).toMatchObject({ status: 'inserted' });
      expect(saved).not.toHaveProperty('page');
      expect(await factRows(engine, claim)).toMatchObject([{ entity_slug: ENTITY, source_markdown_slug: null, row_num: null }]);
    } finally { await close(); }
  }, 300_000);
});
