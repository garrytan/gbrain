import { describe, it, expect } from 'bun:test';
import { createCliRunnerExecutor } from '../../src/core/auto-promote/cli-executor.ts';

const runnerCandidate = (kind: string) => ({
  kind, label: kind, priority: 0, available: true, reason: 'x', command: kind === 'claude_code' ? 'claude' : 'codex',
  runner_version: null, model: null, provider: null, workspace_access: 'read_only',
  can_execute_shell: false, can_access_connector_credentials: false, llm_or_runner_used: true,
} as any);

describe('createCliRunnerExecutor', () => {
  it('invokes claude with -p and returns stdout as output', async () => {
    const calls: any[] = [];
    const exec = createCliRunnerExecutor({
      runCommand: async (cmd, args, input) => { calls.push({ cmd, args, input }); return { code: 0, stdout: '{"decision":"reject","confidence":0.2,"reasoning":"x","source_refs":[]}', stderr: '' }; },
    });
    const res = await exec({ runner: runnerCandidate('claude_code'), task_type: 'candidate_promotion_review', source_scope: {}, prompt: 'P', input: '', tool_policy: { status: 'allowed' } as any, allowed_tools: ['emit_promotion_verdict'] as any });
    expect(res.status).toBe('succeeded');
    expect(res.output).toContain('reject');
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).toContain('-p');
    expect(calls[0].args).not.toContain('P');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--tools', '']));
    expect(calls[0].input).toBe('P');
  });
  it('invokes codex with a read-only sandbox and stdin prompt', async () => {
    const calls: any[] = [];
    const exec = createCliRunnerExecutor({
      runCommand: async (cmd, args, input) => { calls.push({ cmd, args, input }); return { code: 0, stdout: '{"decision":"reject","confidence":0.2,"reasoning":"x","source_refs":[]}', stderr: '' }; },
    });
    const res = await exec({ runner: runnerCandidate('codex'), task_type: 'candidate_promotion_review', source_scope: {}, prompt: 'P', input: '', tool_policy: { status: 'allowed' } as any, allowed_tools: ['emit_promotion_verdict'] as any });
    expect(res.status).toBe('succeeded');
    expect(calls[0].cmd).toBe('codex');
    expect(calls[0].args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '--ignore-rules', '-']));
    expect(calls[0].args).not.toContain('P');
    expect(calls[0].input).toBe('P');
  });
  it('uses the per-request model when provided', async () => {
    const calls: any[] = [];
    const exec = createCliRunnerExecutor({
      model: 'first-pass',
      runCommand: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '{"decision":"defer","confidence":0.2,"reasoning":"x","source_refs":[]}', stderr: '' }; },
    });
    await exec({ runner: runnerCandidate('claude_code'), task_type: 'candidate_promotion_review', source_scope: {}, prompt: 'P', input: '', tool_policy: { status: 'allowed' } as any, allowed_tools: ['emit_promotion_verdict'] as any, model: 'escalation' } as any);
    expect(calls[0].args).toContain('--model');
    expect(calls[0].args.at(-1)).toBe('escalation');
  });
  it('maps a non-zero exit to failed', async () => {
    const exec = createCliRunnerExecutor({ runCommand: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    const res = await exec({ runner: runnerCandidate('codex'), task_type: 'candidate_promotion_review', source_scope: {}, prompt: 'P', input: '', tool_policy: { status: 'allowed' } as any, allowed_tools: [] as any });
    expect(res.status).toBe('failed');
  });
});
