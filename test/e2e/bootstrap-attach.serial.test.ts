/**
 * attach-mode e2e [ENG-tests-2, CX-P1.5, CX2-1, CX2-12]: machine-1 fixture
 * (scripted interview → confirm → render → git init + commit + local bare
 * 'origin') cloned to a machine-2 dir with a SECOND sandboxed GBRAIN_HOME:
 *
 *   - `runBootstrap(['attach'])` on the clone: exit 0, machine-2 receipt
 *     written with brain_created_by_bootstrap: false, ordered todo steps
 *     returned (register_source → hooks_repair → mcp_add → verify).
 *   - hooks repair on machine 2 (env-pinned fake ExecRunner): MCP argv
 *     recorded, settings.local.json written with the _gbrain marker entries,
 *     receipt registration appended.
 *   - template clone (initialized: false via `render --minimal`) REFUSED
 *     with the agent-readable message pointing at `bootstrap render`.
 *   - absent agent.json REFUSED as not-a-workspace.
 *
 * Serial: sandboxed GBRAIN_HOME env mutation across the whole file.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
import { join } from 'node:path';

import { runBootstrap } from '../../src/commands/bootstrap.ts';

import type { ExecRunner } from '../../src/core/bootstrap/repo.ts';
import { attachWorkspace } from '../../src/core/bootstrap/attach.ts';
import { readManifest, readReceipt } from '../../src/core/bootstrap/format.ts';
import { initState, setAnswer, confirm, readBackHash } from '../../src/core/bootstrap/interview.ts';
import { realpathOrResolve } from '../../src/core/path-confine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { addSource } from '../../src/core/sources-ops.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { verifyWorkspace } from '../../src/core/bootstrap/verify.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { CapabilityReport } from '../../src/core/capability.ts';
import { CORPUS_DIR } from '../helpers/bootstrap-corpus.ts';

// Cold-path opt-out (conservative): bootstrap-arc file — attach semantics on
// a brain whose init path should stay the genuine cold build.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

/** Keyless capability report — machine 2 re-ingests + verifies with ZERO keys. */
const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

/** A page authored ONLY on machine 1, committed to the repo, cloned to machine 2. */
const MACHINE1_PAGE_SLUG = 'companies/summit-robotics';
/** A distinctive fact that exists nowhere but machine 1's authored repo page. */
const MACHINE1_MARKER = 'The flagship warehouse pilot runs at the Rivermouth fulfillment center.';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_BOOTSTRAP_ABORT_AFTER',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_CI',
];

const ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Beacon',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Keep the research corpus current and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

let machine1Home: string; // GBRAIN_HOME parent for machine 1
let machine2Home: string; // GBRAIN_HOME parent for machine 2
let ws1: string; // machine-1 workspace (bootstrap-created fixture)
let ws2: string; // machine-2 clone
let bareOrigin: string; // local bare 'origin'
let cloneParent: string;

/** Recording in-process ExecRunner — the env-pinned fake for MCP registration. */
const recorded: string[][] = [];
const fakeRunner: ExecRunner = async (argv: string[]) => {
  recorded.push([...argv]);
  if (argv[0] === 'claude' && argv[1] === 'mcp' && argv[2] === 'list') {
    return { code: 0, stdout: 'gbrain: stdio serve', stderr: '' };
  }
  if (argv[0] === 'claude' || argv[0] === 'codex') {
    return { code: 0, stdout: '', stderr: '' };
  }
  // git and anything else runs for real via a spawn-free refusal — the attach
  // + hooks paths under test never need a real subprocess beyond claude/codex.
  return { code: 0, stdout: '', stderr: '' };
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

beforeAll(async () => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  machine1Home = mkdtempSync(join(tmpdir(), 'gb-att1-'));
  machine2Home = mkdtempSync(join(tmpdir(), 'gb-att2-'));
  ws1 = mkdtempSync(join(tmpdir(), 'gb-att-ws1-'));
  cloneParent = mkdtempSync(join(tmpdir(), 'gb-att-cl-'));
  ws2 = join(cloneParent, 'workspace-clone');
  bareOrigin = join(cloneParent, 'origin.git');

  // ── Machine 1: the committed lifecycle flow (interview → confirm → render).
  process.env.GBRAIN_HOME = machine1Home;
  expect(initState(ws1).ok).toBe(true);
  for (const [key, value] of Object.entries(ANSWERS)) {
    const r = setAnswer(ws1, key, value);
    if (!r.ok) throw new Error(r.message);
  }
  for (const [key, value] of [
    ['MCP_SCOPE', 'project'],
    ['HOOKS_CONSENT', 'yes'],
    ['PERSIST_CRON', 'no'],
  ] as const) {
    const r = setAnswer(ws1, key, value);
    if (!r.ok) throw new Error(r.message);
  }
  const h = readBackHash(ws1);
  if (!h.ok) throw new Error(h.message);
  expect(confirm(ws1, h.hash).ok).toBe(true);
  const renderCode = await (await captureStd(() => runBootstrap(['render', '--workspace', ws1]))).result;
  expect(renderCode).toBe(0);
  expect(readManifest(ws1).state).toBe('initialized');

  // Author a corpus page into machine 1's brain/ BEFORE the commit — a real
  // synthetic page carrying a machine-1-only fact (the Rivermouth marker). It
  // lives ONLY in the repo, so machine 2 can only learn it by re-ingesting the
  // clone [multi-device promise: hot facts arrive via the repo].
  const corpusPage = readFileSync(join(CORPUS_DIR, 'pages', 'companies__summit-robotics.md'), 'utf8');
  mkdirSync(join(ws1, 'brain', 'companies'), { recursive: true });
  writeFileSync(
    join(ws1, 'brain', 'companies', 'summit-robotics.md'),
    `${corpusPage.trimEnd()}\n\n## Operations\n\n${MACHINE1_MARKER}\n`,
  );

  // git init + commit + local bare 'origin' + clone → machine 2.
  git(ws1, ['init', '-q', '-b', 'main']);
  git(ws1, ['config', 'user.email', 'test@example.com']);
  git(ws1, ['config', 'user.name', 'Test']);
  git(ws1, ['add', '-A']);
  git(ws1, ['commit', '-q', '-m', 'bootstrap fixture']);
  execFileSync('git', ['init', '-q', '--bare', bareOrigin]);
  // The bare origin's default HEAD (master) must match the pushed branch or
  // `git clone` checks out an EMPTY tree ("remote HEAD refers to nonexistent
  // ref") and machine 2 sees no agent.json.
  execFileSync('git', ['-C', bareOrigin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(ws1, ['remote', 'add', 'origin', bareOrigin]);
  git(ws1, ['push', '-q', 'origin', 'main']);
  execFileSync('git', ['clone', '-q', bareOrigin, ws2]);

  // ── Machine 2 from here on: a SECOND sandboxed GBRAIN_HOME.
  process.env.GBRAIN_HOME = machine2Home;
}, 120_000);

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  for (const dir of [machine1Home, machine2Home, ws1, cloneParent]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('bootstrap attach (machine-2 adoption, serial e2e)', () => {
  test('attach on a machine-2 clone: exit 0, receipt written with brain_created_by_bootstrap false, steps printed', async () => {
    const { result: code, out } = await captureStd(() =>
      runBootstrap(['attach', '--workspace', ws2, '--harness', 'claude-code']),
    );
    expect(code).toBe(0);
    expect(out).toContain('attached workspace for agent "Beacon"');
    expect(out).toContain("source 'workspace'");
    // The ordered todo-list the dispatcher relays.
    expect(out).toContain('gbrain sources add');
    expect(out).toContain('bootstrap hooks --harness claude-code --repair');
    expect(out).toContain('gbrain bootstrap verify');

    const receipt = readReceipt(join(machine2Home, '.gbrain'));
    expect(receipt).not.toBeNull();
    expect(receipt!.workspace_dir).toBe(realpathOrResolve(ws2));
    expect(receipt!.agent_name).toBe('Beacon');
    expect(receipt!.source_id).toBe('workspace');
    // Attach ADOPTS an existing brain — never claims brain ownership [CX2-12].
    expect(receipt!.brain_created_by_bootstrap).toBe(false);
    expect(receipt!.created_paths).toEqual([]);
    // Attach records repo_url from the adopted origin so the no-daemon push
    // gate (repoPhaseComplete) recognizes the repo phase as done on this
    // machine — without it the per-turn/session-end pushes defer forever, and
    // attach is the ONLY install path in a cloud sandbox.
    expect((receipt as { repo_url?: string }).repo_url).toContain('origin.git');
  }, 60_000);

  test('attach steps are the ordered machine-2 todo list; re-attach preserves the same-workspace receipt', () => {
    const before = readReceipt(join(machine2Home, '.gbrain'));
    expect(before).not.toBeNull();
    const res = attachWorkspace(ws2, {
      harness: 'claude-code',
      gbrainHomeDir: join(machine2Home, '.gbrain'),
      createdBy: 'test-reattach',
    });
    expect(res.steps.map((s) => s.kind)).toEqual(['register_source', 'hooks_repair', 'mcp_add', 'verify']);
    // Same-workspace re-attach preserves ownership fields (no laundering).
    const after = readReceipt(join(machine2Home, '.gbrain'));
    expect(after!.created_at).toBe(before!.created_at);
    expect(after!.brain_created_by_bootstrap).toBe(false);
  }, 30_000);

  test('hooks repair on machine 2: MCP argv recorded via the fake runner, settings.local.json carries the marker entries, receipt updated', async () => {
    // Absolute fake gbrain binary for registration/hook command strings —
    // never executed by this test.
    const fakeBin = join(machine2Home, 'gbrain');
    writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeBin, 0o755);

    recorded.length = 0;
    const { result: code } = await captureStd(() =>
      runBootstrap(
        ['hooks', '--workspace', ws2, '--harness', 'claude-code', '--repair', '--gbrain-bin', fakeBin],
        { runner: fakeRunner },
      ),
    );
    expect(code).toBe(0);

    // MCP registration went through the env-pinned fake runner with the
    // source binding [G1].
    const flat = recorded.map((argv) => argv.join(' '));
    expect(flat.some((c) => c.startsWith('claude mcp add gbrain') && c.includes('GBRAIN_SOURCE=workspace'))).toBe(true);
    expect(flat).toContain('claude mcp list');

    // Machine-local hook wiring re-rendered with the marker entries.
    const settingsPath = join(ws2, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    const raw = readFileSync(settingsPath, 'utf8');
    expect(raw).toContain('"_gbrain"');
    expect(raw).toContain('"bootstrap-v1"');
    const settings = JSON.parse(raw) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']),
    );

    const receipt = readReceipt(join(machine2Home, '.gbrain'));
    expect(receipt!.registrations).toEqual([
      { host: 'claude-code', scope: 'project', detail: 'mcp+hooks' },
    ]);
  }, 60_000);

  test('machine-2 full round-trip: repo page re-ingests into a FRESH brain, verify passes, and a machine-1-only fact is recalled', async () => {
    // A fresh machine-2 PGLite brain — nothing pre-seeded. The only path a fact
    // can reach it is the cloned repo tree. Hermetic in-memory engine (the
    // proven in-process verify pattern) so teardown is clean.
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      // Register the cloned brain/ as the workspace source (what `bootstrap
      // attach` → `gbrain sources add` does on machine 2).
      await addSource(engine, { id: 'workspace', localPath: join(ws2, 'brain'), force: true });

      // Precondition: the machine-1-authored page is NOT in the fresh DB — it
      // exists ONLY as a committed repo file cloned from machine 1.
      expect(await engine.getPage(MACHINE1_PAGE_SLUG, { sourceId: 'workspace' })).toBeNull();
      const clonedFile = join(ws2, 'brain', 'companies', 'summit-robotics.md');
      expect(existsSync(clonedFile)).toBe(true);
      expect(readFileSync(clonedFile, 'utf8')).toContain(MACHINE1_MARKER);

      // Re-ingest through the REAL per-file import path (the primitive `gbrain
      // sync` runs on each changed file), scoped to the workspace source.
      const rel = join('companies', 'summit-robotics.md');
      const imp = await importFromFile(engine, clonedFile, rel, { sourceId: 'workspace', noEmbed: true });
      expect(imp.status).toBe('imported');
      expect(imp.slug).toBe(MACHINE1_PAGE_SLUG);

      // The page + its machine-1-authored content now live in machine 2's DB.
      const page = await engine.getPage(MACHINE1_PAGE_SLUG, { sourceId: 'workspace' });
      expect(page).not.toBeNull();
      expect(page!.title).toBe('Summit Robotics');
      expect(page!.compiled_truth ?? '').toContain(MACHINE1_MARKER);

      // The clone's origin is a local bare path gh cannot prove private; drop it
      // so repo_privacy resolves to the honest local-only pass. The multi-device
      // fact transport under test is orthogonal to remote-privacy verification.
      execFileSync('git', ['-C', ws2, 'remote', 'remove', 'origin']);

      // `bootstrap verify` core runs GREEN on machine 2, keyless.
      const res = await verifyWorkspace(engine, ws2, {
        sourceId: 'workspace',
        gbrainHomeDir: join(machine2Home, '.gbrain'),
        capabilities: KEYLESS,
        skipHooksSmoke: true,
      });
      if (!res.ok) console.error(res.report);
      expect(res.ok).toBe(true);
      expect(res.checks.find((c) => c.id === 'roundtrip')!.ok).toBe(true);

      // Recall the machine-1-only fact through the REAL keyword-search query op.
      // The Rivermouth marker was authored on machine 1 and reached machine 2
      // ONLY via the repo, so a hit proves the multi-device promise end to end.
      const queryOp = operations.find((o) => o.name === 'query')!;
      const ctx: OperationContext = {
        engine,
        config: { engine: 'pglite' } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: false,
        remote: false,
        sourceId: 'workspace',
      };
      const markerHit = await queryOp.handler(ctx, { query: 'Rivermouth fulfillment center warehouse', limit: 10, expand: false });
      expect(JSON.stringify(markerHit)).toContain(MACHINE1_PAGE_SLUG);
      const goldHit = await queryOp.handler(ctx, { query: 'warehouse navigation robots startup', limit: 10, expand: false });
      expect(JSON.stringify(goldHit)).toContain(MACHINE1_PAGE_SLUG);
    } finally {
      // The query op fires retrieval telemetry (last_retrieved_at / search
      // stats) as a background write. PGLite serializes one connection, so a
      // yield-then-flush drains that in-flight write BEFORE close() — issuing
      // db.close() with a query still queued otherwise deadlocks disconnect.
      await new Promise((r) => setTimeout(r, 100));
      await engine.executeRaw('SELECT 1').catch(() => {});
      await engine.disconnect();
    }
  }, 240_000);

  test('template clone (initialized: false) is REFUSED with the agent-readable render pointer [CX2-1]', async () => {
    const ws3 = mkdtempSync(join(tmpdir(), 'gb-att-ws3-'));
    try {
      // `render --minimal` writes the canonical placeholder manifest —
      // exactly what a template-repo clone carries.
      const { result: renderCode } = await captureStd(() => runBootstrap(['render', '--minimal', '--workspace', ws3]));
      expect(renderCode).toBe(0);
      expect(readManifest(ws3).state).toBe('template');

      const { result: code, err } = await captureStd(() => runBootstrap(['attach', '--workspace', ws3]));
      expect(code).toBe(1);
      expect(err).toContain('uninitialized template');
      expect(err).toContain('gbrain bootstrap render');
      // No receipt overwrite from the refused attach: the machine-2 receipt
      // still points at ws2.
      expect(readReceipt(join(machine2Home, '.gbrain'))!.workspace_dir).toBe(realpathOrResolve(ws2));
    } finally {
      rmSync(ws3, { recursive: true, force: true });
    }
  }, 60_000);

  test('absent agent.json is REFUSED as not-a-workspace', async () => {
    const ws4 = mkdtempSync(join(tmpdir(), 'gb-att-ws4-'));
    try {
      const { result: code, err } = await captureStd(() => runBootstrap(['attach', '--workspace', ws4]));
      expect(code).toBe(1);
      expect(err).toContain('not an agent workspace');
      expect(err).toContain('agent.json');
    } finally {
      rmSync(ws4, { recursive: true, force: true });
    }
  }, 30_000);
});
