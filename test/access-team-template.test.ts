/**
 * O1 v1 (GST-3989): the team template sets up a brand-new brain for a team and refuses every other brain before it
 * writes anything. PGLite, repo-less (database rule store) and repo-backed (rules committed to .gbrain/access.yml);
 * reads go over the remote HTTP dispatch path with each member's own key. Invented names only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, getMember, listGroups, listMembers } from '../src/core/access/members.ts';
import { ownerMemberId } from '../src/core/access/owner.ts';
import { addFolderRules, currentFolderRules } from '../src/commands/access-rules.ts';
import { mintToken } from '../src/commands/auth-mint.ts';
import { performSync } from '../src/commands/sync.ts';
import { parseTeamRoster, runTeamTemplate, teamLines, teamRules, teamTemplate, type TeamResult } from '../src/commands/access-team.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

const OWNER = 'olivia-example';
const ALICE = 'alice-example';
const BOB = 'bob-example';
let engine: PGLiteEngine;
let keyDir: string;

const run = (extra: Record<string, unknown> = {}) => teamTemplate(engine, { owner: OWNER, members: `${ALICE},${BOB}`, groups: `eng:${ALICE}`, apply: true, keyDir, ...extra });
const liveTokens = async () => (await engine.executeRaw<{ name: string }>('SELECT name FROM access_tokens WHERE revoked_at IS NULL ORDER BY name')).map(r => r.name);
const local = (op: string, params: Record<string, unknown>) => handleToolCall(engine, op, params) as Promise<any>;
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const page = (title: string) => `---\ntitle: ${title}\n---\n# ${title}\n\nA line about ${title}.\n`;

async function remote(token: string, op: string, params: Record<string, unknown>) {
  __resetPrivateVisibilityCacheForTests();
  const auth = await provider().verifyAccessToken(token) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'], readLog: false } as never);
  return { isError: out.isError === true, text: out.content.map((c: { text: string }) => c.text).join('\n') };
}
const reads = async (token: string, slug: string) => !(await remote(token, 'get_page', { slug })).isError;

/** Nothing the template writes exists: no member, owner, group, rule, token, key file or serves config. */
async function expectNothingWritten(extraMembers: string[] = [], extraTokens: string[] = []) {
  expect((await listMembers(engine)).map(m => m.id).filter(id => !extraMembers.includes(id))).toEqual([]);
  expect((await listGroups(engine)).map(g => g.id)).toEqual([]);
  expect((await liveTokens()).filter(n => !extraTokens.includes(n))).toEqual([]);
  expect(await engine.getConfig('access.serves')).toBeNull();
  expect(readdirSync(keyDir)).toEqual([]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  keyDir = mkdtempSync(join(tmpdir(), 'gbrain-team-keys-'));
});

afterEach(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

/** After the template ran: the owner's own key, then one page in every folder, written on the brain host. */
async function seedAfterApply(r: TeamResult): Promise<Record<string, string>> {
  expect(r.error).toBeUndefined();
  const tokens: Record<string, string> = {};
  for (const k of r.keys) tokens[k.member] = readFileSync(k.path, 'utf8').trim();
  tokens[OWNER] = (await mintToken(engine, 'owner-laptop', { scopes: ['read', 'write'], binding: { member: OWNER } })).token;
  return tokens;
}

const SLUGS = { alice: `people/${ALICE}/notes`, bob: `people/${BOB}/notes`, owner: `people/${OWNER}/notes`, team: 'team/roadmap', eng: 'groups/eng/oncall', root: 'notes/owner-only' };

async function expectIsolation(tokens: Record<string, string>) {
  const view = async (who: string) => Object.fromEntries(await Promise.all(Object.entries(SLUGS).map(async ([k, slug]) => [k, await reads(tokens[who]!, slug)])));
  expect(await view(ALICE)).toEqual({ alice: true, bob: false, owner: false, team: true, eng: true, root: false });
  expect(await view(BOB)).toEqual({ alice: false, bob: true, owner: false, team: true, eng: false, root: false });
  expect(await view(OWNER)).toEqual({ alice: false, bob: false, owner: true, team: true, eng: true, root: true });
}

describe('team template on a repo-less brain', () => {
  test('the preview checks the brain is fresh, lists every step and writes nothing', async () => {
    const r = await run({ apply: false });
    expect(r.fresh).toEqual({ ok: true, problems: [] });
    expect(r.applied).toBe(false);
    expect(r.store).toBe('database');
    expect(r.steps.map(s => s.id)).toEqual(['owner', 'members', 'labelled_only', 'groups', 'rules', 'config', 'keys']);
    expect(r.steps.find(s => s.id === 'rules')!.actions.map(a => a.what)).toEqual([`people/${OWNER}/`, `people/${ALICE}/`, `people/${BOB}/`, 'team/', 'groups/eng/']);
    expect(teamLines(r).at(-1)).toBe('Nothing written. Add --yes to apply.');
    await expectNothingWritten();
  });

  test('--yes sets up the team: each person reads only their own folder, everyone reads team/, the group reads its folder', async () => {
    const r = await run();
    const tokens = await seedAfterApply(r);
    expect(await ownerMemberId(engine)).toBe(OWNER);
    expect((await getMember(engine, ALICE))!.labelled_only).toBe(true);
    expect((await getMember(engine, OWNER))!.labelled_only).toBe(false);
    expect(Object.fromEntries((await listGroups(engine)).map(g => [g.id, g.members]))).toEqual({ team: [ALICE, BOB, OWNER], 'team-eng': [ALICE] });
    expect(await engine.getConfig('access.serves')).toBe('several');
    expect(await liveTokens()).toEqual(['member-alice-example', 'member-bob-example', 'owner-laptop']);
    for (const k of r.keys) expect(statSync(k.path).mode & 0o777).toBe(0o600);
    expect(teamLines(r).join('\n')).not.toContain(tokens[ALICE]!);
    for (const [k, slug] of Object.entries(SLUGS)) await local('put_page', { slug, content: page(k) });
    await expectIsolation(tokens);
  });

  test("a member's own new page is private to that member", async () => {
    const tokens = await seedAfterApply(await run());
    expect((await remote(tokens[ALICE]!, 'put_page', { slug: 'ideas/alice-draft', content: page('draft') })).isError).toBe(false);
    expect(await reads(tokens[ALICE]!, 'ideas/alice-draft')).toBe(true);
    expect(await reads(tokens[BOB]!, 'ideas/alice-draft')).toBe(false);
  });

  test('a re-run converges: every step kept and no second key', async () => {
    expect((await run()).error).toBeUndefined();
    const tokens = await liveTokens();
    const again = await run();
    expect(again.fresh.ok).toBe(true);
    expect(again.error).toBeUndefined();
    expect(again.steps.flatMap(s => s.actions.map(a => a.action)).filter(a => a !== 'keep')).toEqual([]);
    expect(await liveTokens()).toEqual(tokens);
  });
});

describe('team template refuses a brain that is not fresh, before any write', () => {
  test('a brain with a page', async () => {
    await local('put_page', { slug: 'journal/today', content: page('journal') });
    const r = await run();
    expect(r.applied).toBe(false);
    expect(r.fresh.ok).toBe(false);
    expect(r.fresh.problems.map(p => p.what)).toContain('pages');
    expect(teamLines(r)[1]).toContain('NOT FRESH');
    await expectNothingWritten();
    expect(await currentFolderRules(engine, 'default')).toEqual([]);
  });

  test('a brain whose only page was soft-deleted still has history', async () => {
    await local('put_page', { slug: 'journal/gone', content: page('gone') });
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'journal/gone'");
    const r = await run();
    expect(r.fresh.problems.map(p => p.what)).toContain('pages');
    await expectNothingWritten();
  });

  test('an existing folder rule, member, or unbound token', async () => {
    await addFolderRules(engine, 'default', [{ id: 'mine', prefix: 'mine/', readable_by: [`member:${OWNER}`] }], { apply: true, json: true });
    await addMember(engine, 'carol-example', { remote: false });
    await mintToken(engine, 'old-agent', { scopes: ['read'] });
    const r = await run();
    expect(r.fresh.problems.map(p => p.what).sort()).toEqual(['member carol-example', 'rule default:mine', 'token old-agent']);
    expect(r.fresh.problems.find(p => p.what === 'token old-agent')!.remedy).toContain(`gbrain auth rescope --token old-agent --member ${OWNER}`);
    await expectNothingWritten(['carol-example'], ['old-agent']);
  });

  test('credentials that may act for other people, or the owner-read override', async () => {
    await addMember(engine, OWNER, { remote: false });
    await mintToken(engine, 'shared-agent', { scopes: ['read'], binding: { member: OWNER } });
    await engine.executeRaw("UPDATE access_tokens SET may_act_for = ARRAY['*'] WHERE name = 'shared-agent'");
    await engine.setConfig('mcp.stdio_may_act_for', ALICE);
    await engine.setConfig('access.owner_reads_restricted', '1');
    const r = await run();
    expect(r.fresh.problems.map(p => p.what).sort()).toEqual(['owner reads', 'stdio may_act_for', 'token shared-agent']);
    expect(await liveTokens()).toEqual(['shared-agent']);
    expect(readdirSync(keyDir)).toEqual([]);
  });

  test('pages that arrive while it runs stop it before any member key is issued', async () => {
    const original = engine.setConfig.bind(engine);
    const spy = spyOn(engine, 'setConfig').mockImplementation(async (k: string, v: string) => {
      await original(k, v);
      if (k === 'access.serves') await local('put_page', { slug: 'late/page', content: page('late') });
    });
    try {
      const r = await run();
      expect(r.error?.code).toBe('team_template_not_fresh');
      expect(await liveTokens()).toEqual([]);
      expect(readdirSync(keyDir)).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  test('a re-run whose rules were recorded but never put in force issues no key', async () => {
    expect((await run()).error).toBeUndefined();
    await engine.executeRaw("DELETE FROM access_rules WHERE source_id = 'default'");
    await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE revoked_at IS NULL');
    for (const f of readdirSync(keyDir)) rmSync(join(keyDir, f));
    const r = await run();
    expect(r.error?.code).toBe('team_template_rules_pending');
    expect(await liveTokens()).toEqual([]);
    expect(readdirSync(keyDir)).toEqual([]);
  });
});

describe('team template on a repo-backed brain', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-team-repo-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'empty');
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('rules are committed to .gbrain/access.yml and the same isolation holds after a sync', async () => {
    const r = await run();
    expect(r.store).toBe('git');
    const tokens = await seedAfterApply(r);
    const policy = readFileSync(join(root, '.gbrain/access.yml'), 'utf8');
    for (const rule of teamRules(parseTeamRoster(`${ALICE},${BOB}`, `eng:${ALICE}`, OWNER))) expect(policy).toContain(rule.prefix);
    expect(git('status', '--porcelain', '.gbrain')).toBe('');
    for (const [k, slug] of Object.entries(SLUGS)) {
      mkdirSync(join(root, slug, '..'), { recursive: true });
      writeFileSync(join(root, `${slug}.md`), page(k));
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'pages');
    await performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true });
    await expectIsolation(tokens);
  });

  test('a repo folder already holding notes is refused before any write', async () => {
    writeFileSync(join(root, 'old-note.md'), page('old'));
    const r = await run();
    expect(r.fresh.problems.map(p => p.what)).toEqual(['source default']);
    expect(r.fresh.problems[0]!.detail).toContain('old-note.md');
    await expectNothingWritten();
    expect(existsSync(join(root, '.gbrain'))).toBe(false);
  });

  test('a nested index.md that sync imports as a page, a missing folder, or a remote source is refused', async () => {
    mkdirSync(join(root, 'projects'), { recursive: true });
    writeFileSync(join(root, 'projects', 'index.md'), page('projects'));
    expect((await run()).fresh.problems[0]!.detail).toContain('index.md');
    rmSync(join(root, 'projects'), { recursive: true, force: true });
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [join(root, 'gone')]);
    expect((await run()).fresh.problems.map(p => p.detail).join(' ')).toContain('is missing on this host');
    await engine.executeRaw("UPDATE sources SET local_path = $1, config = jsonb_build_object('remote_url', 'https://example.com/notes.git') WHERE id = 'default'", [root]);
    expect((await run()).fresh.problems.map(p => p.detail).join(' ')).toContain('syncs from a remote');
    await expectNothingWritten();
  });

  test('a repo folder holding files another sync strategy imports (code) is refused too', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'main.ts'), 'export const x = 1;\n');
    const r = await run();
    expect(r.fresh.problems.map(p => p.what)).toEqual(['source default']);
    expect(r.fresh.problems[0]!.detail).toContain('main.ts');
    await expectNothingWritten();
  });
});

describe('team template inputs', () => {
  test('the roster needs a member besides the owner, each once, and groups of known members', () => {
    expect(() => parseTeamRoster(undefined, undefined, OWNER)).toThrow(/at least one person besides the owner/);
    expect(() => parseTeamRoster('none', undefined, OWNER)).toThrow(/at least one person besides the owner/);
    expect(() => parseTeamRoster(OWNER, undefined, OWNER)).toThrow(/the owner/);
    expect(() => parseTeamRoster(' , ,', undefined, OWNER)).toThrow(/at least one person besides the owner/);
    expect(() => parseTeamRoster(`${ALICE},${ALICE}`, undefined, OWNER)).toThrow(/twice/);
    expect(() => parseTeamRoster(ALICE, `eng:${BOB}`, OWNER)).toThrow(/not in --members/);
    expect(parseTeamRoster(ALICE, `eng:${ALICE}+${OWNER}`, OWNER).groups).toEqual([{ name: 'eng', id: 'team-eng', members: [ALICE, OWNER] }]);
  });

  test.each(['--guests', '--transcripts', '--shape', '--open-history', '--labelled-only'])('%s is refused, and nothing is written', async (flag) => {
    await withEnv({ GBRAIN_HOME: keyDir }, async () => {
      await expect(runTeamTemplate(engine, ['--members', ALICE, '--owner', OWNER, flag, 'x', '--yes'], true, (a, n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; })).rejects.toThrow(/not part of the team template/);
    });
    await expectNothingWritten();
  });
});
