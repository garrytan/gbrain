import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { normalizeSkillFiles, skillMetadata } from '../../src/core/shared-skills/manifest.ts';
import { setSharedSkillPolicy } from '../../src/core/shared-skills/policy.ts';
import { SHARED_SKILL_LIMITS, type SharedSkillDetail, type SharedSkillFileInput } from '../../src/core/shared-skills/model.ts';
import type { MembershipSnapshot, SharedSkillIdentity } from '../../src/core/shared-skills/membership-types.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';
import { isolatedSharedSkillsEngine } from '../../test/helpers/shared-skills-engine.ts';
import { LifecycleMeter } from './lifecycle-metrics.ts';

export const LIVE_NAME = 'benchmark-live';
export const PACK_ID = 'benchmark-pack';
export const ASSET_PATH = `skills/${LIVE_NAME}/assets/fixture.bin`;
export const READ_OPS = ['list_skills', 'get_skill', 'get_skill_asset'];
export const MEMBER_OPS = [...READ_OPS, 'join_brain', 'sync_brain_skills', 'leave_brain'];
export const PUBLISHER_OPS = [...READ_OPS, 'put_skill', 'get_write_request'];

export function liveFixture(generation: number, assetBytes: number): { files: SharedSkillFileInput[]; body: string; asset: Buffer; description: string; triggers: string[] } {
  const asset = Buffer.alloc(assetBytes);
  for (let index = 0; index < asset.length; index++) asset[index] = (index * 17 + generation) % 256;
  const description = `Synthetic lifecycle generation ${generation}`;
  const triggers = [`synthetic-generation-${generation}`];
  const body = `---\nname: ${LIVE_NAME}\ndescription: ${description}\ntriggers: [${triggers[0]}]\n---\n\nSynthetic benchmark instructions.\nGeneration: ${generation}\n`;
  return { body, asset, description, triggers, files: [
    { path: `skills/${LIVE_NAME}/SKILL.md`, content: body, file_class: 'prose', depends_on: [ASSET_PATH] },
    { path: ASSET_PATH, content: asset.toString('base64'), encoding: 'base64', file_class: 'asset' },
  ] };
}
export const identity = (skill: SharedSkillIdentity): SharedSkillIdentity => ({ brain_id: skill.brain_id, source_id: skill.source_id,
  source_incarnation: skill.source_incarnation, pack_id: skill.pack_id, name: skill.name, revision: skill.revision });

export interface BenchmarkPeer { client: Client; connection_ms: number; cache: Map<string, string>; joined?: MembershipSnapshot; }
export interface LifecycleFixture {
  engine: BrainEngine;
  raw: BrainEngine;
  incarnation: string;
  meter: LifecycleMeter;
  members: BenchmarkPeer[];
  publisher: BenchmarkPeer;
  seed: { count: number; elapsed_ms: number; canonical_fixture_bytes: number; manifest_bytes: number; mode: string };
  call<T>(peer: BenchmarkPeer, operation: string, params: Record<string, unknown>): Promise<T>;
  verifyAndFetch(peer: BenchmarkPeer, skill: SharedSkillIdentity, latest?: boolean): Promise<SharedSkillDetail>;
  close(): Promise<void>;
}

export async function createLifecycleFixture(options: { root: string; size: number; members: number; assetBytes: number; databaseUrl?: string }): Promise<LifecycleFixture> {
  const isolated = await isolatedSharedSkillsEngine(options.databaseUrl);
  const raw = isolated.engine;
  const meter = new LifecycleMeter();
  const engine = meter.observe(raw);
  let server: Awaited<ReturnType<typeof startHttpTransport>> | undefined;
  const peers: BenchmarkPeer[] = [];
  const close = async () => {
    const clients = await Promise.allSettled(peers.map(peer => peer.client.close()));
    server?.stop(true);
    try { await disposePersistenceConsumer(engine); } finally { await isolated.close(); }
    assert(clients.every(result => result.status === 'fulfilled'), 'Every benchmark client must close cleanly');
  };
  try {
    const started = performance.now();
    const contentRoot = join(options.root, 'content'); mkdirSync(contentRoot, { recursive: true });
    const seeded = Array.from({ length: options.size }, (_, index) => {
      const name = index === 0 ? LIVE_NAME : `fixture-${String(index).padStart(4, '0')}`;
      const input: SharedSkillFileInput[] = index === 0 ? liveFixture(0, options.assetBytes).files : [{ path: `skills/${name}/SKILL.md`,
        content: `---\nname: ${name}\ndescription: Synthetic fixture ${index}\n---\n\nBounded fixture prose ${index}.\n`, file_class: 'prose' }];
      const files = normalizeSkillFiles(name, input);
      return { name, revision: randomUUID(), files, metadata: skillMetadata(name, files, {}) };
    });
    let canonicalBytes = 0;
    for (const row of seeded) for (const file of row.files) {
      const path = join(contentRoot, file.path); const bytes = Buffer.from(file.content, 'base64');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); canonicalBytes += bytes.length;
    }
    const manifest = { name: PACK_ID, brain_resident: true, version: '1.0.0', skills: seeded.map(row => `skills/${row.name}`),
      shared_skills: { schema_version: 2, skills: seeded.map(row => ({ name: row.name, revision: row.revision,
        files: row.files.map(({ content: _content, ...file }) => file) })) } };
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    assert(Buffer.byteLength(manifestContent) + options.assetBytes < SHARED_SKILL_LIMITS.bundleBytes, 'Fixture manifest leaves room inside the real publication byte bound');
    writeFileSync(join(contentRoot, 'skillpack.json'), manifestContent);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [contentRoot]);
    await claimWorktree(engine, 'default', contentRoot);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await engine.setConfig('mcp.publish_skills', 'true');
    await engine.setConfig('mcp.strict_params', 'reject');
    const local: OperationContext = { engine, config: { engine: options.databaseUrl ? 'postgres' : 'pglite', embedding_disabled: true },
      sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    const policy = await setSharedSkillPolicy(local, 'default', { version: 1, enabled: true, classes: ['prose', 'asset'],
      audiences: ['readers'], requirements: [], allow_follow: true }, null);
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await withCoordinatedWrite(tx, ['default'], async () => {
        for (let offset = 0; offset < seeded.length; offset += 100) {
          const rows = JSON.stringify(seeded.slice(offset, offset + 100));
          await tx.executeRaw(`INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,policy_epoch)
            SELECT 'default',$1::uuid,$2,r.name,r.revision,r.metadata,$3
            FROM jsonb_to_recordset($4::text::jsonb) AS r(name text,revision uuid,metadata jsonb,files jsonb)`, [source.incarnation, PACK_ID, policy.policy_epoch, rows]);
          await tx.executeRaw(`INSERT INTO shared_skill_revisions(source_id,source_incarnation,pack_id,name,revision,metadata,files,policy_epoch,request_id)
            SELECT 'default',$1::uuid,$2,r.name,r.revision,r.metadata,r.files,$3,$5::uuid
            FROM jsonb_to_recordset($4::text::jsonb) AS r(name text,revision uuid,metadata jsonb,files jsonb)`, [source.incarnation, PACK_ID, policy.policy_epoch, rows, randomUUID()]);
        }
        await tx.executeRaw(`INSERT INTO shared_skill_packs(source_id,source_incarnation,pack_id,revision,manifest,manifest_hash)
          VALUES('default',$1::uuid,$2,$3::uuid,$4::text::jsonb,$5)`, [source.incarnation, PACK_ID, randomUUID(), JSON.stringify(manifest), sha256(manifestContent)]);
      });
    });
    const seed = { count: seeded.length, elapsed_ms: performance.now() - started, canonical_fixture_bytes: canonicalBytes,
      manifest_bytes: Buffer.byteLength(manifestContent), mode: 'matching filesystem and sealed projection fixtures seeded directly; NOT a measured canonical publication' };
    server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
      ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
    } });
    const endpoint = new URL(`http://127.0.0.1:${server.port}/mcp`);
    const credential = async (name: string, scopes: string[], operations: string[]) => {
      const id = randomUUID(); const token = `synthetic-benchmark-${randomUUID()}`;
      await engine.executeRaw(`INSERT INTO access_tokens(id,name,token_hash,scopes,permissions) VALUES($1::uuid,$2,$3,$4::text[],$5::text::jsonb)`,
      [id, name, sha256(token), scopes, JSON.stringify({ source_id: 'default', allowed_operations: operations })]);
      const client = new Client({ name: 'shared-skills-lifecycle-benchmark', version: '1' }, { capabilities: {} });
      const peer: BenchmarkPeer = { client, connection_ms: 0, cache: new Map() }; peers.push(peer);
      const connected = performance.now();
      await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
        { signal: AbortSignal.timeout(30_000) });
      peer.connection_ms = performance.now() - connected;
      return peer;
    };
    const publisher = await credential('synthetic-publisher', ['read', 'write', 'skill_editor'], PUBLISHER_OPS);
    const members = await Promise.all(Array.from({ length: options.members }, (_, index) => credential(`synthetic-member-${index}`,
      ['read', 'skills_member_self'], MEMBER_OPS)));
    async function call<T>(peer: BenchmarkPeer, operation: string, params: Record<string, unknown>): Promise<T> {
      const counters = meter.counters(); counters.tool_calls[operation] = (counters.tool_calls[operation] ?? 0) + 1;
      counters.argument_bytes_by_operation[operation] = (counters.argument_bytes_by_operation[operation] ?? 0) + Buffer.byteLength(JSON.stringify(params));
      try {
        const result = await peer.client.callTool({ name: operation, arguments: params }, undefined, { timeout: 60_000 });
        const resultBytes = Buffer.byteLength(JSON.stringify(result));
        counters.tool_result_json_bytes += resultBytes;
        counters.result_bytes_by_operation[operation] = (counters.result_bytes_by_operation[operation] ?? 0) + resultBytes;
        const text = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text;
        assert(text, 'Every benchmark operation must return its typed JSON result');
        const payload = JSON.parse(text);
        if (result.isError) {
          if (operation === 'put_skill' && payload.error === 'write_pending' && payload.write_request?.request_id === params.request_id &&
            ['queued', 'running', 'recovering'].includes(payload.write_request.state)) {
            counters.pending_receipts++;
            return payload.write_request as T;
          }
          const error = new Error(`Benchmark operation ${operation} failed`) as Error & { code: unknown; operation: string };
          error.code = payload.error ?? 'operation_failed';
          error.operation = operation;
          throw error;
        }
        return payload as T;
      } catch (error) { counters.errors++; throw error; }
    }
    async function verifyAndFetch(peer: BenchmarkPeer, skill: SharedSkillIdentity, latest = false): Promise<SharedSkillDetail> {
      const { revision, brain_id, ...key } = identity(skill);
      const detail = await call<SharedSkillDetail>(peer, 'get_skill', { ...key, expected_brain_id: brain_id, ...(!latest ? { revision } : {}), schema_version: 2 });
      if (!latest) assert.equal(detail.revision, skill.revision, 'Body fetch must return the exact issued revision');
      assert.equal(detail.delivery, 'complete', 'Benchmark files must have complete approved closure');
      const main = detail.files.find(file => file.path === `skills/${detail.name}/SKILL.md`);
      assert(main); assert.equal(sha256(detail.body), main.sha256, 'Body must match its declared manifest hash');
      for (const file of detail.files.filter(file => file.path !== main.path)) {
        const asset = await call<{ revision: string; content: string; sha256: string; size: number }>(peer, 'get_skill_asset', { ...key, expected_brain_id: brain_id, revision: detail.revision, path: file.path });
        const bytes = Buffer.from(asset.content, 'base64');
        meter.counters().decoded_asset_bytes += bytes.length;
        assert.equal(asset.revision, detail.revision); assert.equal(sha256(bytes), file.sha256); assert.equal(asset.sha256, file.sha256); assert.equal(bytes.length, file.size);
        if (detail.name === LIVE_NAME) {
          const generation = Number(detail.body.match(/^Generation: (\d+)$/m)?.[1]);
          const expected = liveFixture(generation, options.assetBytes);
          assert(Number.isSafeInteger(generation)); assert.deepEqual(bytes, expected.asset);
          assert.equal(detail.body, expected.body); assert.equal(detail.description, expected.description); assert.deepEqual(detail.triggers, expected.triggers);
        }
      }
      peer.cache.set(detail.name, detail.revision);
      return detail;
    }
    return { engine, raw, incarnation: source.incarnation, meter, publisher, members, seed, call, verifyAndFetch, close };
  } catch (error) { await close(); throw error; }
}
