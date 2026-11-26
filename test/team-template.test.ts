/**
 * Lane 5 O1: the team template (gbrain setup <harness> --template team, brain side gbrain access template team).
 * The preview writes nothing; --yes sets up members, keys, the team group and the company/ and rules/team/ rules; the
 * receipt (d8, H2's shape) keeps key issuance apart from delivery and holds no key value; --status proves each member's
 * key over the remote path; and (d17) a group or rule the template did not make is never changed: the run is BLOCKED
 * before anything is written, so the existing group and every page it opens read exactly as before. PGLite, repo-less
 * (rules go to the database store). Invented names only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addGroup, addMember, listGroups, listMembers } from '../src/core/access/members.ts';
import { ownerMemberId } from '../src/core/access/owner.ts';
import { addFolderRules, currentFolderRules } from '../src/commands/access-rules.ts';
import { mintToken } from '../src/commands/auth-mint.ts';
import { loadReceipt } from '../src/commands/setup-template-receipt.ts';
import { parseGuestWriters, parseTeamMembers, teamTemplate, teamTemplateStatus, templateLines } from '../src/commands/team-template.ts';
import { renderLayoutBlock } from '../src/commands/setup-brain-layout.ts';
import { __testing } from '../src/commands/setup.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { removeTempDirs, tempDir } from './helpers/setup-serves-box.ts';

const OWNER = 'alice-example';
const MEMBERS = 'bob-example,carol-example';
let engine: PGLiteEngine;
let home: string;
let receiptDir: string;

const run = (extra: Record<string, unknown> = {}) => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined },
  () => teamTemplate(engine, { source: 'default', harness: 'codex', owner: OWNER, members: MEMBERS, apply: true, receiptDir, ...extra } as never));
const status = (extra: Record<string, unknown> = {}) => withEnv({ GBRAIN_HOME: home }, () => teamTemplateStatus(engine, { receiptDir, ...extra }));
const liveTokens = async () => (await engine.executeRaw<{ name: string }>('SELECT name FROM access_tokens WHERE revoked_at IS NULL ORDER BY name')).map(r => r.name);
const page = (slug: string, extra = '') => `---\ntype: note\ntitle: ${slug}\n${extra}---\n# ${slug}\n\nTeam harbor notes.\n`;

/** Whether a token reads source:slug over the remote path, as gbrain serve --http does. */
async function reads(token: string, slug: string, source = 'default'): Promise<boolean> {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const auth = await provider.verifyAccessToken(token, { touch: false }) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, 'get_page', { slug, source_id: source }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'], readLog: false } as never);
  return out.isError !== true;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 120_000);

afterAll(async () => { await engine.disconnect(); removeTempDirs(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  home = tempDir('gbrain-team-home-');
  receiptDir = join(home, 'receipts');
  await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('company', 'company', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
  await importFromContent(engine, 'company/decisions', page('company/decisions'), { sourceId: 'company', noEmbed: true });
  await importFromContent(engine, 'rules/team/no-friday-deploys', page('rules/team/no-friday-deploys'), { sourceId: 'default', noEmbed: true });
  await importFromContent(engine, 'people/bob-example/notes', page('people/bob-example/notes'), { sourceId: 'default', noEmbed: true });
  await importFromContent(engine, 'people/carol-example/notes', page('people/carol-example/notes'), { sourceId: 'default', noEmbed: true });
});

afterEach(() => { delete process.env.GBRAIN_SETUP_ABORT_AFTER; });

describe('team template', () => {
  test('the preview lists the exact access and auth steps and writes nothing', async () => {
    const r = await run({ apply: false });
    expect(r.applied).toBe(false);
    expect(r.receipt_id).toBeNull();
    const commands = r.steps.flatMap(s => s.actions.map(a => a.command));
    expect(commands).toContain(`gbrain access group add team-members --members ${OWNER},${MEMBERS}`);
    expect(commands).toContain(`gbrain access rule add --id company --prefix company/ --readers ${OWNER},group:team-members --source company --yes`);
    expect(commands).toContain(`gbrain access rule add --id rules-team --prefix rules/team/ --readers ${OWNER},group:team-members --source default --yes`);
    expect(commands).toContain('gbrain auth create member-bob-example --member bob-example');
    expect(templateLines(r).at(-1)).toBe('Nothing written. Add --yes to apply.');
    expect(await listMembers(engine)).toEqual([]);
    expect(await listGroups(engine)).toEqual([]);
    expect(await currentFolderRules(engine, 'default')).toEqual([]);
    expect(await currentFolderRules(engine, 'company')).toEqual([]);
    expect(await liveTokens()).toEqual([]);
    expect(existsSync(receiptDir)).toBe(false);
  });

  test('--yes sets up the team; the receipt holds no key; --status proves each member key reads its own folder and the team folders only', async () => {
    const r = await run();
    expect(r.error).toBeUndefined();
    expect(r.applied).toBe(true);
    expect(await ownerMemberId(engine)).toBe(OWNER);
    expect((await listGroups(engine)).find(g => g.id === 'team-members')?.members.sort()).toEqual([OWNER, 'bob-example', 'carol-example']);
    expect((await currentFolderRules(engine, 'company')).map(x => [x.prefix, x.readable_by])).toEqual([['company/', [`member:${OWNER}`, 'group:team-members'].sort()]]);
    expect((await currentFolderRules(engine, 'default')).map(x => x.prefix).sort()).toEqual(['people/bob-example/', 'people/carol-example/', 'rules/team/']);
    expect(await engine.getConfig('access.serves')).toBe('several');
    expect(await liveTokens()).toEqual(['member-bob-example', 'member-carol-example']);
    for (const k of r.keys) expect(statSync(k.path).mode & 0o777).toBe(0o600);
    const receipt = loadReceipt(r.receipt_id!, 'team', receiptDir);
    expect(receipt.steps.map(s => [s.id, s.state])).toEqual([['guests', 'done'], ['serves', 'done'], ['group', 'done'], ['rules', 'done'], ['owner_clients', 'done']]);
    expect(receipt.keys.every(k => k.issued && k.delivered)).toBe(true);
    const raw = readFileSync(join(receiptDir, `${r.receipt_id}.json`), 'utf8');
    for (const k of r.keys) expect(raw.includes(readFileSync(k.path, 'utf8').trim())).toBe(false);
    expect(statSync(join(receiptDir, `${r.receipt_id}.json`)).mode & 0o777).toBe(0o600);

    const bob = readFileSync(r.keys.find(k => k.member === 'bob-example')!.path, 'utf8').trim();
    expect(await reads(bob, 'company/decisions', 'company')).toBe(true);
    expect(await reads(bob, 'rules/team/no-friday-deploys')).toBe(true);
    expect(await reads(bob, 'people/bob-example/notes')).toBe(true);
    expect(await reads(bob, 'people/carol-example/notes')).toBe(false);

    const s = await status();
    expect(s.complete).toBe(true);
    expect(s.proof.map(p => [p.member, p.key, p.read, p.expected, p.extra, p.missing, p.ok])).toEqual([
      ['bob-example', 'delivered', 3, 3, [], [], true],
      ['carol-example', 'delivered', 3, 3, [], [], true],
    ]);
    expect(s.ok).toBe(true);
    expect(s.proof[0]!.check).toBe('gbrain access check --token member-bob-example --as bob-example');

    const again = await run();
    expect(again.error).toBeUndefined();
    expect(again.steps.filter(x => x.state !== 'skipped').flatMap(x => x.actions.map(a => a.action)).every(a => a === 'keep' || a === 'run')).toBe(true);
    expect(await liveTokens()).toEqual(['member-bob-example', 'member-carol-example']);
  });

  test('d17: a team-members group the template did not make, and a hand rule on company/, BLOCK the run; that group and the pages it opens are unchanged', async () => {
    await addMember(engine, OWNER, { remote: false } as never);
    await addMember(engine, 'dana-example', { remote: false } as never);
    await addGroup(engine, 'team-members', ['dana-example']);
    await importFromContent(engine, 'notes/dana-shared', page('notes/dana-shared', 'readable_by: [alice-example, group:team-members]\n'), { sourceId: 'default', noEmbed: true });
    await addFolderRules(engine, 'company', [{ id: 'company', prefix: 'company/', readable_by: ['member:dana-example', `member:${OWNER}`] } as never], { apply: true, json: true });
    const dana = (await mintToken(engine, 'dana-key', { scopes: ['read'], binding: { member: 'dana-example' } })).token;
    const before = { groups: await listGroups(engine), company: await currentFolderRules(engine, 'company'), rules: await currentFolderRules(engine, 'default'), members: await listMembers(engine), tokens: await liveTokens(),
      shared: await reads(dana, 'notes/dana-shared'), carol: await reads(dana, 'people/carol-example/notes') };
    expect(before.shared).toBe(true);

    const r = await run();
    expect(r.applied).toBe(false);
    const blocked = r.steps.filter(s => s.state === 'blocked').map(s => s.id);
    expect(blocked).toEqual(['group', 'rules']);
    expect(r.steps.find(s => s.id === 'group')!.actions[0]!.detail).toContain('this template did not make it');
    expect(templateLines(r).at(-1)).toBe('Nothing written: fix each BLOCKED line, then run this again.');
    expect(await listGroups(engine)).toEqual(before.groups);
    expect(await currentFolderRules(engine, 'company')).toEqual(before.company);
    expect(await currentFolderRules(engine, 'default')).toEqual(before.rules);
    expect(await listMembers(engine)).toEqual(before.members);
    expect(await liveTokens()).toEqual(before.tokens);
    expect(await engine.getConfig('access.serves')).toBeNull();
    expect(existsSync(receiptDir)).toBe(false);
    expect(await reads(dana, 'notes/dana-shared')).toBe(before.shared);
    expect(await reads(dana, 'people/carol-example/notes')).toBe(before.carol);
  });

  test('d17: --team-group names another group, and the existing one keeps its members', async () => {
    await addMember(engine, 'dana-example', { remote: false } as never);
    await addGroup(engine, 'team-members', ['dana-example']);
    const r = await run({ group: 'acme-team' });
    expect(r.error).toBeUndefined();
    expect(r.applied).toBe(true);
    const groups = new Map((await listGroups(engine)).map(g => [g.id, g.members.sort()]));
    expect(groups.get('team-members')).toEqual(['dana-example']);
    expect(groups.get('acme-team')).toEqual([OWNER, 'bob-example', 'carol-example']);
    expect((await currentFolderRules(engine, 'company'))[0]!.readable_by).toContain('group:acme-team');
  });

  test('d8: a run stopped after the serves step resumes from its receipt and finishes, issuing no second key', async () => {
    const first = await withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: 'team-serves' },
      () => teamTemplate(engine, { source: 'default', harness: 'codex', owner: OWNER, members: MEMBERS, apply: true, receiptDir }));
    expect(first.error?.message).toContain('stopped on purpose after team-serves');
    const receipt = loadReceipt(first.receipt_id!, 'team', receiptDir);
    expect(receipt.steps.map(s => [s.id, s.state])).toEqual([['guests', 'done'], ['serves', 'done'], ['group', 'pending'], ['rules', 'pending'], ['owner_clients', 'pending']]);
    expect(receipt.keys.map(k => [k.member, !!k.issued, !!k.delivered])).toEqual([['bob-example', true, true], ['carol-example', true, true]]);
    const tokens = await liveTokens();
    expect((await status()).complete).toBe(false);

    const resumed = await run({ resume: first.receipt_id, members: undefined, owner: undefined, source: undefined });
    expect(resumed.error).toBeUndefined();
    expect(resumed.receipt_id).toBe(first.receipt_id);
    expect(await liveTokens()).toEqual(tokens);
    expect((await status()).ok).toBe(true);
    await expect(run({ resume: first.receipt_id, source: 'company' })).rejects.toThrow(/names another source/);
  });

  test('--guests sets up the guest source with those writers and lets each owner credential read it', async () => {
    await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_name) VALUES ('broker-a', 'broker-a')");
    const r = await run({ guests: 'oauth_client:broker-a' });
    expect(r.error).toBeUndefined();
    const [g] = await engine.executeRaw<{ writers: string[] }>("SELECT writers FROM guest_sources WHERE source_id = 'guests'");
    expect(g?.writers).toEqual(['oauth_client:broker-a']);
    expect(r.steps.find(s => s.id === 'owner_clients')!.state).toBe('done');
    expect(() => parseGuestWriters('broker-a')).toThrow(/not a writer principal/);
    const missing = await run({ guests: 'oauth_client:nobody' });
    expect(missing.steps.find(s => s.id === 'guests')!.state).toBe('blocked');
  });

  test('the roster is the members besides the owner; setup flags route --template team and refuse what does not fit', () => {
    expect(parseTeamMembers('bob-example,carol-example', OWNER)).toEqual(['bob-example', 'carol-example']);
    expect(() => parseTeamMembers('', OWNER)).toThrow(/--members/);
    expect(() => parseTeamMembers(`${OWNER},bob-example`, OWNER)).toThrow(/brain owner/);
    const flags = __testing.parseFlags(['codex', '--template', 'team', '--members', MEMBERS]) as any;
    expect(flags.brain).toBe('company');
    expect(flags.dryRun).toBe(true);
    expect(flags.teamRun).toMatchObject({ members: MEMBERS, status: false });
    expect(__testing.parseFlags(['codex', '--template', 'team'])).toContain('needs the people of the team');
    expect(__testing.parseFlags(['codex', '--template', 'team', '--members', MEMBERS, '--serves', 'several'])).toContain('drop --serves');
    expect(__testing.parseFlags(['codex', '--template', 'team', '--members', MEMBERS, '--shape', 'household'])).toContain('household template');
    expect(__testing.parseFlags(['codex', '--template', 'house'])).toContain("unknown --template 'house'");
    expect(__testing.parseFlags(['codex', '--guests', 'oauth_client:x'])).toContain('--guests applies to --template team');
    expect((__testing.parseFlags(['codex', '--template', 'team', '--status']) as any).teamRun.status).toBe(true);
  });

  test('the brain-layout block names correct --scope team only for the team template', () => {
    expect(renderLayoutBlock('codex', 'user', null, 'company', true)).toContain('correct --scope team');
    expect(renderLayoutBlock('codex', 'user', null, 'company')).not.toContain('correct --scope team');
  });
});
