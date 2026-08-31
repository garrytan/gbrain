/**
 * Plugin-lane coexistence — the codex/claude plugin as a third owner of the
 * `gbrain` MCP server name.
 *
 * Three layers:
 *   1. Detectors (harness.ts): plugin-enable config scans (line-anchored,
 *      fail-open) + the doctor-side any-registration scans that deliberately
 *      count foreign/manual entries.
 *   2. runHooks: plugin present → the MCP substep skips (no `mcp add` argv,
 *      no registration smoke) while hooks and every other phase proceed,
 *      EXIT 0 (a healthy plugin-owned skip is NOT the exit-2 host-failure
 *      mcpSkipped state), receipt records plugin ownership;
 *      plugin absent → the registration argv executes exactly as today
 *      (REGRESSION pin); --mcp-even-if-plugin forces registration through.
 *   3. Doctor: plugin_lane_collision rows — warn only on a real
 *      double-registration, ok when the plugin is sole owner, silent when no
 *      plugin is enabled.
 *
 * Serial: mutates GBRAIN_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR / HOME.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBootstrap } from '../src/commands/bootstrap.ts';
import { bootstrapDoctorChecks } from '../src/commands/doctor.ts';
import {
  codexPluginProvidesName,
  claudePluginProvidesName,
  codexAnyRegistrationExists,
  claudeAnyRegistrationExists,
} from '../src/core/bootstrap/harness.ts';
import { initState, setAnswer, readBackHash, confirm } from '../src/core/bootstrap/interview.ts';
import { readReceipt } from '../src/core/bootstrap/format.ts';

const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Lanekeeper',
  PRINCIPAL_NAME: 'Alice Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research lab; ships a memo every Friday.',
  VOICE_REGISTER: 'Direct. Three options, the second one wins.',
};

const ENABLED_PLUGIN_TOML = `
[projects."/tmp/x"]
trust_level = "trusted"

[plugins."gbrain@gbrain"]
enabled = true

[mcp_servers.other]
command = "/bin/other"
`;

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `gb-plugin-lane-${name}-`));
}

function writeCodexConfig(dir: string, content: string): string {
  const p = join(dir, 'config.toml');
  writeFileSync(p, content);
  return p;
}

describe('codexPluginProvidesName', () => {
  const dir = tmp('codex-detect');

  test('enabled plugin → marketplace-qualified id', () => {
    const p = writeCodexConfig(dir, ENABLED_PLUGIN_TOML);
    expect(codexPluginProvidesName(p, 'gbrain')).toBe('gbrain@gbrain');
  });

  test('other marketplace name is reported', () => {
    const p = writeCodexConfig(dir, '[plugins."gbrain@my-fork"]\nenabled = true\n');
    expect(codexPluginProvidesName(p, 'gbrain')).toBe('gbrain@my-fork');
  });

  test('disabled plugin → null', () => {
    const p = writeCodexConfig(dir, '[plugins."gbrain@gbrain"]\nenabled = false\n');
    expect(codexPluginProvidesName(p, 'gbrain')).toBeNull();
  });

  test('enabled key in the NEXT table never leaks backward', () => {
    const p = writeCodexConfig(dir, '[plugins."gbrain@gbrain"]\n\n[plugins."other@x"]\nenabled = true\n');
    expect(codexPluginProvidesName(p, 'gbrain')).toBeNull();
  });

  test('commented-out lookalike header → null (line-anchored scan)', () => {
    const p = writeCodexConfig(dir, '# [plugins."gbrain@gbrain"]\n# enabled = true\n');
    expect(codexPluginProvidesName(p, 'gbrain')).toBeNull();
  });

  test('different plugin name → null; absent file → null; malformed → null', () => {
    const p = writeCodexConfig(dir, '[plugins."other-plugin@gbrain"]\nenabled = true\n');
    expect(codexPluginProvidesName(p, 'gbrain')).toBeNull();
    expect(codexPluginProvidesName(join(dir, 'nope.toml'), 'gbrain')).toBeNull();
  });
});

describe('claudePluginProvidesName', () => {
  const dir = tmp('claude-detect');

  test('enabledPlugins true → id; false → null; absent key → null', () => {
    const p = join(dir, 'settings.json');
    writeFileSync(p, JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true, 'ruby-lsp@official': true } }));
    expect(claudePluginProvidesName(p, 'gbrain')).toBe('gbrain@gbrain');
    writeFileSync(p, JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': false } }));
    expect(claudePluginProvidesName(p, 'gbrain')).toBeNull();
    writeFileSync(p, JSON.stringify({ enabledPlugins: { 'other@x': true } }));
    expect(claudePluginProvidesName(p, 'gbrain')).toBeNull();
  });

  test('missing file / malformed JSON → null (fail-open)', () => {
    expect(claudePluginProvidesName(join(dir, 'nope.json'), 'gbrain')).toBeNull();
    const p = join(dir, 'broken.json');
    writeFileSync(p, '{not json');
    expect(claudePluginProvidesName(p, 'gbrain')).toBeNull();
  });
});

describe('any-registration scans (doctor-side, counts foreign entries)', () => {
  const dir = tmp('any-reg');

  test('codex: plain and quoted table headers match; comments and absence do not', () => {
    expect(codexAnyRegistrationExists(writeCodexConfig(dir, '[mcp_servers.gbrain]\ncommand = "/x"\n'), 'gbrain')).toBe(true);
    expect(codexAnyRegistrationExists(writeCodexConfig(dir, '[mcp_servers."gbrain"]\nurl = "https://x"\n'), 'gbrain')).toBe(true);
    expect(codexAnyRegistrationExists(writeCodexConfig(dir, '# [mcp_servers.gbrain]\n'), 'gbrain')).toBe(false);
    expect(codexAnyRegistrationExists(writeCodexConfig(dir, '[mcp_servers.other]\n'), 'gbrain')).toBe(false);
    expect(codexAnyRegistrationExists(join(dir, 'nope.toml'), 'gbrain')).toBe(false);
  });

  test('claude: user config and project .mcp.json both count', () => {
    const userCfg = join(dir, 'claude.json');
    writeFileSync(userCfg, JSON.stringify({ mcpServers: { gbrain: { command: 'gbrain' } } }));
    expect(claudeAnyRegistrationExists(userCfg, 'gbrain')).toBe(true);

    const project = join(dir, 'proj');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { gbrain: {} } }));
    expect(claudeAnyRegistrationExists(join(dir, 'absent.json'), 'gbrain', project)).toBe(true);
    expect(claudeAnyRegistrationExists(join(dir, 'absent.json'), 'gbrain', join(dir, 'empty-proj'))).toBe(false);
  });
});

// ── runHooks lane behavior ──────────────────────────────────────────────────

describe('runHooks plugin-lane skip (serial: env fixtures)', () => {
  let tmpParent: string;
  let ws: string;
  let codexHome: string;
  let claudeConfigDir: string;
  const saved: Record<string, string | undefined> = {};

  function makeRunner() {
    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      return { code: 0, stdout: '', stderr: '' };
    };
    return { runner, calls };
  }

  async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
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

  beforeAll(async () => {
    tmpParent = tmp('hooks');
    ws = join(tmpParent, 'ws');
    mkdirSync(ws, { recursive: true });
    codexHome = join(tmpParent, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    claudeConfigDir = join(tmpParent, 'claude-config');
    mkdirSync(claudeConfigDir, { recursive: true });

    for (const key of ['GBRAIN_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const) saved[key] = process.env[key];
    process.env.GBRAIN_HOME = tmpParent;
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    expect(initState(ws).ok).toBe(true);
    for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
      const r = setAnswer(ws, key, value);
      if (!r.ok) throw new Error(r.message);
    }
    expect(setAnswer(ws, 'MCP_SCOPE', 'project').ok).toBe(true);
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    expect(confirm(ws, h.hash).ok).toBe(true);
    const render = await capture(() => runBootstrap(['render', '--workspace', ws]));
    expect(render.result).toBe(0);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmpParent, { recursive: true, force: true });
  });

  test('codex + enabled plugin → MCP substep skipped, exit 0, plugin-mcp receipt', async () => {
    writeFileSync(join(codexHome, 'config.toml'), ENABLED_PLUGIN_TOML);
    const { runner, calls } = makeRunner();
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'codex', '--gbrain-bin', process.execPath], { runner }),
    );
    expect(r.result).toBe(0); // HEALTHY skip — never the exit-2 mcpSkipped state
    expect(r.out).toContain("the 'gbrain@gbrain' plugin already provides the gbrain MCP server");
    expect(r.out).toContain('GBRAIN_SOURCE=');
    expect(r.out).toContain('--mcp-even-if-plugin');
    // No `codex mcp add` argv, and no registration-smoke probes either.
    expect(calls.some((c) => c[0] === 'codex')).toBe(false);
    const receipt = readReceipt(join(tmpParent, '.gbrain'));
    // MCP stays plugin-owned, but the SessionEnd hook (memorable wave) is
    // bootstrap-written even on plugin installs — the receipt records both.
    expect(receipt?.registrations?.at(-1)).toEqual({ host: 'codex', scope: 'user', detail: 'hooks+plugin-mcp' });
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
  }, 30_000);

  test('codex + NO plugin → registration argv executes exactly as today (REGRESSION pin)', async () => {
    writeFileSync(join(codexHome, 'config.toml'), '[projects."/tmp/x"]\ntrust_level = "trusted"\n');
    const { runner, calls } = makeRunner();
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'codex', '--gbrain-bin', process.execPath], { runner }),
    );
    expect(r.result).toBe(0);
    const add = calls.find((c) => c[0] === 'codex' && c[1] === 'mcp' && c[2] === 'add');
    expect(add).toBeDefined();
    expect(add!.join(' ')).toContain('serve --surface full');
  }, 30_000);

  test('codex + plugin + --mcp-even-if-plugin → registration forced through', async () => {
    writeFileSync(join(codexHome, 'config.toml'), ENABLED_PLUGIN_TOML);
    const { runner, calls } = makeRunner();
    const r = await capture(() =>
      runBootstrap(
        ['hooks', '--workspace', ws, '--harness', 'codex', '--gbrain-bin', process.execPath, '--mcp-even-if-plugin'],
        { runner },
      ),
    );
    expect(r.result).toBe(0);
    expect(calls.some((c) => c[0] === 'codex' && c[2] === 'add')).toBe(true);
  }, 30_000);

  test('claude-code + enabled plugin → MCP skipped but hooks STILL install (the CX6 fix)', async () => {
    writeFileSync(
      join(claudeConfigDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true } }),
    );
    const { runner, calls } = makeRunner();
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', process.execPath], {
        runner,
      }),
    );
    expect(r.result).toBe(0);
    expect(calls.some((c) => c[0] === 'claude' && c[2] === 'add')).toBe(false);
    // Hooks (and the rest of runHooks) proceeded — the skip is MCP-substep-scoped.
    expect(existsSync(join(ws, '.claude', 'settings.local.json'))).toBe(true);
    const receipt = readReceipt(join(tmpParent, '.gbrain'));
    expect(receipt?.registrations?.at(-1)).toEqual({ host: 'claude-code', scope: 'project', detail: 'hooks+plugin-mcp' });
  }, 30_000);
});

// ── Doctor rows ─────────────────────────────────────────────────────────────

describe('doctor plugin_lane_collision (serial: env fixtures)', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    dir = tmp('doctor');
    for (const key of ['GBRAIN_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HOME'] as const) saved[key] = process.env[key];
    process.env.GBRAIN_HOME = dir; // fresh home: no bootstrap state
    process.env.CODEX_HOME = join(dir, 'codex-home');
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-config');
    process.env.HOME = join(dir, 'home');
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    mkdirSync(process.env.HOME, { recursive: true });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('no plugin enabled → no plugin_lane_collision rows (zero noise)', async () => {
    writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), '[mcp_servers.gbrain]\ncommand = "/x"\n');
    const checks = await bootstrapDoctorChecks(null);
    expect(checks.filter((c) => c.name === 'plugin_lane_collision')).toEqual([]);
  });

  test('plugin sole owner → ok row', async () => {
    writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), '[plugins."gbrain@gbrain"]\nenabled = true\n');
    const checks = await bootstrapDoctorChecks(null);
    const rows = checks.filter((c) => c.name === 'plugin_lane_collision');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].message).toContain('no hand-wired registration');
  });

  test('plugin + hand-wired registration → warn row with both off-ramps', async () => {
    writeFileSync(
      join(process.env.CODEX_HOME!, 'config.toml'),
      '[plugins."gbrain@gbrain"]\nenabled = true\n\n[mcp_servers.gbrain]\ncommand = "/x"\n',
    );
    const checks = await bootstrapDoctorChecks(null);
    const rows = checks.filter((c) => c.name === 'plugin_lane_collision');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('warn');
    expect(rows[0].message).toContain('codex mcp remove gbrain');
    expect(rows[0].message).toContain('codex plugin remove gbrain');
    expect(rows[0].message).toContain('config signal, not a health signal');
  });

  test('claude plugin + user-config registration → warn on the claude lane', async () => {
    writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), '');
    writeFileSync(
      join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true } }),
    );
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: {} } }));
    const checks = await bootstrapDoctorChecks(null);
    const rows = checks.filter((c) => c.name === 'plugin_lane_collision');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('warn');
    expect(rows[0].message).toContain('claude-code');
  });
});
