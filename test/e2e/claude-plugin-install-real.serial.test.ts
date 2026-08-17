/**
 * REAL-binary door test — the gbrain CLAUDE CODE PLUGIN (the codex door's
 * sibling; see codex-plugin-install-real.serial.test.ts for the full contract
 * map). Stages a CLEAN tree via `git archive HEAD`, then:
 *
 *   1. VALIDATE + INSTALL (no auth turn): `claude plugin validate . --strict`,
 *      `claude plugin marketplace add <stage>`, `claude plugin install
 *      gbrain@gbrain` — asserts the enable entry lands in the hermetic
 *      CLAUDE_CONFIG_DIR settings (the exact shape claudePluginProvidesName
 *      scans) and uninstall clears it.
 *
 *   2. SMOKE (live `claude -p` turn): the session's gbrain MCP server comes
 *      from the PLUGIN (inline mcpServers via ${CLAUDE_PLUGIN_ROOT} launcher);
 *      GBRAIN_* rides the parent env into the launcher. Asserts a gbrain MCP
 *      tool call in the stream AND the seeded fact in the final text.
 *
 * Hermetic per test; self-skips without a plugin-capable claude binary; the
 * SMOKE half additionally needs ANTHROPIC auth (claude's own login state).
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveClaudeBinary,
  claudeSupportsPlugins,
  hasClaudeAuth,
  claudeHeadlessTurn,
  seedBrainForAgent,
  hermeticChildEnv,
  ensureCompiledGbrain,
} from '../helpers/agent-harness.ts';
import { claudePluginProvidesName } from '../../src/core/bootstrap/harness.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const CLAUDE_BIN = resolveClaudeBinary();
const PLUGIN_CAPABLE = !!CLAUDE_BIN && claudeSupportsPlugins(CLAUDE_BIN);

function stageCleanTree(): string {
  const stage = mkdtempSync(join(tmpdir(), 'gb-cplugin-stage-'));
  execFileSync('sh', ['-c', `git -C '${REPO_ROOT}' archive HEAD | tar -x -C '${stage}'`]);
  return stage;
}

function gbrainBinForTests(dir: string): string {
  const compiled = ensureCompiledGbrain(REPO_ROOT);
  if (compiled.binPath) return compiled.binPath;
  const shim = join(dir, 'gbrain-shim');
  writeFileSync(shim, `#!/bin/sh\nexec bun run '${CLI}' "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function makeClaudeRunner(home: string, configDir: string) {
  return (argv: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      env: hermeticChildEnv({ HOME: home, CLAUDE_CONFIG_DIR: configDir, ...extraEnv }) as Record<string, string>,
      timeout: 120_000,
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

describe.skipIf(!PLUGIN_CAPABLE)('claude plugin door — VALIDATE + INSTALL (no live turn)', () => {
  test('validate --strict → marketplace add → install → enable entry → uninstall', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-cplugin-host-'));
    const configDir = join(home, '.claude');
    mkdirSync(configDir, { recursive: true });
    const stage = stageCleanTree();
    try {
      const run = makeClaudeRunner(home, configDir);

      // (a) The shipped manifests validate strict-clean.
      const validate = run([CLAUDE_BIN!, 'plugin', 'validate', stage, '--strict']);
      expect(validate.code, validate.stdout + validate.stderr).toBe(0);

      // (b) marketplace add from the CLEAN staged tree.
      const addMkt = run([CLAUDE_BIN!, 'plugin', 'marketplace', 'add', stage]);
      expect(addMkt.code, addMkt.stderr).toBe(0);

      // (c) install — enable entry lands in the hermetic settings, in the
      // exact shape the coexistence detector scans.
      const install = run([CLAUDE_BIN!, 'plugin', 'install', 'gbrain@gbrain']);
      expect(install.code, install.stderr).toBe(0);
      const settingsPath = join(configDir, 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      expect(claudePluginProvidesName(settingsPath, 'gbrain')).toBe('gbrain@gbrain');

      // (d) uninstall clears the enable entry.
      const un = run([CLAUDE_BIN!, 'plugin', 'uninstall', 'gbrain@gbrain']);
      expect(un.code, un.stderr).toBe(0);
      expect(claudePluginProvidesName(settingsPath, 'gbrain')).toBeNull();
    } finally {
      for (const d of [home, stage]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 300_000);

  // Persona variant (cathedral-7, prove-before-publish [CX11]): the
  // marketplace's gbrain-coding entry installs from its self-contained
  // variant root BEFORE the entries ship to real users.
  test('persona variant gbrain-coding installs from the same marketplace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-cplugin-variant-'));
    const configDir = join(home, '.claude');
    mkdirSync(configDir, { recursive: true });
    const stage = stageCleanTree();
    try {
      const run = makeClaudeRunner(home, configDir);
      const addMkt = run([CLAUDE_BIN!, 'plugin', 'marketplace', 'add', stage]);
      expect(addMkt.code, addMkt.stderr).toBe(0);

      const install = run([CLAUDE_BIN!, 'plugin', 'install', 'gbrain-coding@gbrain']);
      expect(install.code, install.stderr).toBe(0);
      const settingsPath = join(configDir, 'settings.json');
      expect(claudePluginProvidesName(settingsPath, 'gbrain-coding')).toBe('gbrain-coding@gbrain');

      const un = run([CLAUDE_BIN!, 'plugin', 'uninstall', 'gbrain-coding@gbrain']);
      expect(un.code, un.stderr).toBe(0);
      expect(claudePluginProvidesName(settingsPath, 'gbrain-coding')).toBeNull();
    } finally {
      for (const d of [home, stage]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 300_000);
});

describe.skipIf(!PLUGIN_CAPABLE || !hasClaudeAuth())('claude plugin door — SMOKE (live turn)', () => {
  test('plugin-provided MCP server answers from the brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-cplugin-smoke-'));
    const configDir = join(home, '.claude');
    mkdirSync(configDir, { recursive: true });
    const stage = stageCleanTree();
    try {
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: home });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: home });

      const sourceId = 'workspace';
      const seeded = await seedBrainForAgent(home, sourceId);

      const run = makeClaudeRunner(home, configDir);
      expect(run([CLAUDE_BIN!, 'plugin', 'marketplace', 'add', stage]).code).toBe(0);
      expect(run([CLAUDE_BIN!, 'plugin', 'install', 'gbrain@gbrain']).code).toBe(0);

      const binDir = mkdtempSync(join(tmpdir(), 'gb-cplugin-bin-'));
      const gbrainBin = gbrainBinForTests(binDir);

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
        const turn = await claudeHeadlessTurn({
          prompt,
          cwd: home,
          home,
          claudeConfigDir: configDir,
          timeoutMs: 230_000,
          extraEnv: { GBRAIN_BIN: gbrainBin, GBRAIN_HOME: home, GBRAIN_SOURCE: sourceId },
        });
        // Plugin-provided servers are plugin-namespaced (observed live:
        // `mcp__plugin_gbrain_gbrain__search`); a bootstrap-lane server would
        // be `mcp__gbrain__…`. Match both shapes.
        const usedMcp = turn.toolCalls.some((c) => /^mcp__.*gbrain.*__/.test(c));
        const gotFact = turn.finalText.toLowerCase().includes(fact);
        lastEvidence =
          `[claude plugin smoke attempt ${attempt}/${maxAttempts}] exit=${turn.exitCode} ` +
          `timedOut=${turn.timedOut} usedMcp=${usedMcp} gotFact=${gotFact}\n` +
          `toolCalls=${JSON.stringify(turn.toolCalls)}\nfinalText=${turn.finalText.slice(0, 800)}`;
        console.log(lastEvidence);
        if (usedMcp && gotFact) passed = true;
      }
      expect(passed, `claude plugin SMOKE failed on all ${maxAttempts} attempts.\n${lastEvidence}`).toBe(true);

      rmSync(binDir, { recursive: true, force: true });
    } finally {
      for (const d of [home, stage]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 900_000);
});
