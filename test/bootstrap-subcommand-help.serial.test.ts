/**
 * bootstrap subcommand `--help`/`-h`/`help` guard (src/commands/bootstrap.ts).
 *
 * Regression test for a safety defect: `gbrain bootstrap <subcommand> --help`
 * (a help token AFTER the subcommand name, e.g. `gbrain bootstrap repo
 * --help`) fell straight through into the subcommand's own arg parsing, and
 * none of the mutating handlers (repo/hooks/verify/attach/uninstall/render/
 * interview) checked for a help token themselves. So `--help` did not print
 * help — it ran the real operation (private repo creation, MCP/hook
 * registration, the verify contract, workspace adoption, receipt-keyed file
 * removal, or recording an interview answer).
 *
 * Each fixture below is deliberately built so the real (non-`--help`)
 * operation WOULD reach its dangerous side effect if the guard were removed
 * — an operational verify config, an already-initialized attach workspace,
 * an isolated uninstall home with a real receipt + a bootstrap-created file
 * to survive, a fresh interview workspace to prove `--init` never runs. This
 * proves the guard intercepts BEFORE any write/exec call, not merely that
 * the operation would have failed anyway on an unprepared fixture.
 *
 * Serial: mutates GBRAIN_HOME.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBootstrap } from '../src/commands/bootstrap.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import { interviewStatePath } from '../src/core/bootstrap/interview.ts';
import { receiptPath, writeReceipt, type InstallReceipt } from '../src/core/bootstrap/format.ts';
import { readInstallLog } from '../src/core/bootstrap/status.ts';
import { initState, setAnswer, skipAnswer, confirm, readBackHash } from '../src/core/bootstrap/interview.ts';

let tmpParent: string; // GBRAIN_HOME parent (configDir appends .gbrain)
let home: string;
let ws: string;
let prevHome: string | undefined;

const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'HelpGuard',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

/** Recording fake runner — never spawns anything; asserts zero calls when
 * the --help guard is doing its job. */
function makeRunner(): { runner: ExecRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ExecRunner = async (argv: string[]) => {
    calls.push(argv);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

/** Capture console.log + console.error around an async call. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(' ') + '\n';
  };
  console.error = (...args: unknown[]) => {
    err += args.map(String).join(' ') + '\n';
  };
  try {
    const result = await fn();
    return { result, out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeAll(async () => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-subhelp-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  ws = mkdtempSync(join(tmpdir(), 'gb-subhelp-ws-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpParent;

  // Interview: all required answers, confirmed — so a real (non---help)
  // render/hooks/repo/attach call on this workspace would succeed, giving
  // the --help guard something real to intercept.
  expect(initState(ws).ok).toBe(true);
  for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
    const r = setAnswer(ws, key, value);
    if (!r.ok) throw new Error(r.message);
  }
  expect(setAnswer(ws, 'MCP_SCOPE', 'project').ok).toBe(true);
  expect(skipAnswer(ws, 'HOOKS_CONSENT').ok).toBe(true);
  const h = readBackHash(ws);
  if (!h.ok) throw new Error(h.message);
  expect(confirm(ws, h.hash).ok).toBe(true);

  // Materialize a real render + receipt so render/hooks/attach --help have
  // real, pre-existing state they could (but must not) mutate. `ws` now also
  // satisfies attach's precondition (an `initialized: true` agent.json).
  const render = await capture(() => runBootstrap(['render', '--workspace', ws]));
  expect(render.result).toBe(0);

  // An "operational" verify config: loadConfig() resolves, so a real
  // (non---help) verify would proceed past the "no brain configured" early
  // exit into createEngine()/connect() — which would create files under
  // `verifyDataDir`. It's never touched if the --help guard works.
  const verifyDataDir = join(home, 'verify-brain.pglite');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: verifyDataDir }), 'utf8');
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('bootstrap <subcommand> --help/-h/help never runs the real operation', () => {
  test('render --help: usage text, exit 0, receipt + install log untouched', async () => {
    const receiptBefore = readFileSync(receiptPath(home), 'utf8');
    const mtimeBefore = statSync(receiptPath(home)).mtimeMs;
    const logCountBefore = readInstallLog(home, 1000).length;

    const r = await capture(() => runBootstrap(['render', '--workspace', ws, '--help']));

    expect(r.result).toBe(0);
    expect(r.out).toContain('Render identity files');
    expect(readFileSync(receiptPath(home), 'utf8')).toBe(receiptBefore);
    expect(statSync(receiptPath(home)).mtimeMs).toBe(mtimeBefore);
    expect(readInstallLog(home, 1000).length).toBe(logCountBefore);
  });

  test('repo --help: usage text, exit 0, zero exec calls', async () => {
    const { runner, calls } = makeRunner();

    const r = await capture(() => runBootstrap(['repo', '--workspace', ws, '--help'], { runner }));

    expect(r.result).toBe(0);
    expect(r.out).toContain('PRIVATE GitHub repo');
    expect(calls.length).toBe(0);
  });

  test('repo help (bare word, no dashes): usage text, exit 0, zero exec calls', async () => {
    const { runner, calls } = makeRunner();

    const r = await capture(() => runBootstrap(['repo', '--workspace', ws, 'help'], { runner }));

    expect(r.result).toBe(0);
    expect(r.out).toContain('PRIVATE GitHub repo');
    expect(calls.length).toBe(0);
  });

  test('hooks --help: usage text, exit 0, zero exec calls, receipt untouched', async () => {
    const receiptBefore = readFileSync(receiptPath(home), 'utf8');
    const mtimeBefore = statSync(receiptPath(home)).mtimeMs;
    const { runner, calls } = makeRunner();

    const r = await capture(() =>
      runBootstrap(
        ['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', process.execPath, '--help'],
        { runner },
      ),
    );

    expect(r.result).toBe(0);
    expect(r.out).toContain('Register MCP');
    expect(calls.length).toBe(0);
    expect(readFileSync(receiptPath(home), 'utf8')).toBe(receiptBefore);
    expect(statSync(receiptPath(home)).mtimeMs).toBe(mtimeBefore);
  });

  test('verify --help: usage text, exit 0, engine never connects (data dir never created)', async () => {
    const verifyDataDir = join(home, 'verify-brain.pglite');
    expect(existsSync(verifyDataDir)).toBe(false); // sanity: config points at a path that doesn't exist yet

    const r = await capture(() => runBootstrap(['verify', '--workspace', ws, '--help']));

    expect(r.result).toBe(0);
    expect(r.out).toContain('install contract');
    // A real (unguarded) verify would have called engine.connect(), which
    // acquires a file lock under the data dir — creating it. It must still
    // be absent.
    expect(existsSync(verifyDataDir)).toBe(false);
  });

  test('attach --help: usage text, exit 0, receipt untouched — a real attach here WOULD rewrite it', async () => {
    // `ws` already has an `initialized: true` agent.json (from the render
    // above) and an existing receipt — attach's real precondition, and the
    // exact case its own docstring says it does NOT refuse (it merges into
    // the existing receipt instead). So an unguarded attach --help here
    // would visibly touch the receipt.
    const receiptBefore = readFileSync(receiptPath(home), 'utf8');
    const mtimeBefore = statSync(receiptPath(home)).mtimeMs;

    const r = await capture(() => runBootstrap(['attach', '--workspace', ws, '--help']));

    expect(r.result).toBe(0);
    expect(r.out).toContain('adopt a cloned agent workspace');
    expect(readFileSync(receiptPath(home), 'utf8')).toBe(receiptBefore);
    expect(statSync(receiptPath(home)).mtimeMs).toBe(mtimeBefore);
  });

  describe('uninstall --help (isolated home + a real receipt-tracked file that must survive)', () => {
    function seedUninstallFixture(): { uninstallWs: string; isolatedHome: string; dummyCreatedPath: string } {
      const uninstallWs = mkdtempSync(join(tmpdir(), 'gb-subhelp-uninstall-ws-'));
      const isolatedHome = join(uninstallWs, '.gbrain');
      mkdirSync(join(isolatedHome, 'brain.pglite'), { recursive: true });
      mkdirSync(join(isolatedHome, 'bootstrap'), { recursive: true });
      writeFileSync(join(isolatedHome, 'config.json'), '{"engine":"pglite"}', 'utf8');
      const dummyCreatedPath = join(uninstallWs, 'DUMMY_CREATED.md');
      writeFileSync(dummyCreatedPath, 'created-by-bootstrap — must survive --help', 'utf8');
      const receipt: InstallReceipt = {
        receipt_version: 1,
        workspace_dir: uninstallWs,
        source_id: 'workspace',
        agent_name: 'Uninstall Help Test',
        created_at: '2026-01-01T00:00:00.000Z',
        created_by: '0.0.0-test',
        brain_created_by_bootstrap: false,
        created_paths: [dummyCreatedPath],
        registrations: [],
      };
      writeReceipt(isolatedHome, receipt);
      return { uninstallWs, isolatedHome, dummyCreatedPath };
    }

    test('--help: usage text, exit 0, zero exec calls, receipt-tracked file + receipt survive', async () => {
      const { uninstallWs, isolatedHome, dummyCreatedPath } = seedUninstallFixture();
      try {
        const receiptBefore = readFileSync(receiptPath(isolatedHome), 'utf8');
        const { runner, calls } = makeRunner();

        const r = await capture(() =>
          runBootstrap(['uninstall', '--workspace', uninstallWs, '--home', isolatedHome, '--help'], { runner }),
        );

        expect(r.result).toBe(0);
        expect(r.out).toContain('Receipt-keyed removal');
        expect(calls.length).toBe(0);
        expect(existsSync(dummyCreatedPath)).toBe(true);
        expect(readFileSync(receiptPath(isolatedHome), 'utf8')).toBe(receiptBefore);
      } finally {
        rmSync(uninstallWs, { recursive: true, force: true });
      }
    });

    test('-h: same interception (the highest-risk subcommand, short flag spelling)', async () => {
      const { uninstallWs, isolatedHome, dummyCreatedPath } = seedUninstallFixture();
      try {
        const { runner, calls } = makeRunner();

        const r = await capture(() =>
          runBootstrap(['uninstall', '--workspace', uninstallWs, '--home', isolatedHome, '-h'], { runner }),
        );

        expect(r.result).toBe(0);
        expect(r.out).toContain('Receipt-keyed removal');
        expect(calls.length).toBe(0);
        expect(existsSync(dummyCreatedPath)).toBe(true);
      } finally {
        rmSync(uninstallWs, { recursive: true, force: true });
      }
    });

    test('help (bare word): same interception', async () => {
      const { uninstallWs, isolatedHome, dummyCreatedPath } = seedUninstallFixture();
      try {
        const { runner, calls } = makeRunner();

        const r = await capture(() =>
          runBootstrap(['uninstall', '--workspace', uninstallWs, '--home', isolatedHome, 'help'], { runner }),
        );

        expect(r.result).toBe(0);
        expect(r.out).toContain('Receipt-keyed removal');
        expect(calls.length).toBe(0);
        expect(existsSync(dummyCreatedPath)).toBe(true);
      } finally {
        rmSync(uninstallWs, { recursive: true, force: true });
      }
    });
  });

  describe('interview + help (Warning: help combined with a real action flag)', () => {
    test('interview --init --help: usage text, exit 0, state/interview.json never created', async () => {
      const freshWs = mkdtempSync(join(tmpdir(), 'gb-subhelp-interview-'));
      try {
        expect(existsSync(interviewStatePath(freshWs))).toBe(false);

        const r = await capture(() => runBootstrap(['interview', '--workspace', freshWs, '--init', '--help']));

        expect(r.result).toBe(0);
        expect(r.out).toContain('Create/record/read interview state');
        expect(existsSync(interviewStatePath(freshWs))).toBe(false);
      } finally {
        rmSync(freshWs, { recursive: true, force: true });
      }
    });

    test('interview --set KEY value --help: usage text, exit 0, no answer recorded', async () => {
      const freshWs = mkdtempSync(join(tmpdir(), 'gb-subhelp-interview-'));
      try {
        expect(initState(freshWs).ok).toBe(true);

        const r = await capture(() =>
          runBootstrap(['interview', '--workspace', freshWs, '--set', 'AGENT_NAME', 'ShouldNotRecord', '--help']),
        );

        expect(r.result).toBe(0);
        expect(r.out).toContain('Create/record/read interview state');
        const raw = JSON.parse(readFileSync(interviewStatePath(freshWs), 'utf8')) as { answers: Record<string, unknown> };
        expect(raw.answers['AGENT_NAME']).toBeUndefined();
      } finally {
        rmSync(freshWs, { recursive: true, force: true });
      }
    });

    test('interview --set VOICE_REGISTER "help" (bare word as a legitimate answer VALUE, no --help flag): still records — proves the bare-word exclusion for interview', async () => {
      const freshWs = mkdtempSync(join(tmpdir(), 'gb-subhelp-interview-'));
      try {
        expect(initState(freshWs).ok).toBe(true);

        const r = await capture(() => runBootstrap(['interview', '--workspace', freshWs, '--set', 'VOICE_REGISTER', 'help']));

        expect(r.result).toBe(0);
        expect(r.out).toContain('recorded');
        const raw = JSON.parse(readFileSync(interviewStatePath(freshWs), 'utf8')) as { answers: Record<string, { value?: string }> };
        expect(raw.answers['VOICE_REGISTER']?.value).toBe('help');
      } finally {
        rmSync(freshWs, { recursive: true, force: true });
      }
    });
  });
});
