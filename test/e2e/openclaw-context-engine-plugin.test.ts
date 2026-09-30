/**
 * E2E plugin-shape test for `src/openclaw-context-engine.ts`.
 *
 * The 21-test unit suite at `test/context-engine.test.ts` exercises
 * `createGBrainContextEngine` directly — that's the ENGINE, not the PLUGIN.
 * This file tests the plugin discovery + registration path that OpenClaw
 * will actually walk at runtime.
 *
 * Codex outside-voice F1: closes the "we ship a plugin we don't test as a
 * plugin" gap. The brittle SDK-shim approach Codex flagged is avoided —
 * Layer 2 dropped the unnecessary `definePluginEntry` import so the plugin
 * entry has zero build-time dependencies on the OpenClaw SDK. The remaining
 * SDK call (the lazy `buildMemorySystemPromptAddition` resolution inside
 * `assemble()`) is intercepted via `mock.module()` because Bun mocks DO
 * intercept dynamic imports.
 */

import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Intercept the lazy SDK import in core/context-engine so the engine sees a
// mock memory-addition function instead of falling through to the no-runtime
// fallback. Bun's mock.module() runs at module evaluation in source order,
// before the dynamic import inside ensureSdkLoaded() fires.
mock.module('openclaw/plugin-sdk/core', () => ({
  delegateCompactionToRuntime: async () => ({ ok: true, compacted: true, reason: 'mock-runtime' }),
  buildMemorySystemPromptAddition: () => '[mock memory addition]',
}));

import pluginEntry from '../../src/openclaw-context-engine.ts';
import { ENGINE_ID, __resetSdkLoadStateForTests } from '../../src/core/context-engine.ts';

interface PluginEntryShape {
  id: string;
  name: string;
  description: string;
  register: (api: unknown) => void;
}

describe('openclaw-context-engine plugin entry', () => {
  it('default export has the expected plugin-entry shape', () => {
    const entry = pluginEntry as PluginEntryShape;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('gbrain-context-engine');
    expect(entry.name).toBe('GBrain Context Engine');
    expect(typeof entry.description).toBe('string');
    expect(entry.description.length).toBeGreaterThan(0);
    expect(typeof entry.register).toBe('function');
  });

  it('register() wires registerContextEngine with ENGINE_ID and a factory', () => {
    type RegisterCall = { id: string; factory: (ctx: { workspaceDir: string }) => unknown };
    const calls: RegisterCall[] = [];
    const stubApi = {
      registerContextEngine: (id: string, factory: RegisterCall['factory']) => {
        calls.push({ id, factory });
      },
    };

    (pluginEntry as PluginEntryShape).register(stubApi);

    expect(calls).toHaveLength(2);
    expect(calls[0].id).toBe(ENGINE_ID);
    expect(typeof calls[0].factory).toBe('function');
    expect(calls[1].id).toBe('gbrain-context-engine');
    expect(typeof calls[1].factory).toBe('function');
  });

  it('factory returns a working ContextEngine bound to the workspace', async () => {
    // Reset lazy-load state so this test exercises the mocked SDK path
    // independently of earlier-in-process state.
    __resetSdkLoadStateForTests();

    type RegisterCall = { id: string; factory: (ctx: { workspaceDir: string }) => any };
    const calls: RegisterCall[] = [];
    (pluginEntry as PluginEntryShape).register({
      registerContextEngine: (id: string, factory: RegisterCall['factory']) => {
        calls.push({ id, factory });
      },
    });

    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-plugin-e2e-'));
    try {
      mkdirSync(join(tmp, 'memory'), { recursive: true });
      writeFileSync(join(tmp, 'memory', 'heartbeat-state.json'), '{}');
      writeFileSync(join(tmp, 'memory', 'upcoming-flights.json'), '{}');

      const engine = calls[0].factory({ workspaceDir: tmp });

      expect(engine).toBeDefined();
      expect(engine.info.id).toBe(ENGINE_ID);
      expect(engine.info.ownsCompaction).toBe(false);
      expect(engine.info.transcriptSemantics).toEqual({
        currentTurnFence: 'before-current-turn-entry-v1',
        turnAdvancementIdempotency: 'atomic-idempotent-v1',
      });
      const acceptedTurn = { advancementKey: 'accepted-once', messages: [{ role: 'user', content: 'hello' }] };
      expect(await engine.commitTurn(acceptedTurn)).toEqual({ status: 'committed' });
      expect(await engine.commitTurn(acceptedTurn)).toEqual({ status: 'committed' });

      // First method call exercises the full assemble path through the
      // factory-built engine — same code the OpenClaw runtime will hit.
      const result = await engine.assemble({ sessionId: 'plug-e2e', messages: [] });
      expect(result.systemPromptAddition).toContain('Live Context');
      // The mocked memory-addition SDK call lands in the prompt too.
      expect(result.systemPromptAddition).toContain('[mock memory addition]');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('zero-argument factories construct without guessing the gateway workspace', async () => {
    const factories = new Map<string, (ctx?: { workspaceDir?: string }) => ReturnType<typeof import('../../src/core/context-engine.ts').createGBrainContextEngine>>();
    const warnings: string[] = [];
    pluginEntry.register({
      registerContextEngine: (id, factory) => { factories.set(id, factory); },
      logger: { warn: (message) => { warnings.push(message); } },
    });
    for (const [id, factory] of factories) {
      const engine = factory();
      expect(engine.info.id).toBe(id);
      const messages = [{ role: 'user', content: 'hello' }];
      const result = await engine.assemble({ sessionId: 'fresh-session', messages });
      expect(result.messages).toBe(messages);
      expect(result.estimatedTokens).toBe(2);
      expect(result.systemPromptAddition).toContain('No brain source was selected');
      expect(await engine.compact({ sessionId: 'fresh-session', sessionFile: '/unused' })).toEqual({
        ok: false, compacted: false, reason: 'workspace-unavailable',
      });
    }
    expect(warnings).toHaveLength(2);
  });

  it('uses explicit legacy workspace configuration but never a multi-agent default or empty context', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-plugin-legacy-'));
    try {
      mkdirSync(join(tmp, 'ops'));
      writeFileSync(join(tmp, 'ops', 'tasks.md'), '## Today\n- [ ] workspace-bound-canary\n');
      for (const config of [
        { pluginConfig: { workspaceDir: tmp } },
        { config: { agents: { defaults: { workspace: tmp } } } },
      ]) {
        let factory!: Parameters<Parameters<typeof pluginEntry.register>[0]['registerContextEngine']>[1];
        pluginEntry.register({ ...config, registerContextEngine: (_id, fn) => { factory = fn; } });
        const result = await factory().assemble({ sessionId: '', messages: [] });
        expect(result.systemPromptAddition).toContain('workspace-bound-canary');
        for (const workspaceDir of ['', 'relative-workspace', '   ']) {
          const empty = await factory({ workspaceDir }).assemble({ sessionId: '', messages: [] });
          expect(empty.systemPromptAddition).toContain('No brain source was selected');
          expect(empty.systemPromptAddition).not.toContain('workspace-bound-canary');
        }
      }
      let factory!: Parameters<Parameters<typeof pluginEntry.register>[0]['registerContextEngine']>[1];
      for (const roster of [{ list: [{ id: 'main' }, { id: 'other' }] }, { entries: { main: {}, other: {} } }]) {
        pluginEntry.register({
          config: { agents: { defaults: { workspace: tmp }, ...roster } },
          registerContextEngine: (_id, fn) => { factory = fn; },
        });
        expect((await factory().assemble({ sessionId: '', messages: [] })).systemPromptAddition).toContain('No brain source was selected');
        expect((await factory({ workspaceDir: tmp }).assemble({ sessionId: '', messages: [] })).systemPromptAddition).toContain('workspace-bound-canary');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
