import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation, submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { runSchemaTransition } from '../src/core/embedding-migration.ts';
import { planMigrationFlow, executeMigrationFlow } from '../src/commands/migrate-embeddings.ts';
import { countStaleFactEmbeddings } from '../src/core/facts/embedding-identity.ts';
import { runExport } from '../src/commands/export.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { createConnectorFixture, json, options, sourceCheckpoint } from './helpers/connector-fixture.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { withEnv } from './helpers/with-env.ts';

const fixture = createConnectorFixture();
beforeAll(fixture.setup, 120_000);
afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await fixture.teardown();
});
const originalModel = 'openai:text-embedding-3-small';
const targetModel = 'openai:text-embedding-3-large';
const dimensions = 8;
const retired = 'retiredvioletclaim prefers synthetic fixtures';
const privateText = 'privatecobaltsentinel';
const visibleText = 'visiblequartzsentinel';
const foreignText = 'foreignambersentinel';
const vectorQuery = 'vectoronlysaffronlookup';
const config = { kind: 'google', g_account: 'reader@example.com', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const messageTime = Date.now() - 1000;

function embedding(text: string): number[] {
  const vector = Array(dimensions).fill(0);
  vector[text.includes(visibleText) || text.includes(vectorQuery) ? 0 : text.includes(privateText) ? 1 : text.includes(foreignText) ? 2 : text.includes(retired) ? 3 : 4] = 1;
  return vector;
}

async function gmailFetch(url: string) {
  if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
  if (url.includes('/profile')) return json({ historyId: '100', emailAddress: config.g_account });
  if (url.includes('/history?')) return json({ historyId: '101', history: [] });
  if (url.includes('/messages?')) {
    const before = Number(new URL(url).searchParams.get('q')?.match(/before:(\d+)/)?.[1]);
    return json({ messages: before * 1000 > messageTime + 1000 ? [{ id: '123abcdef4567890', threadId: 'abc123' }] : [] });
  }
  if (url.includes('/threads/abc123?')) return json({ id: 'abc123', messages: [{ id: '123abcdef4567890', internalDate: String(messageTime), payload: {
    mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'sender@example.com' }, { name: 'Subject', value: 'Synthetic lifecycle report' }], parts: [
      { mimeType: 'text/plain', body: { data: Buffer.from(`Synthetic message ${privateText}`).toString('base64') } },
      { partId: '1', mimeType: 'application/pdf', filename: 'synthetic-report.pdf', body: { attachmentId: 'opaque', size: 84 } },
    ],
  } }] });
  throw new Error('Unexpected synthetic Gmail endpoint');
}

function context(engine: BrainEngine, sourceId: string): OperationContext {
  return { engine, sourceId, config: { engine: engine.kind }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
}

test('sync, remember, withdraw, metadata repair, migration, export and HTTP MCP retain source and privacy boundaries', async () => withEnv({
  ...fixture.env, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
  GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined,
}, async () => {
  for (const engine of fixture.engines) {
    let database: GBrainConfig = { engine: 'pglite', database_path: join(fixture.home, 'database') };
    if (engine.kind === 'postgres') {
      const [row] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = row.name;
      database = { engine: 'postgres', database_url: url.toString() };
    }
    await runSchemaTransition(engine, dimensions);
    await engine.setConfig('embedding_model', originalModel);
    await engine.setConfig('embedding_dimensions', String(dimensions));
    resetGateway();
    configureGateway({ embedding_model: originalModel, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'synthetic-only' } });
    __setEmbedTransportForTests(async ({ values }) => ({ embeddings: values.map(embedding), usage: { tokens: values.length * 8 } }) as never);
    mkdirSync(join(fixture.home, '.gbrain'), { recursive: true });
    writeFileSync(join(fixture.home, '.gbrain', 'config.json'), JSON.stringify({ ...database,
      embedding_model: originalModel, embedding_dimensions: dimensions, openai_api_key: 'synthetic-only' }));

    const source = await fixture.boundSource(engine, config);
    const other = await fixture.boundSource(engine, { kind: 'filesystem' });
    const ctx = context(engine, source.id);
    const cfg = parseGoogleSourceConfig(config, source.dir);
    expect((await runGoogleSync(engine, source.id, cfg, options, gmailFetch)).added).toBe(1);
    const [email] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND frontmatter->>'thread_id'='abc123'", [source.id]);
    const imported = (await engine.readPageSnapshot(email.slug, { sourceId: source.id }))!;
    const { gmail_attachment_receipts: oldReceipts, ...frontmatter } = imported.page.frontmatter;
    expect(oldReceipts).toBeDefined();
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: email.slug, expected_revision: imported.revision,
      content: serializePageToMarkdown({ ...imported.page, frontmatter: { ...frontmatter, visibility: 'private', custom: 'preserved' },
        compiled_truth: imported.page.compiled_truth + '\nUser-edited historical prose.\n' }, imported.tags) } });
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/synthetic-profile',
      content: `---\ntype: person\ntitle: Synthetic profile\nvisibility: world\n---\n# Synthetic profile\n\n${visibleText}\n` } });
    await submitPageMutation(context(engine, other.id), { operation: 'put_page', params: { slug: 'notes/foreign',
      content: `---\ntype: note\ntitle: Synthetic foreign source\nvisibility: world\n---\n${foreignText}\n` } });
    const beforeWithdrawal = (await engine.readPageSnapshot(email.slug, { sourceId: source.id }))!;
    const forgotten = await submitRememberMutation(ctx, { fact: retired, entity: 'people/synthetic-profile', provenance: 'synthetic lifecycle', visibility: 'world' });
    const beforeForget = (await engine.readPageSnapshot('people/synthetic-profile', { sourceId: source.id }))!;
    const staleImport = serializePageToMarkdown(beforeForget.page, beforeForget.tags);
    await submitRememberMutation(ctx, { fact: 'Active synthetic subjectless memory', provenance: 'synthetic lifecycle', visibility: 'private' });
    await submitForgetMutation(ctx, 'forget', { id: forgotten.id });
    await disposePersistenceConsumer(engine);
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 100 });
    expect((await engine.readPageSnapshot(email.slug, { sourceId: source.id }))!.revision).toBe(beforeWithdrawal.revision);
    const thread = await (await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/threads/abc123?format=full')).json();
    const repairChild = async (crash: boolean) => {
      await disposePersistenceConsumer(engine);
      await engine.disconnect();
      let pid: number | undefined;
      try {
        const child = Bun.spawn([process.execPath, '--no-env-file', 'run', join(import.meta.dir, 'helpers/memory-safety-wave-repair.ts')], {
          env: keylessBrainEnv(process.env, fixture.home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
            GBRAIN_TEST_MEMORY_WAVE_REPAIR: JSON.stringify({ database, sourceId: source.id, root: source.dir, sourceConfig: config, thread, crash }) }),
          stdout: 'pipe', stderr: 'pipe',
        });
        pid = child.pid;
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        try {
          const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          return { stdout, stderr, exit };
        } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
      } finally {
        await engine.connect(database);
        if (crash && pid) await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquired_at=now()-interval '2 minutes',last_refreshed_at=now()-interval '1 hour',ttl_expires_at=now()-interval '1 hour' WHERE id=$1 AND holder_pid=$2`, [syncLockId(source.id), pid]);
      }
    };
    const killed = await repairChild(true);
    expect(killed.stdout, killed.stderr).toContain('MEMORY_WAVE_CRASH after_metadata_commit');
    expect(killed.exit).not.toBe(0);
    expect(JSON.stringify(await sourceCheckpoint(engine, source.id))).toContain('"afterPageId":0');
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_connector_google_receipts' AND state='committed'", [source.id])).toHaveLength(1);
    const resumed = await repairChild(false);
    expect(resumed.exit, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('"status":"complete"');
    expect(JSON.stringify(await sourceCheckpoint(engine, source.id))).toContain('"complete":true');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [source.id])).toHaveLength(0);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_connector_google_receipts' AND state='committed' AND NOT COALESCE((outcome->>'noop')::boolean,false)", [source.id])).toHaveLength(1);
    const repaired = (await engine.readPageSnapshot(email.slug, { sourceId: source.id }))!;
    expect(repaired.page.compiled_truth).toBe(beforeWithdrawal.page.compiled_truth);
    expect(repaired.page.frontmatter).toMatchObject({ visibility: 'private', custom: 'preserved', gmail_attachment_receipts: { messages: [{ inspection: { state: 'present' } }] } });
    await disposePersistenceConsumer(engine);
    await withManagedFixtureWrite(engine, [source.id], async tx => {
      await tx.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1 AND slug='people/synthetic-profile'", [source.id]);
      await tx.executeRaw('UPDATE facts SET embedding_model=NULL,embedded_text_hash=NULL WHERE source_id=$1 AND expired_at IS NULL', [source.id]);
    });
    const migration = { to: targetModel, dim: dimensions, reranker: 'off', maxCostUsd: 1, quiet: true };
    const migrated = await executeMigrationFlow(engine, await planMigrationFlow(engine, migration), migration);
    expect(migrated.status).toBe('completed');
    expect((await countStaleFactEmbeddings(engine, targetModel, dimensions)).count).toBe(0);
    expect(await engine.executeRaw('SELECT embedding_model,embedding IS NOT NULL AS vector_present,embedded_text_hash=md5(fact) AS current FROM facts WHERE source_id=$1 AND expired_at IS NULL', [source.id]))
      .toEqual([{ embedding_model: targetModel, vector_present: true, current: true }]);
    expect(await engine.executeRaw('SELECT fact_hash FROM fact_withdrawals WHERE source_id=$1', [source.id])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [source.id, retired])).toHaveLength(0);
    const current = (await engine.readPageSnapshot('people/synthetic-profile', { sourceId: source.id }))!;
    expect(sanitizeRemoteBody(current.page.compiled_truth)).not.toContain(retired);

    const output = join(fixture.home, `export-${engine.kind}`);
    await runExport(engine, ['--source', source.id, '--dir', output]);
    expect(existsSync(join(output, 'notes/foreign.md'))).toBe(false);
    expect(readFileSync(join(output, '.gbrain-export-status'), 'utf8')).toBe('GBRAIN EXPORT INCOMPLETE\nCOMPLETE\n');
    const exported = readFileSync(join(output, 'people/synthetic-profile.md'), 'utf8');
    expect(exported).toContain(visibleText);
    expect(sanitizeRemoteBody(exported)).not.toContain(retired);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: current.page.slug, expected_revision: current.revision, content: exported } });
    const reimported = (await engine.readPageSnapshot(current.page.slug, { sourceId: source.id }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: current.page.slug, expected_revision: reimported.revision, content: staleImport } });
    expect(sanitizeRemoteBody((await engine.readPageSnapshot(current.page.slug, { sourceId: source.id }))!.page.compiled_truth)).not.toContain(retired);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [source.id, retired])).toHaveLength(0);

    await engine.setConfig('search.mcp_keyword_only', 'true');
    const token = `gbrain_${randomUUID()}`;
    await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,permissions,scopes) VALUES($1,$2,$3::text::jsonb,$4::text[])',
      ['synthetic-wave', createHash('sha256').update(token).digest('hex'), JSON.stringify({ source_id: source.id, takes_holders: ['world'] }), ['read']]);
    const server = await startHttpTransport({ port: 0, engine });
    try {
      for (const query of [visibleText, privateText, foreignText, retired, 'genuinemisssentinel']) {
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query, expand: false } } }) });
        expect(response.status).toBe(200);
        const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
        expect(body.result.isError).not.toBe(true);
        const rows = JSON.parse(body.result.content[0].text) as Array<{ source_id: string }>;
        if (query === visibleText) {
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.every(row => row.source_id === source.id)).toBe(true);
        } else expect(rows).toEqual([]);
        expect(JSON.stringify(body.result)).not.toContain(privateText);
        expect(JSON.stringify(body.result)).not.toContain(foreignText);
        expect(JSON.stringify(body.result)).not.toContain(retired);
      }
    } finally { server.stop(true); }
    expect((await engine.readPageSnapshot(email.slug, { sourceId: source.id }))!.page.compiled_truth).toBe(beforeWithdrawal.page.compiled_truth);

    await engine.setConfig('search.mcp_keyword_only', 'false');
    await registerLocalWriter(engine, 'stdio', { sourceIds: [source.id], operations: null, scopes: ['read'], slugPrefixes: null });
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    let embeddingCalls = 0;
    const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/embeddings') return new Response('Unexpected fixture endpoint', { status: 400 });
      const body = await request.json() as { input: string | string[]; model: string };
      if (body.model !== 'text-embedding-3-large') return new Response('Unexpected fixture model', { status: 400 });
      embeddingCalls++;
      const values = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ object: 'list', model: body.model,
        data: values.map((text, index) => ({ object: 'embedding', index, embedding: embedding(text) })), usage: { prompt_tokens: values.length, total_tokens: values.length } });
    } });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--no-env-file', 'run', join(import.meta.dir, '../src/cli.ts'), 'serve', '--surface', 'starter'],
      cwd: fixture.home, stderr: 'pipe', env: keylessBrainEnv(process.env, fixture.home, {
        DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_ENGINE: undefined, GBRAIN_BRAIN_ID: 'host',
        GBRAIN_SOURCE: source.id, GBRAIN_SCHEMA_PACK: 'gbrain-base-v2', GBRAIN_SWEEP: '0', GBRAIN_SKIP_STARTUP_HOOKS: '1',
        OPENAI_API_KEY: 'synthetic-only', OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      }),
    });
    let stderr = '';
    transport.stderr?.on('data', data => { stderr += String(data); });
    const client = new Client({ name: 'memory-safety-wave', version: '1' });
    try {
      await client.connect(transport);
      for (const query of [vectorQuery, privateText, foreignText, retired]) {
        const callsBefore = embeddingCalls;
        const result = await client.callTool({ name: 'search', arguments: { query, expand: false } });
        expect(result.isError, stderr).not.toBe(true);
        const rows = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Array<{ slug: string; source_id: string; cosine?: number }>;
        const meta = result._meta?.retrieval as { vector_enabled?: boolean; degraded?: unknown[]; projection_readiness: { status: string } };
        expect(meta.vector_enabled).toBe(true);
        expect(meta.degraded ?? []).toEqual([]);
        expect(meta.projection_readiness.status).toBe('ready');
        expect(embeddingCalls).toBeGreaterThan(callsBefore);
        expect(rows.every(row => row.source_id === source.id && row.slug !== email.slug)).toBe(true);
        for (const hidden of [privateText, foreignText, retired]) expect(JSON.stringify(result)).not.toContain(hidden);
        if (query === vectorQuery) {
          const positive = rows.find(row => row.slug === 'people/synthetic-profile');
          expect(positive).toBeDefined();
          expect(positive!.cosine).toBeGreaterThan(0.99);
        }
      }
      const foreignRequest = await client.callTool({ name: 'search', arguments: { query: foreignText, source_id: other.id, expand: false } });
      expect(foreignRequest.isError).toBe(true);
      expect(JSON.stringify(foreignRequest)).not.toContain(foreignText);
    } finally {
      await client.close();
      await transport.close();
      await provider.stop(true);
      await engine.connect(database);
    }
  }
}), 180_000);
