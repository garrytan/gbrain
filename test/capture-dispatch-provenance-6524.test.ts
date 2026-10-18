/**
 * #6524: `gbrain capture` has sent its provenance trio (`source_kind`,
 * `source_uri`, `ingested_via`) since #5622; since #5970 dispatch rejects any
 * undeclared key on a write. A CLI delegating to a running serve (IPC owner)
 * and every thin client reach capture through `dispatchToolCall`, so the
 * trio must be declared on the op. The literal below is the CLI's shape for
 * `gbrain capture "<text>" --slug <slug>` (the builder itself is pinned by
 * test/capture-cli-params-contract-6524.test.ts). Dispatch admits it; the
 * owner keeps a trusted local caller's values and replaces a remote caller's
 * with the server stamp, so declaring the keys lends no trust.
 *
 * On master both captures fail with "3 unknown parameters not declared in the
 * capture tool schema". Runs on PGLite; also on Postgres when DATABASE_URL is
 * set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: Array<{ backend: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    engines.push({ backend: 'pglite', engine });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push({ backend: 'postgres', engine: pg.engine }); closePostgres = pg.close;
  }
  for (const { engine } of engines) await engine.setConfig('schema_pack', 'gbrain-base');
}, 120_000);

afterAll(async () => {
  for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

const cliShape = (slug: string, content: string) => ({
  content, request_id: randomUUID(), slug, source_kind: 'capture-cli', source_uri: 'cli-positional', ingested_via: 'capture-cli',
});
const parsed = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;
const provenance = async (engine: BrainEngine, slug: string) => {
  const page = await engine.getPage(slug);
  return { source_kind: page?.source_kind, source_uri: page?.source_uri, ingested_via: page?.ingested_via };
};

describe('#6524 the CLI capture shape through dispatch', () => {
  for (const backend of backends) {
    const engineFor = () => engines.find(e => e.backend === backend)!.engine;

    test(`[${backend}] a trusted local caller (resident-owner IPC) is admitted and its provenance is stored`, async () => {
      const engine = engineFor();
      const slug = 'inbox/capture-cli-provenance-6524';
      const res = await dispatchToolCall(engine, 'capture', cliShape(slug, 'Captured from the CLI through a running serve.'), { remote: false, sourceId: 'default' });
      expect({ isError: res.isError ?? false, body: parsed(res) }).toMatchObject({ isError: false, body: { slug, channel: 'capture' } });
      expect(await provenance(engine, slug)).toEqual({ source_kind: 'capture-cli', source_uri: 'cli-positional', ingested_via: 'capture-cli' });
    });

    test(`[${backend}] a remote caller sending the same shape is admitted and its provenance is replaced by the server stamp`, async () => {
      const engine = engineFor();
      const slug = 'inbox/capture-remote-provenance-6524';
      const res = await dispatchToolCall(engine, 'capture', cliShape(slug, 'Submitted remotely with a claimed CLI provenance.'), { remote: true, transport: 'stdio', sourceId: 'default' });
      expect({ isError: res.isError ?? false, body: parsed(res) }).toMatchObject({ isError: false, body: { slug } });
      expect(await provenance(engine, slug)).toEqual({ source_kind: 'mcp:capture', source_uri: null, ingested_via: 'mcp:capture' });
    });
  }
});
