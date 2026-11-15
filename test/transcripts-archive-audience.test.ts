/**
 * GST-2768 PR 2: the archive and a brain's audience. A brain archived while personal and then made shared keeps no
 * earlier archive page open to other members: the next run re-scopes the finished days first, checked with remote=true
 * credentials bound to members through get_page and search. A run whose audience lookup failed publishes nothing.
 * Repo-less PGLite; every value is synthetic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
import { ARCHIVE_SOURCE_KEY, ARCHIVE_TIMEZONE_KEY, archiveGroupPrincipal, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const SRC = 'conversations';
const CANARY = 'canary-personal-era-0007';
let engine: PGLiteEngine;
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

async function token(who: string, source = SRC): Promise<AuthInfo> {
  const minted = await mintLegacyToken(engine, { name: 'tok-' + who + '-' + source, scopes: ['read'], takesHolders: ['world'], sourceGrant: [source] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member: who });
  return await provider().verifyAccessToken(minted.token) as unknown as AuthInfo;
}
const text = (out: { content: Array<{ text?: string }> }) => out.content.map(c => c.text ?? '').join('\n');

describe('archive and the brain audience (pglite, remote=true)', () => {
  test('a day archived while personal is re-scoped when the brain becomes shared: a non-owner member reads it through neither get_page nor search', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const reader = staticReader('openclaw', [conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', CANARY + ' private note']], { chatType: 'direct', verified: true })]);
    const first = await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [reader], now: new Date('2026-10-05T00:00:00Z') });
    expect([first.privacy, first.written]).toEqual(['personal', 1]);
    await engine.setConfig('brain.audience', 'shared');
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    await setOwner(engine, 'alice-example');
    const next = await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('openclaw', [])], now: new Date('2026-11-05T00:00:00Z') });
    expect(next.privacy).toBe('shared');
    const slug = (await archivedPages(engine, SRC)).find(p => p.body.includes(CANARY))!.slug;
    const [owner, other] = [await token('alice-example'), await token('bob-example')];
    const ctx = (auth: AuthInfo) => ({ remote: true, transport: 'http' as const, auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
    expect(text(await dispatchToolCall(engine, 'get_page', { slug }, ctx(other)))).not.toContain(CANARY);
    expect(text(await dispatchToolCall(engine, 'search', { query: CANARY }, ctx(other)))).not.toContain(slug);
    expect(text(await dispatchToolCall(engine, 'get_page', { slug }, ctx(owner)))).toContain(CANARY);
  }, 120_000);

  test('after the re-scope, a group conversation archived on the shared brain keeps its group: the group member reads it, the personal-era day stays the owner\'s', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const dm = staticReader('openclaw', [conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', CANARY + ' private note']], { chatType: 'direct', verified: true })]);
    await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [dm], now: new Date('2026-10-05T00:00:00Z') });
    await engine.setConfig('brain.audience', 'shared');
    for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
    await setOwner(engine, 'alice-example');
    const groupKey = 'agent:main:telegram:group:example-group-9';
    await addGroup(engine, archiveGroupPrincipal('openclaw', groupKey), ['bob-example']);
    const group = staticReader('openclaw', [conversation('openclaw', groupKey, [['user', '2026-11-04T11:00:00.000Z', 'canary-group-after-0009 team note']], { chatType: 'group', verified: true })]);
    const next = await runTranscriptArchive(engine, { mode: 'run', readers: [group], now: new Date('2026-11-05T00:00:00Z') });
    expect(next.privacy).toBe('shared');
    const pages = await archivedPages(engine, SRC);
    const groupSlug = pages.find(p => p.body.includes('canary-group-after-0009'))!.slug;
    const dmSlug = pages.find(p => p.body.includes(CANARY))!.slug;
    const [owner, member, other] = [await token('alice-example'), await token('bob-example'), await token('carol-example')];
    const ctx = (auth: AuthInfo) => ({ remote: true, transport: 'http' as const, auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: groupSlug }, ctx(member)))).toContain('canary-group-after-0009');
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: groupSlug }, ctx(owner)))).toContain('canary-group-after-0009');
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: groupSlug }, ctx(other)))).not.toContain('canary-group-after-0009');
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: dmSlug }, ctx(member)))).not.toContain(CANARY);
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: dmSlug }, ctx(owner)))).toContain(CANARY);
  }, 120_000);

  test('the re-scope keeps to the archive\'s own folders: a page outside conversations/ in the same source stays readable and its owner rule is untouched', async () => {
    const shared = 'source-a';
    const outside = 'notes/plan-a';
    const OUTSIDE_CANARY = 'canary-outside-archive-0011';
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [shared]);
    await engine.setConfig(ARCHIVE_SOURCE_KEY, shared);
    await importFromContent(engine, outside, ['---', 'type: note', 'title: Plan A', '---', '# Plan A', '', 'Canary ' + OUTSIDE_CANARY + '.'].join('\n'), { sourceId: shared, noEmbed: true });
    await engine.setConfig('brain.audience', 'personal');
    const reader = staticReader('openclaw', [conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', CANARY + ' private note']], { chatType: 'direct', verified: true })]);
    const first = await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [reader], now: new Date('2026-10-05T00:00:00Z') });
    expect([first.privacy, first.written]).toEqual(['personal', 1]);
    await engine.setConfig('brain.audience', 'shared');
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    await setOwner(engine, 'alice-example');
    await proposeRevision(engine, shared, [{ id: 'notes-team', prefix: 'notes/', readable_by: ['member:alice-example', 'member:bob-example'] }], { origin: 'cli', store: 'database' });
    const before = await appliedRules(engine, shared);
    expect(before.map(r => r.prefix)).toEqual(['notes/']);
    const next = await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('openclaw', [])], now: new Date('2026-11-05T00:00:00Z') });
    expect(next.privacy).toBe('shared');
    const after = await appliedRules(engine, shared);
    expect(after.filter(r => r.prefix === 'notes/')).toEqual(before);
    expect(after.filter(r => !r.prefix.startsWith('conversations/')).map(r => r.prefix)).toEqual(['notes/']);
    const slug = (await archivedPages(engine, shared)).find(p => p.body.includes(CANARY))!.slug;
    const [owner, other] = [await token('alice-example', shared), await token('bob-example', shared)];
    const ctx = (auth: AuthInfo) => ({ remote: true, transport: 'http' as const, auth, sourceId: shared, takesHoldersAllowList: ['world'] });
    expect(text(await dispatchToolCall(engine, 'get_page', { slug: outside }, ctx(other)))).toContain(OUTSIDE_CANARY);
    expect(text(await dispatchToolCall(engine, 'search', { query: OUTSIDE_CANARY, match: 'keyword', fields: 'full' }, ctx(other)))).toContain(OUTSIDE_CANARY);
    expect(text(await dispatchToolCall(engine, 'get_page', { slug }, ctx(other)))).not.toContain(CANARY);
    expect(text(await dispatchToolCall(engine, 'search', { query: CANARY, match: 'keyword', fields: 'full' }, ctx(other)))).not.toContain(CANARY);
    expect(text(await dispatchToolCall(engine, 'get_page', { slug }, ctx(owner)))).toContain(CANARY);
  }, 120_000);

  test('a run whose audience lookup failed writes no day page and ends archive_audience_unproven', async () => {
    const failing = new Proxy(engine, { get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
      return (sql: string, params?: unknown[]) => /mcp_request_log/.test(sql) ? Promise.reject(new Error('synthetic usage read failure')) : target.executeRaw(sql, params);
    } }) as unknown as BrainEngine;
    const reader = staticReader('claude-code', [conversation('claude-code', 'session-unproven', [['user', '2026-10-01T10:00:00.000Z', 'unproven audience note']])]);
    const err = await runTranscriptArchive(failing, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [reader], now: new Date('2026-10-05T00:00:00Z') }).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe('archive_audience_unproven');
    expect(await archivedPages(engine, SRC)).toEqual([]);
  }, 120_000);
});
