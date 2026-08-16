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

describe('GrokRunner detection (reliable on box without grok)', () => {
  test('detect returns the contract shape when GROK_BIN unset', async () => {
    const orig = process.env.GROK_BIN;
    delete process.env.GROK_BIN;
    try {
      const { GrokRunner } = await import('../src/core/claw-test/runners/grok.ts');
      const d = await new GrokRunner().detect();
      expect(typeof d.available).toBe('boolean');
      if (!d.available) expect(typeof d.reason).toBe('string');
      else expect(d.binPath?.startsWith('/')).toBe(true);
    } finally {
      if (orig !== undefined) process.env.GROK_BIN = orig;
    }
  });

  test('detect rejects relative GROK_BIN', async () => {
    const orig = process.env.GROK_BIN;
    process.env.GROK_BIN = 'relative/grok';
    try {
      const { GrokRunner } = await import('../src/core/claw-test/runners/grok.ts');
      const d = await new GrokRunner().detect();
      expect(d.available).toBe(false);
      expect(d.reason).toMatch(/GROK_BIN must be absolute/);
    } finally {
      if (orig !== undefined) process.env.GROK_BIN = orig;
      else delete process.env.GROK_BIN;
    }
  });

  test("detect rejects '..' segments in GROK_BIN", async () => {
    const orig = process.env.GROK_BIN;
    process.env.GROK_BIN = '/tmp/foo/../grok';
    try {
      const { GrokRunner } = await import('../src/core/claw-test/runners/grok.ts');
      const d = await new GrokRunner().detect();
      expect(d.available).toBe(false);
      expect(d.reason).toMatch(/'\.\.' segments/);
    } finally {
      if (orig !== undefined) process.env.GROK_BIN = orig;
      else delete process.env.GROK_BIN;
    }
  });

  test('detect rejects shell metacharacters in GROK_BIN (through-runner injection pin)', async () => {
    // validateBinPathEnv's metachar branch is unit-tested directly below;
    // this pins that a runner's detect() actually routes through it — the
    // first through-runner coverage of the injection-relevant branch.
    const orig = process.env.GROK_BIN;
    process.env.GROK_BIN = '/tmp/gr"ok';
    try {
      const { GrokRunner } = await import('../src/core/claw-test/runners/grok.ts');
      const d = await new GrokRunner().detect();
      expect(d.available).toBe(false);
      expect(d.reason).toMatch(/quotes, backslashes, dollar signs/);
    } finally {
      if (orig !== undefined) process.env.GROK_BIN = orig;
      else delete process.env.GROK_BIN;
    }
  });
});

describe('GrokRunner invoke argv/env (shim — no grok binary needed)', () => {
  test('argv is the pinned one-shot shape; GROK_HOME + XAI_API_KEY propagate; unlisted env does not', async () => {
    const orig = {
      GROK_BIN: process.env.GROK_BIN,
      GROK_HOME: process.env.GROK_HOME,
      XAI_API_KEY: process.env.XAI_API_KEY,
      LEAK_CANARY: process.env.LEAK_CANARY,
      GBRAIN_DATABASE_URL: process.env.GBRAIN_DATABASE_URL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    const shim = join(tmp, 'grok-shim');
    // The runner first execs the shim with a version flag (the transcript
    // preamble), then spawns the real turn — the shim answers both.
    writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 9.9.9 (shimhash)"; exit 0; fi\nprintf "ARGV:%s\\n" "$@"\nprintf "GH:[%s] KEY:[%s] CANARY:[%s] DBURL:[%s] ANT:[%s] OAI:[%s]\\n" "$GROK_HOME" "$XAI_API_KEY" "$LEAK_CANARY" "$GBRAIN_DATABASE_URL" "$ANTHROPIC_API_KEY" "$OPENAI_API_KEY"\n', 'utf-8');
    chmodSync(shim, 0o755);
    process.env.GROK_BIN = shim;
    process.env.GROK_HOME = '/tmp/gh-canary-test';
    // grok's documented headless auth path (docs/mcp/GROK-CLI-PIN.md): the
    // grok delta must forward it or env-key operators get "Not signed in"
    // blamed on the agent.
    process.env.XAI_API_KEY = 'xai-sentinel-3fa1';
    process.env.LEAK_CANARY = 'must-not-leak';
    process.env.GBRAIN_DATABASE_URL = 'postgres://must-not-leak';
    // Foreign provider keys: in BASE_ENV_ALLOWLIST (hermes needs them) but
    // deliberately filtered OUT of grok's list — a single-provider third-party
    // binary must never receive the operator's Anthropic/OpenAI credentials.
    process.env.ANTHROPIC_API_KEY = 'ant-must-not-leak';
    process.env.OPENAI_API_KEY = 'oai-must-not-leak';
    try {
      const { GrokRunner } = await import('../src/core/claw-test/runners/grok.ts');
      const chunks: Buffer[] = [];
      const result = await new GrokRunner().invoke({
        cwd: tmp,
        brief: 'BRIEF BODY sentinel-9e4d',
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
      // Version preamble recorded as a plain stdout transcript event.
      expect(stdout).toContain('[grok-runner preamble] version: grok 9.9.9 (shimhash)');
      // Pinned argv: single-shot flag, brief, then plain output format
      // (docs/mcp/GROK-CLI-PIN.md; permission flags deliberately absent
      // pending the authed observation).
      expect(stdout).toContain('ARGV:-p\nARGV:BRIEF BODY sentinel-9e4d\nARGV:--output-format\nARGV:plain');
      // Allowlist held: the grok delta passes; the canary and the
      // deliberately-delisted GBRAIN_DATABASE_URL don't.
      expect(stdout).toContain('GH:[/tmp/gh-canary-test]');
      expect(stdout).toContain('KEY:[xai-sentinel-3fa1]');
      expect(stdout).toContain('CANARY:[] DBURL:[] ANT:[] OAI:[]');
    } finally {
      for (const [k, v] of Object.entries(orig)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });
});

describe('GrokRunner vendor-config tripwire + preamble resilience (shim)', () => {
  async function invokeWithHome(home: string): Promise<{ warns: string[]; exitCode: number; stdout: string }> {
    const shim = join(tmp, 'grok-shim-tripwire');
    writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 1; fi\necho ok\n', 'utf-8');
    chmodSync(shim, 0o755);
    const origBin = process.env.GROK_BIN;
    process.env.GROK_BIN = shim;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (m: unknown) => { warns.push(String(m)); };
    try {
      const { GrokRunner } = await import('../src/core/claw-test/runners/grok.ts');
      const chunks: Buffer[] = [];
      const result = await new GrokRunner().invoke({
        cwd: tmp,
        brief: 'brief',
        env: { HOME: home },
        timeoutMs: 10_000,
        transcriptSink: {
          write: (e) => { if (e.channel === 'stdout') chunks.push(e.bytes); },
          nextOffset: () => 0,
          close: async () => {},
        },
      });
      return { warns, exitCode: result.exitCode, stdout: Buffer.concat(chunks).toString('utf-8') };
    } finally {
      console.warn = origWarn;
      if (origBin !== undefined) process.env.GROK_BIN = origBin;
      else delete process.env.GROK_BIN;
    }
  }

  test('warns loudly when ~/.claude.json registers mcpServers.gbrain (real-brain contamination channel)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-vendor-'));
    try {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: {} } }));
      const r = await invokeWithHome(home);
      expect(r.warns.some((w) => w.includes('REAL brain'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('stays silent without a gbrain vendor entry; a broken --version never fails the run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-vendor-'));
    try {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: {} } }));
      const r = await invokeWithHome(home);
      expect(r.warns.some((w) => w.includes('REAL brain'))).toBe(false);
      // The shim's --version exits 1 (preamble failure path): the run still
      // completes with the main turn's exit code and simply has no preamble.
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[grok-runner preamble]');
      expect(r.stdout).toContain('ok');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('flag-registry accepted over-inclusion — SAFETY_FLAGS collision guard', () => {
  test("no grok argv literal collides with the generator's SAFETY_FLAGS", async () => {
    // The claw-test registry entry absorbs grok's long-form argv literals by
    // design (prose-bleed over-inclusion is tolerated); what must NEVER
    // happen is one of them colliding with a SAFETY flag the generator
    // deliberately excludes from validity (a collision would make a safety
    // flag silently valid on claw-test).
    const { CLI_FLAG_REGISTRY } = await import('../src/core/cli-flag-registry.generated.ts');
    const clawFlags: readonly string[] = CLI_FLAG_REGISTRY['claw-test'] ?? [];
    expect(clawFlags.length).toBeGreaterThan(0);
    const SAFETY_FLAGS = ['--dry-run']; // mirrors scripts/generate-flag-registry.ts
    for (const f of SAFETY_FLAGS) {
      expect(clawFlags).not.toContain(f);
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

describe('OpencodeRunner detection (reliable on box without opencode)', () => {
  test('detect returns the contract shape when OPENCODE_BIN unset', async () => {
    const orig = process.env.OPENCODE_BIN;
    delete process.env.OPENCODE_BIN;
    try {
      const { OpencodeRunner } = await import('../src/core/claw-test/runners/opencode.ts');
      const d = await new OpencodeRunner().detect();
      expect(typeof d.available).toBe('boolean');
      if (!d.available) expect(typeof d.reason).toBe('string');
      else expect(d.binPath?.startsWith('/')).toBe(true);
    } finally {
      if (orig !== undefined) process.env.OPENCODE_BIN = orig;
    }
  });

  test('detect rejects relative / ..-segment / metachar OPENCODE_BIN (through-runner injection pin)', async () => {
    const orig = process.env.OPENCODE_BIN;
    const { OpencodeRunner } = await import('../src/core/claw-test/runners/opencode.ts');
    try {
      process.env.OPENCODE_BIN = 'relative/opencode';
      expect((await new OpencodeRunner().detect()).reason).toMatch(/OPENCODE_BIN must be absolute/);
      process.env.OPENCODE_BIN = '/tmp/foo/../opencode';
      expect((await new OpencodeRunner().detect()).reason).toMatch(/'\.\.' segments/);
      process.env.OPENCODE_BIN = '/tmp/open"code';
      expect((await new OpencodeRunner().detect()).reason).toMatch(/quotes, backslashes, dollar signs/);
    } finally {
      if (orig !== undefined) process.env.OPENCODE_BIN = orig;
      else delete process.env.OPENCODE_BIN;
    }
  });
});

describe('OpencodeRunner invoke argv/env (shim — no opencode binary needed)', () => {
  test('argv is the pinned run shape; multi-provider keys + XDG dirs propagate; unlisted env does not', async () => {
    const orig = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE,
      OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      XAI_API_KEY: process.env.XAI_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      LEAK_CANARY: process.env.LEAK_CANARY,
      GBRAIN_DATABASE_URL: process.env.GBRAIN_DATABASE_URL,
    };
    const shim = join(tmp, 'opencode-shim');
    // The runner first execs the shim with --version (transcript preamble),
    // then spawns the real turn — the shim answers both. Bare-semver output
    // mirrors the SST CLI's real shape.
    writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi\nprintf "ARGV:%s\\n" "$@"\nprintf "XDGC:[%s] XDGD:[%s] AUP:[%s] INLINE:[%s] ANT:[%s] XAI:[%s] GGL:[%s] OR:[%s] CANARY:[%s] DBURL:[%s]\\n" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$OPENCODE_DISABLE_AUTOUPDATE" "$OPENCODE_CONFIG_CONTENT" "$ANTHROPIC_API_KEY" "$XAI_API_KEY" "$GOOGLE_GENERATIVE_AI_API_KEY" "$OPENROUTER_API_KEY" "$LEAK_CANARY" "$GBRAIN_DATABASE_URL"\n', 'utf-8');
    chmodSync(shim, 0o755);
    process.env.OPENCODE_BIN = shim;
    process.env.XDG_CONFIG_HOME = '/tmp/xdgc-canary';
    process.env.XDG_DATA_HOME = '/tmp/xdgd-canary';
    process.env.OPENCODE_DISABLE_AUTOUPDATE = '1';
    // The config-shadowing channel: deliberately NOT in the allowlist.
    process.env.OPENCODE_CONFIG_CONTENT = '{"mcp":{}}';
    // Multi-provider: opencode's headline feature — BASE carries only
    // Anthropic+OpenAI; the delta must name the rest (EV6) or a live-lane
    // operator on xai/google/openrouter models sees a misleading auth failure.
    process.env.ANTHROPIC_API_KEY = 'ant-sentinel-77aa';
    process.env.XAI_API_KEY = 'xai-sentinel-77bb';
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'ggl-sentinel-77cc';
    process.env.OPENROUTER_API_KEY = 'or-sentinel-77dd';
    process.env.LEAK_CANARY = 'must-not-leak';
    process.env.GBRAIN_DATABASE_URL = 'postgres://must-not-leak';
    try {
      const { OpencodeRunner } = await import('../src/core/claw-test/runners/opencode.ts');
      const chunks: Buffer[] = [];
      const result = await new OpencodeRunner().invoke({
        cwd: tmp,
        brief: 'BRIEF BODY sentinel-4c2f',
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
      expect(stdout).toContain('[opencode-runner preamble] version: 9.9.9');
      // Pinned argv: run + brief + explicit default format (an upstream
      // default flip must not silently change the transcript shape); no
      // --auto (MCP tools fire without it — OPENCODE-CLI-PIN.md §One-shot).
      expect(stdout).toContain('ARGV:run\nARGV:BRIEF BODY sentinel-4c2f\nARGV:--format\nARGV:default');
      expect(stdout).not.toContain('ARGV:--auto');
      // Allowlist held: XDG + autoupdate kill + all four provider deltas
      // pass; the inline-config shadow channel, the canary, and the
      // deliberately-delisted GBRAIN_DATABASE_URL do not.
      expect(stdout).toContain('XDGC:[/tmp/xdgc-canary]');
      expect(stdout).toContain('XDGD:[/tmp/xdgd-canary]');
      expect(stdout).toContain('AUP:[1]');
      expect(stdout).toContain('ANT:[ant-sentinel-77aa]');
      expect(stdout).toContain('XAI:[xai-sentinel-77bb]');
      expect(stdout).toContain('GGL:[ggl-sentinel-77cc]');
      expect(stdout).toContain('OR:[or-sentinel-77dd]');
      expect(stdout).toContain('INLINE:[] ');
      expect(stdout).toContain('CANARY:[] DBURL:[]');
    } finally {
      for (const [k, v] of Object.entries(orig)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });
});

describe('OpencodeRunner global-config tripwire + preamble resilience (shim)', () => {
  async function invokeWithXdg(xdgConfig: string): Promise<{ warns: string[]; exitCode: number; stdout: string }> {
    const shim = join(tmp, 'opencode-shim-tripwire');
    writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 1; fi\necho ok\n', 'utf-8');
    chmodSync(shim, 0o755);
    const origBin = process.env.OPENCODE_BIN;
    process.env.OPENCODE_BIN = shim;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (m: unknown) => { warns.push(String(m)); };
    try {
      const { OpencodeRunner } = await import('../src/core/claw-test/runners/opencode.ts');
      const chunks: Buffer[] = [];
      const result = await new OpencodeRunner().invoke({
        cwd: tmp,
        brief: 'brief',
        env: { XDG_CONFIG_HOME: xdgConfig },
        timeoutMs: 10_000,
        transcriptSink: {
          write: (e) => { if (e.channel === 'stdout') chunks.push(e.bytes); },
          nextOffset: () => 0,
          close: async () => {},
        },
      });
      return { warns, exitCode: result.exitCode, stdout: Buffer.concat(chunks).toString('utf-8') };
    } finally {
      console.warn = origWarn;
      if (origBin !== undefined) process.env.OPENCODE_BIN = origBin;
      else delete process.env.OPENCODE_BIN;
    }
  }

  test('warns loudly when the global config carries mcp.gbrain (checks BOTH merged filenames, JSONC-tolerant)', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'opencode-vendor-'));
    try {
      mkdirSync(join(xdg, 'opencode'), { recursive: true });
      // .jsonc name + a comment: the tripwire must not require strict JSON.
      writeFileSync(
        join(xdg, 'opencode', 'opencode.jsonc'),
        '{\n  // operator config\n  "mcp": { "gbrain": { "type": "local", "command": ["gbrain", "serve"] } }\n}\n',
      );
      const r = await invokeWithXdg(xdg);
      expect(r.warns.some((w) => w.includes("OPERATOR'S REAL"))).toBe(true);
      // A failing --version preamble never fails the run.
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('ok');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test('no warning for a gbrain-free global config', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'opencode-clean-'));
    try {
      mkdirSync(join(xdg, 'opencode'), { recursive: true });
      writeFileSync(join(xdg, 'opencode', 'opencode.json'), '{"mcp":{"other":{"type":"remote","url":"https://x/mcp"}}}');
      const r = await invokeWithXdg(xdg);
      expect(r.warns.length).toBe(0);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});
