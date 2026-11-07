import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Protect the first embed after migration persistence, including env-canonical
// deployments. Rebuilding from file/env alone loses the probed DB endpoint.
// Existing config hygiene tests do not seed DB-only provider URLs. No new seam:
// run the real config merge and gateway in an isolated child with a fake wire.
// isolation-lint: R5-subprocess-only
test('migration retains probed DB provider URLs without persisting runtime config', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'migration-provider-'));
  try {
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', `
      import { strict as assert } from 'node:assert';
      import { existsSync, readFileSync, rmSync } from 'node:fs';
      import { join } from 'node:path';
      import { saveConfig, loadConfigWithEngine } from './src/core/config.ts';
      import { buildGatewayConfig } from './src/core/ai/build-gateway-config.ts';
      import { configureGateway, embed } from './src/core/ai/gateway.ts';
      import { persistEmbeddingFileConfig, probeTargetProvider } from './src/commands/migrate-embeddings.ts';
      import { withEnv } from './test/helpers/with-env.ts';

      const target = 'ollama:nomic-embed-text:v1.5';
      const getConfigPath = () => join(process.env.GBRAIN_HOME, '.gbrain', 'config.json');
      const dbUrl = 'http://127.0.0.1:11435/v1';
      const fileUrl = 'http://127.0.0.1:11436/v1';
      const envUrl = 'http://127.0.0.1:11437/v1';
      const rows = { 'provider_base_urls.ollama': dbUrl };
      const reader = {
        getConfig: async key => rows[key] ?? null,
        getAllConfig: async () => rows,
      };
      const requests = [];
      globalThis.fetch = async (input, init) => {
        requests.push(String(input));
        const body = JSON.parse(init.body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({
          object: 'list', model: 'nomic-embed-text:v1.5',
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: Array(768).fill(0.25) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      };
      for (const hasFile of [true, false]) {
        for (const override of ['none', 'env', 'file', 'both']) {
          if (!hasFile && (override === 'file' || override === 'both')) continue;
          await withEnv({
            OPENROUTER_API_KEY: 'runtime-canary',
            DATABASE_URL: 'postgres://127.0.0.1:5432/disposable_test',
            OLLAMA_BASE_URL: override === 'env' || override === 'both' ? envUrl : undefined,
            GBRAIN_EMBEDDING_MODEL: hasFile ? undefined : target,
            GBRAIN_EMBEDDING_DIMENSIONS: hasFile ? undefined : '768',
          }, async () => {
          rmSync(getConfigPath(), { force: true });
          const fileWins = override === 'file' || override === 'both';
          if (hasFile) saveConfig({
            engine: 'pglite', embedding_model: 'openai:text-embedding-3-small',
            embedding_dimensions: 1536,
            ...(fileWins ? { provider_base_urls: { ollama: fileUrl } } : {}),
          });
          configureGateway(buildGatewayConfig(await loadConfigWithEngine(reader)));
          requests.length = 0;
          assert.deepEqual(await probeTargetProvider(target, 768), { ok: true });
          // The builder's existing local-provider precedence is config > env.
          const expected = fileWins ? fileUrl : dbUrl;
          assert.equal(requests[0], expected + '/embeddings');
          await persistEmbeddingFileConfig(target, 768);
          const vectors = await embed(['first post-apply chunk']);
          assert.equal(vectors[0].length, 768);
          assert.equal(requests[1], expected + '/embeddings');
          if (hasFile) {
            const saved = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
            assert.deepEqual(saved, {
              engine: 'pglite', embedding_model: target, embedding_dimensions: 768,
              ...(fileWins ? { provider_base_urls: { ollama: fileUrl } } : {}),
            });
          } else assert.equal(existsSync(getConfigPath()), false);
          });
        }
      }
    `], {
      env: { PATH: process.env.PATH, GBRAIN_HOME: scratch, GBRAIN_MODEL_DISCOVERY: 'off' },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    expect(child.exitCode).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60000);
