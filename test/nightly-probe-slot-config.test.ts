/**
 * #5872 / D12: the nightly probe's judge-slot keys
 * `models.eval.cross_modal.slot_{a,b,c}` are registered config keys whose
 * value is the slot's effective route.
 *
 * Protects: `gbrain config set` accepts each key without --force (no
 * unknown-key refusal), `config get` reads it back, the probe's route
 * resolver returns the set value (alias-expanded) as that slot's model, and
 * `config unset` returns the slot to the panel default.
 * Fails when: a key drops out of KNOWN_CONFIG_KEYS or the resolver stops
 * reading it.
 * Seams: none; in-memory PGLite, console/process.exit spies around runConfig.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runConfig } from '../src/commands/config.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { NIGHTLY_PROBE_SLOT_KEYS, resolveNightlyProbeModelRoutes } from '../src/core/cycle/nightly-probe-routes.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function runConfigCapture(args: string[]) {
  const logs: string[] = [];
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
  try { await runConfig(engine, args); }
  catch (e) { if (!(e as Error).message.startsWith('EXIT:')) throw e; }
  finally { logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore(); }
  return { out: logs.join('\n'), err: errs.join('\n'), exit: exit as number | null };
}

describe('models.eval.cross_modal.slot_{a,b,c} (D12)', () => {
  test('the three keys are registered', () => {
    expect(Object.values(NIGHTLY_PROBE_SLOT_KEYS)).toEqual([
      'models.eval.cross_modal.slot_a', 'models.eval.cross_modal.slot_b', 'models.eval.cross_modal.slot_c',
    ]);
    for (const key of Object.values(NIGHTLY_PROBE_SLOT_KEYS)) expect(KNOWN_CONFIG_KEYS).toContain(key);
  });

  test('set → get → effective route → unset → panel default', async () => {
    await withEnv({ GBRAIN_HOME: '/nonexistent-gbrain-home-d12', GBRAIN_MODEL: undefined }, async () => {
      const set = await runConfigCapture(['set', 'models.eval.cross_modal.slot_a', 'claude-cli:claude-opus-5-5']);
      expect(set.exit).toBeNull();
      expect(set.err).not.toContain('Unknown config key');
      await runConfigCapture(['set', 'models.eval.cross_modal.slot_c', 'haiku']);

      const get = await runConfigCapture(['get', 'models.eval.cross_modal.slot_a']);
      expect(get.out.trim()).toBe('claude-cli:claude-opus-5-5');

      const routes = await resolveNightlyProbeModelRoutes(engine);
      expect(routes.slots.A).toBe('claude-cli:claude-opus-5-5');
      expect(routes.slots.B).toBeUndefined();
      expect(routes.slots.C).toBe('anthropic:claude-haiku-4-5-20251001');

      await runConfigCapture(['unset', 'models.eval.cross_modal.slot_a']);
      await runConfigCapture(['unset', 'models.eval.cross_modal.slot_c']);
      expect((await resolveNightlyProbeModelRoutes(engine)).slots).toEqual({});
    });
  });
});
