/**
 * Degraded-modes e2e [ENG-tests-2]: the decline-everything install must
 * complete HONESTLY — local-only, keyless, hooks declined — with every
 * degradation named and nothing silently broken.
 *
 *   (a) decline-everything: gh missing from the env-pinned fake runner
 *       (GH_MISSING exit 2 from the repo phase is EXPECTED + resumable),
 *       HOOKS_CONSENT=no, zero provider keys → interview + render + verify
 *       still complete; verify exits 0-with-warnings; the capability report
 *       says keyless; the no-repo and hooks-declined degradations are named
 *       in the check details.
 *   (b) keyless magic-moment THROUGH THE DISPATCHER: `runBootstrap(['verify',
 *       '--json'])` end-to-end keyless against a real temp PGLite engine,
 *       exit 0.
 *
 * Serial: sandboxed GBRAIN_HOME + provider-key env strip across the file.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBootstrap } from '../../src/commands/bootstrap.ts';
import type { ExecRunner } from '../../src/core/bootstrap/repo.ts';
import { readManifest, readReceipt } from '../../src/core/bootstrap/format.ts';
import { readBackHash } from '../../src/core/bootstrap/interview.ts';
import { readInstallLog, statusReport } from '../../src/core/bootstrap/status.ts';
import type { VerifyCheck } from '../../src/core/bootstrap/verify.ts';
import type { CapabilityReport } from '../../src/core/capability.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_BOOTSTRAP_ABORT_AFTER',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_CI',
  // Provider keys — keyless mode means detectCapabilities finds NOTHING
  // (mergedEnv folds these names; GEMINI_API_KEY aliases the google key).
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY',
  'OPENROUTER_API_KEY', 'DASHSCOPE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY',
];

const ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Hermit',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

let tmpParent: string;
let home: string;
let dbDir: string;
let ws: string;

/** Env-pinned fake runner: NO gh anywhere (spawn-not-found ⇒ 127, the code
 * defaultRunner returns for a missing binary); claude is a canned recorder;
 * everything else (git) runs for real with the CURRENT env pinned. */
const recorded: string[][] = [];
const ghLessRunner: ExecRunner = async (argv: string[]) => {
  if (argv[0] === 'gh') {
    return { code: 127, stdout: '', stderr: 'spawn gh ENOENT (fake PATH: gh not installed)' };
  }
  if (argv[0] === 'claude') {
    recorded.push([...argv]);
    if (argv[1] === 'mcp' && argv[2] === 'list') return { code: 0, stdout: 'gbrain: stdio serve', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
  try {
    const proc = Bun.spawn(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env } as Record<string, string>,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message };
  }
};

async function captureStd<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => { out += args.map(String).join(' ') + '\n'; };
  console.error = (...args: unknown[]) => { err += args.map(String).join(' ') + '\n'; };
  try {
    const result = await fn();
    return { result, out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  tmpParent = mkdtempSync(join(tmpdir(), 'gb-deg-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  dbDir = join(tmpParent, 'db');
  process.env.GBRAIN_HOME = tmpParent;

  // Engine phase artifact — a keyless `gbrain init --pglite` config (no
  // provider keys anywhere in the file plane either).
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbDir }, null, 2),
  );

  ws = mkdtempSync(join(tmpdir(), 'gb-deg-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws });
  mkdirSync(join(ws, 'brain'), { recursive: true });
}, 60_000);

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  for (const dir of [tmpParent, ws]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('bootstrap degraded modes (decline-everything + keyless, serial e2e)', () => {
  test('interview (hooks declined, no cron) + confirmed render complete normally', async () => {
    expect((await captureStd(() => runBootstrap(['interview', '--init', '--workspace', ws]))).result).toBe(0);
    for (const [key, value] of Object.entries(ANSWERS)) {
      expect((await captureStd(() => runBootstrap(['interview', '--set', key, value, '--workspace', ws]))).result).toBe(0);
    }
    for (const [key, value] of [
      ['MCP_SCOPE', 'project'],
      ['HOOKS_CONSENT', 'no'],
      ['PERSIST_CRON', 'no'],
    ] as const) {
      expect((await captureStd(() => runBootstrap(['interview', '--set', key, value, '--workspace', ws]))).result).toBe(0);
    }
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    expect((await captureStd(() => runBootstrap(['interview', '--confirm', h.hash, '--workspace', ws]))).result).toBe(0);

    expect((await captureStd(() => runBootstrap(['render', '--workspace', ws]))).result).toBe(0);
    expect(readManifest(ws).state).toBe('initialized');
  }, 60_000);

  test('repo phase without gh: GH_MISSING exit 2, agent-readable, resumable (status still points at the pending phase)', async () => {
    const { result: code, err } = await captureStd(() => runBootstrap(['repo', '--workspace', ws], { runner: ghLessRunner }));
    expect(code).toBe(2); // the install-gh-and-re-run semantics, not a crash
    expect(err).toContain('gh');
    expect(err).toContain('re-run');

    // [B1] The failure is on the record, not swallowed.
    const entries = readInstallLog(home).filter((e) => e.workspace === ws && e.phase === 'repo');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1].outcome).toBe('error');

    // Resumable: the workspace is untouched (no origin), the phase reads
    // pending, and a re-run refuses identically instead of corrupting state.
    const report = await statusReport(ws, { gbrainHomeDir: home });
    const repoPhase = report.phases.find((p) => p.id === 'repo')!;
    expect(repoPhase.state).toBe('pending');
    const again = await captureStd(() => runBootstrap(['repo', '--workspace', ws], { runner: ghLessRunner }));
    expect(again.result).toBe(2);
  }, 60_000);

  test('hooks phase with HOOKS_CONSENT=no: MCP registers, hooks are NOT written, the pull protocol is stated plainly', async () => {
    const fakeBin = join(tmpParent, 'gbrain');
    writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
    const { result: code, out } = await captureStd(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', fakeBin], {
        runner: ghLessRunner,
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain('hooks declined');
    expect(out).toContain('pull protocol');
    // Declined consent means NO settings file — the absence IS the contract.
    expect(existsSync(join(ws, '.claude', 'settings.local.json'))).toBe(false);
    // But MCP registration still happened (keyless ≠ toolless).
    const flat = recorded.map((argv) => argv.join(' '));
    expect(flat.some((c) => c.startsWith('claude mcp add gbrain') && c.includes('GBRAIN_SOURCE=workspace'))).toBe(true);
    const receipt = readReceipt(home);
    expect(receipt!.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp' }]);
  }, 60_000);

  test('verify THROUGH THE DISPATCHER, fully keyless: exit 0-with-warnings, capability says keyless, every degradation named', async () => {
    // Pre-init the brain the way `gbrain init --pglite` + `sources add` would.
    const engineConfig = { engine: 'pglite' as const, database_path: dbDir };
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    await engine.initSchema();
    await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
    await engine.disconnect();

    const { result: code, out } = await captureStd(() => runBootstrap(['verify', '--workspace', ws, '--json']));
    expect(code).toBe(0); // (b) the full dispatcher path, end-to-end keyless

    const payload = JSON.parse(out) as {
      ok: boolean;
      checks: VerifyCheck[];
      capability: CapabilityReport;
      tour: string[];
    };
    expect(payload.ok).toBe(true);
    // Keyless capability report — zero provider keys anywhere.
    expect(payload.capability.mode).toBe('keyless');
    expect(payload.capability.search).toBe('keyword-only');

    const byId = (id: string) => payload.checks.filter((c) => c.id === id);
    // The keyless magic moment (agent-authored fence fact → BM25 recall).
    expect(byId('magic_moment')[0].ok).toBe(true);
    expect(byId('magic_moment')[0].detail).toContain('keyless path: yes');
    for (const c of byId('roundtrip')) expect(c.ok).toBe(true);
    expect(byId('capability_report')[0].detail).toContain('keyless');

    // Degradations NAMED, not silent:
    //  - hooks declined → the smoke says so instead of pretending to run;
    expect(byId('hooks_smoke')[0].ok).toBe(true);
    expect(byId('hooks_smoke')[0].detail).toContain('not applicable');
    //  - no repo → repo_privacy + push_probe say local-only, in words.
    expect(byId('repo_privacy')[0].ok).toBe(true);
    expect(byId('repo_privacy')[0].detail).toContain('local-only');
    expect(byId('push_probe')[0].ok).toBe(true);
    expect(byId('push_probe')[0].detail).toContain('local-only');

    // 0-with-warnings discipline: any non-ok check must be an explicit warn,
    // and EVERY check carries a non-empty human-readable detail.
    for (const c of payload.checks) {
      expect(c.ok || c.warn === true).toBe(true);
      expect(c.detail.length).toBeGreaterThan(0);
    }
    expect(payload.tour.length).toBe(3);

    // The verify snapshot flips the status phase — the resume loop closes.
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.phases.find((p) => p.id === 'verify')!.state).toBe('done');
  }, 300_000);
});

// ── cloud-sandbox simulation [D-cloud] ──────────────────────────────────────
//
// CLAUDE_CODE_REMOTE=true is the official cloud signal. This block pins the
// three cloud behaviors end-to-end through the real dispatcher: the status
// report names the environment, verify's execution_env check states the
// degradations, and repo creation refuses fast with the attach flow.

describe('cloud-sandbox simulation (CLAUDE_CODE_REMOTE=true)', () => {
  const K = 'CLAUDE_CODE_REMOTE';
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[K];
    process.env[K] = 'true';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[K];
    else process.env[K] = saved;
  });

  test('status --json reports execution_environment: cloud-sandbox', async () => {
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.execution_environment).toBe('cloud-sandbox');
  });

  test('repo phase refuses creation with the attach flow (no half-created unpushable repo)', async () => {
    // Fake runner: gh + auth fine, no origin — the CREATE path would begin.
    const runner: ExecRunner = async (argv) => {
      const joined = argv.join(' ');
      if (joined.includes('gh --version') || joined.includes('auth status')) return { code: 0, stdout: 'ok', stderr: '' };
      if (joined.includes('remote get-url origin')) return { code: 2, stdout: '', stderr: 'error: No such remote' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const origErr = console.error;
    let err = '';
    console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
    try {
      const code = await runBootstrap(['repo', '--workspace', ws], { runner });
      expect(code).toBe(2);
      expect(err).toContain('cloud sandbox');
      expect(err).toContain('gbrain bootstrap attach');
    } finally {
      console.error = origErr;
    }
  }, 60_000);
});
