/**
 * bootstrap status — phase list [D5], install log [B1], runbook skew [C1],
 * support blob [B5], and the CLI reachability membership asserts (#2035
 * precedent, extended per ENG-2 for the bootstrap family).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBootstrap } from '../src/commands/bootstrap.ts';

import { CLI_ONLY, THIN_CLIENT_REFUSED_COMMANDS } from '../src/cli.ts';
import { VERSION } from '../src/version.ts';
import {
  BOOTSTRAP_PHASE_IDS,
  PHASES,
  appendInstallLog,
  readInstallLog,
  installLogPath,
  readRunbookStamp,
  listVerifyRuns,
  statusReport,
} from '../src/core/bootstrap/status.ts';
import { initState, setAnswer, confirm, readBackHash } from '../src/core/bootstrap/interview.ts';
import { writeManifest } from '../src/core/bootstrap/format.ts';
import { loadQuestionBank } from '../src/core/bootstrap/assets.ts';

let tmpParent: string; // GBRAIN_HOME parent (configDir appends .gbrain)
let home: string;
let ws: string;
let prevHome: string | undefined;

beforeAll(() => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-status-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  ws = mkdtempSync(join(tmpdir(), 'gb-status-ws-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpParent;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('phase list is the single TS source of truth [D5]', () => {
  test('PHASES matches BOOTSTRAP_PHASE_IDS exactly, in order', () => {
    expect(PHASES.map((p) => p.id)).toEqual([...BOOTSTRAP_PHASE_IDS]);
    expect(BOOTSTRAP_PHASE_IDS).toEqual([
      'preflight', 'engine', 'interview', 'render', 'skills', 'wire', 'repo', 'verify',
    ]);
  });

  test('every phase carries a title, a resume hint, and a detector', () => {
    for (const p of PHASES) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.resume_hint.length).toBeGreaterThan(0);
      expect(typeof p.detect).toBe('function');
    }
  });

  test('wire hint carries the harness scope rule (Claude Code + opencode consent vs Codex user-global)', () => {
    const wire = PHASES.find((p) => p.id === 'wire');
    expect(wire?.resume_hint).toContain('MCP scope consent applies on Claude Code and opencode');
    expect(wire?.resume_hint).toContain('opencode defaults to user-global');
    expect(wire?.resume_hint).toContain('Codex registrations are always user-global (no scope flag)');
  });
});

describe('CLI reachability membership (#2035 shape, ENG-2)', () => {
  test('bootstrap, hook, and sweep are in CLI_ONLY so dispatch reaches them', () => {
    expect(CLI_ONLY.has('bootstrap')).toBe(true);
    expect(CLI_ONLY.has('hook')).toBe(true);
    expect(CLI_ONLY.has('sweep')).toBe(true);
  });

  test('bootstrap and hook are NOT thin-client refused; sweep IS (local engine only)', () => {
    expect(THIN_CLIENT_REFUSED_COMMANDS.has('bootstrap')).toBe(false);
    expect(THIN_CLIENT_REFUSED_COMMANDS.has('hook')).toBe(false);
    expect(THIN_CLIENT_REFUSED_COMMANDS.has('sweep')).toBe(true);
  });
});

describe('install log [B1]', () => {
  test('append + read round-trip, torn lines skipped, never throws', () => {
    appendInstallLog(home, {
      ts: new Date().toISOString(),
      phase: 'render',
      outcome: 'ok',
      duration_ms: 12,
      binary_version: VERSION,
      workspace: ws,
    });
    // Torn line in the middle must not break the reader.
    writeFileSync(installLogPath(home), '{"half\n', { flag: 'a' });
    appendInstallLog(home, {
      ts: new Date().toISOString(),
      phase: 'wire',
      outcome: 'error',
      duration_ms: 5,
      binary_version: VERSION,
      harness: 'claude-code',
      workspace: ws,
    });
    const entries = readInstallLog(home);
    expect(entries.length).toBe(2);
    expect(entries[0].phase).toBe('render');
    expect(entries[1].phase).toBe('wire');
    expect(entries[1].harness).toBe('claude-code');
  });

  test('reader returns [] for a missing log', () => {
    expect(readInstallLog(join(tmpdir(), 'no-such-gbrain-home'))).toEqual([]);
  });
});

describe('runbook stamp [C1]', () => {
  test('reads the stamp comment; null when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-runbook-'));
    expect(readRunbookStamp(dir)).toBeNull();
    writeFileSync(join(dir, 'BOOTSTRAP_FOR_AGENTS.md'), '<!-- gbrain-runbook-stamp: 0.0.1 -->\n# runbook\n');
    expect(readRunbookStamp(dir)).toBe('0.0.1');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('statusReport detection + support blob [B5]', () => {
  test('fresh workspace: engine/interview/render/verify pending, next action present', async () => {
    const report = await statusReport(ws, { gbrainHomeDir: home });
    const byId = new Map(report.phases.map((p) => [p.id, p]));
    expect(byId.get('engine')!.state).toBe('pending');
    expect(byId.get('interview')!.state).toBe('pending');
    expect(byId.get('render')!.state).toBe('pending');
    expect(byId.get('verify')!.state).toBe('pending');
    expect(report.next).toBeTruthy();
    // The third axis [D-cloud]: installing agents branch on this field.
    expect(['local', 'cloud-sandbox', 'ephemeral-container']).toContain(report.execution_environment);
    expect(report.support.binary_version).toBe(VERSION);
    expect(report.support.engine).toBeNull();
    expect(report.support.harness_registrations).toEqual([]);
  });

  test('artifacts flip phases: config → engine done; confirmed interview → done; manifest → render done', async () => {
    // engine: config file in the sandboxed home.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));

    // interview: answer every required key, then confirm the read-back hash.
    const bank = loadQuestionBank();
    const required = bank.interviewKeys.filter((k) => bank.questions[k]?.required === true);
    expect(initState(ws).ok).toBe(true);
    for (const key of required) {
      const r = setAnswer(ws, key, `verbatim answer for ${key} with enough substance to be real`);
      expect(r.ok).toBe(true);
    }
    const h = readBackHash(ws);
    if (!h.ok) throw new Error('readBackHash failed');
    expect(confirm(ws, h.hash).ok).toBe(true);

    // render: initialized manifest.
    writeManifest(ws, {
      format_version: 1,
      initialized: true,
      agent_name: 'Testy',
      created_by: 'test',
      created_at: new Date().toISOString(),
      source_id: 'workspace',
    });

    // verify: one persisted failing snapshot → verify phase partial.
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(
      join(home, 'bootstrap', 'verify-2026-01-01T00-00-00-000Z.json'),
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ok: false, checks: [{ id: 'roundtrip', ok: false, detail: 'x' }] }),
    );

    const report = await statusReport(ws, { gbrainHomeDir: home });
    const byId = new Map(report.phases.map((p) => [p.id, p]));
    expect(byId.get('engine')!.state).toBe('done');
    expect(byId.get('interview')!.state).toBe('done');
    expect(byId.get('render')!.state).toBe('done');
    expect(byId.get('verify')!.state).toBe('partial');
    expect(report.support.engine).toBe('pglite');
    expect(report.support.last_verify).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      ok: false,
      checks_failed: ['roundtrip'],
    });
    // listVerifyRuns agrees with the support blob.
    const runs = listVerifyRuns(home);
    expect(runs.length).toBe(1);
    expect(runs[0].ok).toBe(false);
  });

  test('runbook skew surfaces when the stamp disagrees with the binary', async () => {
    writeFileSync(join(ws, 'BOOTSTRAP_FOR_AGENTS.md'), '<!-- gbrain-runbook-stamp: 0.0.1 -->\n');
    const report = await statusReport(ws, { gbrainHomeDir: home });
    expect(report.runbookSkew).toEqual({ runbookStamp: '0.0.1', binaryVersion: VERSION });

    // Matching stamp → no skew reported.
    writeFileSync(join(ws, 'BOOTSTRAP_FOR_AGENTS.md'), `<!-- gbrain-runbook-stamp: ${VERSION} -->\n`);
    const clean = await statusReport(ws, { gbrainHomeDir: home });
    expect(clean.runbookSkew).toBeUndefined();
  });
});

describe('template-door privacy gate (recording gh shim)', () => {
  let tws: string; // template-clone workspace with an origin remote
  let shimDir: string;
  let recordFile: string;
  let savedPath: string | undefined;
  let savedRecord: string | undefined;

  beforeAll(() => {
    tws = mkdtempSync(join(tmpdir(), 'gb-status-tmpl-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tws });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/tester/agent-template.git'], { cwd: tws });
    // Uninitialized template clone — the gate's trigger state [CX2-1].
    writeManifest(tws, {
      format_version: 1,
      initialized: false,
      agent_name: '{{AGENT_NAME}}',
      created_by: 'template',
      created_at: '1970-01-01T00:00:00.000Z',
      source_id: 'workspace',
    });

    shimDir = mkdtempSync(join(tmpdir(), 'gb-status-shim-'));
    recordFile = join(shimDir, 'record.log');
    savedPath = process.env.PATH;
    savedRecord = process.env.GB_FAKE_RECORD;
    process.env.GB_FAKE_RECORD = recordFile;
    // Recording gh shim: answer comes from the GB_FAKE_GH_ANSWER env var.
    writeFileSync(
      join(shimDir, 'gh'),
      `#!/bin/sh
echo "gh $*" >> "$GB_FAKE_RECORD"
case "$GB_FAKE_GH_ANSWER" in
  private) echo "true"; exit 0 ;;
  public) echo "false"; exit 0 ;;
  *) echo "auth error" >&2; exit 4 ;;
esac
`,
    );
    chmodSync(join(shimDir, 'gh'), 0o755);
    process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
  });

  afterAll(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedRecord === undefined) delete process.env.GB_FAKE_RECORD;
    else process.env.GB_FAKE_RECORD = savedRecord;
    delete process.env.GB_FAKE_GH_ANSWER;
    rmSync(tws, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });

  async function captureStatus(): Promise<{ code: number; out: string; err: string }> {
    const origLog = console.log;
    const origErr = console.error;
    let out = '';
    let err = '';
    console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
    console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
    try {
      const code = await runBootstrap(['status', '--workspace', tws]);
      return { code, out, err };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  test('PUBLIC origin on a template clone → hard fail (exit 1, agent-readable fix)', async () => {
    process.env.GB_FAKE_GH_ANSWER = 'public';
    const report = await statusReport(tws, { gbrainHomeDir: home });
    expect(report.privacy_gate).toEqual({
      verdict: 'public',
      origin: 'https://github.com/tester/agent-template.git',
      detail: expect.stringContaining('PUBLIC'),
    });
    // The probe went through REST (`gh api repos/...`), NEVER `gh repo view`
    // — that command rides GraphQL, which cloud sandbox proxies always 403.
    const recorded = readFileSync(recordFile, 'utf8');
    expect(recorded).toContain('gh api repos/tester/agent-template --jq .private');
    expect(recorded).not.toContain('repo view');

    const r = await captureStatus();
    expect(r.code).toBe(1);
    expect(r.err).toContain('PUBLIC');
    expect(r.err).toContain('private');
  });

  test('[FIX6] `bootstrap render` refuses a PUBLIC origin BEFORE writing identity files', async () => {
    process.env.GB_FAKE_GH_ANSWER = 'public';
    // Precondition: no identity file has been rendered yet.
    expect(existsSync(join(tws, 'SOUL.md'))).toBe(false);

    const origLog = console.log;
    const origErr = console.error;
    let out = '';
    let err = '';
    console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
    console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
    let code: number;
    try {
      code = await runBootstrap(['render', '--workspace', tws]);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    void out;
    expect(code).toBe(1);
    expect(err).toContain('render refused');
    expect(err).toContain('PUBLIC');
    expect(err).toContain('private');
    // Refused BEFORE any identity file was written.
    expect(existsSync(join(tws, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(tws, 'USER.md'))).toBe(false);
  });

  test('PRIVATE origin → no gate, exit 0', async () => {
    process.env.GB_FAKE_GH_ANSWER = 'private';
    const report = await statusReport(tws, { gbrainHomeDir: home });
    expect(report.privacy_gate).toBeUndefined();
    const r = await captureStatus();
    expect(r.code).toBe(0);
  });

  test('gh unavailable/offline → loud warning, NOT a fail', async () => {
    delete process.env.GB_FAKE_GH_ANSWER; // shim exits 4 (auth error / offline shape)
    const report = await statusReport(tws, { gbrainHomeDir: home });
    expect(report.privacy_gate?.verdict).toBe('unknown');
    const r = await captureStatus();
    expect(r.code).toBe(0);
    expect(r.err).toContain('WARNING');
    expect(r.err).toContain('visibility');
  });

  test('initialized workspace never trips the template-door gate', async () => {
    process.env.GB_FAKE_GH_ANSWER = 'public';
    // ws (outer fixture) is initialized by the earlier detection test and has
    // no origin anyway; flip tws to initialized to isolate the discriminator.
    writeManifest(tws, {
      format_version: 1,
      initialized: true,
      agent_name: 'Testy',
      created_by: 'test',
      created_at: new Date().toISOString(),
      source_id: 'workspace',
    });
    try {
      const report = await statusReport(tws, { gbrainHomeDir: home });
      expect(report.privacy_gate).toBeUndefined();
    } finally {
      writeManifest(tws, {
        format_version: 1,
        initialized: false,
        agent_name: '{{AGENT_NAME}}',
        created_by: 'template',
        created_at: '1970-01-01T00:00:00.000Z',
        source_id: 'workspace',
      });
    }
  });
});
