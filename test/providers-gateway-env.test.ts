/**
 * #2728 — `gbrain providers env/explain/list` key checks must read the SAME
 * env the gateway resolves against (file-plane keys from ~/.gbrain/config.json
 * folded in via buildGatewayConfig), not bare process.env. A user whose only
 * OPENAI_API_KEY lives in config.json was told the provider is missing while
 * the real gateway path worked fine.
 *
 * Env mutations go through withEnv() (test-isolation rule R1).
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { gatewayEnv } from '../src/commands/providers.ts';

describe('gatewayEnv (#2728)', () => {
  test('folds file-plane openai_api_key into the env used for key checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-providers-env-'));
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(
      join(dir, '.gbrain', 'config.json'),
      JSON.stringify({
        engine: 'pglite',
        database_path: join(dir, '.gbrain', 'brain'),
        openai_api_key: 'sk-file-plane-only',
      }),
    );
    try {
      await withEnv({ GBRAIN_HOME: dir, OPENAI_API_KEY: undefined }, () => {
        // Sanity: the key is NOT in process.env — bare process.env checks
        // (the pre-fix behavior of `providers env` / `explain`) would miss it.
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
        const env = gatewayEnv();
        expect(env.OPENAI_API_KEY).toBe('sk-file-plane-only');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
