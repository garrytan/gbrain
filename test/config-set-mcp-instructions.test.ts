/**
 * #4748 ship-review fix — `gbrain config set mcp.instructions …` must be
 * observable by resolveMcpInstructions.
 *
 * The `mcp.` prefix let `config set mcp.instructions` through the unknown-key
 * gate, but the write landed on the DB plane while resolveMcpInstructions
 * (every MCP transport's initialize response) reads ONLY the file plane via
 * loadConfig() — the documented command was accepted and silently ignored.
 * `mcp.instructions` is now a FILE_PLANE_DOTTED_KEYS member (set + unset).
 *
 * Hermetic: GBRAIN_HOME points at a temp dir; the stub engine records any
 * DB-plane write so the test can prove none happened.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runConfig } from '../src/commands/config.ts';
import { loadConfig } from '../src/core/config.ts';
import { GBRAIN_MCP_INSTRUCTIONS, resolveMcpInstructions } from '../src/mcp/instructions.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function stubEngine(): { engine: BrainEngine; setCalls: Array<[string, string]>; unsetCalls: string[] } {
  const setCalls: Array<[string, string]> = [];
  const unsetCalls: string[] = [];
  const engine = {
    getConfig: async () => null,
    setConfig: async (key: string, value: string) => { setCalls.push([key, value]); },
    unsetConfig: async (key: string) => { unsetCalls.push(key); return 0; },
  } as unknown as BrainEngine;
  return { engine, setCalls, unsetCalls };
}

async function runConfigCapture(
  engine: BrainEngine,
  args: string[],
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
    await runConfig(engine, args);
  } catch (e) {
    if (!(e as Error).message.startsWith('EXIT:')) throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exit };
}

describe('#4748 config set mcp.instructions lands on the plane resolveMcpInstructions reads', () => {
  test('set → visible via resolveMcpInstructions(loadConfig()); unset → canonical contract again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-mcp-instructions-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
    try {
      await withEnv(
        { GBRAIN_HOME: home, GBRAIN_MCP_INSTRUCTIONS: undefined, DATABASE_URL: undefined },
        async () => {
          const identity = 'Personal brain of alice-example — route personal notes here';
          const { engine, setCalls, unsetCalls } = stubEngine();

          const set = await runConfigCapture(engine, ['set', 'mcp.instructions', identity]);
          expect(set.exit).toBeNull();
          expect(set.errs.join('\n')).not.toContain('Unknown config key');
          // File plane, not DB plane — the DB plane is invisible to the resolver.
          expect(setCalls).toEqual([]);
          expect(set.logs.join('\n')).toContain('file plane');

          const resolved = resolveMcpInstructions(loadConfig(), {});
          expect(resolved).toStartWith(GBRAIN_MCP_INSTRUCTIONS);
          expect(resolved).toEndWith(`Deployment identity:\n${identity}`);

          const unset = await runConfigCapture(engine, ['unset', 'mcp.instructions']);
          expect(unset.exit).toBeNull();
          expect(unsetCalls).toEqual([]);
          expect(resolveMcpInstructions(loadConfig(), {})).toBe(GBRAIN_MCP_INSTRUCTIONS);
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
