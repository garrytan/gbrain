/**
 * GST-2768: a personal archive with more folders than a source's rule limit (MAX_RULES) that becomes shared. The
 * re-scope keeps every earlier day to the owner, leaves a rulebook that still validates, and gbrain access rule list,
 * rule add and access apply keep working afterwards. Checked with remote=true credentials bound to members through
 * get_page and search. Repo-less PGLite; every value is synthetic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addGroup, addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { appliedRules, proposeRevision } from '../src/core/access/policy.ts';
import { MAX_RULES, normalizeRule, parsePolicyYaml, serializePolicyYaml } from '../src/core/access/folder-rules.ts';
import assert from 'node:assert';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveGroupPrincipal, archiveStatus, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { checkTranscriptArchiveFreshness } from '../src/commands/doctor/checks/transcript-archive.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const SRC = 'conversations';
const FOLDERS = 300;
const NOW = new Date('2026-11-05T00:00:00Z');
let engine: PGLiteEngine;
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

async function token(who: string): Promise<AuthInfo> {
  const minted = await mintLegacyToken(engine, { name: 'tok-' + who, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member: who });
  return await provider().verifyAccessToken(minted.token) as unknown as AuthInfo;
}
const text = (out: { content: Array<{ text?: string }> }) => out.content.map(c => c.text ?? '').join('\n');
const ctx = (auth: AuthInfo) => ({ remote: true, transport: 'http' as const, auth, sourceId: SRC, takesHoldersAllowList: ['world'] });

async function cli(args: string[]): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runAccessRules(engine, args[0]!, [...args.slice(1), '--json'], true); } finally { spy.mockRestore(); }
  return JSON.parse(lines.join('\n'));
}

const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const canary = (i: number) => 'canary-day-' + String(i).padStart(4, '0');

/**
 * One real archive run while personal, then folders - 1 more archive folders seeded directly, then the switch to shared,
 * with otherRules owner-only rules outside conversations/ already applied to the source.
 */
async function longPersonalHistoryThenShared(folderCount = FOLDERS, otherRules = 0): Promise<string[]> {
  await engine.setConfig('brain.audience', 'personal');
  const reader = staticReader('codex', [conversation('codex', 'cap-session', [['user', '2026-11-04T10:00:00.000Z', canary(0) + ' personal era note']])]);
  const first = await runTranscriptArchive(engine, { mode: 'run', readers: [reader], now: NOW });
  expect(first.privacy).toBe('personal');
  const slugs = [(await archivedPages(engine, SRC)).find(p => p.body.includes(canary(0)))!.slug];
  for (let i = 1; i < folderCount; i++) {
    const harness = ['claude-code', 'codex', 'openclaw'][i % 3]!;
    const slug = 'conversations/' + harness + '/' + day(i) + '/session-' + i;
    await importFromContent(engine, slug, ['---', 'type: conversation', 'title: Session ' + i, '---', '# Session ' + i, '', canary(i) + ' personal era note.'].join('\n'), { sourceId: SRC, noEmbed: true });
    slugs.push(slug);
  }
  await engine.setConfig('brain.audience', 'shared');
  for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
  await setOwner(engine, 'alice-example');
  if (otherRules) {
    const rules = Array.from({ length: otherRules }, (_, i) => normalizeRule({ prefix: 'notes/topic-' + i + '/', readable_by: ['alice-example'] }));
    await proposeRevision(engine, SRC, rules.map(r => ('rule' in r ? r.rule : assert.fail(r.problem))), { origin: 'cli', store: 'database', proposedBy: 'test' });
    expect((await appliedRules(engine, SRC)).length).toBe(otherRules);
  }
  return slugs;
}

const statusLine = async () => (await archiveStatus(engine, { readers: [] })).rescope;
const doctorLine = async () => checkTranscriptArchiveFreshness(engine, { readers: [staticReader('codex', [])], nowMs: NOW.getTime() });

describe('the archive re-scope past the folder-rule limit (pglite, remote=true)', () => {
  test(FOLDERS + ' archive folders: every day closes to a non-owner, the rulebook validates, and rule list, add and apply still work', async () => {
    const slugs = await longPersonalHistoryThenShared();
    const folders = (await engine.executeRaw<{ n: number }>("SELECT count(DISTINCT regexp_replace(slug, '[^/]+$', ''))::int AS n FROM pages WHERE source_id = $1 AND slug LIKE 'conversations/%'", [SRC]))[0]!.n;
    expect(folders).toBeGreaterThan(MAX_RULES);
    const next = await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('codex', [])], now: NOW });
    expect(next.privacy).toBe('shared');

    const [owner, other] = [await token('alice-example'), await token('bob-example')];
    for (const [i, slug] of slugs.entries()) {
      expect(text(await dispatchToolCall(engine, 'get_page', { slug }, ctx(other)))).not.toContain(canary(i));
    }
    for (const i of [0, 1, 150, FOLDERS - 1]) {
      expect(text(await dispatchToolCall(engine, 'search', { query: canary(i), match: 'keyword', fields: 'full' }, ctx(other)))).not.toContain(canary(i));
    }
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: slugs[150]! }, ctx(owner)))).toContain(canary(150));

    const rules = await appliedRules(engine, SRC);
    expect(rules.length).toBeLessThanOrEqual(MAX_RULES);
    expect(parsePolicyYaml(serializePolicyYaml(rules)).ok).toBe(true);
    expect(rules.filter(r => r.prefix.startsWith('conversations/'))).toEqual([expect.objectContaining({ prefix: 'conversations/', readable_by: ['member:alice-example'] })]);

    const status = await archiveStatus(engine, { readers: [] });
    expect(status.rescope).toMatchObject({ code: 'archive_rescope_folder_cap' });
    expect(status.rescope!.message).toContain('group conversations archived since stay owner-only');
    expect(status.rescope!.message).toContain('opens every earlier personal day');
    const doctor = await checkTranscriptArchiveFreshness(engine, { readers: [staticReader('codex', [])], nowMs: NOW.getTime() });
    expect(doctor.status).toBe('warn');
    expect(doctor.message).toContain('group conversations archived since stay owner-only');

    const listed = await cli(['rule', 'list', '--source', SRC]);
    expect(listed.invalid).toEqual([]);
    expect((listed.rules as unknown[]).length).toBe(rules.length);
    const add = ['rule', 'add', '--prefix', 'notes/', '--readers', 'alice-example,bob-example', '--source', SRC];
    const preview = await cli(add);
    expect(preview.applied).toBe(false);
    const added = await cli([...add, '--yes']);
    expect(added.state).toBe('applied');
    expect((await appliedRules(engine, SRC)).some(r => r.prefix === 'notes/')).toBe(true);
    const applyPreview = await cli(['apply', '--source', SRC]);
    expect(applyPreview.applied).toBe(false);
    if (applyPreview.plan_hash) expect((await cli(['apply', '--source', SRC, '--yes', '--expect', String(applyPreview.plan_hash)])).revision).toBeDefined();
    expect(parsePolicyYaml(serializePolicyYaml(await appliedRules(engine, SRC))).ok).toBe(true);
  }, 600_000);

  test('past the limit, a group conversation archived later stays the owner\'s: a wider rule on its own folder does not open it under the conversations/ rule', async () => {
    await longPersonalHistoryThenShared();
    await addMember(engine, 'carol-example');
    await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('codex', [])], now: NOW });
    const groupKey = 'agent:main:telegram:group:example-group-9';
    const principal = archiveGroupPrincipal('openclaw', groupKey);
    await addGroup(engine, principal, ['bob-example']);
    const group = staticReader('openclaw', [conversation('openclaw', groupKey, [['user', '2026-11-05T11:00:00.000Z', 'canary-group-after-0009 team note']], { chatType: 'group', verified: true })]);
    await runTranscriptArchive(engine, { mode: 'run', readers: [group], now: new Date('2026-11-06T00:00:00Z') });
    const groupSlug = (await archivedPages(engine, SRC)).find(p => p.body.includes('canary-group-after-0009'))!.slug;
    const [member, other] = [await token('bob-example'), await token('carol-example')];
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: groupSlug }, ctx(member)))).not.toContain('canary-group-after-0009');

    const add = ['rule', 'add', '--prefix', groupSlug.replace(/[^/]+$/, ''), '--readers', 'alice-example,group:' + principal, '--source', SRC];
    await cli(add);
    await cli([...add, '--yes']);
    const applyPreview = await cli(['apply', '--source', SRC]);
    if (applyPreview.plan_hash) await cli(['apply', '--source', SRC, '--yes', '--expect', String(applyPreview.plan_hash)]);
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: groupSlug }, ctx(member)))).not.toContain('canary-group-after-0009');
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: groupSlug }, ctx(other)))).not.toContain('canary-group-after-0009');
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: groupSlug }, ctx(await token('alice-example'))))).toContain('canary-group-after-0009');
  }, 600_000);
});

describe('what status and doctor say after the folder-cap fallback (pglite, remote=true)', () => {
  test('once the owner widens the conversations/ rule, status and doctor stop saying the folder is kept to the owner', async () => {
    await longPersonalHistoryThenShared(3, MAX_RULES - 2);
    await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('codex', [])], now: NOW });
    expect((await appliedRules(engine, SRC)).length).toBeLessThanOrEqual(MAX_RULES);
    expect(await statusLine()).toMatchObject({ code: 'archive_rescope_folder_cap' });

    const id = (await appliedRules(engine, SRC)).find(r => r.prefix === 'conversations/')!.id;
    const widen = ['rule', 'add', '--id', String(id), '--prefix', 'conversations/', '--readers', 'alice-example,bob-example', '--source', SRC];
    await cli(widen);
    await cli([...widen, '--yes']);
    const applyPreview = await cli(['apply', '--source', SRC]);
    if (applyPreview.plan_hash) await cli(['apply', '--source', SRC, '--yes', '--expect', String(applyPreview.plan_hash)]);
    expect((await appliedRules(engine, SRC)).find(r => r.prefix === 'conversations/')!.readable_by).toEqual(['member:alice-example', 'member:bob-example']);

    expect(await statusLine()).toBeUndefined();
    const doctor = await doctorLine();
    expect(doctor.message).not.toContain('archive_rescope_folder_cap');
    expect(doctor.message).not.toContain('to the owner');
  }, 600_000);

  test('200 folders and 100 other rules: the line says the folders with the other rules pass the limit, not the folders alone', async () => {
    await longPersonalHistoryThenShared(200, 100);
    await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('codex', [])], now: NOW });
    const line = await statusLine();
    expect(line).toMatchObject({ code: 'archive_rescope_folder_cap' });
    expect(line!.message).toMatch(/fill 20\d folders, and one owner-only rule per folder/);
    expect(line!.message).not.toMatch(/folders, more than the/);
    expect(line!.message).toContain("with the source's other rules would pass the " + MAX_RULES + ' rules');
  }, 600_000);

  test('a source already at the limit in other rules ends one over it: the days stay closed and status names the failed export', async () => {
    const slugs = await longPersonalHistoryThenShared(3, MAX_RULES);
    await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('codex', [])], now: NOW });
    const rules = await appliedRules(engine, SRC);
    expect(rules.length).toBe(MAX_RULES + 1);
    expect(rules.filter(r => r.prefix.startsWith('notes/')).length).toBe(MAX_RULES);
    expect(parsePolicyYaml(serializePolicyYaml(rules)).ok).toBe(false);
    const other = await token('bob-example');
    for (const [i, slug] of slugs.entries()) expect(text(await dispatchToolCall(engine, 'get_page', { slug }, ctx(other)))).not.toContain(canary(i));

    const line = await statusLine();
    expect(line).toMatchObject({ code: 'archive_rescope_folder_cap' });
    expect(line!.message).toContain('now holds ' + (MAX_RULES + 1) + ' rules');
    expect(line!.message).toContain('gbrain access rule export then import fails validation');
    expect((await doctorLine()).message).toContain('gbrain access rule export then import fails validation');
  }, 600_000);
});
