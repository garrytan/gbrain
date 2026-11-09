/**
 * #8982: `gbrain sources federate` names the member-written pages it makes readable to every no-grant connection.
 *
 * 1. Protects: a credential bound to a member and granted a non-default source writes there without stamped readers
 *    (GST-2051 stamps only writes the no-grant floor reads). Federating that source adds it to the floor, so an
 *    unbound token then reads the member's page. The federate still happens (exit and config unchanged), and its
 *    output now names the count, the page and its member, the check and restrict commands, on stderr and under
 *    --json as member_pages_exposed. Pages with readers and pages no member credential wrote are not named.
 * 2. Fails when: federate prints no preview of the member's page (master), names a page with readers or an operator
 *    page, warns on unfederate, or stops federating.
 * 3. Existing coverage: access-ungranted-member-writes (the default-source stamp) never federates a source.
 * 4. Real seams: a token minted by the token service and bound with SQL, verified by the OAuth provider, put_page
 *    dispatched through MCP dispatch on a repo-less PGLite brain, then the real sources command.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runSources } from '../src/commands/sources.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const SRC = 'team-notes';
const note = (title: string, body: string, readers = '') =>
  ['---', 'type: note', 'title: ' + title, ...(readers ? ['readable_by: ' + readers] : []), '---', '# ' + title, '', body].join('\n');

describe('sources federate previews member-written pages it exposes (#8982, pglite, repo-less)', () => {
  let engine: PGLiteEngine;
  const tokens: Record<string, string> = {};
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

  async function call(who: string, op: string, params: Record<string, unknown>) {
    const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const sourceId = auth.sourceId ?? 'default';
    const localFederatedSourceIds = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
    const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: ['world'],
      ...(localFederatedSourceIds ? { localFederatedSourceIds } : {}) });
    return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
  }
  async function sources(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const warn = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    try { await runSources(engine, args); } finally { log.mockRestore(); warn.mockRestore(); }
    return { stdout: out.join('\n'), stderr: err.join('\n') };
  }
  const federated = async () => (await engine.executeRaw<{ f: unknown }>("SELECT config->'federated' AS f FROM sources WHERE id = $1", [SRC]))[0]?.f;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example')");
    for (const [name, member, grant] of [['alice', 'alice-example', [SRC, 'default']], ['public', null, undefined]] as const) {
      const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], ...(grant ? { sourceGrant: [...grant] } : {}) });
      tokens[name] = minted.token;
      if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
    }
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('federate names the member page an unbound token then reads; readers and operator pages are not named', async () => {
    const canary = 'plan' + randomUUID().slice(0, 8);
    const slug = 'notes/alice-plan-' + canary;
    expect((await call('alice', 'put_page', { slug, content: note('Alice plan', 'Alice plan ' + canary + '.'), request_id: randomUUID() })).isError).toBe(false);
    expect((await call('alice', 'put_page', { slug: 'notes/alice-kept', content: note('Alice kept', 'Kept.', '[alice-example]'), request_id: randomUUID() })).isError).toBe(false);
    await importFromContent(engine, 'notes/operator-page', note('Operator page', 'Operator.'), { sourceId: SRC, noEmbed: true });
    const [row] = await engine.executeRaw<{ page_readers: unknown }>('SELECT page_readers FROM pages WHERE source_id = $1 AND slug = $2', [SRC, slug]);
    expect(row?.page_readers).toBeNull();
    expect((await call('public', 'get_page', { slug, include_content: true })).text).not.toContain(canary + '.');

    const out = await sources(['federate', SRC]);
    expect(await federated()).toBe(true);
    expect(out.stdout).toContain('is now federated');
    expect(out.stderr).toContain('1 page(s) in "' + SRC + '" were written by a credential bound to a member');
    expect(out.stderr).toContain(slug + ' (member alice-example)');
    expect(out.stderr).toContain('gbrain access rule add --prefix notes/ --readers alice-example --source ' + SRC);
    expect(out.stderr).not.toContain('notes/alice-kept');
    expect(out.stderr).not.toContain('notes/operator-page');
    expect((await call('public', 'get_page', { slug, include_content: true })).text).toContain(canary + '.');

    const off = await sources(['unfederate', SRC]);
    expect(off.stderr).not.toContain('Warning');
    const json = await sources(['federate', SRC, '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ id: SRC, federated: true, member_pages_exposed: {
      count: 1, examples: [{ slug, member: 'alice-example' }],
      check: 'gbrain access who-can-read ' + slug + ' --source ' + SRC,
      restrict: 'gbrain access rule add --prefix notes/ --readers alice-example --source ' + SRC } });
    expect(await federated()).toBe(true);
  }, 240_000);

  const archive = () => engine.executeRaw(`UPDATE sources SET archived = true, archived_at = now(), archive_expires_at = now() + interval '72 hours',
    config = config || '{"federated": false}'::jsonb WHERE id = $1`, [SRC]);

  test('sources restore, which re-federates, names them too; --no-federate does not', async () => {
    await archive();
    const kept = await sources(['restore', SRC, '--no-federate']);
    expect(kept.stderr).not.toContain('Warning');
    await archive();
    const out = await sources(['restore', SRC]);
    expect(await federated()).toBe(true);
    expect(out.stderr).toContain('1 page(s) in "' + SRC + '" were written by a credential bound to a member');
    expect(out.stderr).toMatch(/notes\/alice-plan-\S+ \(member alice-example\)/);
  }, 240_000);

  test('a managed restore returns them as member_pages_exposed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-federate-exposure-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined }, async () => {
        await registerLocalWriter(engine, 'cli');
        await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
        await runPersistenceAdministration(engine, 'source_lifecycle', { action: 'archive', source_id: SRC });
        const result = await runPersistenceAdministration(engine, 'source_lifecycle', { action: 'restore', source_id: SRC });
        expect(result).toMatchObject({ state: 'committed', member_pages_exposed: { count: 1, examples: [{ member: 'alice-example' }] } });
        expect(await federated()).toBe(true);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      rmSync(home, { recursive: true, force: true });
    }
  }, 240_000);
});
