import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { credentialAccessToken, type HarnessCredentials } from './credentials.ts';
import { extractResultText } from '../connect-probe.ts';
import { shellQuote } from '../mcp-registration.ts';

export interface VerificationStage { name: string; status: 'passed' | 'failed' | 'unverified' | 'not_requested'; reason?: string }
export interface VerificationPeer { connect(): Promise<void>; call(name: string, params: Record<string, unknown>): Promise<any>; readCapabilities?(): Promise<any>; close(): Promise<void> }
export interface VerificationOptions { timeoutMs?: number; delegate?: boolean; peer?: VerificationPeer }

async function createPeer(c: HarnessCredentials, signal: AbortSignal, timeout: number): Promise<VerificationPeer> {
  const token = await credentialAccessToken(c, signal);
  const client = new Client({ name: 'gbrain-capability-verifier', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(c.mcp_url), { requestInit: { headers: { Authorization: `Bearer ${token}` }, signal } });
  return {
    connect: () => client.connect(transport),
    call: async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout });
      if (result.isError) throw new Error('tool_error');
      return JSON.parse(extractResultText(result.content));
    },
    readCapabilities: async () => {
      const result = await client.readResource({ uri: 'gbrain://capabilities' }, { signal, timeout });
      const content = result.contents[0];
      return JSON.parse(content && 'text' in content ? content.text : '{}');
    },
    close: () => client.close(),
  };
}

async function bounded<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('timeout');
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('timeout'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([fn(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** A server probe proves transport/tool execution only. Vendor-session evidence
 * stays separate and can never be inferred from these SDK calls. */
export async function verifyHarnessConnection(c: HarnessCredentials, options: VerificationOptions = {}) {
  const stages: VerificationStage[] = [];
  const timeout = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const fixture = `gbrain-verification-${randomBytes(10).toString('hex')}`;
  let cleanupSlug: string | undefined;
  let factId: string | undefined;
  let factAttempted = false;
  let mutationAttempted = false;
  let mutationConfirmed = false;
  let submissionAttempted = false;
  let jobId: number | undefined;
  let workerTerminal = false;
  let identity: any = null;
  let peer = options.peer;
  const stage = async (name: string, fn: () => Promise<void>, signal = controller.signal) => {
    try { await bounded(fn, signal); stages.push({ name, status: 'passed' }); return true; }
    catch { stages.push({ name, status: 'failed', reason: signal.aborted ? 'timeout' : `${name}_failed` }); return false; }
  };
  try {
    peer ??= await bounded(() => createPeer(c, controller.signal, timeout), controller.signal);
    const active = peer;
    if (!await stage('transport', () => active.connect())) return result();
    if (!await stage('authentication', async () => {
      identity = active.readCapabilities ? await active.readCapabilities() : await active.call('whoami', {});
      if (identity?.transport !== 'oauth' || identity.client_id !== c.client_id || !Array.isArray(identity.scopes)) throw new Error('wrong_identity');
    })) return result();
    const profile = c.profile ?? identity.profile ?? 'memory-reader';
    const write = profile !== 'memory-reader';
    const delegation = profile === 'delegating-agent' || profile === 'full';
    if (!await stage('permissions', async () => {
      const scopes = identity.scopes as string[];
      if (!scopes.some(s => ['read', 'write', 'admin'].includes(s))) throw new Error('read_missing');
      if (write && !scopes.some(s => ['write', 'admin'].includes(s))) throw new Error('write_missing');
      if (delegation && !scopes.includes('agent')) throw new Error('agent_missing');
    })) return result();
    const pageMode = profile === 'coding-agent' || Boolean(identity.direct_write?.prefixes?.length);
    if (!await stage('read', async () => { await active.call(pageMode ? 'list_pages' : 'recall', pageMode ? { limit: 1 } : { grep: fixture, limit: 1 }); })) return result();
    if (write) {
      const prefix = identity.direct_write?.prefixes?.[0];
      if (pageMode) cleanupSlug = `${typeof prefix === 'string' ? prefix.replace(/\/?\*?$/, '/') : 'gbrain-verification/'}${fixture}`;
      else factAttempted = true;
      const wrote = await stage('write', async () => {
        mutationAttempted = true;
        const saved = await active.call(pageMode ? 'put_page' : 'remember', pageMode
          ? { slug: cleanupSlug, title: 'Connection check', content: `# Connection check\n\n${fixture}\n` }
          : { fact: fixture, entity: fixture, provenance: 'GBrain randomized connection verification', visibility: 'world' });
        if (!pageMode) factId = String(saved.id ?? '');
        mutationConfirmed = true;
      });
      // A lost response is reconciled by reading the unique fixture, never by
      // repeating a mutation. Both the write and its readback are observed.
      const readBack = await stage('write_readback', async () => {
        const found = await active.call(pageMode ? 'get_page' : 'recall', pageMode ? { slug: cleanupSlug } : { entity: fixture, grep: fixture });
        if (!JSON.stringify(found).includes(fixture)) throw new Error('fixture_missing');
        mutationConfirmed = true;
        if (!pageMode) factId = String(found.facts?.find((f: any) => JSON.stringify(f).includes(fixture))?.fact_id ?? factId ?? '');
      });
      if (!wrote && readBack) Object.assign(stages.find(s => s.name === 'write')!, { status: 'passed', reason: 'lost_response_reconciled_by_readback' });
    } else stages.push({ name: 'write', status: 'not_requested' });
    if (delegation) {
      const ready = await stage('delegation_configuration', async () => {
        const preview = await active.call('submit_agent', { prompt: `Reply with exactly ${fixture}. Do not modify memory.`, max_turns: 1, dry_run: true });
        if (!preview?.dry_run) throw new Error('invalid_preview');
      });
      if (ready && options.delegate) {
        await stage('worker_completion', async () => {
          submissionAttempted = true;
          const submitted = await active.call('submit_agent', { prompt: `Reply with exactly ${fixture}. Do not modify memory.`, max_turns: 1 });
          const submittedId = Number(submitted.job_id ?? submitted.id);
          if (!Number.isSafeInteger(submittedId) || submittedId < 1) throw new Error('invalid_job_id');
          jobId = submittedId;
          while (!controller.signal.aborted) {
            const job = await active.call('get_agent_job', { id: jobId });
            if (job.status === 'completed') {
              workerTerminal = true;
              if (!JSON.stringify(job.result).includes(fixture)) throw new Error('wrong_worker_result');
              return;
            }
            if (['failed', 'dead', 'cancelled'].includes(job.status)) { workerTerminal = true; throw new Error('worker_failed'); }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          throw new Error('timeout');
        });
      } else stages.push({ name: 'worker_completion', status: 'unverified', reason: ready ? 'run_verify_with_delegate_to_execute_a_paid_worker_check' : 'delegation_not_ready' });
    } else stages.push({ name: 'delegation_configuration', status: 'not_requested' });
    return result();
  } catch {
    stages.push({ name: 'authentication', status: 'failed', reason: 'credential_exchange_failed' });
    return result();
  } finally {
    clearTimeout(timer);
    const cleanupController = new AbortController();
    const cleanupTimer = setTimeout(() => cleanupController.abort(), 5_000);
    const signal = cleanupController.signal;
    const hasCleanup = cleanupSlug || factAttempted || (jobId && !workerTerminal);
    if (hasCleanup && controller.signal.aborted && !options.peer) {
      const old = peer;
      void old?.close().catch(() => {});
      await stage('cleanup_transport', async () => { peer = await createPeer(c, signal, 5_000); await peer.connect(); }, signal);
    }
    if (submissionAttempted && !jobId) stages.push({ name: 'worker_cleanup', status: 'unverified', reason: 'submission_outcome_unknown_do_not_retry' });
    if (peer && jobId && !workerTerminal) await stage('worker_cleanup', async () => {
      const terminal = (status: unknown) => ['completed', 'failed', 'dead', 'cancelled'].includes(String(status));
      const before = await peer!.call('get_agent_job', { id: jobId });
      if (terminal(before.status)) { workerTerminal = true; return; }
      await peer!.call('cancel_job', { id: jobId });
      const after = await peer!.call('get_agent_job', { id: jobId });
      if (!terminal(after.status)) throw new Error('worker_cleanup_not_terminal');
      workerTerminal = true;
    }, signal);
    if (peer && (cleanupSlug || factAttempted)) await stage('cleanup', async () => {
      if (cleanupSlug) {
        const sourceId = identity?.source_id ?? c.source_id;
        const target = { slug: cleanupSlug, ...(typeof sourceId === 'string' ? { source_id: sourceId } : {}) };
        // The delete response can be lost after commit. Read the recoverable
        // row once, without repeating the mutation; an acknowledgement or a
        // failed lookup alone never proves that the page was withdrawn.
        try { await peer!.call('delete_page', target); } catch { /* reconcile below */ }
        const after = await peer!.call('get_page', { ...target, include_deleted: true });
        if (after?.slug !== cleanupSlug || typeof after.deleted_at !== 'string'
          || !Number.isFinite(Date.parse(after.deleted_at))
          || (typeof sourceId === 'string' && after.source_id !== sourceId)) throw new Error('cleanup_incomplete');
        return;
      }
      if (!factId) {
        const found = await peer!.call('recall', { entity: fixture, grep: fixture });
        factId = String(found.facts?.find((f: any) => JSON.stringify(f).includes(fixture))?.fact_id ?? '');
        if (factId) mutationConfirmed = true;
      }
      if (factId) await peer!.call('forget', { id: factId, reason: 'connection verification cleanup' });
      const after = await peer!.call('recall', { entity: fixture, grep: fixture });
      if (JSON.stringify(after.facts ?? []).includes(fixture)) throw new Error('cleanup_incomplete');
    }, signal);
    // A timed-out/lost write may still commit after an empty read. Absence
    // alone cannot certify cleanup while the original outcome is unknown.
    if (mutationAttempted && !mutationConfirmed) {
      const cleanup = stages.find(s => s.name === 'cleanup');
      if (cleanup?.status === 'passed') Object.assign(cleanup, { status: 'unverified', reason: 'mutation_outcome_unknown_inspect_fixture' });
    }
    if (peer) { try { await bounded(() => peer!.close(), signal); } catch { stages.push({ name: 'transport_cleanup', status: 'failed', reason: 'close_timeout' }); } }
    clearTimeout(cleanupTimer);
  }
  function result() {
    return { get status(): 'failed' | 'partial' | 'passed' { return stages.some(s => s.status === 'failed') ? 'failed' : 'partial'; },
      get server_status() { return stages.some(s => s.status === 'failed') ? 'failed' : stages.some(s => s.status === 'unverified') ? 'partial' : 'passed'; },
      client_id: c.client_id, harness: c.harness ?? null, fixture, stages,
      native_harness: { status: 'unverified', reason: 'SDK probe cannot verify a vendor session or instruction loading' },
      get cleanup() { return cleanupSlug ? { slug: cleanupSlug, semantics: 'soft_delete' } : factAttempted ? { id: factId ?? null, semantics: 'withdrawal_from_active_memory' } : null; },
      get job_id() { return jobId ?? null; },
      get submission() {
        if (!submissionAttempted) return { status: 'not_requested' };
        if (jobId) return { status: workerTerminal ? 'terminal' : 'known_job', job_id: jobId };
        const prompt = `Reply with exactly ${fixture}. Do not modify memory.`;
        const filter = '.[] | select(.data.__owner_client_id == $client and .data.prompt == $prompt)';
        return {
          status: 'outcome_unknown', may_have_started: true, retry_safe: false,
          client_id: c.client_id, source_id: identity?.source_id ?? c.source_id ?? null, fixture, prompt,
          reason: 'submit_agent has no idempotency-key parameter; a lost response does not prove the worker was not accepted',
          host_reconcile_command: `gbrain jobs list --queue default --limit 1000 --json | jq --arg client ${shellQuote(c.client_id)} --arg prompt ${shellQuote(prompt)} ${shellQuote(filter)}`,
          next_action: 'Run this command on the brain host (requires jq), inspect matching job IDs and source_id, then use gbrain jobs get ID --json and explicitly cancel unfinished matches. An empty bounded listing does not prove absence; do not resubmit the probe while its outcome is unknown.',
        };
      }, identity };
  }
}
