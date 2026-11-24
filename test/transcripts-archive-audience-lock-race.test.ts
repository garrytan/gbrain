/**
 * GST-3662: a conversation archive run reads the brain's audience (personal or shared, and the owner) before it takes
 * the source's run lock. A member add that turns the brain shared and finishes in that gap re-scopes the pages archived
 * so far and records the audience shared, so the run must not then write with the personal audience it read first:
 * it re-reads the audience under the lock and writes owner-only pages, or, when the new audience moves the run to
 * another source (a checkout's <source>-owner twin), writes nothing and says to rerun. Synthetic values only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import * as dbLock from '../src/core/db-lock.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { runAccess } from '../src/commands/access.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const SRC = 'conversations';
const OWNER = 'alice-example';
const OTHER = 'bob-example';
const EARLY = 'bodyonlyearlyqzx';
const LATE = 'bodyonlylatewvk';

/** Runs gbrain access member add for OTHER, start to finish, after the run has read the audience and before it takes its lock. */
function addMemberBeforeTheRunLock(engine: BrainEngine, home: string) {
  const original = dbLock.withRefreshingLock;
  let fired = false;
  return spyOn(dbLock, 'withRefreshingLock').mockImplementation((async (...args: Parameters<typeof original>) => {
    if (!fired && args[1] === 'transcripts-archive:' + SRC) {
      fired = true;
      const quiet = spyOn(console, 'error').mockImplementation(() => {});
      try { await withEnv({ GBRAIN_HOME: home }, () => runAccess(engine, ['member', 'add', OTHER])); } finally { quiet.mockRestore(); }
    }
    return original(...args);
  }) as typeof original);
}

const early = (key: string) => staticReader('openclaw', [conversation('openclaw', key, [['user', '2026-10-01T10:00:00.000Z', 'harbor planning notes ' + EARLY]], { chatType: 'direct', verified: true })]);
const late = (key: string) => staticReader('openclaw', [conversation('openclaw', key, [['user', '2026-10-03T10:00:00.000Z', 'ledger planning notes ' + LATE]], { chatType: 'direct', verified: true })]);

for (const kind of testBackends()) {
  describe('archive run whose brain turns shared between its audience read and its run lock (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const home = emptyHome();
    let token = '';
    let result: Awaited<ReturnType<typeof runTranscriptArchive>>;

    async function otherReads(slug: string): Promise<string[]> {
      __resetPrivateVisibilityCacheForTests();
      const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) }).verifyAccessToken(token) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const leaks: string[] = [];
      for (const [label, op, params] of [['get_page', 'get_page', { slug }], ['search keyword', 'search', { query: LATE, match: 'keyword', fields: 'full', limit: 20 }]] as const) {
        const out = await dispatchToolCall(engine, op, { ...params }, {
          remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
          ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
        });
        if (out.content.map(c => c.text ?? '').join('\n').includes(LATE)) leaks.push(label);
      }
      return leaks;
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.setConfig('maintenance.auto', 'false');
      await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
      await setArchiveEnabled(engine, true);
      await addMember(engine, OWNER);
      await setOwner(engine, OWNER);
      const first = await withEnv({ GBRAIN_HOME: home }, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [early('agent:main:main')], now: new Date('2026-10-05T00:00:00Z') }));
      expect(first.privacy).toBe('personal');
      const spy = addMemberBeforeTheRunLock(engine, home);
      try {
        result = await withEnv({ GBRAIN_HOME: home }, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-03', to: '2026-10-03', readers: [late('agent:main:other')], now: new Date('2026-10-05T00:00:00Z') }));
      } finally { spy.mockRestore(); }
      const minted = await mintLegacyToken(engine, { name: 'tok-other', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      token = minted.token;
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OTHER });
    }, 240_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine).catch(() => {});
      await close?.();
    }, 60_000);

    test('the run writes under the audience it finds under its lock: shared, every page kept to the owner', async () => {
      expect(result.errors).toEqual([]);
      expect(result.privacy).toBe('shared');
      const page = (await archivedPages(engine, SRC)).find(p => p.body.includes(LATE));
      expect(page?.frontmatter.readable_by).toEqual([OWNER]);
      expect(await engine.getConfig('transcripts.archive.audience.' + SRC)).toBe('shared');
    }, 60_000);

    test('the second member reads nothing the run wrote', async () => {
      const page = (await archivedPages(engine, SRC)).find(p => p.body.includes(LATE));
      expect(page).toBeDefined();
      expect(await otherReads(page!.slug)).toEqual([]);
    }, 120_000);
  });
}

if (testBackends().includes('pglite')) describe('archive run on a checkout source whose brain turns shared before its run lock (pglite)', () => {
  let engine: PGLiteEngine;
  const home = emptyHome();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-audience-lock-')));

  beforeAll(async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SRC, dir]);
    await engine.setConfig('maintenance.auto', 'false');
    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
    await setArchiveEnabled(engine, true);
    await engine.setConfig('transcripts.archive.audience.' + SRC, 'personal');
    await addMember(engine, OWNER);
    await setOwner(engine, OWNER);
  }, 120_000);

  afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

  test('the run writes nothing into the checkout and asks for a rerun, which archives into the owner-only twin', async () => {
    const spy = addMemberBeforeTheRunLock(engine, home);
    let error: unknown = null;
    try {
      await withEnv({ GBRAIN_HOME: home }, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-03', to: '2026-10-03', readers: [late('agent:main:repo')], now: new Date('2026-10-05T00:00:00Z') }));
    } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect((error as { code?: string } | null)?.code).toBe('archive_audience_changed');
    expect(readdirSync(dir).filter(f => f !== '.git')).toEqual([]);
    expect(await archivedPages(engine, SRC)).toEqual([]);
    const rerun = await withEnv({ GBRAIN_HOME: home }, () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-03', to: '2026-10-03', readers: [late('agent:main:repo')], now: new Date('2026-10-05T00:00:00Z') }));
    expect(rerun.errors).toEqual([]);
    expect(rerun.source_id).toBe(SRC + '-owner');
    expect((await archivedPages(engine, SRC + '-owner')).find(p => p.body.includes(LATE))?.frontmatter.readable_by).toEqual([OWNER]);
  }, 180_000);
});
