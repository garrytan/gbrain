import { describe, expect, test } from 'bun:test';
import {
  REQUIRED_AGENT_TOOLS,
  buildInstalledAgentReadinessReport,
  parseAgentMcpRegistrationOutput,
  parseAgentRulesVersion,
  splitAgentCommand,
} from '../src/core/services/installed-agent-readiness-service.ts';

const rulesBlock = [
  '<!-- MBRAIN:RULES:START -->',
  '<!-- mbrain-agent-rules-version: 0.5.6 -->',
  'Use route_memory_writeback before durable memory writes.',
  'canonical_write_allowed',
  '<!-- MBRAIN:RULES:END -->',
].join('\n');
const rulesContent = [
  '<!-- mbrain-agent-rules-version: 0.5.6 -->',
  'Use route_memory_writeback before durable memory writes.',
  'canonical_write_allowed',
].join('\n');

describe('installed-agent readiness service', () => {
  test('parses agent rules version from prompt content', () => {
    expect(parseAgentRulesVersion(rulesBlock)).toBe('0.5.6');
    expect(parseAgentRulesVersion('no marker')).toBeNull();
  });

  test('splits agent command strings for the default runner', () => {
    expect(splitAgentCommand('mbrain')).toEqual(['mbrain']);
    expect(splitAgentCommand('bun run src/cli.ts')).toEqual(['bun', 'run', 'src/cli.ts']);
    expect(splitAgentCommand('bun run "scripts/dev cli.ts"')).toEqual(['bun', 'run', 'scripts/dev cli.ts']);
    expect(splitAgentCommand('  bun   run   src/cli.ts  ')).toEqual(['bun', 'run', 'src/cli.ts']);
  });

  test('reports healthy when required tools, prompts, and hook are present', () => {
    const report = buildInstalledAgentReadinessReport({
      command: 'mbrain',
      commandPath: '/opt/homebrew/bin/mbrain',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: rulesBlock,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      codexMcpRegistration: {
        client: 'codex',
        detected: true,
        registered: true,
        command: 'mbrain serve',
        source: 'codex mcp list',
      },
      claudeMcpRegistration: {
        client: 'claude',
        detected: true,
        registered: true,
        command: 'mbrain serve',
        source: 'claude mcp get mbrain',
      },
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('ok');
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(report.checks.find((check) => check.name === 'mcp_required_tools')?.message)
      .toContain('route_memory_writeback');
  });

  test('fails when a detected agent has no MCP registration', () => {
    const report = buildInstalledAgentReadinessReport({
      command: 'mbrain',
      commandPath: '/opt/homebrew/bin/mbrain',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: rulesBlock,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      codexMcpRegistration: {
        client: 'codex',
        detected: true,
        registered: false,
        command: null,
        source: 'codex mcp list',
      },
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check) => check.name === 'codex_mcp_registration')).toMatchObject({
      status: 'fail',
    });
  });

  test('fails when an MCP registration points at a non-mbrain server command', () => {
    const report = buildInstalledAgentReadinessReport({
      command: 'mbrain',
      commandPath: '/opt/homebrew/bin/mbrain',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: rulesBlock,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      codexMcpRegistration: {
        client: 'codex',
        detected: true,
        registered: true,
        command: 'node other-server.js',
        source: 'codex mcp list',
      },
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check) => check.name === 'codex_mcp_registration')).toMatchObject({
      status: 'fail',
    });
  });

  test('warns when a source-tree agent command differs from a valid installed mbrain registration', () => {
    const report = buildInstalledAgentReadinessReport({
      command: 'bun run src/cli.ts',
      commandPath: '/opt/homebrew/bin/bun',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: rulesBlock,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      codexMcpRegistration: {
        client: 'codex',
        detected: true,
        registered: true,
        command: 'mbrain serve',
        source: 'codex mcp list',
      },
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('warn');
    expect(report.checks.find((check) => check.name === 'codex_mcp_registration')).toMatchObject({
      status: 'warn',
    });
  });

  test('parses Codex and Claude MCP registration output', () => {
    const codexOutput = [
      'Name          Command        Args   Env  Cwd  Status',
      'mbrain        mbrain         serve  -    -    enabled',
    ].join('\n');
    const claudeOutput = [
      'mbrain:',
      '  Scope: Local config (private to you in this project)',
      '  Status: Connected',
      '  Type: stdio',
      '  Command: mbrain',
      '  Args: serve',
    ].join('\n');

    expect(parseAgentMcpRegistrationOutput('codex', codexOutput)).toBe('mbrain serve');
    expect(parseAgentMcpRegistrationOutput('claude', claudeOutput)).toBe('mbrain serve');
  });

  test('parses multi-token Codex MCP registration args', () => {
    const codexOutput = [
      'Name          Command        Args                  Env  Cwd  Status',
      'mbrain        bun            run src/cli.ts serve  -    -    enabled',
    ].join('\n');

    expect(parseAgentMcpRegistrationOutput('codex', codexOutput)).toBe('bun run src/cli.ts serve');
  });

  test('fails when route_memory_writeback is absent from MCP tools', () => {
    const report = buildInstalledAgentReadinessReport({
      command: 'mbrain',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS
        .filter((name) => name !== 'route_memory_writeback')
        .map((name) => ({ name })),
      codexPrompt: rulesBlock,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check) => check.name === 'mcp_required_tools')).toMatchObject({
      status: 'fail',
    });
  });

  test('warns when a prompt file is absent but does not fail all readiness', () => {
    const report = buildInstalledAgentReadinessReport({
      command: 'mbrain',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: null,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('warn');
    expect(report.checks.find((check) => check.name === 'codex_prompt_rules')).toMatchObject({
      status: 'warn',
    });
  });

  test('fails when no supported agent prompt has the managed rules installed', () => {
    const report = buildInstalledAgentReadinessReport({
      command: 'mbrain',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: null,
      claudePrompt: null,
      claudeStopHook: null,
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check) => check.name === 'agent_prompt_rules')).toMatchObject({
      status: 'fail',
    });
  });

  test('fails when router terms are absent from the managed prompt block', () => {
    const staleRulesBlock = [
      '<!-- MBRAIN:RULES:START -->',
      '<!-- mbrain-agent-rules-version: 0.5.6 -->',
      'This managed block is missing required router terms.',
      '<!-- MBRAIN:RULES:END -->',
      'Outside the block: route_memory_writeback canonical_write_allowed',
    ].join('\n');

    const report = buildInstalledAgentReadinessReport({
      command: 'mbrain',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: staleRulesBlock,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check) => check.name === 'codex_prompt_rules')).toMatchObject({
      status: 'fail',
    });
  });

  test('fails when the managed prompt block has the right version and tokens but not the packaged rules', () => {
    const tokenOnlyRulesBlock = [
      '<!-- MBRAIN:RULES:START -->',
      '<!-- mbrain-agent-rules-version: 0.5.6 -->',
      'route_memory_writeback canonical_write_allowed',
      '<!-- MBRAIN:RULES:END -->',
    ].join('\n');

    const report = buildInstalledAgentReadinessReport({
      command: 'mbrain',
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: tokenOnlyRulesBlock,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      expectedRulesVersion: '0.5.6',
      expectedRulesContent: rulesContent,
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check) => check.name === 'codex_prompt_rules')).toMatchObject({
      status: 'fail',
    });
  });
});
