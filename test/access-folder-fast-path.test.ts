/**
 * GBRA-218 (A2) folder rules on an unrestricted brain. A1's fast path reads a
 * brain whose access.restrictions_present flag is unset with the short form of
 * accessAllowedSql. Creating the first folder rule sets the flag in the same
 * transaction, so the very next remote request hides pages under the prefix;
 * and with the flag forced back off the short form still hides them, because
 * it tests the stamped folder_rule_ids column too. Repo-less PGLite, keyless.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const SRC = 'fold-fast';
let engine: PGLiteEngine;
let token = '';
const page = (title: string, canary: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Canary ' + canary + '.'].join('\n');
const flagSet = async () => (await engine.executeRaw("SELECT 1 FROM config WHERE key = 'access.restrictions_present' AND value = '1'")).length === 1;

async function seen(slug: string, canary: string): Promise<boolean> {
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) })
    .verifyAccessToken(token) as unknown as AuthInfo;
  const read = async (op: string, params: Record<string, unknown>) => (await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] }))
    .content.map(c => c.text).join('\n');
  return (await read('search', { query: canary, match: 'keyword', fields: 'full' })).includes(canary)
    || (await read('get_page', { slug })).includes(canary)
    || (await read('list_pages', { limit: 50 })).includes(slug);
}

describe('folder rules on an unrestricted brain (pglite, repo-less)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
    await importFromContent(engine, 'partners/alice-example/plan', page('Plan', 'foldfastplan'), { sourceId: SRC, noEmbed: true });
    await importFromContent(engine, 'notes/open', page('Open', 'foldfastopen'), { sourceId: SRC, noEmbed: true });
    token = (await mintLegacyToken(engine, { name: 'unbound', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] })).token;
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the first narrowing rule hides its folder on the next request, and the flag forced off keeps it hidden', async () => {
    expect(await flagSet()).toBe(false);
    expect(await seen('partners/alice-example/plan', 'foldfastplan')).toBe(true);
    await proposeRevision(engine, SRC, [{ id: 'alice', prefix: 'partners/alice-example/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
    expect(await flagSet()).toBe(true);
    expect(await seen('partners/alice-example/plan', 'foldfastplan')).toBe(false);
    expect(await seen('notes/open', 'foldfastopen')).toBe(true);
    await engine.executeRaw("DELETE FROM config WHERE key = 'access.restrictions_present'");
    expect(await seen('partners/alice-example/plan', 'foldfastplan')).toBe(false);
    expect(await seen('notes/open', 'foldfastopen')).toBe(true);
  }, 120_000);

  test('an invalid policy file on an unrestricted brain sets the flag', async () => {
    await engine.executeRaw("DELETE FROM config WHERE key = 'access.restrictions_present'");
    await engine.executeRaw("INSERT INTO access_pending_coverage (source_id, prefix, reason) VALUES ($1, 'hr/', 'invalid')", [SRC]);
    expect(await flagSet()).toBe(true);
  }, 60_000);
});
