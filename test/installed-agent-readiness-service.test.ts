import { describe, expect, test } from 'bun:test';
import {
  REQUIRED_AGENT_TOOLS,
  buildInstalledAgentReadinessReport,
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
      commandVersion: 'mbrain 0.10.3',
      tools: REQUIRED_AGENT_TOOLS.map((name) => ({ name })),
      codexPrompt: rulesBlock,
      claudePrompt: rulesBlock,
      claudeStopHook: 'route_memory_writeback with sources',
      expectedRulesVersion: '0.5.6',
    });

    expect(report.status).toBe('ok');
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(report.checks.find((check) => check.name === 'mcp_required_tools')?.message)
      .toContain('route_memory_writeback');
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
});
