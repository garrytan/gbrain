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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runFriction } from '../src/commands/friction.ts';
import { listScenarios, loadScenario } from '../src/core/claw-test/scenarios.ts';
import {
  registerAgentRunner, resolveAgentRunner, listRegisteredAgents,
  _resetRegistryForTests, validateBinPathEnv,
  type AgentRunner, type DetectResult, type InvokeOpts, type InvokeResult,
} from '../src/core/claw-test/agent-runner.ts';
import { mergeChildFriction } from '../src/commands/claw-test.ts';

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

describe('HermesRunner detection (reliable on box without hermes)', () => {
  test('detect returns the contract shape when HERMES_BIN unset', async () => {
    const orig = process.env.HERMES_BIN;
    delete process.env.HERMES_BIN;
    try {
      const { HermesRunner } = await import('../src/core/claw-test/runners/hermes.ts');
      const d = await new HermesRunner().detect();
      // Available when hermes IS on the dev's PATH, unavailable otherwise —
      // both are valid; assert the contract shape only.
      expect(typeof d.available).toBe('boolean');
      if (!d.available) expect(typeof d.reason).toBe('string');
      else expect(d.binPath?.startsWith('/')).toBe(true);
    } finally {
      if (orig !== undefined) process.env.HERMES_BIN = orig;
    }
  });

  test('detect rejects relative HERMES_BIN', async () => {
    const orig = process.env.HERMES_BIN;
    process.env.HERMES_BIN = 'relative/hermes';
    try {
      const { HermesRunner } = await import('../src/core/claw-test/runners/hermes.ts');
      const d = await new HermesRunner().detect();
      expect(d.available).toBe(false);
      expect(d.reason).toMatch(/HERMES_BIN must be absolute/);
    } finally {
      if (orig !== undefined) process.env.HERMES_BIN = orig;
      else delete process.env.HERMES_BIN;
    }
  });

  test("detect rejects '..' segments in HERMES_BIN", async () => {
    const orig = process.env.HERMES_BIN;
    process.env.HERMES_BIN = '/tmp/foo/../hermes';
    try {
      const { HermesRunner } = await import('../src/core/claw-test/runners/hermes.ts');
      const d = await new HermesRunner().detect();
      expect(d.available).toBe(false);
      expect(d.reason).toMatch(/'\.\.' segments/);
    } finally {
      if (orig !== undefined) process.env.HERMES_BIN = orig;
      else delete process.env.HERMES_BIN;
    }
  });
});

describe('HermesRunner invoke argv/env (shim — no hermes binary needed)', () => {
  test('argv starts with the one-shot flag; HERMES_HOME propagates; unlisted env does not', async () => {
    const orig = {
      HERMES_BIN: process.env.HERMES_BIN,
      HERMES_HOME: process.env.HERMES_HOME,
      LEAK_CANARY: process.env.LEAK_CANARY,
      GBRAIN_DATABASE_URL: process.env.GBRAIN_DATABASE_URL,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    const shim = join(tmp, 'hermes-shim');
    // Echo the argv and the env probes, then exit 0. The transcript sink
    // captures stdout, so assertions read the sink's events.
    writeFileSync(shim, '#!/bin/sh\nprintf "ARGV:%s\\n" "$@"\nprintf "HH:[%s] CANARY:[%s] DBURL:[%s] OR:[%s]\\n" "$HERMES_HOME" "$LEAK_CANARY" "$GBRAIN_DATABASE_URL" "$OPENROUTER_API_KEY"\n', 'utf-8');
    chmodSync(shim, 0o755);
    process.env.HERMES_BIN = shim;
    process.env.HERMES_HOME = '/tmp/hh-canary-test';
    process.env.LEAK_CANARY = 'must-not-leak';
    // Hermes-documented auth path (docs/mcp/HERMES.md): the hermes delta must
    // forward it or env-only OpenRouter operators get "no inference provider".
    process.env.OPENROUTER_API_KEY = 'or-sentinel-91c4';
    // Removed from BASE_ENV_ALLOWLIST in the adversarial review: an inherited
    // GBRAIN_DATABASE_URL would flip only the AGENT's gbrain to Postgres while
    // staging + the oracle stay on the hermetic PGLite (split-brain).
    process.env.GBRAIN_DATABASE_URL = 'postgres://must-not-leak';
    try {
      const { HermesRunner } = await import('../src/core/claw-test/runners/hermes.ts');
      const chunks: Buffer[] = [];
      const result = await new HermesRunner().invoke({
        cwd: tmp,
        brief: 'BRIEF BODY sentinel-7c2f',
        env: {},
        timeoutMs: 10_000,
        transcriptSink: {
          write: (e) => { if (e.channel === 'stdout') chunks.push(e.bytes); },
          nextOffset: () => 0,
          close: async () => {},
        },
      });
      expect(result.exitCode).toBe(0);
      const stdout = Buffer.concat(chunks).toString('utf-8');
      // First argv token is the one-shot flag, second is the brief itself.
      expect(stdout).toContain('ARGV:-z\nARGV:BRIEF BODY sentinel-7c2f');
      // Allowlist held: HERMES_HOME + OPENROUTER_API_KEY (the hermes delta)
      // pass; the canary and the deliberately-delisted GBRAIN_DATABASE_URL
      // don't.
      expect(stdout).toContain('HH:[/tmp/hh-canary-test]');
      expect(stdout).toContain('CANARY:[] DBURL:[] OR:[or-sentinel-91c4]');
    } finally {
      for (const [k, v] of Object.entries(orig)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });
});

describe('OpenClawRunner invoke env (shim — pins the shared-allowlist leak barrier)', () => {
  test('GBRAIN_DATABASE_URL does not propagate through the openclaw runner either', async () => {
    // The split-brain fix removed GBRAIN_DATABASE_URL from BASE_ENV_ALLOWLIST;
    // the hermes shim test pins the hermes side — this pins the openclaw side
    // so an openclaw-specific delta re-adding it (the exact one-line
    // regression) cannot pass silently.
    const orig = { OPENCLAW_BIN: process.env.OPENCLAW_BIN, GBRAIN_DATABASE_URL: process.env.GBRAIN_DATABASE_URL };
    const shim = join(tmp, 'openclaw-shim');
    writeFileSync(shim, '#!/bin/sh\nprintf "DBURL:[%s]\\n" "$GBRAIN_DATABASE_URL"\n', 'utf-8');
    chmodSync(shim, 0o755);
    process.env.OPENCLAW_BIN = shim;
    process.env.GBRAIN_DATABASE_URL = 'postgres://must-not-leak';
    try {
      const { OpenClawRunner } = await import('../src/core/claw-test/runners/openclaw.ts');
      const chunks: Buffer[] = [];
      const result = await new OpenClawRunner().invoke({
        cwd: tmp,
        brief: 'brief',
        env: {},
        timeoutMs: 10_000,
        transcriptSink: {
          write: (e) => { if (e.channel === 'stdout') chunks.push(e.bytes); },
          nextOffset: () => 0,
          close: async () => {},
        },
      });
      expect(result.exitCode).toBe(0);
      expect(Buffer.concat(chunks).toString('utf-8')).toContain('DBURL:[]');
    } finally {
      for (const [k, v] of Object.entries(orig)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });
});

describe('validateBinPathEnv — shim-quoting hardening', () => {
  test('rejects quote/metacharacter values that would break out of the generated shim quoting', () => {
    // The value is interpolated single-quoted into sh shim scripts; each of
    // these would otherwise become shell code.
    for (const bad of [
      "/tmp/x'; rm -rf /tmp/pwn; '",
      '/tmp/x"double',
      '/tmp/x`tick`',
      '/tmp/x$HOME',
      '/tmp/x\\backslash',
      '/tmp/x\nnewline',
    ]) {
      expect(validateBinPathEnv('X_BIN', bad)).not.toBeNull();
    }
    // Spaces stay legal (macOS paths); quoting handles them.
    expect(validateBinPathEnv('X_BIN', '/Applications/App Support/gbrain')).toBeNull();
  });
});

describe('mergeChildFriction — untrusted child file hardening', () => {
  // The child file lives in a workspace the AGENT writes to; the destination
  // is the operator's permanent friction log.
  const runId = 'claw-test-merge-hardening';

  function childPath(runRoot: string): string {
    const dir = join(runRoot, '.gbrain', 'friction');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${runId}.jsonl`);
  }

  function parentFile(): string {
    return join(tmp, '.gbrain', 'friction', `${runId}.jsonl`);
  }

  test('valid JSONL lines merge; non-JSON and non-object lines are dropped', () => {
    const runRoot = join(tmp, 'runroot-valid');
    const entry = JSON.stringify({ phase: 'agent-side', message: 'kept', kind: 'friction' });
    writeFileSync(childPath(runRoot), `${entry}\nnot json at all\n"a json string scalar"\n[1,2]\n`, 'utf-8');
    mergeChildFriction(runRoot, runId);
    const merged = readFileSync(parentFile(), 'utf-8').split('\n').filter(l => l.trim());
    expect(merged).toEqual([entry]);
  });

  test('a symlinked child file is refused (an agent-dropped link could import any readable file)', () => {
    const runRoot = join(tmp, 'runroot-symlink');
    const target = join(tmp, 'outside-secret.jsonl');
    writeFileSync(target, JSON.stringify({ phase: 'x', message: 'secret' }) + '\n', 'utf-8');
    const cp = childPath(runRoot);
    symlinkSync(target, cp);
    mergeChildFriction(runRoot, runId);
    expect(existsSync(parentFile())).toBe(false);
  });

  test('an oversized child file is refused (size cap)', () => {
    const runRoot = join(tmp, 'runroot-huge');
    const line = JSON.stringify({ phase: 'x', message: 'y'.repeat(1024) });
    const lines = Math.ceil((5 * 1024 * 1024) / line.length) + 1;
    writeFileSync(childPath(runRoot), Array(lines).fill(line).join('\n') + '\n', 'utf-8');
    mergeChildFriction(runRoot, runId);
    expect(existsSync(parentFile())).toBe(false);
  });
});

describe('spawnWithCapture — stdin EOF (no payload)', () => {
  test('an agent that waits for stdin EOF exits promptly instead of hanging to the timeout', async () => {
    const orig = process.env.HERMES_BIN;
    const shim = join(tmp, 'stdin-wait-shim');
    // `cat` blocks until stdin EOF; with stdin left open this burns the whole
    // timeout and exits 124 via the kill path.
    writeFileSync(shim, '#!/bin/sh\ncat > /dev/null\necho done\n', 'utf-8');
    chmodSync(shim, 0o755);
    process.env.HERMES_BIN = shim;
    try {
      const { HermesRunner } = await import('../src/core/claw-test/runners/hermes.ts');
      const start = Date.now();
      const result = await new HermesRunner().invoke({
        cwd: tmp,
        brief: 'brief',
        env: {},
        timeoutMs: 15_000,
        transcriptSink: { write: () => {}, nextOffset: () => 0, close: async () => {} },
      });
      expect(result.exitCode).toBe(0);
      expect(Date.now() - start).toBeLessThan(10_000);
    } finally {
      if (orig !== undefined) process.env.HERMES_BIN = orig;
      else delete process.env.HERMES_BIN;
    }
  });
});

// NOTE deliberately absent: a "command module registers openclaw + hermes"
// unit test. Any in-process version is a tautology — this file's beforeEach
// wipes the registry and bun caches the command module, so the test would
// have to re-register the runners itself and would pass even if the command
// module dropped its registrations. The HONEST integration check lives in
// test/e2e/claw-test.test.ts ("--list-agents reports both built-in runners"),
// which spawns the real CLI and asserts both runner lines.
