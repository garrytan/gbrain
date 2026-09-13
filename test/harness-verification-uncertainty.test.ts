import { expect, test } from 'bun:test';
import { verifyHarnessConnection, type VerificationPeer } from '../src/core/harness/verify.ts';
import type { HarnessCredentials } from '../src/core/harness/credentials.ts';

const credentials: HarnessCredentials = { version: 1, client_id: 'gbrain_cl_verifier_fixture', mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', access_token: 'fixture-token', source_id: 'default', profile: 'delegating-agent' };
function peer(mode: 'lost_submission' | 'stalled_write' | 'cancel_not_terminal') {
  const calls: string[] = [];
  let fact: string | undefined;
  const value: VerificationPeer = { connect: async () => {}, close: async () => {}, call: async (name, params) => {
    calls.push(name);
    if (name === 'whoami') return { transport: 'oauth', client_id: credentials.client_id, scopes: ['read', 'write', 'agent'], source_id: 'default' };
    if (name === 'recall') return { facts: fact ? [{ fact_id: '1', fact }] : [] };
    if (name === 'remember') { if (mode === 'stalled_write') return new Promise(() => {}); fact = String(params.fact); return { id: '1' }; }
    if (name === 'forget') { fact = undefined; return { expired: true }; }
    if (name === 'submit_agent') {
      if (params.dry_run) return { dry_run: true };
      if (mode === 'lost_submission') throw new Error('accepted remotely, response lost');
      return { job_id: 9 };
    }
    if (name === 'get_agent_job') return { status: 'waiting' };
    if (name === 'cancel_job') return { status: 'cancelled' }; // Deliberately dishonest acknowledgement.
    throw new Error('unexpected tool');
  } };
  return { value, calls };
}

test('lost paid submission is never retried and reports explicit host reconciliation instead of no job', async () => {
  const fixture = peer('lost_submission');
  const result = await verifyHarnessConnection(credentials, { peer: fixture.value, delegate: true });
  expect(fixture.calls.filter(n => n === 'submit_agent')).toHaveLength(2); // One preview, one actual submission.
  expect(result.submission).toMatchObject({ status: 'outcome_unknown', may_have_started: true, retry_safe: false, client_id: credentials.client_id, source_id: 'default' });
  expect(result.submission).toHaveProperty('host_reconcile_command');
  expect(JSON.stringify(result.submission)).toContain(result.fixture);
  expect(result.stages.find(s => s.name === 'worker_cleanup')).toMatchObject({ status: 'unverified', reason: 'submission_outcome_unknown_do_not_retry' });
  expect(result.status).toBe('failed');
  expect(fixture.calls).not.toContain('cancel_job');
});

test('an empty read after a stalled write does not certify cleanup', async () => {
  const fixture = peer('stalled_write');
  const result = await verifyHarnessConnection({ ...credentials, profile: 'memory-writer' }, { peer: fixture.value, timeoutMs: 20 });
  expect(result.stages.find(s => s.name === 'write')).toMatchObject({ status: 'failed', reason: 'timeout' });
  expect(result.stages.find(s => s.name === 'cleanup')).toMatchObject({ status: 'unverified', reason: 'mutation_outcome_unknown_inspect_fixture' });
  expect(result.status).toBe('failed');
});

test('worker cancellation must be visible as a terminal status after acknowledgement', async () => {
  const fixture = peer('cancel_not_terminal');
  const result = await verifyHarnessConnection(credentials, { peer: fixture.value, delegate: true, timeoutMs: 20 });
  expect(fixture.calls.filter(n => n === 'cancel_job')).toHaveLength(1);
  expect(result.stages.find(s => s.name === 'worker_cleanup')?.status).toBe('failed');
  expect(result.submission).toMatchObject({ status: 'known_job', job_id: 9 });
});

for (const mode of ['retained', 'deleted', 'lost_response', 'readback_failed'] as const) {
  test(`page cleanup requires observed withdrawal: ${mode}`, async () => {
    const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
    let page: Record<string, unknown> | undefined;
    const value: VerificationPeer = { connect: async () => {}, close: async () => {}, call: async (name, params) => {
      calls.push({ name, params });
      if (name === 'whoami') return { transport: 'oauth', client_id: credentials.client_id, scopes: ['read', 'write'], source_id: 'default', direct_write: { prefixes: ['agents/fixture/'] } };
      if (name === 'list_pages') return [];
      if (name === 'put_page') { page = { ...params, source_id: 'default', deleted_at: null }; return { slug: params.slug }; }
      if (name === 'get_page') {
        if (params.include_deleted && mode === 'readback_failed') throw new Error('read response unavailable');
        return page;
      }
      if (name === 'delete_page') {
        if (mode !== 'retained') page!.deleted_at = '2026-09-10T00:00:00.000Z';
        if (mode === 'lost_response') throw new Error('response lost after deletion');
        return { status: 'soft_deleted' };
      }
      throw new Error('unexpected tool');
    } };
    const result = await verifyHarnessConnection({ ...credentials, profile: 'coding-agent' }, { peer: value });
    expect(calls.filter(call => call.name === 'delete_page')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'get_page').at(-1)?.params).toMatchObject({
      slug: `agents/fixture/${result.fixture}`, source_id: 'default', include_deleted: true,
    });
    expect(result.stages.find(stage => stage.name === 'cleanup')?.status).toBe(
      mode === 'deleted' || mode === 'lost_response' ? 'passed' : 'failed',
    );
    expect(result.server_status).toBe(mode === 'deleted' || mode === 'lost_response' ? 'passed' : 'failed');
    expect(result.native_harness.status).toBe('unverified');
  });
}
