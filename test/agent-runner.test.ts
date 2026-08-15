/**
 * AgentRunner registry + selection tests. Proves the harness contract is
 * truly agent-agnostic via a fake-runner integration.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import {
  registerAgentRunner, resolveAgentRunner, listRegisteredAgents,
  _resetRegistryForTests, detectBinary, filterAllowlistEnv,
  type AgentRunner, type DetectResult, type InvokeOpts, type InvokeResult, type TranscriptSink,
} from '../src/core/claw-test/agent-runner.ts';

class FakeRunner implements AgentRunner {
  readonly name: string;
  invocations = 0;
  detected: DetectResult = { available: true, binPath: '/usr/bin/fake-agent' };

  constructor(name: string) { this.name = name; }

  async detect(): Promise<DetectResult> { return this.detected; }
  async invoke(_opts: InvokeOpts): Promise<InvokeResult> {
    this.invocations++;
    return { exitCode: 0, durationMs: 1 };
  }
}

beforeEach(() => {
  _resetRegistryForTests();
});

describe('registry', () => {
  test('register + resolve roundtrips', () => {
    registerAgentRunner('fake', () => new FakeRunner('fake'));
    const r = resolveAgentRunner('fake');
    expect(r.name).toBe('fake');
  });

  test('resolve unknown agent throws with helpful list', () => {
    registerAgentRunner('alpha', () => new FakeRunner('alpha'));
    registerAgentRunner('beta', () => new FakeRunner('beta'));
    expect(() => resolveAgentRunner('gamma')).toThrow(/registered: alpha, beta/);
  });

  test('listRegisteredAgents returns sorted names', () => {
    registerAgentRunner('zeta', () => new FakeRunner('zeta'));
    registerAgentRunner('alpha', () => new FakeRunner('alpha'));
    expect(listRegisteredAgents()).toEqual(['alpha', 'zeta']);
  });

  test('factory pattern produces independent instances', () => {
    registerAgentRunner('fake', () => new FakeRunner('fake'));
    const a = resolveAgentRunner('fake') as FakeRunner;
    const b = resolveAgentRunner('fake') as FakeRunner;
    expect(a).not.toBe(b);
  });
});

describe('agent-agnosticism guard', () => {
  test('a fake runner can satisfy the AgentRunner contract end-to-end', async () => {
    registerAgentRunner('fake', () => new FakeRunner('fake'));
    const runner = resolveAgentRunner('fake');

    // The harness contract: detect → invoke. Nothing else.
    const detected = await runner.detect();
    expect(detected.available).toBe(true);
    expect(detected.binPath).toBe('/usr/bin/fake-agent');

    let written = 0;
    const sink: TranscriptSink = {
      write: () => { written++; },
      nextOffset: () => 0,
      close: async () => { /* noop */ },
    };

    const result = await runner.invoke({
      cwd: '/tmp',
      brief: 'hello',
      env: {},
      timeoutMs: 1000,
      transcriptSink: sink,
    });
    expect(result.exitCode).toBe(0);
  });

  test('a runner reporting unavailable still satisfies the contract', async () => {
    class UnavailableRunner implements AgentRunner {
      name = 'gone';
      async detect() { return { available: false, reason: 'not installed' } as DetectResult; }
      async invoke(): Promise<InvokeResult> { throw new Error('should not be called'); }
    }
    registerAgentRunner('gone', () => new UnavailableRunner());
    const r = resolveAgentRunner('gone');
    const d = await r.detect();
    expect(d.available).toBe(false);
    expect(d.reason).toBe('not installed');
  });
});

describe('shared runner helpers (detectBinary / filterAllowlistEnv)', () => {
  test('filterAllowlistEnv: overrides win over process.env (PATH-shim precedence)', () => {
    const realPath = process.env.PATH;
    expect(realPath).toBeTruthy();
    const env = filterAllowlistEnv(['PATH', 'HOME'], { PATH: '/shim-bin:/usr/bin' });
    expect(env.PATH).toBe('/shim-bin:/usr/bin');
    expect(env.PATH).not.toBe(realPath);
    if (typeof process.env.HOME === 'string') expect(env.HOME).toBe(process.env.HOME);
  });

  test('filterAllowlistEnv: unlisted process.env keys never reach the child', async () => {
    await withEnv({ AGENT_RUNNER_TEST_LEAK_CANARY: 'leaked' }, () => {
      const env = filterAllowlistEnv(['PATH'], {});
      expect(env.AGENT_RUNNER_TEST_LEAK_CANARY).toBeUndefined();
    });
  });

  test('detectBinary: non-executable regular file is unavailable with the stat reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runner-detect-'));
    const p = join(dir, 'not-exec');
    try {
      writeFileSync(p, '#!/bin/sh\n', { mode: 0o644 });
      await withEnv({ AGENT_RUNNER_TEST_BIN: p }, () => {
        const d = detectBinary('AGENT_RUNNER_TEST_BIN', 'definitely-not-a-real-binary-name');
        expect(d.available).toBe(false);
        expect(d.reason).toBe(`not executable: ${p}`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detectBinary: missing env + missing binary reports not-on-PATH', async () => {
    await withEnv({ AGENT_RUNNER_TEST_BIN: undefined }, () => {
      const d = detectBinary('AGENT_RUNNER_TEST_BIN', 'definitely-not-a-real-binary-name');
      expect(d.available).toBe(false);
      expect(d.reason).toBe('definitely-not-a-real-binary-name not on PATH');
    });
  });
});
