/**
 * A member's `remember` under a granted token persists and reads back (GBRA-190, harness-evals HARN-2 follow-up).
 *
 * Protects: a token rescoped to `--sources private-alice,public` (write source first) remembers into its write source,
 * and the same token finds the fact again: `recall` returns it, and `search` shows it in the model-visible
 * "Saved facts (remember)" block after the (empty) result array. A harness check that reads only the JSON blocks of a
 * search result sees no fact there, which is not a dropped write. A token with no grant for the write source never sees it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { generateToken, hashToken } from '../src/core/utils.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['public', 'private-alice', 'private-bob']) {
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{"federated":true}'::jsonb) ON CONFLICT DO NOTHING`, [id]);
  }
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example is a company.', timeline: '', frontmatter: {} }, { sourceId: 'public' });
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

async function grantedToken(sources: string): Promise<AuthInfo> {
  const name = `member-${randomUUID().slice(0, 8)}`;
  const token = generateToken('gbrain_');
  await engine.executeRaw("INSERT INTO access_tokens (name, token_hash, scopes) VALUES ($1, $2, '{read,write}'::text[])", [name, hashToken(token)]);
  await rescopeLegacyToken(engine, parseRescopeTokenArgs([name, '--sources', sources]));
  return await provider().verifyAccessToken(token) as unknown as AuthInfo;
}

const call = (auth: AuthInfo, op: string, args: Record<string, unknown>) =>
  dispatchToolCall(engine, op, args, { remote: true, transport: 'http', sourceId: auth.sourceId, auth });

describe('remember under a granted member token', () => {
  test('lands in the write source and reads back through recall and search; another member never sees it', async () => {
    const alice = await grantedToken('private-alice,public');
    expect(alice).toMatchObject({ sourceId: 'private-alice', allowedSources: ['private-alice', 'public'], hasSourceGrant: true });

    const remembered = await call(alice, 'remember', { fact: 'Acme Example asked about ticket 4092', provenance: 'member turn', entity: 'Acme Example' });
    expect(remembered.isError).toBeFalsy();
    const out = JSON.parse(remembered.content[0].text);
    expect(out.status).toBe('inserted');

    const [row] = await engine.executeRaw<{ source_id: string; expired_at: unknown }>('SELECT source_id, expired_at FROM facts WHERE id = $1', [Number(out.id)]);
    expect(row).toMatchObject({ source_id: 'private-alice', expired_at: null });

    const recalled = await call(alice, 'recall', { query: 'ticket 4092' });
    expect(JSON.parse(recalled.content[0].text).facts.map((f: { fact: string }) => f.fact)).toContain('Acme Example asked about ticket 4092');

    const searched = await call(alice, 'search', { query: 'ticket 4092' });
    expect(JSON.parse(searched.content[0].text)).toEqual([]);
    expect(searched.content.slice(1).some(c => c.text.startsWith('Saved facts (remember)') && c.text.includes('Acme Example asked about ticket 4092'))).toBe(true);

    const bob = await grantedToken('private-bob,public');
    const bobRecall = await call(bob, 'recall', { query: 'ticket 4092' });
    expect(JSON.parse(bobRecall.content[0].text).facts.map((f: { fact: string }) => f.fact)).not.toContain('Acme Example asked about ticket 4092');
    const bobSearch = await call(bob, 'search', { query: 'ticket 4092' });
    expect(bobSearch.content.some(c => c.text.includes('ticket 4092'))).toBe(false);
  }, 120_000);
});
