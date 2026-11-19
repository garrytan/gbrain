/**
 * A put with embedding configured reaches the same final effect state on a Rust brain as on a PGLite brain: the
 * effect worker claims the embedding effect, embeds the page through the provider and commits the effect.
 *
 * The provider is a fake transport (no network, no key leaves the process); the effect pass runs in-process, as
 * the resident consumer runs it. Needs the Rust addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: a page written to a Rust brain with an embedding model configured gets its chunks embedded and its
 *    receipt's embedding effect committed, exactly as on PGLite.
 * 2. Fails when: a member the embedding effect needs (noop settle, segmented read, page lease, chunk manifest, budget
 *    plan, embedding install, projection read, receipt true-up) refuses on Rust or answers differently from PGLite.
 * 3. Existing coverage: test/engine-parity/ compares single members; test/rust-cli-parity.serial.test.ts runs keyless,
 *    so the embedding effect only settles as skipped there. Nothing runs a configured embedding effect on Rust.
 * 4. Seams: the gateway's existing test transport (__setEmbedTransportForTests); no new production seam.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { localHostId, registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { withEnv } from './helpers/with-env.ts';
import { openRustBrain, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const addonReady = existsSync(rustArmAddonPath());
const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';

afterEach(() => { __setEmbedTransportForTests(null); resetGateway(); });

/** Puts one page, runs the effect worker until nothing is due, and answers the final effects and embedded chunks. */
async function putAndEmbed(engine: BrainEngine, home: string) {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    let calls = 0;
    __setEmbedTransportForTests(async ({ values }) => {
      calls++;
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const registration = await registerLocalWriter(engine, 'cli');
    const requestId = randomUUID();
    const content = '---\ntitle: Example\ntype: note\n---\n\nA page the effect worker embeds.\n';
    const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'put_page',
      { slug: 'notes/embedded', content, request_id: requestId }, {
        remote: false, config: { engine: 'pglite' }, sourceId: 'default',
        logger: { info() {}, warn() {}, error() {} },
      }));
    const put = JSON.parse((response.content[0] as { text: string }).text);
    await disposePersistenceConsumer(engine);
    for (let pass = 0; pass < 5; pass++) {
      if (await runPersistenceEffects(engine, { engine: 'pglite' }, { hostId: localHostId(), limit: 10 }) === 0) break;
    }
    const receipt = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'get_write_request',
      { request_id: requestId }, { remote: false, config: { engine: 'pglite' }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } }));
    const effects: Array<{ kind: string; state: string; reason?: string }> = JSON.parse((receipt.content[0] as { text: string }).text).effects ?? [];
    const chunks = await engine.getChunks('notes/embedded', { sourceId: 'default', includeEmbedding: true });
    return {
      embedding: put.embedding_state ?? put.outcome?.embedding_state,
      effects,
      chunks: chunks.length,
      embedded: chunks.filter(c => c.embedding != null).length,
      providerCalled: calls > 0,
    };
  });
}

describe('the effect worker embeds a put on a Rust brain as on PGLite', () => {
  const run = addonReady || required ? test : test.skip;
  const dirs: string[] = [];
  let pg: PGLiteEngine;
  let pgHome: string;

  beforeAll(async () => {
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-ew-pg-')); dirs.push(pgHome);
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never); await pg.initSchema();
  });

  afterAll(async () => {
    await disposePersistenceConsumer(pg).catch(() => {});
    await pg.disconnect();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  run('a put with embedding configured reaches the same final effect state', async () => {
    const expected = await putAndEmbed(pg, pgHome);
    expect(expected.effects.find(e => e.kind === 'embedding')?.state).toBe('committed');
    expect(expected.embedded).toBe(expected.chunks);
    const rust = await openRustBrain(); dirs.push(rust.dir);
    const rustHome = mkdtempSync(join(tmpdir(), 'gbrain-ew-rust-')); dirs.push(rustHome);
    try {
      const got = await putAndEmbed(rust.engine as unknown as BrainEngine, rustHome);
      expect(got).toEqual(expected);
    } finally {
      await disposePersistenceConsumer(rust.engine as unknown as BrainEngine).catch(() => {});
      await rust.engine.disconnect();
    }
  }, 120_000);
});
