import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseDoctorAgentArgs } from '../src/commands/doctor.ts';
import { buildDoctorReport, formatDoctorReport } from '../src/core/services/doctor-service.ts';
import { buildAgentTrustExplainReport } from '../src/core/services/agent-trust-explain-service.ts';
import { runProofAgentMemory } from '../src/core/services/proof-agent-service.ts';
import type { InstalledAgentReadinessReport } from '../src/core/services/installed-agent-readiness-service.ts';

const originalEnv = { ...process.env };
let tempHome = '';

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-doctor-explain-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

describe('doctor agent explain', () => {
  test('parseDoctorAgentArgs recognizes explicit explain without implying agent', () => {
    expect(parseDoctorAgentArgs(['--agent', '--explain'])).toEqual({
      agent: true,
      explain: true,
      agentCommand: 'mbrain',
    });
    expect(parseDoctorAgentArgs(['--agent-command', 'bun run src/cli.ts', '--agent', '--explain'])).toEqual({
      agent: true,
      explain: true,
      agentCommand: 'bun run src/cli.ts',
    });
    expect(parseDoctorAgentArgs(['--explain'])).toEqual({
      agent: false,
      explain: true,
      agentCommand: 'mbrain',
    });
  });

  test('buildAgentTrustExplainReport exposes stable authority boundaries and proof summary', () => {
    const explain = buildAgentTrustExplainReport({
      command: 'mbrain',
      installedAgent: healthyInstalledAgent(),
      expectedRulesVersion: '0.5.9',
      proof: runProofAgentMemory({ now: '2026-06-06T00:00:00.000Z' }),
    });

    expect(explain.installed_surface.command).toBe('mbrain');
    expect(explain.installed_surface.mcp_registrations).toEqual(['codex: ok', 'claude: ok']);
    expect(explain.installed_surface.prompt_rules_version).toBe('0.5.9');
    expect(explain.installed_surface.claude_stop_hook).toBe('installed');
    expect(explain.memory_behavior.read_context_evidence_boundary).toBe(true);
    expect(explain.memory_behavior.graph_frontier_default).toBe('off');
    expect(explain.memory_behavior.canonical_write_requirements).toEqual([
      'canonical_write_allowed',
      'target_snapshot_hash',
      'write_session_id',
      'expected_content_hash',
    ]);
    expect(explain.memory_behavior.hint_only_surfaces).toEqual(expect.arrayContaining([
      'Memory Inbox candidates',
      'graph paths',
      'raw episodes',
      'Dream outputs',
    ]));
    expect(explain.proof).toEqual({
      status: 'pass',
      scenarios: [
        'decision_reuse',
        'failed_attempt_avoidance',
        'stale_code_verify_first',
        'candidate_exclusion',
        'memory_why_explanation',
      ],
      authority_violations: 0,
      mutations: 0,
    });
    expect(explain.next_actions).toEqual(['No action required.']);
    expect(explain.limitations.join('\n')).toContain('read-only');
    expect(explain.limitations.join('\n')).toContain('not answer authority by default');
  });

  test('buildAgentTrustExplainReport points readiness issues to preview without repairing', () => {
    const explain = buildAgentTrustExplainReport({
      command: 'mbrain',
      installedAgent: {
        status: 'fail',
        checks: [
          { name: 'codex_mcp_registration', status: 'fail', message: 'Codex MCP registration for mbrain was not found' },
          { name: 'codex_prompt_rules', status: 'fail', message: 'Codex prompt missing required rules content' },
          { name: 'claude_stop_hook', status: 'warn', message: 'Claude stop hook is absent' },
        ],
      },
      expectedRulesVersion: '0.5.9',
      proof: runProofAgentMemory({ now: '2026-06-06T00:00:00.000Z' }),
    });

    expect(explain.installed_surface.mcp_registrations).toEqual(['codex: fail']);
    expect(explain.installed_surface.prompt_rules_version).toBeNull();
    expect(explain.installed_surface.claude_stop_hook).toBe('missing');
    expect(explain.next_actions).toEqual(expect.arrayContaining([
      'Fix failed installed-agent readiness checks before relying on agent memory behavior.',
      'Run mbrain setup-agent --preview to inspect MCP registration changes.',
      'Run mbrain setup-agent --preview to inspect prompt rule changes.',
    ]));
    expect(explain.limitations[0]).toContain('does not run setup');
  });

  test('buildDoctorReport and human formatter include concise explain section only when requested', () => {
    const agentExplain = buildAgentTrustExplainReport({
      command: 'mbrain',
      installedAgent: healthyInstalledAgent(),
      expectedRulesVersion: '0.5.9',
      proof: runProofAgentMemory({ now: '2026-06-06T00:00:00.000Z' }),
    });
    const baseReport = buildDoctorReport(baseDoctorInput());
    const explainReport = buildDoctorReport({
      ...baseDoctorInput(),
      installedAgent: healthyInstalledAgent(),
      agentExplain,
    });

    expect(baseReport).not.toHaveProperty('agent_explain');
    expect(explainReport.agent_explain?.memory_behavior.read_context_evidence_boundary).toBe(true);

    const output = formatDoctorReport(explainReport);
    expect(output).toContain('Agent Trust Explain');
    expect(output).toContain('read_context evidence boundary: true');
    expect(output).toContain('Graph frontier: off');
    expect(output).toContain('Proof: pass');
  });

  test('runDoctor rejects --explain without --agent before running probes', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = mock((msg: string) => { logs.push(msg); });
    const errorSpy = mock((msg: string) => { errors.push(msg); });
    const exitSpy = mock((_code?: number) => undefined as never);
    const consoleLog = console.log;
    const consoleError = console.error;
    const processExit = process.exit;
    console.log = logSpy as typeof console.log;
    console.error = errorSpy as typeof console.error;
    process.exit = exitSpy as typeof process.exit;

    try {
      const { runDoctor } = await import('../src/commands/doctor.ts');
      await runDoctor({
        getStats: async () => {
          throw new Error('doctor inputs should not be collected for --explain without --agent');
        },
      } as any, ['--explain']);
    } finally {
      console.log = consoleLog;
      console.error = consoleError;
      process.exit = processExit;
    }

    expect(logs).toEqual([]);
    expect(errors).toEqual(['doctor --explain requires --agent']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('runDoctor emits agent_explain for --agent --explain --json and keeps normal doctor fields', async () => {
    const logs: string[] = [];
    const logSpy = mock((msg: string) => { logs.push(msg); });
    const exitSpy = mock((_code?: number) => undefined as never);
    const consoleLog = console.log;
    const processExit = process.exit;
    console.log = logSpy as typeof console.log;
    process.exit = exitSpy as typeof process.exit;

    try {
      const { runDoctor } = await import('../src/commands/doctor.ts');
      await runDoctor(baseEngine(), ['--agent', '--explain', '--json', '--agent-command', 'bun run src/cli.ts']);
    } finally {
      console.log = consoleLog;
      process.exit = processExit;
    }

    const payload = JSON.parse(logs[0] || '{}');
    expect(payload.status).toBeDefined();
    expect(Array.isArray(payload.checks)).toBe(true);
    expect(payload.remediation_plan.mode).toBe('report_only');
    expect(payload.remediation_plan.summary.auto_apply_supported).toBe(false);
    expect(payload.agent_explain.installed_surface.command).toBe('bun run src/cli.ts');
    expect(payload.agent_explain.memory_behavior.read_context_evidence_boundary).toBe(true);
    expect(payload.agent_explain.memory_behavior.graph_frontier_default).toBe('off');
    expect(payload.agent_explain.memory_behavior.hint_only_surfaces).toEqual(expect.arrayContaining([
      'Memory Inbox candidates',
      'graph paths',
      'raw episodes',
      'Dream outputs',
    ]));
    expect(payload.agent_explain.proof.status).toBe('pass');
    expect(payload.agent_explain.proof.authority_violations).toBe(0);
    expect(payload.agent_explain.proof.mutations).toBe(0);
  });

  test('runDoctor does not include agent_explain for ordinary --agent --json', async () => {
    const logs: string[] = [];
    const logSpy = mock((msg: string) => { logs.push(msg); });
    const exitSpy = mock((_code?: number) => undefined as never);
    const consoleLog = console.log;
    const processExit = process.exit;
    console.log = logSpy as typeof console.log;
    process.exit = exitSpy as typeof process.exit;

    try {
      const { runDoctor } = await import('../src/commands/doctor.ts');
      await runDoctor(baseEngine(), ['--agent', '--json', '--agent-command', 'bun run src/cli.ts']);
    } finally {
      console.log = consoleLog;
      process.exit = processExit;
    }

    const payload = JSON.parse(logs[0] || '{}');
    expect(payload).not.toHaveProperty('agent_explain');
    expect(payload.remediation_plan.mode).toBe('report_only');
  });
});

function healthyInstalledAgent(): InstalledAgentReadinessReport {
  return {
    status: 'ok',
    checks: [
      { name: 'command_version', status: 'ok', message: 'mbrain 0.5.9' },
      { name: 'mcp_required_tools', status: 'ok', message: 'Required MCP tools present' },
      { name: 'codex_mcp_registration', status: 'ok', message: 'Codex MCP registration points to mbrain serve' },
      { name: 'claude_mcp_registration', status: 'ok', message: 'Claude MCP registration points to mbrain serve' },
      { name: 'codex_prompt_rules', status: 'ok', message: 'Codex prompt rules version 0.5.9 is installed' },
      { name: 'claude_prompt_rules', status: 'ok', message: 'Claude prompt rules version 0.5.9 is installed' },
      { name: 'agent_prompt_rules', status: 'ok', message: 'At least one supported agent prompt has the managed MBrain rules installed' },
      { name: 'claude_stop_hook', status: 'ok', message: 'Claude stop hook calls route_memory_writeback' },
    ],
  };
}

function baseDoctorInput() {
  return {
    connectionOk: true,
    stats: {
      page_count: 1,
      chunk_count: 0,
      embedded_count: 0,
      link_count: 0,
      tag_count: 0,
      timeline_entry_count: 0,
      pages_by_type: {},
    },
    config: null,
    profile: null,
    rawPostgresChecksSupported: false,
    latestVersion: 4,
    schemaVersion: '4',
    health: {
      page_count: 1,
      embed_coverage: 1,
      stale_pages: 0,
      orphan_pages: 0,
      dead_links: 0,
      missing_embeddings: 0,
    },
  };
}

function baseEngine() {
  return {
    getStats: async () => ({
      page_count: 1,
      chunk_count: 0,
      embedded_count: 0,
      link_count: 0,
      tag_count: 0,
      timeline_entry_count: 0,
      pages_by_type: {},
    }),
    getConfig: async (key: string) => key === 'version' ? '4' : null,
    getHealth: async () => ({
      page_count: 1,
      embed_coverage: 1,
      stale_pages: 0,
      orphan_pages: 0,
      dead_links: 0,
      missing_embeddings: 0,
    }),
  } as any;
}
