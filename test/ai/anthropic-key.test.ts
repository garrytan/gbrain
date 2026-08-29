/**
 * #1698 — shared `hasAnthropicKey` (consolidated from 3 private copies).
 *
 * Hermetic: every case isolates env + GBRAIN_HOME via `withEnv` (R1) so the
 * dev machine's real ~/.gbrain/config.json never leaks into the "neither" case.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import {
  hasAnthropicKey,
  resolveAnthropicKey,
  setGatewayAnthropicKeySnapshot,
} from '../../src/core/ai/anthropic-key.ts';

const tmpDirs: string[] = [];
function freshHome(withConfig?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-akey-'));
  tmpDirs.push(home);
  if (withConfig) {
    const dir = join(home, '.gbrain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(withConfig), 'utf8');
  }
  return home;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('hasAnthropicKey', () => {
  test('env ANTHROPIC_API_KEY set → true (no config read needed)', async () => {
    const home = freshHome(); // empty home so config can't accidentally satisfy it
    await withEnv(
      { ANTHROPIC_API_KEY: 'sk-test', GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => {
        expect(hasAnthropicKey()).toBe(true);
      },
    );
  });

  test('gbrain config anthropic_api_key set (no env) → true', async () => {
    const home = freshHome({ anthropic_api_key: 'sk-from-config' });
    await withEnv(
      { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => {
        expect(hasAnthropicKey()).toBe(true);
      },
    );
  });

  test('neither env nor config → false', async () => {
    const home = freshHome(); // no config.json written
    await withEnv(
      { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => {
        expect(hasAnthropicKey()).toBe(false);
      },
    );
  });
});

describe('resolveAnthropicKey (#2048 — subagent config-key auth)', () => {
  test('env wins over config', async () => {
    const home = freshHome({ anthropic_api_key: 'sk-from-config' });
    await withEnv(
      { ANTHROPIC_API_KEY: 'sk-from-env', GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => {
        expect(resolveAnthropicKey()).toBe('sk-from-env');
      },
    );
  });

  test('config key returned when env unset', async () => {
    const home = freshHome({ anthropic_api_key: 'sk-from-config' });
    await withEnv(
      { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => {
        expect(resolveAnthropicKey()).toBe('sk-from-config');
      },
    );
  });

  test('neither → undefined', async () => {
    const home = freshHome();
    await withEnv(
      { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => {
        expect(resolveAnthropicKey()).toBeUndefined();
      },
    );
  });
});

// #2119 read-side: the gateway env snapshot sits BETWEEN env and file.
// configureGateway() pushes it (push seam — this module never imports
// gateway.ts); these tests drive the setter directly to pin the layer order.
describe('resolveAnthropicKey gateway snapshot layer (#2119)', () => {
  test('snapshot wins over the config file when env is unset', async () => {
    const home = freshHome({ anthropic_api_key: 'sk-from-config' });
    try {
      setGatewayAnthropicKeySnapshot('sk-from-gateway-env');
      await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        async () => {
          expect(resolveAnthropicKey()).toBe('sk-from-gateway-env');
          expect(hasAnthropicKey()).toBe(true);
        },
      );
    } finally {
      setGatewayAnthropicKeySnapshot(undefined);
    }
  });

  test('env still wins over the snapshot', async () => {
    const home = freshHome();
    try {
      setGatewayAnthropicKeySnapshot('sk-from-gateway-env');
      await withEnv(
        { ANTHROPIC_API_KEY: 'sk-from-env', GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        async () => {
          expect(resolveAnthropicKey()).toBe('sk-from-env');
        },
      );
    } finally {
      setGatewayAnthropicKeySnapshot(undefined);
    }
  });

  test('clearing the snapshot falls back to the file layer', async () => {
    const home = freshHome({ anthropic_api_key: 'sk-from-config' });
    try {
      setGatewayAnthropicKeySnapshot('sk-from-gateway-env');
      setGatewayAnthropicKeySnapshot(undefined);
      await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        async () => {
          expect(resolveAnthropicKey()).toBe('sk-from-config');
        },
      );
    } finally {
      setGatewayAnthropicKeySnapshot(undefined);
    }
  });
});
