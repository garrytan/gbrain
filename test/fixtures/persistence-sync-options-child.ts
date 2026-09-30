import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  kind: 'pglite' | 'postgres'; database: string; sourceId: string; root: string; noEmbed: boolean;
};
configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
let networkCalls = 0, transportCalls = 0;
globalThis.fetch = Object.assign(async () => { networkCalls++; throw new Error('Unexpected provider or connector network access'); }, { preconnect: globalThis.fetch.preconnect });
const engine = input.kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
await engine.connect(input.kind === 'pglite' ? { database_path: input.database } : { database_url: input.database });
const opts = { sourceId: input.sourceId, repoPath: input.root, noPull: true, noEmbed: input.noEmbed, noExtract: true, noSchemaPack: true };
const requests = () => engine.executeRaw('SELECT id,request_id,state,intent FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [input.sourceId]);
try {
  const before = await requests();
  let changedOptions: unknown;
  if (process.argv[3] === 'resume') {
    try { await performManagedSync(engine, { ...opts, noEmbed: !input.noEmbed }); }
    catch (error) { changedOptions = { code: (error as { code?: string }).code }; }
  }
  const afterChangedOptions = await requests();
  const result = await performManagedSync(engine, { ...opts, retryFailed: true });
  await disposePersistenceConsumer(engine);
  const beforeDrain = await engine.executeRaw('SELECT kind,state FROM persistence_effects WHERE source_id=$1 ORDER BY kind', [input.sourceId]);
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND kind='embedding'", [input.sourceId]);
  await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: false }, { hostId: localHostId(), limit: 10,
    embedding: { signature: 'test:restart:1536', model: 'test:model', embed: async texts => {
      transportCalls++; return texts.map(() => new Float32Array(1536).fill(0.25));
    } } });
  const chunks = await engine.executeRaw('SELECT c.id,c.embedding::text AS vector FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 ORDER BY c.id', [input.sourceId]);
  const effects = await engine.executeRaw('SELECT kind,state FROM persistence_effects WHERE source_id=$1 ORDER BY kind', [input.sourceId]);
  const source = await engine.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [input.sourceId]);
  const pages = await engine.executeRaw('SELECT id,knowledge_revision,embedding_signature FROM pages WHERE source_id=$1 ORDER BY id', [input.sourceId]);
  console.log(JSON.stringify({ pid: process.pid, before, changedOptions, afterChangedOptions, result, beforeDrain,
    after: await requests(), chunks, effects, source, pages, networkCalls, transportCalls }));
} finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
