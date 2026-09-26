import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitSharedSkillMutation } from '../../src/core/shared-skills/publication.ts';
import { setSharedSkillPolicy } from '../../src/core/shared-skills/policy.ts';
import type { SharedSkillFileInput, SharedSkillPolicy } from '../../src/core/shared-skills/model.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { PROVIDER_ENV_KEYS } from '../helpers/provider-env.ts';
import { fixtureDiagnostic } from '../helpers/fixture-diagnostics.ts';
import { withEnv } from '../helpers/with-env.ts';

export const READ_OPERATIONS = ['list_skills', 'get_skill', 'get_skill_asset', 'list_brain_skillpack'];
export const MEMBER_OPERATIONS = ['join_brain', 'sync_brain_skills', 'leave_brain'];
export const ALL_OPERATIONS = [...READ_OPERATIONS, ...MEMBER_OPERATIONS, 'put_skill', 'delete_skill', 'set_skill_policy'];
export const FULL_POLICY: SharedSkillPolicy = { version: 1, enabled: true, classes: ['prose', 'reference', 'asset'],
  audiences: ['readers'], requirements: [], allow_follow: true };
export const ASSET_PATH = 'skills/alpha/assets/example.txt';
export const skillFiles = (body = 'Original shared instructions', asset = 'Original shared asset'): SharedSkillFileInput[] => [
  { path: 'skills/alpha/SKILL.md', content: `---\nname: alpha\ndescription: Synthetic shared transport fixture\ntriggers: [example task]\n---\n\n${body}\n`,
    file_class: 'prose', depends_on: [ASSET_PATH] },
  { path: ASSET_PATH, content: asset, file_class: 'asset', media_type: 'text/plain' },
];
export interface Credential { id: string; token: string; client: Client }
export interface TransportFixture {
  engine: BrainEngine;
  local: OperationContext;
  dir: string;
  root: string;
  url: string;
  incarnation: string;
  peers: Record<'reader' | 'editor' | 'parent' | 'memory', Credential>;
  connect(token: string): Promise<Client>;
  credential(name: string, scopes: string[], operations: string[], source?: string | string[]): Promise<Credential>;
  seed(source?: string, files?: SharedSkillFileInput[]): Promise<void>;
}

export async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  const content = result.content as Array<{ type: string; text?: string }>;
  const payload = JSON.parse(content.find(item => item.type === 'text')?.text ?? 'null');
  if (result.isError) throw Object.assign(new Error(fixtureDiagnostic(name, JSON.stringify(payload))), { code: payload.error });
  return payload as T;
}

export async function textResource(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (result.contents.length !== 1 || content.uri !== uri || !('text' in content)) throw new Error('Expected one text resource');
  return content.text;
}

export async function blobResource(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (result.contents.length !== 1 || content.uri !== uri || !('blob' in content)) throw new Error('Expected one binary resource');
  return content.blob;
}

export async function withTransportFixture(run: (fixture: TransportFixture) => Promise<void>, databaseUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shared-transports-'));
  try {
    await withEnv({ ...Object.fromEntries(PROVIDER_ENV_KEYS.map(key => [key, undefined])), HOME: join(dir, 'home'),
      GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_ENGINE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined,
      GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
      const isolated = await isolatedSharedSkillsEngine(databaseUrl);
      const engine = isolated.engine;
      const clients: Client[] = [];
      let server: Awaited<ReturnType<typeof startHttpTransport>> | undefined;
      try {
        const root = join(dir, 'content'); mkdirSync(root, { recursive: true });
        const hiddenRoot = join(dir, 'hidden'); mkdirSync(hiddenRoot);
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$2,$3)', ['hidden', 'Hidden fixture', hiddenRoot]);
        await claimWorktree(engine, 'default', root); await claimWorktree(engine, 'hidden', hiddenRoot);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        await engine.setConfig('mcp.publish_skills', 'true');
        const local: OperationContext = { engine, config: { engine: databaseUrl ? 'postgres' : 'pglite', embedding_disabled: true },
          remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await setSharedSkillPolicy(local, 'default', FULL_POLICY);
        await setSharedSkillPolicy(local, 'hidden', FULL_POLICY);
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
        server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
          ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
          token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        } });
        const url = `http://127.0.0.1:${server.port}/mcp`;
        const connect = async (token: string) => {
          const client = new Client({ name: 'shared-skills-fixture', version: '1' }, { capabilities: {} });
          clients.push(client);
          await client.connect(new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }), { signal: AbortSignal.timeout(30_000) });
          return client;
        };
        const credential: TransportFixture['credential'] = async (name, scopes, operations, source = 'default') => {
          const id = randomUUID(); const token = `fixture-${randomUUID()}`;
          await engine.executeRaw(`INSERT INTO access_tokens(id,name,token_hash,scopes,permissions)
            VALUES($1::uuid,$2,$3,$4::text[],$5::text::jsonb)`, [id, name, createHash('sha256').update(token).digest('hex'), scopes,
            JSON.stringify({ source_id: source, allowed_operations: operations })]);
          return { id, token, client: await connect(token) };
        };
        const peers = {
          reader: await credential('fixture-reader', ['read', 'skills_member_self'], [...READ_OPERATIONS, ...MEMBER_OPERATIONS]),
          editor: await credential('fixture-editor', ['read', 'write', 'skill_editor', 'skills_member_self'], ALL_OPERATIONS),
          parent: await credential('fixture-parent', ['read', 'skills_member_self'], [...READ_OPERATIONS, ...MEMBER_OPERATIONS]),
          memory: await credential('fixture-memory-writer', ['read', 'write', 'admin'], ALL_OPERATIONS),
        };
        const seed: TransportFixture['seed'] = async (sourceId = 'default', files = skillFiles()) => {
          const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
          await submitSharedSkillMutation({ ...local, sourceId }, 'put_skill', { request_id: randomUUID(), expected_revision: null,
            source_id: sourceId, source_incarnation: source.incarnation, name: 'alpha', pack_id: 'example-pack', files });
        };
        await run({ engine, local, dir, root, url, incarnation: source.incarnation, peers, connect, credential, seed });
      } finally {
        await Promise.all(clients.map(client => client.close().catch(() => {})));
        server?.stop(true);
        await disposePersistenceConsumer(engine);
        await isolated.close();
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
