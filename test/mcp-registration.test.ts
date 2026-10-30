/**
 * One surface for every stdio registration gbrain writes
 * (src/core/mcp-registration.ts): readiness (Claude Code, Codex, opencode),
 * init's quickstart line, `registerClaudeMcp` / `registerCodexMcp`, and the
 * plugin generator all build from REGISTRATION_SURFACE through
 * `stdioServeArgv`; `registeredSurface` reads an existing entry's form for
 * never-narrow. The opencode user/project writer and the exec-lane
 * replacement are driven end to end in bootstrap-opencode-door.serial and
 * bootstrap-dispatcher.serial.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PLUGIN_SURFACE, REGISTRATION_ADVERTISE, REGISTRATION_SURFACE, registeredAdvertise, registeredSurface, registrationAdvertise, stdioServeArgv } from '../src/core/mcp-registration.ts';
import { harnessWiringEntry } from '../src/core/readiness.ts';
import { registerClaudeMcp, registerCodexMcp } from '../src/core/bootstrap/hooks.ts';
import { resolveSurfaceWithSource } from '../src/mcp/surface.ts';

const BIN = '/opt/example/bin/gbrain';
const ROOT = resolve(import.meta.dir, '..');
const wiring = (h: 'claude-code' | 'codex' | 'opencode', surface?: 'verbs' | 'starter' | 'full') =>
  harnessWiringEntry({ transport: 'cli', harnesses: [h], lockOwner: null, gbrainBin: BIN, ...(surface ? { surface } : {}) }).fix;

describe('REGISTRATION_SURFACE and stdioServeArgv', () => {
  test('new registrations pin starter (Garry, 2026-10-24); plugins stay full; null renders a bare serve', () => {
    expect(REGISTRATION_SURFACE).toBe('starter');
    expect(PLUGIN_SURFACE).toBe('full');
    expect(stdioServeArgv(BIN)).toEqual([BIN, 'serve', '--surface', 'starter']);
    expect(stdioServeArgv(BIN, 'starter')).toEqual([BIN, 'serve', '--surface', 'starter']);
    expect(stdioServeArgv(BIN, 'full')).toEqual([BIN, 'serve', '--surface', 'full']);
    expect(stdioServeArgv(BIN, null)).toEqual([BIN, 'serve']);
  });

  test('new registrations list the memory verbs; --advertise is written only when narrower than the surface', () => {
    expect(REGISTRATION_ADVERTISE).toBe('verbs');
    expect(stdioServeArgv(BIN, REGISTRATION_SURFACE, REGISTRATION_ADVERTISE)).toEqual([BIN, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(stdioServeArgv(BIN, 'starter', 'verbs')).toEqual([BIN, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(stdioServeArgv(BIN, 'verbs', 'verbs')).toEqual([BIN, 'serve', '--surface', 'verbs']);
    expect(stdioServeArgv(BIN, null, 'verbs')).toEqual([BIN, 'serve']);
  });

  test('registrationAdvertise: a chosen surface lists in full, an existing registration keeps its listing, a new one lists the verbs', () => {
    expect(registrationAdvertise({ userChoseSurface: false })).toBe('verbs');
    expect(registrationAdvertise({ userChoseSurface: true })).toBeNull();
    expect(registrationAdvertise({ userChoseSurface: false, prior: {} })).toBeNull();
    expect(registrationAdvertise({ userChoseSurface: false, prior: { advertise: 'starter' } })).toBe('starter');
    expect(registrationAdvertise({ userChoseSurface: true, prior: { advertise: 'verbs' } })).toBeNull();
  });

  test('registeredAdvertise reads an existing registration\'s listing', () => {
    expect(registeredAdvertise(`${BIN} serve --surface full --advertise verbs`)).toBe('verbs');
    expect(registeredAdvertise('Args: serve --surface full --advertise=starter')).toBe('starter');
    expect(registeredAdvertise(`${BIN} serve --surface full`)).toBeNull();
  });

  test('registeredSurface reads a pinned value, a bare serve, or nothing', () => {
    expect(registeredSurface(`gbrain:\n  Command: ${BIN}\n  Args: serve --surface full\n`)).toBe('full');
    expect(registeredSurface(`${BIN} serve --surface=verbs --source-guard`)).toBe('verbs');
    expect(registeredSurface(`gbrain:\n  Command: ${BIN}\n  Args: serve\n`)).toBeNull();
    expect(registeredSurface('gbrain: http https://brain.example/mcp')).toBeUndefined();
  });
});

describe('every stdio registration path builds from REGISTRATION_SURFACE', () => {
  test('readiness harness_wiring: Claude Code and Codex pin the surface; opencode runs bootstrap hooks', () => {
    expect(wiring('claude-code')?.argv).toEqual(['claude', 'mcp', 'add', 'gbrain', '--', ...stdioServeArgv(BIN, REGISTRATION_SURFACE, REGISTRATION_ADVERTISE)]);
    expect(wiring('codex')?.argv).toEqual(['codex', 'mcp', 'add', 'gbrain', '--', ...stdioServeArgv(BIN, REGISTRATION_SURFACE, REGISTRATION_ADVERTISE)]);
    expect(wiring('opencode')?.argv).toEqual(['gbrain', 'bootstrap', 'hooks', '--harness', 'opencode', '--no-hooks']);
    expect(wiring('claude-code')?.why).toContain(`${BIN} serve --surface starter --advertise verbs`);
  });

  test('init --surface reaches the readiness fix (the quickstart line and the first-run harness decision read it)', () => {
    expect(wiring('claude-code', 'starter')?.argv).toEqual(['claude', 'mcp', 'add', 'gbrain', '--', BIN, 'serve', '--surface', 'starter']);
    expect(wiring('opencode', 'verbs')?.argv).toEqual(['gbrain', 'bootstrap', 'hooks', '--harness', 'opencode', '--no-hooks', '--surface', 'verbs']);
    const missing = harnessWiringEntry({ transport: 'cli', harnesses: [], lockOwner: null, gbrainBin: BIN }).fix;
    expect(missing?.why).toContain('serve --surface starter --advertise verbs');
  });

  test('bootstrap hooks: registerClaudeMcp and registerCodexMcp write --advertise when given', () => {
    const claude = registerClaudeMcp({ gbrainBin: BIN, scope: 'user', sourceId: 'workspace', advertise: 'verbs' })[0];
    const codex = registerCodexMcp({ gbrainBin: BIN, sourceId: 'workspace', advertise: 'verbs' })[0];
    expect(claude.slice(claude.indexOf('--') + 1)).toEqual([BIN, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
    expect(codex.slice(codex.indexOf('--') + 1)).toEqual([BIN, 'serve', '--surface', 'starter', '--advertise', 'verbs']);
  });

  test('bootstrap hooks: registerClaudeMcp and registerCodexMcp default to the surface and carry an existing form', () => {
    const claude = registerClaudeMcp({ gbrainBin: BIN, scope: 'user', sourceId: 'workspace' })[0];
    const codex = registerCodexMcp({ gbrainBin: BIN, sourceId: 'workspace' })[0];
    expect(claude.slice(claude.indexOf('--') + 1)).toEqual(stdioServeArgv(BIN));
    expect(codex.slice(codex.indexOf('--') + 1)).toEqual(stdioServeArgv(BIN));
    expect(registerClaudeMcp({ gbrainBin: BIN, scope: 'user', sourceId: 'w', surface: 'starter' })[0].slice(-3)).toEqual(['serve', '--surface', 'starter']);
    expect(registerCodexMcp({ gbrainBin: BIN, sourceId: 'w', surface: null })[0].slice(-2)).toEqual([BIN, 'serve']);
  });

  test('the plugin generator states the plugin surface and refuses a manifest pinned elsewhere', () => {
    const out = mkdtempSync(join(tmpdir(), 'gb-reg-plugin-'));
    try {
      const ok = spawnSync('bun', ['run', join(ROOT, 'scripts/generate-plugin-tree.ts'), '--out', join(out, 'plugin')], { encoding: 'utf8', timeout: 60_000 });
      expect(ok.status, ok.stderr).toBe(0);
      expect(readFileSync(join(out, 'plugin', 'README.md'), 'utf8')).toContain(`gbrain serve --surface ${PLUGIN_SURFACE}`);
      for (const file of ['.codex-plugin/mcp.json', '.claude-plugin/plugin.json']) {
        const args = (JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as { mcpServers: { gbrain: { args: string[] } } }).mcpServers.gbrain.args;
        expect(args[args.indexOf('--surface') + 1]).toBe(PLUGIN_SURFACE);
      }

      const root = join(out, 'fixture');
      mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
      mkdirSync(join(root, 'skills', 'conventions'), { recursive: true });
      mkdirSync(join(root, '.codex-plugin'), { recursive: true });
      writeFileSync(join(root, 'VERSION'), '0.0.0.0\n');
      writeFileSync(join(root, 'openclaw.plugin.json'), JSON.stringify({ name: 'fixture', version: '0.0.0.0', skills: ['skills/alpha'], shared_deps: [] }));
      writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: fixture skill\n---\n# alpha\n');
      writeFileSync(join(root, 'skills', 'manifest.json'), JSON.stringify({ skills: [{ name: 'alpha' }] }));
      writeFileSync(join(root, 'skills', 'plugin-lanes.json'), JSON.stringify({ starter_policy: 'x', additions: {}, base_exclusions: {}, not_added: {}, starter_gaps: {} }));
      writeFileSync(join(root, '.codex-plugin', 'mcp.json'), JSON.stringify({ mcpServers: { gbrain: { command: 'x', args: ['serve', '--surface', 'starter'] } } }));
      const bad = spawnSync('bun', ['run', join(ROOT, 'scripts/generate-plugin-tree.ts'), '--out', join(root, 'out')], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, GBRAIN_PLUGIN_TREE_ROOT: root },
      });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain(`.codex-plugin/mcp.json pins --surface starter; plugin lanes serve the plugin surface '${PLUGIN_SURFACE}'`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

// S0 (wave 0): one surface constant across every install path. Every
// registration command these files show pins REGISTRATION_SURFACE; a bare
// `serve` resolves to the same value. Narrower surfaces stay documented as
// opt-ins in prose, never as a registration command. The dated *-CLI-PIN.md
// files are verification records of what was observed, not install paths.
describe('S0: README, docs/mcp, INSTALL, BOOTSTRAP, push-context and the manifests name one surface', () => {
  const DOCS = [
    'README.md', 'INSTALL_FOR_AGENTS.md', 'BOOTSTRAP_FOR_AGENTS.md', 'docs/guides/push-context.md',
    'docs/INSTALL.md', 'docs/protocol/MEMORY_VERBS_v1.md', 'docs/tutorials/connect-coding-agent.md',
    ...readdirSync(join(ROOT, 'docs/mcp')).filter(f => f.endsWith('.md') && !f.endsWith('-CLI-PIN.md')).map(f => `docs/mcp/${f}`),
  ];

  test('every `serve --surface <x>` in the install docs is the registration surface', () => {
    const offenders: string[] = [];
    for (const file of DOCS) {
      readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/\bserve\b[^`\n|]*?--surface[\s=]+["']?(verbs|starter|full)\b/g)) {
          if (m[1] !== REGISTRATION_SURFACE) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('every harness registration command in the install docs lists the memory verbs (--advertise verbs)', () => {
    const offenders: string[] = [];
    let commands = 0;
    for (const file of DOCS) {
      readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/\bmcp add\b[^`\n|]*?\bserve\b([^`\n|]*)/g)) {
          commands++;
          if (/--access[\s=]+read-only/.test(m[1])) continue;
          if (!new RegExp(`--advertise(?:[\\s=]+|\\s+--arg\\s+)${REGISTRATION_ADVERTISE}\\b`).test(m[1])) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(commands).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  test('the plugin manifests pin the plugin surface (full); the OpenClaw bundle runs a bare serve, whose default is full too', () => {
    for (const file of ['.codex-plugin/mcp.json', '.claude-plugin/plugin.json']) {
      const args = (JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as { mcpServers: { gbrain: { args: string[] } } }).mcpServers.gbrain.args;
      expect({ file, surface: args[args.indexOf('--surface') + 1] }).toEqual({ file, surface: PLUGIN_SURFACE });
    }
    const openclaw = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8')) as { mcpServers: { gbrain: { args: string[] } } };
    expect(openclaw.mcpServers.gbrain.args).toEqual(['serve']);
    expect(resolveSurfaceWithSource(null, {})).toEqual({ surface: PLUGIN_SURFACE, source: 'default' });
  });
});
