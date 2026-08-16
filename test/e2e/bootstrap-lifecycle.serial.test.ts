/**
 * bootstrap lifecycle e2e [A7]: temp workspace + sandboxed GBRAIN_HOME +
 * PATH-shimmed fake gh/claude (argv recorders) driving the REAL dispatcher:
 *
 *   status (subprocess CLI smoke) → interview (scripted answers, read-back
 *   hash, dispatcher render gate) → render → hooks (consents from answers)
 *   → repo (fake gh, privacy verified) → verify (real PGLite engine,
 *   keyless) → idempotent re-runs → GBRAIN_BOOTSTRAP_ABORT_AFTER kill-mid-
 *   phase → status resumes → lock collision refusal.
 *
 * Serial: PGLite cold starts + a bun subprocess spawn would starve parallel
 * siblings. Every test carries an explicit timeout.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runBootstrap } from '../../src/commands/bootstrap.ts';
import type { ExecRunner } from '../../src/core/bootstrap/repo.ts';
import { readManifest, readReceipt } from '../../src/core/bootstrap/format.ts';
import { initState, setAnswer, confirm, readBackHash } from '../../src/core/bootstrap/interview.ts';
import { acquireBootstrapLock } from '../../src/core/bootstrap/lock.ts';
import { statusReport, readInstallLog, BOOTSTRAP_PHASE_IDS } from '../../src/core/bootstrap/status.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');

let tmpParent: string; // GBRAIN_HOME parent (short prefix — unix socket path budget)
let home: string;
let dbDir: string;
let ws: string;
let shimDir: string;
let recordFile: string;

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'GBRAIN_HOME', 'PATH', 'GB_FAKE_RECORD', 'GBRAIN_DATABASE_URL', 'DATABASE_URL',
  'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_BOOTSTRAP_ABORT_AFTER',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_CI',
];

const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Lifeboat',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

function record(): string {
  try {
    return readFileSync(recordFile, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Env-pinned exec runner. Bun.spawn WITHOUT an explicit env uses Bun's
 * STARTUP env snapshot — the shimmed PATH / GB_FAKE_RECORD mutated in
 * beforeAll would be invisible and the test would exec the REAL gh/claude
 * (verified the hard way). Every runBootstrap call that spawns goes through
 * this runner seam.
 */
const testRunner: ExecRunner = async (argv: string[]) => {
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

/** Capture console.log output (stdout data) around an async call. */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const orig = console.log;
  let out = '';
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(' ') + '\n';
  };
  try {
    const result = await fn();
    return { result, out };
  } finally {
    console.log = orig;
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // Ambient-state strip (the install-gbrain.mjs guard, plan resolved D2):
  // a dev/CI DATABASE_URL must not flip the sandboxed brain to Postgres.
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_BRAIN_ID;
  delete process.env.GBRAIN_SOURCE;
  delete process.env.GBRAIN_HOOKS;
  delete process.env.GBRAIN_BOOTSTRAP_ABORT_AFTER;
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CODEX_CI;

  // Short prefix: the IPC socket lives under database_path and unix socket
  // paths cap out around 104 bytes on macOS.
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-e2e-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  dbDir = join(tmpParent, 'db');
  process.env.GBRAIN_HOME = tmpParent;

  // Engine phase artifact: the config `gbrain init --pglite` would write.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbDir }, null, 2));

  // Workspace: a fresh git repo (the cwd the human pasted in).
  ws = mkdtempSync(join(tmpdir(), 'gb-e2e-ws-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws });
  mkdirSync(join(ws, 'brain'), { recursive: true });

  // PATH shims: fake gh + fake claude, both recording argv [A7].
  shimDir = mkdtempSync(join(tmpdir(), 'gb-e2e-bin-'));
  recordFile = join(shimDir, 'record.log');
  process.env.GB_FAKE_RECORD = recordFile;

  writeFileSync(
    join(shimDir, 'gh'),
    `#!/bin/sh
echo "gh $*" >> "$GB_FAKE_RECORD"
case "$1" in
  --version) echo "gh version 2.40.0"; exit 0 ;;
  auth) exit 0 ;;
  api)
    case "$2" in
      user) echo '{"login":"tester","id":42}'; exit 0 ;;
      repos/*) echo "true"; exit 0 ;;
    esac
    exit 1 ;;
  repo)
    case "$2" in
      view)
        case "$*" in
          *--json*) echo "true"; exit 0 ;;
        esac
        exit 1 ;;
      create)
        name="$3"
        src=""
        prev=""
        for a in "$@"; do
          if [ "$prev" = "--source" ]; then src="$a"; fi
          prev="$a"
        done
        if [ -n "$src" ]; then
          git -C "$src" remote add origin "https://github.com/tester/$name.git" >/dev/null 2>&1 || true
        fi
        exit 0 ;;
    esac
    exit 1 ;;
esac
exit 0
`,
  );
  chmodSync(join(shimDir, 'gh'), 0o755);

  writeFileSync(
    join(shimDir, 'claude'),
    `#!/bin/sh
echo "claude $*" >> "$GB_FAKE_RECORD"
case "$1 $2" in
  "mcp add") exit 0 ;;
  "mcp list") echo "gbrain: stdio serve"; exit 0 ;;
  "mcp remove") exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(join(shimDir, 'claude'), 0o755);

  // STATEFUL codex shim: `mcp add` records the exact command+env line, `mcp
  // get` echoes it back, `mcp list`/`remove` reflect real state. This is what
  // lets verifyMcpTargetsWorkspace ([FIX7]) actually pass/fail — an inert shim
  // that always printed "gbrain" made the mismatch detector unfalsifiable.
  // State lives next to the argv record so it's cleaned up with shimDir.
  writeFileSync(
    join(shimDir, 'codex'),
    `#!/bin/sh
echo "codex $*" >> "$GB_FAKE_RECORD"
STATE="$(dirname "$GB_FAKE_RECORD")/codex-mcp.state"
case "$1 $2" in
  "mcp add") printf '%s\\n' "$*" > "$STATE"; exit 0 ;;
  "mcp get")
    [ -f "$STATE" ] || { echo "no such MCP server: $3" >&2; exit 1; }
    cat "$STATE"; exit 0 ;;
  "mcp list") [ -f "$STATE" ] && echo "gbrain: stdio serve"; exit 0 ;;
  "mcp remove") rm -f "$STATE"; exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(join(shimDir, 'codex'), 0o755);

  // A dummy absolute gbrain binary for registrations/hook command strings
  // (never executed by this test — hooks fire in-process).
  writeFileSync(join(shimDir, 'gbrain'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(shimDir, 'gbrain'), 0o755);

  // git shim: intercept `push` (recorded, succeeds — the fake origin is an
  // https URL no real push could reach) and `ls-remote` (reports the branch
  // exists, so the FIX3 adoption re-run sees a genuinely-pushed remote instead
  // of trying to reach github.com). Everything else delegates to real git —
  // so repo.ts's create → privacy-verify → ensure-commit → FIRST-push ordering
  // [G8] and the real add/commit run without network.
  const realGit = Bun.which('git');
  if (!realGit) throw new Error('git not on PATH — the e2e needs a real git to delegate to');
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "push" ]; then
    echo "git $*" >> "$GB_FAKE_RECORD"
    exit 0
  fi
  if [ "$a" = "ls-remote" ]; then
    echo "git $*" >> "$GB_FAKE_RECORD"
    echo "0000000000000000000000000000000000000000	refs/heads/main"
    exit 0
  fi
done
exec "${realGit}" "$@"
`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);

  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
}, 60_000);

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  for (const dir of [tmpParent, ws, shimDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('bootstrap lifecycle (serial e2e)', () => {
  test('CLI wiring smoke: `gbrain bootstrap status --json` reaches the dispatcher as a subprocess', () => {
    const res = spawnSync('bun', ['run', join(REPO_ROOT, 'src', 'cli.ts'), 'bootstrap', 'status', '--json'], {
      cwd: ws,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { phases: Array<{ id: string }>; support: { binary_version: string } };
    expect(parsed.phases.map((p) => p.id)).toEqual([...BOOTSTRAP_PHASE_IDS]);
    expect(parsed.support.binary_version.length).toBeGreaterThan(0);
  }, 90_000);

  test('interview: scripted answers, render refuses before confirm, read-back hash confirms', async () => {
    expect(await runBootstrap(['interview', '--init', '--workspace', ws])).toBe(0);
    for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
      expect(await runBootstrap(['interview', '--set', key, value, '--workspace', ws])).toBe(0);
    }
    // Consents ride the same state file (wire/repo phases read them later).
    expect(await runBootstrap(['interview', '--set', 'MCP_SCOPE', 'project', '--workspace', ws])).toBe(0);
    expect(await runBootstrap(['interview', '--set', 'HOOKS_CONSENT', 'yes', '--workspace', ws])).toBe(0);
    expect(await runBootstrap(['interview', '--set', 'PERSIST_CRON', 'no', '--workspace', ws])).toBe(0);

    // Dispatcher-level render gate [A8]: complete but UNCONFIRMED → refuse.
    expect(await runBootstrap(['render', '--workspace', ws])).toBe(1);

    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    // A wrong hash must not confirm.
    expect(await runBootstrap(['interview', '--confirm', 'deadbeef', '--workspace', ws])).toBe(1);
    expect(await runBootstrap(['interview', '--confirm', h.hash, '--workspace', ws])).toBe(0);
    expect(await runBootstrap(['interview', '--status', '--workspace', ws])).toBe(0);
  }, 60_000);

  test('render: identity files + initialized manifest + machine receipt; idempotent re-run keeps files', async () => {
    expect(await runBootstrap(['render', '--workspace', ws])).toBe(0);
    expect(existsSync(join(ws, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(ws, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(ws, '.gitignore'))).toBe(true);
    const manifest = readManifest(ws);
    expect(manifest.state).toBe('initialized');
    const receipt = readReceipt(home);
    expect(receipt?.workspace_dir).toBeTruthy();
    expect(receipt?.agent_name).toBe('Lifeboat');

    // Idempotent re-run: nothing clobbered, exit 0.
    const soulBefore = readFileSync(join(ws, 'SOUL.md'), 'utf8');
    expect(await runBootstrap(['render', '--workspace', ws])).toBe(0);
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf8')).toBe(soulBefore);

    // Interview answers rendered verbatim (identity from the human's words).
    expect(soulBefore).toContain('Lifeboat');
  }, 60_000);

  test('hooks: MCP argv recorded with GBRAIN_SOURCE binding [G1], hooks written under consent, receipt updated', async () => {
    const gbrainBin = join(shimDir, 'gbrain');
    expect(
      await runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', gbrainBin], {
        runner: testRunner,
      }),
    ).toBe(0);

    const rec = record();
    expect(rec).toContain('claude mcp add gbrain --scope project -e GBRAIN_SOURCE=workspace');
    expect(rec).toContain('claude mcp list');

    const settingsPath = join(ws, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']),
    );
    expect(readFileSync(settingsPath, 'utf8')).toContain('"_gbrain"');

    const receipt = readReceipt(home);
    expect(receipt?.registrations).toEqual([
      { host: 'claude-code', scope: 'project', detail: 'mcp+hooks' },
    ]);
  }, 60_000);

  test('repo: private repo created via fake gh, privacy verified BEFORE first push, URL recorded; re-run reuses', async () => {
    expect(await runBootstrap(['repo', '--workspace', ws], { runner: testRunner })).toBe(0);
    const rec = record();
    // Create runs WITHOUT --push; the first push happens only AFTER the
    // privacy bit verified true [G8] (create → verify → push).
    expect(rec).toContain('gh repo create lifeboat-workspace --private --source');
    expect(rec).not.toContain('--push');
    expect(rec).toContain('gh api repos/tester/lifeboat-workspace --jq .private');
    const verifyIdx = rec.indexOf('gh api repos/tester/lifeboat-workspace --jq .private');
    const pushIdx = rec.indexOf(`git -C ${ws} push -u origin`);
    expect(pushIdx).toBeGreaterThan(verifyIdx);

    const origin = execFileSync('git', ['-C', ws, 'remote', 'get-url', 'origin']).toString().trim();
    expect(origin).toBe('https://github.com/tester/lifeboat-workspace.git');
    const receipt = readReceipt(home) as (ReturnType<typeof readReceipt> & { repo_url?: string }) | null;
    expect(receipt?.repo_url).toBe(origin);
    expect(readFileSync(join(ws, 'GITHUB.md'), 'utf8')).toContain(origin);

    // Idempotent re-run: adopts our own origin, re-verifies privacy.
    expect(await runBootstrap(['repo', '--workspace', ws], { runner: testRunner })).toBe(0);
  }, 60_000);

  test('verify: real PGLite engine, keyless — exit 0 with magic moment + committed brain/ write-through', async () => {
    // Pre-init the brain the way `gbrain init --pglite` + `sources add` would.
    const engineConfig = { engine: 'pglite' as const, database_path: dbDir };
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    await engine.initSchema();
    await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
    await engine.disconnect();

    const { result: code, out } = await captureStdout(() => runBootstrap(['verify', '--workspace', ws, '--json']));
    expect(code).toBe(0);
    const payload = JSON.parse(out) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean; warn?: boolean; detail: string }>;
      tour: string[];
    };
    expect(payload.ok).toBe(true);
    const byId = (id: string) => payload.checks.filter((c) => c.id === id);
    for (const c of byId('roundtrip')) expect(c.ok).toBe(true);
    expect(byId('graph_floor')[0].ok).toBe(true);
    expect(byId('magic_moment')[0].ok).toBe(true);
    expect(byId('repo_privacy')[0].ok).toBe(true); // fake gh answered true
    expect(byId('hooks_smoke')[0].ok).toBe(true); // hooks installed → smoke ran (ok or documented warn)
    expect(payload.tour.length).toBe(3);

    // The probe cleaned itself up [G13]; brain/ dir exists for real writes.
    expect(existsSync(join(ws, 'brain', 'wiki', 'bootstrap-verify-probe.md'))).toBe(false);

    // Verify snapshot persisted → status flips the verify phase to done [B2].
    const report = await statusReport(ws, { gbrainHomeDir: home });
    const verifyPhase = report.phases.find((p) => p.id === 'verify')!;
    expect(verifyPhase.state).toBe('done');
    // Only skills stays pending (this e2e never scaffolds the skillpack) —
    // and `next` points exactly at that phase's resume hint.
    const notDone = report.phases.filter((p) => p.state !== 'done' && p.state !== 'skipped');
    expect(notDone.map((p) => p.id)).toEqual(['skills']);
    expect(report.next).toBe(notDone[0].resume_hint);
  }, 300_000);

  test('kill-mid-phase [A7]: GBRAIN_BOOTSTRAP_ABORT_AFTER=render aborts after artifacts; status resumes; re-run no-ops', async () => {
    const ws2 = mkdtempSync(join(tmpdir(), 'gb-e2e-ws2-'));
    try {
      expect(initState(ws2).ok).toBe(true);
      for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
        const r = setAnswer(ws2, key, value);
        if (!r.ok) throw new Error(r.message);
      }
      const h = readBackHash(ws2);
      if (!h.ok) throw new Error(h.message);
      expect(confirm(ws2, h.hash).ok).toBe(true);

      process.env.GBRAIN_BOOTSTRAP_ABORT_AFTER = 'render';
      const code = await runBootstrap(['render', '--workspace', ws2]);
      expect(code).toBe(130);
      delete process.env.GBRAIN_BOOTSTRAP_ABORT_AFTER;

      // Artifacts exist (the abort fired AFTER the phase's mutation)…
      expect(readManifest(ws2).state).toBe('initialized');
      // …and the log recorded the abort, not a green 'ok' [B1].
      const entries = readInstallLog(home).filter((e) => e.workspace === ws2 && e.phase === 'render');
      expect(entries[entries.length - 1]?.outcome).toBe('aborted');

      // status resumes: render detected done from artifacts, next points onward.
      const report = await statusReport(ws2, { gbrainHomeDir: home });
      const byId = new Map(report.phases.map((p) => [p.id, p]));
      expect(byId.get('render')!.state).toBe('done');
      expect(report.next).not.toBe(byId.get('render')!.resume_hint);

      // Re-run converges: exit 0, files kept.
      expect(await runBootstrap(['render', '--workspace', ws2])).toBe(0);

      // Codex door: MCP registered via `codex mcp add` (user-global, env
      // binding [G1]); NO hooks written — the pull protocol is the per-turn
      // seam, stated plainly.
      const gbrainBin = join(shimDir, 'gbrain');
      const { result: hooksCode, out: hooksOut } = await captureStdout(() =>
        runBootstrap(['hooks', '--workspace', ws2, '--harness', 'codex', '--gbrain-bin', gbrainBin], {
          runner: testRunner,
        }),
      );
      expect(hooksCode).toBe(0);
      expect(record()).toContain('codex mcp add gbrain --env GBRAIN_SOURCE=workspace');
      // [FIX7] the stateful shim echoes the recorded reg on `mcp get`, so the
      // registration smoke VERIFIES it targets THIS workspace (binary + source)
      // rather than falling back to the substring probe. A regressed
      // verifyMcpTargetsWorkspace (mismatch/unknown) would change this line.
      expect(hooksOut).toContain('MCP registered with codex (scope: user-global) — verified targeting this workspace.');
      expect(existsSync(join(ws2, '.claude', 'settings.local.json'))).toBe(false);
      const receipt = readReceipt(home);
      // Receipt is machine-scoped last-attach-wins: ws2's registration replaced ws's record.
      expect(receipt?.registrations).toEqual([{ host: 'codex', scope: 'user', detail: 'mcp' }]);
    } finally {
      delete process.env.GBRAIN_BOOTSTRAP_ABORT_AFTER;
      rmSync(ws2, { recursive: true, force: true });
    }
  }, 120_000);

  test('lock collision [G9]: a held bootstrap lock refuses a second mutating run, politely', async () => {
    const handle = await acquireBootstrapLock(ws);
    try {
      const code = await runBootstrap(['render', '--workspace', ws]);
      expect(code).toBe(1); // BOOTSTRAP_IN_PROGRESS → typed refusal, exit 1
    } finally {
      handle.release();
    }
    // Lock released → the same command succeeds again (idempotent render).
    expect(await runBootstrap(['render', '--workspace', ws])).toBe(0);
  }, 60_000);
});
