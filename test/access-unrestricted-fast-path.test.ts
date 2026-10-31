/**
 * GBRA-218: the unrestricted fast path. On a brain whose config
 * access.restrictions_present is unset, a remote read tests only each row's
 * own derived readers column (accessAllowedSql's short form). This file proves the short form
 * never shows a page that names readers: the trigger flips the flag in the
 * page's own transaction, and even with the flag forced back off the row test
 * alone still hides the page. Repo-less PGLite, keyless.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { accessAllowedSql, withCallerAccess } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const SRC = 'fast-src';
let engine: PGLiteEngine;
let token = '';

async function seen(slug: string, canary: string): Promise<boolean> {
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) })
    .verifyAccessToken(token) as unknown as AuthInfo;
  const read = async (op: string, params: Record<string, unknown>) => (await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] }))
    .content.map(c => c.text).join('\n');
  // get_page echoes a missing slug in its not-found error, so only its content counts.
  return (await read('search', { query: canary, match: 'keyword', fields: 'full' })).includes(canary)
    || (await read('get_page', { slug })).includes(canary)
    || (await read('list_pages', { limit: 50 })).includes(slug);
}

describe('unrestricted fast path (pglite, repo-less)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
    await importFromContent(engine, 'notes/open-page', '---\ntype: note\ntitle: Open\n---\nCanary fastopenpage.', { sourceId: SRC, noEmbed: true });
    token = (await mintLegacyToken(engine, { name: 'unbound', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] })).token;
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the short form is used only when the request record says unrestricted, and tests the row readers', () => {
    const full = withCallerAccess({ restricted: true }, () => accessAllowedSql('p', []));
    const short = withCallerAccess({ restricted: false }, () => accessAllowedSql('p', ['member:alice-example']));
    expect(full).toContain('gbrain_access_origin_restricted');
    expect(short).not.toContain('gbrain_access_origin_restricted');
    expect(short).toBe('(p.page_readers IS NULL)');
    expect(accessAllowedSql('p', [])).toContain('gbrain_access_origin_restricted');
  });

  test('a page that gains readers is hidden on the next request, and stays hidden with the flag forced off', async () => {
    expect((await engine.executeRaw("SELECT 1 FROM config WHERE key = 'access.restrictions_present' AND value = '1'")).length).toBe(0);
    expect(await seen('notes/open-page', 'fastopenpage')).toBe(true);
    await importFromContent(engine, 'notes/open-page', '---\ntype: note\ntitle: Open\nreadable_by: [alice-example]\n---\nCanary fastopenpage.', { sourceId: SRC, noEmbed: true });
    expect((await engine.executeRaw("SELECT 1 FROM config WHERE key = 'access.restrictions_present' AND value = '1'")).length).toBe(1);
    expect(await seen('notes/open-page', 'fastopenpage')).toBe(false);
    await engine.executeRaw("DELETE FROM config WHERE key = 'access.restrictions_present'");
    expect(await seen('notes/open-page', 'fastopenpage')).toBe(false);
  }, 120_000);
});
