/**
 * REAL-binary door test — the gbrain CODEX PLUGIN. Drives the actual `codex`
 * binary's plugin/marketplace subcommands against the committed plugin
 * artifacts (manifests + curated plugin/ tree + launcher):
 *
 *   1. INSTALL (no auth needed — marketplace/plugin ops are local): stage a
 *      CLEAN tree via `git archive HEAD` (a dirty worktree / node_modules must
 *      never enter the snapshot), `codex plugin marketplace add <stage>`,
 *      `codex plugin add gbrain@gbrain`. Asserts: enable entry in the hermetic
 *      config.toml, snapshot carries the curated skills + non-root mcp.json +
 *      an EXECUTABLE launcher, dual-marketplace resolution yields exactly one
 *      gbrain plugin, add-twice idempotency, the deterministic tools/list
 *      surface oracle (== the starter surface, via the snapshot launcher),
 *      the cold-home fast-fail ("No brain configured. Run: gbrain init"),
 *      the --source-guard write gate (blocked without GBRAIN_SOURCE on a
 *      multi-source brain, allowed with it), the `codex mcp add` coexistence
 *      probe, and `codex plugin remove`.
 *
 *   2. SMOKE (needs codex auth): one live `codex exec` turn in a session whose
 *      gbrain MCP server comes from the PLUGIN (no `codex mcp add`) — proves
 *      marketplace → plugin → mcp.json → launcher → GBRAIN_BIN → serve →
 *      brain → fact. Plus the recovery-loop probe: with no gbrain binary
 *      reachable, the session still completes (degrade, don't brick).
 *
 * Hermetic per test (temp HOME/CODEX_HOME/GBRAIN_HOME); INSTALL self-skips
 * without a plugin-capable codex binary, SMOKE additionally without auth.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveCodexBinary,
  hasCodexAuth,
  codexSupportsPlugins,
  codexExecTurn,
  seedBrainForAgent,
  hermeticChildEnv,
  mcpToolsListProbe,
  ensureCompiledGbrain,
} from '../helpers/agent-harness.ts';
import { operations } from '../../src/core/operations.ts';
import { filterOpsForSurface } from '../../src/mcp/surface.ts';
import { codexPluginProvidesName } from '../../src/core/bootstrap/harness.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const CODEX_BIN = resolveCodexBinary();
const PLUGIN_CAPABLE = !!CODEX_BIN && codexSupportsPlugins(CODEX_BIN);

/** Stage a CLEAN tree (tracked files only, modes preserved) from HEAD. */
function stageCleanTree(): string {
  const stage = mkdtempSync(join(tmpdir(), 'gb-plugin-stage-'));
  execFileSync('sh', ['-c', `git -C '${REPO_ROOT}' archive HEAD | tar -x -C '${stage}'`]);
  return stage;
}

/** A GBRAIN_BIN-usable executable: the compiled binary when available, else a
 *  sh shim exec'ing `bun run src/cli.ts`. */
function gbrainBinForTests(dir: string): string {
  const compiled = ensureCompiledGbrain(REPO_ROOT);
  if (compiled.binPath) return compiled.binPath;
  const shim = join(dir, 'gbrain-shim');
  writeFileSync(shim, `#!/bin/sh\nexec bun run '${CLI}' "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function makeCodexRunner(home: string) {
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  return (argv: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      env: hermeticChildEnv(
        { HOME: home, CODEX_HOME: codexHome, ...extraEnv },
        { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] },
      ) as Record<string, string>,
      timeout: 120_000,
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/** Find the installed plugin snapshot root (the dir holding .codex-plugin/mcp.json). */
function findSnapshotRoot(codexHome: string): string | null {
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 7) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (existsSync(join(p, '.codex-plugin', 'mcp.json'))) hits.push(p);
        else walk(p, depth + 1);
      }
    }
  };
  walk(codexHome, 0);
  return hits[0] ?? null;
}

/** JSON-RPC tools/call over stdio: initialize → call → first id:2 response. */
async function mcpToolCallProbe(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  tool: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ text: string; isError: boolean }> {
  const proc = Bun.spawn([opts.command, ...opts.args], {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gbrain-e2e-probe', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: opts.tool, arguments: opts.params } },
  ];
  proc.stdin.write(frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  await proc.stdin.end();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split('\n').slice(0, -1)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.id === 2) {
            const content = obj.result?.content?.[0]?.text ?? JSON.stringify(obj.error ?? obj.result ?? {});
            return { text: content, isError: !!(obj.result?.isError || obj.error) };
          }
        } catch { /* partial/non-JSON line */ }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    }
    throw new Error('mcpToolCallProbe: no response before deadline');
  } finally {
    try { proc.kill(); } catch { /* dead */ }
  }
}

describe.skipIf(!PLUGIN_CAPABLE)('codex plugin door — INSTALL (no auth needed)', () => {
  test('marketplace add → plugin add → snapshot, oracle, guard, coexistence, removal', async () => {
    const host = mkdtempSync(join(tmpdir(), 'gb-plugin-host-'));
    const stage = stageCleanTree();
    try {
      const codexHome = join(host, '.codex');
      const run = makeCodexRunner(host);

      // (a) marketplace add from the CLEAN staged tree (local-path source).
      const addMkt = run([CODEX_BIN!, 'plugin', 'marketplace', 'add', stage]);
      expect(addMkt.code, addMkt.stderr).toBe(0);
      const mktList = run([CODEX_BIN!, 'plugin', 'marketplace', 'list']);
      expect(mktList.stdout).toContain('gbrain');

      // (b) plugin add — the exact command the docs headline.
      const addPlugin = run([CODEX_BIN!, 'plugin', 'add', 'gbrain@gbrain']);
      expect(addPlugin.code, addPlugin.stderr).toBe(0);
      expect(codexPluginProvidesName(join(codexHome, 'config.toml'), 'gbrain')).toBe('gbrain@gbrain');

      // (c) snapshot contents: curated skills, NON-ROOT mcp.json honored,
      // launcher exec bit survived the copy.
      const snap = findSnapshotRoot(codexHome) ?? findSnapshotRoot(host);
      expect(snap, 'no plugin snapshot with .codex-plugin/mcp.json found under the hermetic home').toBeTruthy();
      expect(existsSync(join(snap!, 'plugin', 'skills', 'cold-start', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(snap!, 'plugin', 'skills', 'setup', 'SKILL.md'))).toBe(true);
      // Curation held: repo-dev skills are NOT in the snapshot tree.
      expect(existsSync(join(snap!, 'plugin', 'skills', 'testing'))).toBe(false);
      expect(existsSync(join(snap!, 'plugin', 'skills', 'skillify'))).toBe(false);
      const launcher = join(snap!, '.agents', 'gbrain-launcher');
      expect(existsSync(launcher)).toBe(true);
      expect(statSync(launcher).mode & 0o111, 'launcher lost its exec bit in the snapshot copy').toBeGreaterThan(0);
      const mcpJson = JSON.parse(readFileSync(join(snap!, '.codex-plugin', 'mcp.json'), 'utf8'));
      const serverArgs: string[] = mcpJson.mcpServers.gbrain.args;
      expect(serverArgs).toEqual(['serve', '--surface', 'starter', '--source-guard']);

      // (d) idempotency: add twice each — state stays sane (exactly one
      // gbrain@gbrain row; outcome recorded in the evidence, not softened).
      const addMkt2 = run([CODEX_BIN!, 'plugin', 'marketplace', 'add', stage]);
      const addPlugin2 = run([CODEX_BIN!, 'plugin', 'add', 'gbrain@gbrain']);
      console.log(`[idempotency] marketplace re-add exit=${addMkt2.code}; plugin re-add exit=${addPlugin2.code}`);
      const list = run([CODEX_BIN!, 'plugin', 'list']);
      const rows = list.stdout.split('\n').filter((l) => l.includes('gbrain@gbrain'));
      expect(rows.length, `dual-marketplace/idempotency: expected exactly one gbrain@gbrain row:\n${list.stdout}`).toBe(1);

      // (e) deterministic surface oracle: tools/list through the SNAPSHOT
      // launcher == the starter surface (never an LLM-output assertion).
      const binDir = mkdtempSync(join(tmpdir(), 'gb-plugin-bin-'));
      const gbrainBin = gbrainBinForTests(binDir);
      const seededHome = mkdtempSync(join(tmpdir(), 'gb-plugin-brain-'));
      await seedBrainForAgent(seededHome, 'workspace');
      const probeEnv = hermeticChildEnv({
        HOME: seededHome,
        GBRAIN_BIN: gbrainBin,
        GBRAIN_HOME: seededHome,
        GBRAIN_SOURCE: 'workspace',
      });
      const { tools } = await mcpToolsListProbe({
        command: launcher,
        args: serverArgs,
        cwd: snap!,
        env: probeEnv,
        timeoutMs: 120_000,
      });
      const expected = filterOpsForSurface(operations, 'starter').map((o) => o.name).sort();
      expect(tools.sort()).toEqual(expected);

      // (f) cold-home fast-fail: fresh empty GBRAIN_HOME → actionable exit,
      // never a hang or silent auto-init.
      const coldHome = mkdtempSync(join(tmpdir(), 'gb-plugin-cold-'));
      const cold = spawnSync(launcher, serverArgs, {
        cwd: snap!,
        encoding: 'utf8',
        env: hermeticChildEnv({ HOME: coldHome, GBRAIN_BIN: gbrainBin, GBRAIN_HOME: coldHome }) as Record<string, string>,
        timeout: 60_000,
      });
      expect(cold.status).not.toBe(0);
      expect(cold.stderr).toContain('No brain configured');
      expect(cold.stderr).toContain('gbrain init');

      // (g) --source-guard: a GENUINELY AMBIGUOUS brain (default + TWO
      // non-default sources, so resolution can't land on the unambiguous
      // sole_non_default tier) → an env-less write via the plugin serve is
      // BLOCKED with the actionable envelope; GBRAIN_SOURCE unblocks it.
      // (A sole-source brain is unambiguous and correctly NOT blocked — that
      // is the guard's contract, so it can't be the block fixture.)
      const guardHome = mkdtempSync(join(tmpdir(), 'gb-plugin-guard-'));
      await seedBrainForAgent(guardHome, 'workspace');
      {
        const { createEngine } = await import('../../src/core/engine-factory.ts');
        const { addSource } = await import('../../src/core/sources-ops.ts');
        const dbPath = join(guardHome, '.gbrain', 'brain.pglite');
        const cfg = { engine: 'pglite' as const, database_path: dbPath };
        const eng = await createEngine(cfg);
        await eng.connect(cfg);
        const secondDir = join(guardHome, 'source-notes');
        mkdirSync(secondDir, { recursive: true });
        await addSource(eng, { id: 'notes', localPath: secondDir, force: true });
        await eng.disconnect();
      }
      const blocked = await mcpToolCallProbe({
        command: launcher,
        args: serverArgs,
        cwd: snap!,
        env: hermeticChildEnv({ HOME: guardHome, GBRAIN_BIN: gbrainBin, GBRAIN_HOME: guardHome }),
        tool: 'remember',
        params: { content: 'guard probe', provenance: 'e2e source-guard probe' },
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain('source_binding_required');
      const allowed = await mcpToolCallProbe({
        command: launcher,
        args: serverArgs,
        cwd: snap!,
        env: hermeticChildEnv({ HOME: guardHome, GBRAIN_BIN: gbrainBin, GBRAIN_HOME: guardHome, GBRAIN_SOURCE: 'workspace' }),
        tool: 'remember',
        params: { content: 'guard probe ok', provenance: 'e2e source-guard probe' },
      });
      expect(allowed.text).not.toContain('source_binding_required');
      rmSync(guardHome, { recursive: true, force: true });

      // (h) coexistence probe: a hand-wired `codex mcp add` NEXT TO the
      // plugin — record the deterministic outcome; both owners visible in
      // config.toml afterward (the doctor-warn scenario).
      const coexist = run([CODEX_BIN!, 'mcp', 'add', 'gbrain', '--', '/bin/echo', 'noop']);
      console.log(`[coexistence] codex mcp add next to plugin: exit=${coexist.code} stderr=${coexist.stderr.slice(0, 200)}`);
      if (coexist.code === 0) {
        const toml2 = readFileSync(join(codexHome, 'config.toml'), 'utf8');
        expect(toml2).toContain('[mcp_servers.gbrain]');
        expect(codexPluginProvidesName(join(codexHome, 'config.toml'), 'gbrain')).toBe('gbrain@gbrain');
      }

      // (i) removal: the uninstall path is part of the contract (removal is
      // marketplace-qualified: `codex plugin remove gbrain@gbrain`).
      const remove = run([CODEX_BIN!, 'plugin', 'remove', 'gbrain@gbrain']);
      expect(remove.code, remove.stderr).toBe(0);
      expect(codexPluginProvidesName(join(codexHome, 'config.toml'), 'gbrain')).toBeNull();

      rmSync(binDir, { recursive: true, force: true });
      rmSync(seededHome, { recursive: true, force: true });
      rmSync(coldHome, { recursive: true, force: true });
    } finally {
      for (const d of [host, stage]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 600_000);
});

describe.skipIf(!PLUGIN_CAPABLE || !hasCodexAuth())('codex plugin door — SMOKE (live turn)', () => {
  test('plugin-provided MCP server answers from the brain; missing binary degrades, not bricks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-plugin-smoke-'));
    const stage = stageCleanTree();
    try {
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: home });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: home });

      const sourceId = 'workspace';
      const seeded = await seedBrainForAgent(home, sourceId);

      // Hermetic ~/.codex with the operator's auth, then install the PLUGIN —
      // no `codex mcp add` anywhere in this test.
      const codexHome = join(home, '.codex');
      mkdirSync(codexHome, { recursive: true });
      const realAuth = join(process.env.HOME ?? '', '.codex', 'auth.json');
      if (existsSync(realAuth)) {
        try { writeFileSync(join(codexHome, 'auth.json'), readFileSync(realAuth)); } catch { /* best-effort */ }
      }
      for (const f of ['AGENTS.md', 'SOUL.md']) {
        writeFileSync(join(codexHome, f), '<!-- hermetic test placeholder -->\n');
      }
      const run = makeCodexRunner(home);
      expect(run([CODEX_BIN!, 'plugin', 'marketplace', 'add', stage]).code).toBe(0);
      expect(run([CODEX_BIN!, 'plugin', 'add', 'gbrain@gbrain']).code).toBe(0);

      const binDir = mkdtempSync(join(tmpdir(), 'gb-plugin-smoke-bin-'));
      const gbrainBin = gbrainBinForTests(binDir);
      const extraEnv = { GBRAIN_BIN: gbrainBin, GBRAIN_HOME: home, GBRAIN_SOURCE: sourceId };

      const prompt =
        `You have a gbrain MCP tool connected to a knowledge brain (provided by the gbrain plugin). ` +
        `Using ONLY that brain (do not guess, do not use general knowledge), answer: ` +
        `${seeded.query} Report exactly what the brain says.`;

      const fact = 'rivermouth';
      const maxAttempts = 2;
      let passed = false;
      let lastEvidence = '';
      for (let attempt = 1; attempt <= maxAttempts && !passed; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 3_000));
        const turn = await codexExecTurn({ prompt, cwd: home, home, timeoutMs: 230_000, extraEnv });
        const usedMcp = turn.mcpToolCalls.some((c) => c.server === 'gbrain');
        const gotFact = turn.finalText.toLowerCase().includes(fact);
        lastEvidence =
          `[plugin smoke attempt ${attempt}/${maxAttempts}] exit=${turn.exitCode} timedOut=${turn.timedOut} ` +
          `usedMcp=${usedMcp} gotFact=${gotFact}\nmcpToolCalls=${JSON.stringify(turn.mcpToolCalls)}\n` +
          `finalText=${turn.finalText.slice(0, 800)}`;
        console.log(lastEvidence);
        if (usedMcp && gotFact) passed = true;
      }
      expect(passed, `plugin SMOKE failed on all ${maxAttempts} attempts.\n${lastEvidence}`).toBe(true);

      // Recovery-loop probe (CX2): with NO gbrain binary reachable, the
      // session must still complete a trivial turn — the plugin degrades
      // (launcher exits 127 with the install one-liner), never bricks codex.
      const brokenTurn = await codexExecTurn({
        prompt: 'Reply with exactly: session alive',
        cwd: home,
        home,
        timeoutMs: 120_000,
        extraEnv: { GBRAIN_BIN: '/nonexistent/gbrain', GBRAIN_HOME: home },
      });
      console.log(`[recovery] exit=${brokenTurn.exitCode} finalText=${brokenTurn.finalText.slice(0, 200)}`);
      expect(brokenTurn.finalText.toLowerCase()).toContain('session alive');

      rmSync(binDir, { recursive: true, force: true });
    } finally {
      for (const d of [home, stage]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 900_000);
});
