/**
 * GST-2768 PR 2, review change 3: read scope of archive pages on a shared brain, read with remote=true credentials
 * bound to members, with access.owner_reads_restricted off. The owner reads every archive page (group pages list the
 * owner beside the group); a group member reads only that group's pages; another member reads none. Repo-less PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addGroup, addMember, bindCredential } from '../src/core/access/members.ts';
import { ownerReadsRestrictedOn, setOwner } from '../src/core/access/owner.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveGroupPrincipal, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const SRC = 'conversations';
let engine: PGLiteEngine;
const tokens: Record<string, string> = {};
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

async function readable(who: string, slug: string, canary: string): Promise<boolean> {
  const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
  return out.content.map(c => c.text).join('\n').includes(canary);
}

const GROUP_KEY = 'agent:main:telegram:group:example-group-2';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('brain.audience', 'shared');
  for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
  await setOwner(engine, 'alice-example');
  await addGroup(engine, archiveGroupPrincipal('openclaw', GROUP_KEY), ['bob-example']);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
  const reader = staticReader('openclaw', [
    conversation('openclaw', 'agent:main:main', [['user', '2026-10-01T10:00:00.000Z', 'canary-dm-0001 private note']], { chatType: 'direct', verified: true }),
    conversation('openclaw', GROUP_KEY, [['user', '2026-10-01T11:00:00.000Z', 'canary-group-0002 team note']], { chatType: 'group', verified: true }),
    conversation('openclaw', 'agent:main:legacy-unknown', [['user', '2026-10-01T12:00:00.000Z', 'canary-unknown-0003']], { verified: false }),
  ]);
  const result = await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', readers: [reader], now: new Date('2026-10-05T00:00:00Z') });
  expect(result.written).toBe(3);
  for (const who of ['alice-example', 'bob-example', 'carol-example']) {
    const minted = await mintLegacyToken(engine, { name: `tok-${who}`, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
    await bindCredential(engine, { kind: 'token', id: minted.id }, { member: who });
    tokens[who] = minted.token;
  }
}, 240_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

describe('archive read scope on a shared brain (pglite, remote=true)', () => {
  test('owner reads all, the group member reads only the group page, another member reads none', async () => {
    expect(await ownerReadsRestrictedOn(engine)).toBe(false);
    const pages = (await archivedPages(engine, SRC)).filter(p => p.slug.startsWith('conversations/openclaw/'));
    const slugOf = (canary: string) => pages.find(p => p.body.includes(canary))!.slug;
    const cases: Array<[string, string]> = [['canary-dm-0001', 'dm'], ['canary-group-0002', 'group'], ['canary-unknown-0003', 'unknown']];
    for (const [canary] of cases) expect(pages.find(p => p.body.includes(canary))!.frontmatter.readable_by).toContain('alice-example');
    const seen = async (who: string) => {
      const out: string[] = [];
      for (const [canary, label] of cases) if (await readable(who, slugOf(canary), canary)) out.push(label);
      return out;
    };
    expect(await seen('alice-example')).toEqual(['dm', 'group', 'unknown']);
    expect(await seen('bob-example')).toEqual(['group']);
    expect(await seen('carol-example')).toEqual([]);
  }, 120_000);

  test('no archive page is open: every page names readers, and none names more than the owner and one group', async () => {
    for (const p of await archivedPages(engine, SRC)) {
      const readers = p.frontmatter.readable_by as string[];
      expect(readers[0]).toBe('alice-example');
      expect(readers.length).toBeLessThanOrEqual(2);
      if (readers.length === 2) expect(readers[1]).toMatch(/^group:chat-[0-9a-f]{8}$/);
    }
  });
});
