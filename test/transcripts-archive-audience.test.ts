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
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
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

async function token(who: string): Promise<AuthInfo> {
  const minted = await mintLegacyToken(engine, { name: 'tok-' + who, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
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
