/**
 * GST-2768 PR 3 review fixes (one round). Each test failed before its fix:
 *  - a brain archived by default while personal and then made shared is re-scoped to the owner even though the unset
 *    switch now resolves off, and doctor reports a pending re-scope while the archive is off;
 *  - held older days do not finish the automatic backfill, so they are archived once the hold clears;
 *  - a shared declaration that lives only in the config file keeps the automatic pass off;
 *  - a reader whose scan outlasts the pass budget still archives at least one conversation per pass.
 * Repo-less PGLite, remote=true reads, synthetic values only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, setArchiveEnabled, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { ARCHIVE_BACKFILL_STATE_KEY, readArchiveMaintenance, runArchiveMaintenance } from '../src/core/transcripts/archive-maintenance.ts';
import { checkTranscriptArchiveFreshness } from '../src/commands/doctor/checks/transcript-archive.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const SRC = 'conversations';
let engine: PGLiteEngine;
let home: string;
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await engine.setConfig('transcripts.archive.maintenance_floor_min', '0');
  home = mkdtempSync(join(tmpdir(), 'gb-archive-review-'));
  return () => rmSync(home, { recursive: true, force: true });
});

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const pass = (now: Date, readers: ArchiveReader[], extra: { budgetMs?: number } = {}) => inHome(() => runArchiveMaintenance(engine, { runner: 'test', now, readers, ...extra }));
async function token(who: string): Promise<AuthInfo> {
  const minted = await mintLegacyToken(engine, { name: 'tok-' + who, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member: who });
  return await provider().verifyAccessToken(minted.token) as unknown as AuthInfo;
}
const text = (out: { content: Array<{ text?: string }> }) => out.content.map(c => c.text ?? '').join('\n');

describe('PR 3 review fixes', () => {
  test('a default-on brain made shared is re-scoped by the next pass although the unset switch now resolves off', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const canary = 'canary-default-flip-0011';
    const first = await pass(new Date('2026-11-05T00:00:00Z'), [staticReader('codex', [conversation('codex', 'flip-session', [['user', '2026-11-04T10:00:00.000Z', canary + ' private']])])]);
    expect(first.record?.written).toBe(1);
    await engine.setConfig('brain.audience', 'shared');
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    await setOwner(engine, 'alice-example');
    const second = await pass(new Date('2026-11-06T00:00:00Z'), [staticReader('codex', [])]);
    expect(second.code).toBe('archive_off');
    const slug = (await archivedPages(engine, SRC)).find(p => p.body.includes(canary))!.slug;
    const ctx = (auth: AuthInfo) => ({ remote: true, transport: 'http' as const, auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
    expect(text(await dispatchToolCall(engine, 'get_page', { slug }, ctx(await token('bob-example'))))).not.toContain(canary);
    expect(text(await dispatchToolCall(engine, 'search', { query: canary }, ctx(await token('bob-example'))))).not.toContain(slug);
    expect(text(await dispatchToolCall(engine, 'get_page', { slug }, ctx(await token('alice-example'))))).toContain(canary);
  }, 120_000);

  test('doctor reports a re-scope that is still waiting while the archive is off', async () => {
    await engine.setConfig('brain.audience', 'personal');
    await pass(new Date('2026-11-05T00:00:00Z'), [staticReader('codex', [conversation('codex', 'flip-session-2', [['user', '2026-11-04T10:00:00.000Z', 'personal note']])])]);
    await engine.setConfig('brain.audience', 'shared');
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    const check = await inHome(() => checkTranscriptArchiveFreshness(engine, { readers: [], nowMs: Date.parse('2026-11-06T00:00:00Z') }));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain access owner set');
  }, 120_000);

  test('held older days keep the automatic backfill open, and are archived once the hold clears', async () => {
    await engine.setConfig('brain.audience', 'shared');
    for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
    await setArchiveEnabled(engine, true);
    const readers = () => [staticReader('codex', [conversation('codex', 'held-old', [['user', '2026-10-01T10:00:00.000Z', 'older held day']])])];
    const first = await pass(new Date('2026-11-05T00:00:00Z'), readers());
    expect(first.record?.held).toBeGreaterThan(0);
    expect(first.record?.backfill?.done).toBe(false);
    expect(await engine.getConfig(ARCHIVE_BACKFILL_STATE_KEY)).toBeNull();
    await setOwner(engine, 'alice-example');
    const second = await pass(new Date('2026-11-05T07:00:00Z'), readers());
    expect(second.record?.written).toBe(1);
  }, 120_000);

  test('a shared declaration kept only in the config file keeps the automatic pass off', async () => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', brain: { audience: 'shared' } }));
    const outcome = await pass(new Date('2026-11-05T00:00:00Z'), [staticReader('codex', [conversation('codex', 'file-shared', [['user', '2026-11-04T10:00:00.000Z', 'host note']])])]);
    expect(outcome).toMatchObject({ status: 'skipped', code: 'archive_off' });
    expect(await archivedPages(engine, SRC)).toEqual([]);
  }, 60_000);

  test('a reader whose scan outlasts the pass budget still archives a conversation each pass', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const slowScan: ArchiveReader = {
      harness: 'codex', name: 'codex-slow-scan',
      async *scan(opts) {
        await new Promise(resolve => setTimeout(resolve, 300));
        for (let i = 0; i < 3; i++) {
          const conv = conversation('codex', 'slow-scan-' + i, [['user', '2026-11-04T10:0' + i + ':00.000Z', 'slow scan ' + i]]);
          yield { harness: 'codex', conversationKey: conv.conversationKey, sessionId: conv.conversationKey, days: [opts.dayOf('2026-11-04T10:00:00.000Z')], load: async () => conv };
        }
      },
    };
    const outcome = await pass(new Date('2026-11-05T00:00:00Z'), [slowScan], { budgetMs: 100 });
    expect(outcome.record?.stopped_at_deadline).toBe(true);
    expect(outcome.record?.written).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
