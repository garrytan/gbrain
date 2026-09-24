import { test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import { PROVIDER_ENV_KEYS } from './provider-env.ts';
import { withEnv } from './with-env.ts';

/** These dream fixtures are keyless even when the E2E runner preserves real
 * provider credentials for other files. Tests may still inject synthetic keys
 * and stub transports explicitly; ambient providers must never select a model
 * or embed pages that the fixture expects to leave unembedded. */
export function keylessDreamTest(name: string, body: () => void | Promise<void>, timeout?: number): void {
  test(name, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-keyless-dream-'));
    const overrides: Record<string, string | undefined> = { HOME: home, GBRAIN_HOME: home };
    for (const key of PROVIDER_ENV_KEYS) overrides[key] = undefined;
    try {
      await withEnv(overrides, async () => {
        resetGateway();
        try { await body(); }
        finally { resetGateway(); }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, timeout);
}
