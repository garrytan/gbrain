/**
 * AgentRunner registry + selection tests. Proves the harness contract is
 * truly agent-agnostic via a fake-runner integration.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  registerAgentRunner, resolveAgentRunner, listRegisteredAgents,
  _resetRegistryForTests,
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
