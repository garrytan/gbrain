/**
 * #2120 — `gbrain config get` must resolve the file/env plane, not just the
 * DB plane. Pre-fix, `get` called only `engine.getConfig(key)`, so a
 * runtime-effective key in ~/.gbrain/config.json reported not-found while
 * the runtime happily used it.
 *
 * Hermetic: GBRAIN_HOME points at a tmp dir (configDir() honors it) via
 * withEnv (check-test-isolation R1), and the engine is a getConfig-only
 * stub — the `get` path touches nothing else.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runConfig } from '../src/commands/config.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-config-get-'));
mkdirSync(join(home, '.gbrain'), { recursive: true });

function stubEngine(dbValues: Record<string, string>): BrainEngine {
  return {
    getConfig: async (key: string) => dbValues[key] ?? null,
  } as unknown as BrainEngine;
}

function writeFileConfig(cfg: Record<string, unknown>): void {
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(cfg));
}

/** Run `config get <key>` with GBRAIN_HOME pinned to the tmp brain and the
 *  chat-model env overlay cleared, capturing output + exit code. */
async function runGet(
  dbValues: Record<string, string>,
  key: string,
): Promise<{ logs: string[]; errs: string[]; exit: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
  try {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_CHAT_MODEL: undefined },
      () => runConfig(stubEngine(dbValues), ['get', key]),
    );
  } catch (e) {
    if (!(e as Error).message.startsWith('EXIT:')) throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exit };
}

describe('#2120 — config get resolves file plane with DB fallback', () => {
  test('file-plane key with no DB row is found (the pre-fix not-found bug)', async () => {
    writeFileConfig({ engine: 'pglite', chat_model: 'anthropic:claude-sonnet-4-6' });
    const { logs, errs, exit } = await runGet({}, 'chat_model');
    expect(exit).toBeNull();
    expect(logs).toContain('anthropic:claude-sonnet-4-6');
    expect(errs.join('\n')).toContain('file/env plane');
  });

  test('file plane wins over DB plane (matches runtime precedence) and reports the shadow', async () => {
    writeFileConfig({ engine: 'pglite', chat_model: 'anthropic:claude-sonnet-4-6' });
    const { logs, errs } = await runGet({ chat_model: 'openai:gpt-5' }, 'chat_model');
    expect(logs).toContain('anthropic:claude-sonnet-4-6');
    expect(logs).not.toContain('openai:gpt-5');
    expect(errs.join('\n')).toContain('shadowed');
  });

  test('DB-plane-only key still resolves (no regression for dotted keys)', async () => {
    writeFileConfig({ engine: 'pglite' });
    const { logs, errs } = await runGet({ 'search.mode': 'balanced' }, 'search.mode');
    expect(logs).toContain('balanced');
    expect(errs.join('\n')).toContain('db plane');
  });

  test('key in neither plane is still not-found (exit 1)', async () => {
    writeFileConfig({ engine: 'pglite' });
    const { errs, exit } = await runGet({}, 'chat_model');
    expect(exit).toBe(1);
    expect(errs.join('\n')).toContain('Config key not found: chat_model');
  });
});
