/**
 * gbrain claw-test CLI dispatch tests.
 *
 * These tests exercise the harness's argument parsing, scenario loading,
 * agent registry resolution, and friction-report path. They do NOT spawn
 * real gbrain commands (no built binary in CI yet); the canonical scripted
 * E2E that walks `gbrain init → import → query → extract → verify` lives
 * in test/e2e/claw-test.test.ts and gates on a built binary.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runFriction } from '../src/commands/friction.ts';
import { listScenarios, loadScenario } from '../src/core/claw-test/scenarios.ts';
import {
  registerAgentRunner, resolveAgentRunner, listRegisteredAgents,
  _resetRegistryForTests,
  type AgentRunner, type DetectResult, type InvokeOpts, type InvokeResult,
} from '../src/core/claw-test/agent-runner.ts';

let tmp: string;
const ORIG_HOME = process.env.GBRAIN_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claw-test-cli-'));
  process.env.GBRAIN_HOME = tmp;
  _resetRegistryForTests();
});

afterEach(() => {
  process.env.GBRAIN_HOME = ORIG_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('shipped scenarios are loadable', () => {
  test('default fixtures root contains both v1 scenarios', () => {
    delete process.env.GBRAIN_CLAW_SCENARIOS_DIR;
    const names = listScenarios();
    expect(names).toContain('fresh-install');
    expect(names).toContain('upgrade-from-v0.18');
  });

  test('fresh-install has expected_phases', () => {
    delete process.env.GBRAIN_CLAW_SCENARIOS_DIR;
    const cfg = loadScenario('fresh-install');
    expect(cfg.expectedPhases).toContain('import.files');
    expect(cfg.expectedPhases).toContain('extract.links_fs');
    expect(cfg.expectedPhases).toContain('doctor.db_checks');
  });

  test('upgrade-from-v0.18 declares from_version', () => {
    delete process.env.GBRAIN_CLAW_SCENARIOS_DIR;
    const cfg = loadScenario('upgrade-from-v0.18');
    expect(cfg.kind).toBe('upgrade');
    expect(cfg.fromVersion).toBe('0.18.0');
    expect(cfg.seedRelative).toBe('seed');
  });
});

describe('agent registry — fake-runner integration', () => {
  test('a fake runner can be registered, resolved, and detect/invoke called', async () => {
    let invokeCount = 0;
    class FakeRunner implements AgentRunner {
      readonly name = 'fake';
      async detect(): Promise<DetectResult> { return { available: true, binPath: '/usr/bin/fake' }; }
      async invoke(_opts: InvokeOpts): Promise<InvokeResult> {
        invokeCount++;
        return { exitCode: 0, durationMs: 1 };
      }
    }
    registerAgentRunner('fake', () => new FakeRunner());
    expect(listRegisteredAgents()).toContain('fake');

    const r = resolveAgentRunner('fake');
    const detected = await r.detect();
    expect(detected.available).toBe(true);

    const result = await r.invoke({
      cwd: tmp,
      brief: 'test',
      env: {},
      timeoutMs: 1000,
      transcriptSink: { write: () => {}, nextOffset: () => 0, close: async () => {} },
    });
    expect(result.exitCode).toBe(0);
    expect(invokeCount).toBe(1);
  });

  test('resolveAgentRunner with unknown name throws with registered list', () => {
    registerAgentRunner('alpha', () => ({} as AgentRunner));
    expect(() => resolveAgentRunner('unknown')).toThrow(/registered: alpha/);
  });
});

describe('friction CLI integrates with harness run-id env', () => {
  test('GBRAIN_FRICTION_RUN_ID populates harness-style run-ids', () => {
    process.env.GBRAIN_FRICTION_RUN_ID = 'claw-test-20260428-fake-abcd1234';
    try {
      const code = runFriction(['log', '--phase', 'install', '--message', 'simulated harness write']);
      expect(code).toBe(0);
      const expectedFile = join(tmp, '.gbrain', 'friction', 'claw-test-20260428-fake-abcd1234.jsonl');
      expect(existsSync(expectedFile)).toBe(true);
      const raw = readFileSync(expectedFile, 'utf-8');
      const entry = JSON.parse(raw.split('\n')[0]);
      expect(entry.run_id).toBe('claw-test-20260428-fake-abcd1234');
      expect(entry.message).toBe('simulated harness write');
    } finally {
      delete process.env.GBRAIN_FRICTION_RUN_ID;
    }
  });
});

describe('OpenClawRunner detection (reliable on box without openclaw)', () => {
  test('detect returns unavailable when OPENCLAW_BIN missing', async () => {
    const orig = process.env.OPENCLAW_BIN;
    delete process.env.OPENCLAW_BIN;
    try {
      const { OpenClawRunner } = await import('../src/core/claw-test/runners/openclaw.ts');
      const r = new OpenClawRunner();
      const d = await r.detect();
      // Either unavailable, or available if openclaw IS on PATH for the dev — both states are valid.
      // We only assert the contract shape.
      expect(typeof d.available).toBe('boolean');
      if (!d.available) {
        expect(typeof d.reason).toBe('string');
      } else {
        expect(d.binPath?.startsWith('/')).toBe(true);
      }
    } finally {
      if (orig !== undefined) process.env.OPENCLAW_BIN = orig;
    }
  });

  test('detect rejects relative OPENCLAW_BIN', async () => {
    const orig = process.env.OPENCLAW_BIN;
    process.env.OPENCLAW_BIN = 'relative/openclaw';
    try {
      const { OpenClawRunner } = await import('../src/core/claw-test/runners/openclaw.ts');
      const r = new OpenClawRunner();
      const d = await r.detect();
      expect(d.available).toBe(false);
      expect(d.reason).toMatch(/absolute/);
    } finally {
      if (orig !== undefined) process.env.OPENCLAW_BIN = orig;
      else delete process.env.OPENCLAW_BIN;
    }
  });

  test("detect rejects '..' segments in OPENCLAW_BIN", async () => {
    const orig = process.env.OPENCLAW_BIN;
    process.env.OPENCLAW_BIN = '/tmp/foo/../bar';
    try {
      const { OpenClawRunner } = await import('../src/core/claw-test/runners/openclaw.ts');
      const r = new OpenClawRunner();
      const d = await r.detect();
      expect(d.available).toBe(false);
      expect(d.reason).toMatch(/'\.\.' segments/);
    } finally {
      if (orig !== undefined) process.env.OPENCLAW_BIN = orig;
      else delete process.env.OPENCLAW_BIN;
    }
  });
});
