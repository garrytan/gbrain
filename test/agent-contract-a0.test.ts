/**
 * A0 frozen-interface smoke (docs/designs/AGENT_OPERATOR_WAVE.md): the
 * primitives every lane codes against exist with their frozen shapes.
 * Behavioural tables live in the per-primitive tests.
 */
import { describe, expect, test } from 'bun:test';
import { agentProcessMarker, isInteractive } from '../src/core/interaction.ts';
import { isCallable } from '../src/core/ops/callable.ts';
import { configReadiness, embeddingEnablement } from '../src/core/readiness.ts';
import { jsonRequested } from '../src/core/cli-force-exit.ts';
import { operations } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('A0 interfaces', () => {
  test('isInteractive needs two TTYs and no agent marker; CODEX_HOME is not a marker', () => {
    expect(isInteractive({ env: {}, stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(isInteractive({ env: {}, stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
    expect(isInteractive({ env: { CLAUDECODE: '1' }, stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
    expect(isInteractive({ env: { CODEX_HOME: '/x' }, stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(agentProcessMarker({ CODEX_HOME: '/x' })).toBeNull();
    expect(isInteractive({ env: { CLAUDECODE: '1', GBRAIN_INTERACTIVE: '1' }, stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
  });

  test('jsonRequested stops at a bare --', () => {
    expect(jsonRequested(['doctor', '--json'])).toBe(true);
    expect(jsonRequested(['doctor', '--json=true'])).toBe(true);
    expect(jsonRequested(['get', '--', '--json'])).toBe(false);
    expect(jsonRequested(['doctor'])).toBe(false);
  });

  test('isCallable: verbs surface admits only verbs; http drops localOnly', () => {
    const recall = operations.find(o => o.name === 'recall')!;
    const local = operations.find(o => o.localOnly)!;
    const base = { scopes: ['read', 'write'], publishGates: {} };
    expect(isCallable(recall, { ...base, transport: 'stdio', surface: 'verbs' })).toBe(true);
    expect(isCallable(local, { ...base, transport: 'http', surface: 'full' })).toBe(false);
    expect(isCallable(local, { ...base, transport: 'stdio', surface: 'full' })).toBe(local.publishGateKey === undefined);
  });

  test('readiness entry points have their frozen shapes', () => {
    const cfg = { engine: 'pglite' } as GBrainConfig;
    const r = configReadiness(cfg, { transport: 'cli' });
    expect(Array.isArray(r.entries)).toBe(true);
    expect(r).toHaveProperty('lock_owner');
    const fix = embeddingEnablement(cfg);
    expect(typeof fix.requires_exclusive).toBe('boolean');
  });
});
