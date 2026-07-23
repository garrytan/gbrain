/**
 * eval-takes-quality gateway self-config — adapter-boundary regression
 * (takeover of PR #2430).
 *
 * The old callsite spread `{ ...cfg, ...process.env }` straight into
 * configureGateway. The gateway NEVER reads process.env at call time — it
 * reads `_config.env` — and that spread never populated an `env` field at
 * all, so every availability/diagnose check dereferenced `undefined.env[k]`
 * and file-plane API keys (config.json `openai_api_key` etc.) were dropped.
 * Routing through buildGatewayConfig fixes both. This test fails (throws)
 * on the old code path.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvalTakesQuality } from '../src/commands/eval-takes-quality.ts';
import { isAvailable, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

afterAll(() => {
  resetGateway();
});

describe('runEvalTakesQuality — gateway self-config routes through buildGatewayConfig', () => {
  test('file-plane openai_api_key reaches the gateway env (help path, engine untouched)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-etq-gw-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: join(home, '.gbrain', 'brain'),
          openai_api_key: 'sk-file-plane-test',
        }),
      );
      await withEnv(
        {
          GBRAIN_HOME: home,
          OPENAI_API_KEY: undefined,
          DATABASE_URL: undefined,
          GBRAIN_DATABASE_URL: undefined,
        },
        async () => {
          // 'help' returns before touching the engine, but the gateway is
          // configured first — exactly the seam under test.
          await runEvalTakesQuality({} as BrainEngine, ['--help']);
          expect(isAvailable('embedding', 'openai:text-embedding-3-small')).toBe(true);
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
