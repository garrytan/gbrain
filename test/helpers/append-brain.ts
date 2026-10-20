/**
 * A database-only brain for the append_page / segmented edit_page tests (Wave B PR 3): PGLite, or an isolated
 * Postgres database when kind is 'postgres'; `pages.segmented_storage` on; a fake embedder that records every text it
 * is asked to embed; `call` runs one MCP tool call as the trusted local CLI, or as a remote writer bound to notes/.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';
import { withEnv } from './with-env.ts';

export interface AppendBrain {
  engine: BrainEngine;
  /** The canonical checkout when opened with `repo` (write-through on), else null. */
  root: string | null;
  /** Every text the fake embedder was asked to embed, in order. */
  embedded: string[];
  /** A direct import (the seed path for pages too large to put in one call). */
  seed(slug: string, content: string): Promise<void>;
  call(name: string, params: Record<string, unknown>, opts?: { remote?: boolean }): Promise<{ isError: boolean; body: Record<string, any> }>;
  /** The stored body (truth + timeline), however it is stored. */
  body(slug: string): Promise<{ storage: string; truth: string; timeline: string }>;
  close(): Promise<void>;
}

export async function openAppendBrain(kind: 'pglite' | 'postgres', opts: { repo?: boolean } = {}): Promise<AppendBrain> {
  let engine: BrainEngine;
  let closeEngine: () => Promise<void>;
  if (kind === 'postgres') ({ engine, close: closeEngine } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  else {
    const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
    engine = lite; closeEngine = () => lite.disconnect();
  }
  const dims = (await resolveActiveEmbeddingColumnFromEngine(engine)).dimensions;
  const embedded: string[] = [];
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedded.push(...values);
    return { embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
  }) as never);
  await engine.setConfig('pages.segmented_storage', 'on');
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-append-'));
  const env = { GBRAIN_HOME: join(dir, 'home') };
  const root = opts.repo ? join(dir, 'brain') : null;
  if (root) {
    mkdirSync(join(root, 'notes'), { recursive: true });
    await engine.setConfig('sync.repo_path', root);
    await engine.setConfig('sync.write_through', 'true');
    await withEnv(env, () => claimWorktree(engine, 'default', root));
  }
  const [cli, remote] = await withEnv(env, async () => [await registerLocalWriter(engine, 'cli'),
    await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] })] as [LocalRegistration, LocalRegistration]);
  const remoteAuth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };
  return {
    engine, root, embedded,
    seed: async (slug, content) => { await importFromContent(engine, slug, content, { noEmbed: true }); },
    call: async (name, params, opts = {}) => withEnv(env, async () => {
      const response = await withVerifiedLocalRegistration(engine, opts.remote ? remote : cli, () => dispatchToolCall(engine, name, params, {
        remote: opts.remote === true, config: { engine: kind }, sourceId: 'default', ...(opts.remote ? { auth: remoteAuth } : {}),
        logger: { info() {}, warn() {}, error() {} } }));
      return { isError: response.isError === true, body: JSON.parse((response.content[0] as { text: string }).text) };
    }),
    body: async slug => {
      const [row] = await engine.executeRaw<{ id: number; body_storage: string; compiled_truth: string | null; timeline: string | null }>(
        "SELECT id, body_storage, compiled_truth, timeline FROM pages WHERE source_id='default' AND slug=$1", [slug]);
      if (row!.body_storage !== 'segmented') return { storage: row!.body_storage, truth: row!.compiled_truth ?? '', timeline: row!.timeline ?? '' };
      const stored = await materializeSegmentedBody(engine, Number(row!.id), 'default');
      return { storage: 'segmented', truth: stored.compiled_truth, timeline: stored.timeline ?? '' };
    },
    close: async () => {
      __setEmbedTransportForTests(null);
      await disposePersistenceConsumer(engine);
      await closeEngine();
      resetGateway();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
