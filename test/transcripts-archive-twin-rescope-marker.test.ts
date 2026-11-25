/**
 * A personal-era archive run still writing source C when a member add turns the brain shared leaves C's audience recorded
 * personal (archive_rescope_pending), so the run after it re-scopes what that run wrote. On a shared brain a checkout
 * source archives into its <source>-owner twin under that twin's lock, and that run must not record C as shared while
 * another run holds C: the pages the in-flight run writes after the member add would then never get an owner-only rule.
 * Synthetic values only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveRescopeSkipped, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { runAccess } from '../src/commands/access.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';
import { conversation, staticReader } from './helpers/transcript-archive.ts';

const SRC = 'conversations';
const OWNER = 'alice-example';
const OTHER = 'bob-example';
const LATE = 'bodyonlytwinlatepfn';
const LATE_SLUG = 'conversations/openclaw/2026-10-09/late-in-flight';

describe('an owner-twin archive run while a personal-era run still holds the checkout source (pglite)', () => {
  let engine: PGLiteEngine;
  const home = emptyHome();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-twin-marker-')));
  let bearer = '';
  const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);

  async function otherReads(): Promise<string[]> {
    __resetPrivateVisibilityCacheForTests();
    const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) }).verifyAccessToken(bearer) as unknown as AuthInfo;
    const sourceId = auth.sourceId ?? 'default';
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
    const leaks: string[] = [];
    for (const [label, op, params] of [['get_page', 'get_page', { slug: LATE_SLUG }], ['search keyword', 'search', { query: LATE, match: 'keyword', fields: 'full', limit: 20 }]] as const) {
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      if (out.content.map(c => c.text ?? '').join('\n').includes(LATE)) leaks.push(label);
    }
    return leaks;
  }

  beforeAll(async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SRC, dir]);
    await engine.setConfig('maintenance.auto', 'false');
    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
    await setArchiveEnabled(engine, true);
    await addMember(engine, OWNER);
    await setOwner(engine, OWNER);
    await engine.setConfig('transcripts.archive.audience.' + SRC, 'personal');
    await engine.putPage('conversations/openclaw/2026-10-01/early', { type: 'conversation', title: 'Early', compiled_truth: 'Early harbor notes.', timeline: '', frontmatter: {} }, { sourceId: SRC });

    const inFlight = await tryAcquireDbLock(engine, 'transcripts-archive:' + SRC);
    expect(inFlight).not.toBeNull();
    try {
      const quiet = spyOn(console, 'error').mockImplementation(() => {});
      try { await inHome(() => runAccess(engine, ['member', 'add', OTHER])); } finally { quiet.mockRestore(); }
      const twin = await inHome(() => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-03', to: '2026-10-03', now: new Date('2026-10-12T00:00:00Z'),
        readers: [staticReader('openclaw', [conversation('openclaw', 'agent:main:twin', [['user', '2026-10-03T10:00:00.000Z', 'ledger planning notes']], { chatType: 'direct', verified: true })])] }));
      expect(twin.source_id).toBe(SRC + '-owner');
      await engine.putPage(LATE_SLUG, { type: 'conversation', title: 'Late', compiled_truth: 'Late planning notes ' + LATE + '.', timeline: '', frontmatter: {} }, { sourceId: SRC });
    } finally { await inFlight!.release(); }
    await inHome(() => runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('openclaw', [])], now: new Date('2026-10-12T00:00:00Z') }));

    const minted = await mintLegacyToken(engine, { name: 'tok-other', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
    bearer = minted.token;
    await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OTHER });
  }, 240_000);

  afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

  test('the run after the in-flight run keeps what it wrote to the owner, and nothing is left pending', async () => {
    expect(await otherReads()).toEqual([]);
    expect(await inHome(() => archiveRescopeSkipped(engine))).toBeNull();
  }, 120_000);
});
