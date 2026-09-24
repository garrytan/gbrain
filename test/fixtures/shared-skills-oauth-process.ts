import { expect } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { registerLocalWriter, verifyLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { SharedSkillDetail, SharedSkillList } from '../../src/core/shared-skills/model.ts';
import type { MembershipSnapshot } from '../../src/core/shared-skills/membership-types.ts';
import { sharedSkillResourceUri } from '../../src/mcp/skill-resources.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { fixtureDiagnostic } from '../helpers/fixture-diagnostics.ts';
import { ALL_OPERATIONS, ASSET_PATH, blobResource, call, MEMBER_OPERATIONS, READ_OPERATIONS, skillFiles, textResource, withTransportFixture } from './shared-skills-transports.ts';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

export async function sharedSkillsOAuthProcessCase(databaseUrl: string, editorPrefix = 'skills/alpha/') {
  await withTransportFixture(async f => {
    await f.seed(); await f.seed('hidden', skillFiles('OAuth hidden-source canary', 'OAuth hidden asset'));
    const [database] = await f.engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database.name}`;
    const home = join(f.dir, 'home'); mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: isolatedUrl.toString(),
      embedding_disabled: true, mcp: { surface: 'full' } }), { mode: 0o600 });
    const env = keylessBrainEnv(process.env, home, { DATABASE_URL: isolatedUrl.toString(), GBRAIN_DATABASE_URL: undefined,
      GBRAIN_SOURCE: 'default', GBRAIN_ENGINE: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_REMOTE_CLIENT_SECRET: undefined });
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(f.engine) });
    const reader = await provider.registerClientManual('fixture-oauth-reader', ['client_credentials'], 'read skills_member_self', [], 'default', ['default', 'hidden'],
      'client_secret_post', { allowedOperations: [...READ_OPERATIONS, ...MEMBER_OPERATIONS] });
    const editor = await provider.registerClientManual('fixture-oauth-editor', ['client_credentials'], 'read write skill_editor skills_member_self', [], 'default', ['default'],
      'client_secret_post', { allowedOperations: ALL_OPERATIONS, boundSlugPrefixes: [editorPrefix] });
    const parent = await provider.registerClientManual('fixture-oauth-parent', ['client_credentials'], 'read skills_member_self', [], 'default', ['default'],
      'client_secret_post', { allowedOperations: [...READ_OPERATIONS, ...MEMBER_OPERATIONS] });
    const oldWriter = await provider.registerClientManual('fixture-oauth-old-writer', ['client_credentials'], 'read write', [], 'default', ['default'],
      'client_secret_post', { allowedOperations: ALL_OPERATIONS });
    await disposePersistenceConsumer(f.engine);
    const port = await unusedPort(); const base = `http://127.0.0.1:${port}`;
    const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
    let stderr = '';
    const child = spawn(process.execPath, ['--no-env-file', cli, 'serve', '--http', '--surface', 'full', '--bind', '127.0.0.1',
      '--port', String(port), '--public-url', base, '--suppress-bootstrap-token'], { cwd: home, env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
    const clients: Client[] = [];
    const secrets = [reader.clientSecret!, editor.clientSecret!, parent.clientSecret!, oldWriter.clientSecret!];
    let current: SharedSkillDetail | undefined;
    let forbiddenUri = '';
    try {
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
        if (ready) break;
        await Bun.sleep(100);
      }
      if (!ready) throw new Error(fixtureDiagnostic('OAuth serve readiness', stderr, secrets));
      const connect = async (registration: { clientId: string; clientSecret?: string }) => {
        const response = await fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: registration.clientId, client_secret: registration.clientSecret! }) });
        expect(response.status, 'OAuth confidential token exchange').toBe(200);
        const result = await response.json() as { access_token: string; scope: string };
        expect(typeof result.access_token).toBe('string'); secrets.push(result.access_token);
        const client = new Client({ name: 'shared-skills-fixture', version: '1' }, { capabilities: {} }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${result.access_token}` } },
        }), { signal: AbortSignal.timeout(30_000) });
        return client;
      };
      const readerClient = await connect(reader); const editorClient = await connect(editor); const parentClient = await connect(parent);
      const oldWriterClient = await connect(oldWriter);
      const original = await call<SharedSkillDetail>(editorClient, 'get_skill', { schema_version: 2, name: 'alpha' });
      const all = await call<SharedSkillList>(readerClient, 'list_skills', { schema_version: 2 });
      expect(all.skills.map(s => s.source_id).sort()).toEqual(['default', 'hidden']);
      const hidden = all.skills.find(s => s.source_id === 'hidden')!;
      const hiddenUri = sharedSkillResourceUri(hidden.qualified_id, hidden.revision);
      forbiddenUri = hiddenUri;
      expect(await textResource(readerClient, hiddenUri)).toContain('OAuth hidden-source canary');
      const memberships: MembershipSnapshot[] = [];
      for (const client of [readerClient, editorClient, parentClient]) {
        memberships.push(await call<MembershipSnapshot>(client, 'join_brain', { adapter: 'generic', follow_policy: { approved: true } }));
      }
      expect(new Set(memberships.map(m => m.installation_id)).size).toBe(3);
      const params = { request_id: randomUUID(), expected_revision: original.revision, source_id: 'default', source_incarnation: original.source_incarnation,
        name: 'alpha', pack_id: original.pack_id, files: skillFiles('OAuth durable new body', 'OAuth durable new asset') };
      await f.engine.executeRaw('UPDATE oauth_clients SET scope=$2,grant_revision=grant_revision+1 WHERE client_id=$1',
        [oldWriter.clientId, 'read write skill_editor']);
      expect((await oldWriterClient.listTools()).tools.map(t => t.name)).not.toContain('put_skill');
      await expect(call(oldWriterClient, 'put_skill', params)).rejects.toMatchObject({ code: 'insufficient_scope' });
      const result = await call<{ state: string; revision: string }>(editorClient, 'put_skill', params);
      expect(result.state).toBe('committed');
      if (editorPrefix === 'skills/alpha/') {
        await expect(call(editorClient, 'put_skill', { ...params, request_id: randomUUID(), expected_revision: null, name: 'alpha-sibling',
          files: [{ path: 'skills/alpha-sibling/SKILL.md', content: '---\nname: alpha-sibling\ndescription: Synthetic sibling\n---\nDenied sibling instructions\n', file_class: 'prose' }] })).rejects.toMatchObject({ code: 'permission_denied' });
      }
      for (const [index, client] of [readerClient, editorClient, parentClient].entries()) {
        const member = memberships[index];
        const sync = await call<MembershipSnapshot>(client, 'sync_brain_skills', { installation_id: member.installation_id, enrollment_epoch: member.enrollment_epoch });
        expect(sync.skills.find(s => s.source_id === 'default')!.revision).toBe(result.revision);
        const detail = await call<SharedSkillDetail>(client, 'get_skill', { schema_version: 2, qualified_id: original.qualified_id });
        expect(detail.body).toContain('OAuth durable new body'); expect(detail.revision).toBe(result.revision);
        const asset = await call<{ content: string }>(client, 'get_skill_asset', { qualified_id: detail.qualified_id, revision: detail.revision, path: ASSET_PATH });
        expect(Buffer.from(asset.content, 'base64').toString()).toBe('OAuth durable new asset');
        expect(await textResource(client, sharedSkillResourceUri(detail.qualified_id, detail.revision))).toBe(detail.body);
        current = detail;
      }
      await f.engine.executeRaw('UPDATE oauth_clients SET federated_read=$2::text[],grant_revision=grant_revision+1 WHERE client_id=$1', [reader.clientId, ['default']]);
      expect((await call<SharedSkillList>(readerClient, 'list_skills', { schema_version: 2 })).skills.map(s => s.source_id)).toEqual(['default']);
      await expect(call(readerClient, 'get_skill', { schema_version: 2, qualified_id: hidden.qualified_id })).rejects.toThrow();
      await expect(readerClient.readResource({ uri: hiddenUri })).rejects.toThrow();
      await expect(readerClient.readResource({ uri: sharedSkillResourceUri(hidden.qualified_id, hidden.revision, ASSET_PATH) })).rejects.toThrow();
      const narrowed = await call<MembershipSnapshot>(readerClient, 'sync_brain_skills', { installation_id: memberships[0].installation_id, enrollment_epoch: memberships[0].enrollment_epoch });
      expect(narrowed.skills.map(s => s.source_id)).toEqual(['default']);
      await f.engine.executeRaw('UPDATE oauth_clients SET allowed_operations=$2::text[],grant_revision=grant_revision+1 WHERE client_id=$1', [reader.clientId, ['list_skills']]);
      expect((await readerClient.listTools()).tools.map(t => t.name)).toEqual(['list_skills']);
      await expect(call(readerClient, 'get_skill', { schema_version: 2, name: 'alpha' })).rejects.toMatchObject({ code: 'unknown_operation' });
      await expect(readerClient.readResource({ uri: sharedSkillResourceUri(current!.qualified_id, current!.revision) })).rejects.toThrow();
      await f.engine.executeRaw('UPDATE oauth_clients SET scope=$2,grant_revision=grant_revision+1 WHERE client_id=$1', [editor.clientId, 'read write skills_member_self']);
      await expect(call(editorClient, 'put_skill', { ...params, request_id: randomUUID(), expected_revision: current!.revision })).rejects.toMatchObject({ code: 'insufficient_scope' });
      expect((await editorClient.listTools()).tools.map(t => t.name)).not.toContain('put_skill');
    } finally {
      await Promise.all(clients.map(client => client.close().catch(() => {})));
      await stop(child);
    }
    const registration = await registerLocalWriter(f.engine, 'stdio', { sourceIds: ['default'], scopes: ['read'], operations: READ_OPERATIONS, slugPrefixes: null }, true);
    expect((await verifyLocalWriter(f.engine, registration)).grant.sourceIds).toEqual(['default']);
    const stdio = new Client({ name: 'shared-skills-new-process', version: '1' }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', cli, 'serve', '--surface', 'full'], cwd: home, env, stderr: 'pipe' });
    let stdioError = '';
    transport.stderr?.on('data', chunk => { stdioError = (stdioError + String(chunk)).slice(-4000); });
    try {
      await stdio.connect(transport, { signal: AbortSignal.timeout(30_000) });
      expect(stdio.getServerVersion()?.name).toBe('gbrain');
      const reread = await call<SharedSkillDetail>(stdio, 'get_skill', { schema_version: 2, name: 'alpha' });
      expect(reread.source_id).toBe('default');
      expect(reread.revision).toBe(current!.revision); expect(reread.body).toBe(current!.body);
      expect((await call(stdio, 'get_skill', { name: 'alpha' })).body).toBe(current!.body);
      expect(await textResource(stdio, sharedSkillResourceUri(reread.qualified_id, reread.revision))).toBe(current!.body);
      const asset = await blobResource(stdio, sharedSkillResourceUri(reread.qualified_id, reread.revision, ASSET_PATH));
      expect(Buffer.from(asset, 'base64').toString()).toBe('OAuth durable new asset');
      expect((await stdio.listTools()).tools.map(t => t.name)).not.toContain('put_skill');
      await expect(call(stdio, 'get_skill', { schema_version: 2, name: 'alpha', source_id: 'hidden' })).rejects.toThrow();
      await expect(stdio.readResource({ uri: forbiddenUri })).rejects.toThrow();
    } catch (error) {
      throw new Error(fixtureDiagnostic('New stdio process', `${String(error)}\n${stdioError}`, secrets));
    } finally { await stdio.close(); }
  }, databaseUrl);
}
