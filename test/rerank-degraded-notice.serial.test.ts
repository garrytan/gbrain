/**
 * Cat 40 Hard R0 (DX "Rerank notice"): the `degraded_recall` notice for
 * `rerank_failed` names the reason, the fallback and this session's count of
 * reranker-degraded calls, with a `fix.next` per reason under the agent
 * operator contract; every affected call's `_meta.retrieval` records the same
 * without `fields: "full"`.
 *
 * Drives the REAL dispatch path (dispatchToolCall → search op handler) with
 * hybridSearchCached mocked to report the degradation.
 *
 * Serial: mock.module (isolation guard R2).
 */
import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderNotice, type RenderContext } from '../src/core/agent-output.ts';
import { degradedRecallNotice } from '../src/core/interop-notices.ts';
import { NoticeLedger } from '../src/core/notice-ledger.ts';
import { DEGRADED_REASONS } from '../src/core/types.ts';
import type { RerankFailedReason } from '../src/core/search/rerank.ts';

let nextReason: string | undefined = 'unreachable';

mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearchCached: async (_engine: unknown, _query: string, opts: { onMeta?: (m: unknown) => void }) => {
    opts.onMeta?.({
      vector_enabled: true, expansion_applied: false, detail_resolved: null, retrieved_count: 1,
      degraded: nextReason === undefined ? [] : [{ stage: 'rerank_failed', reason: nextReason }],
    });
    return [{ page_id: 1, source_id: 'default', slug: 'notes/a', title: 'A', type: 'note', chunk_text: 'a text', score: 1 }];
  },
}));

const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');

const engineStub = {
  getConfig: async () => null,
  executeRaw: async (sql: string) => sql.includes('AS pending') ? [{ pending: false }] : [],
  countKeywordPages: async () => 0,
} as unknown as BrainEngine;

const REASONS: RerankFailedReason[] = ['timeout', 'budget', 'rate_limited', 'unreachable', 'auth', 'provider_error'];
const callable: RenderContext = { transport: 'stdio', isCallable: () => true, preapproved: () => false };

function notice(reason: RerankFailedReason, calls = 1) {
  return degradedRecallNotice([{ stage: 'rerank_failed', reason }], {
    transport: 'stdio', rerankDegradedCalls: calls, retry: { op: 'search', args: { query: 'q', limit: 5 } },
  })!;
}

function noticeBlock(out: { content: Array<{ text: string }> }): string | undefined {
  return out.content.map(c => c.text).find(t => t.startsWith('[gbrain notice degraded_recall'));
}

describe('rerank_failed notice per reason', () => {
  test('every reason is a wire reason code (the redactor keeps it)', () => {
    for (const r of REASONS) expect((DEGRADED_REASONS as readonly string[]).includes(r)).toBe(true);
  });

  test('the why names the reason, the fallback and the session count, and keeps the not-absence rule', () => {
    for (const r of REASONS) {
      const n = notice(r, 3);
      expect(n.code).toBe('degraded_recall');
      expect(n.kind).toBe('degraded');
      expect(n.why).toContain(`rerank_failed: ${r}`);
      expect(n.why).toContain('fallback: fused_order');
      expect(n.why).toContain('reranker-degraded calls this session: 3');
      expect(n.why).toContain('never as "the brain has nothing on this"');
    }
    expect(notice('unreachable').why).toContain('could not be reached');
    expect(notice('timeout').why).toContain('did not answer within its timeout');
    expect(notice('rate_limited').why).toContain('HTTP 429');
  });

  test('timeout and rate_limited: next wait, repeating the same call after the stated delay', () => {
    for (const [r, s] of [['timeout', 5], ['rate_limited', 20]] as const) {
      const fix = renderNotice(notice(r), callable).fix!;
      expect(fix.next).toBe('wait');
      expect(fix.mcp).toEqual({ tool: 'search', arguments: { query: 'q', limit: 5 } });
      expect(fix.why).toContain(`after about ${s} seconds`);
    }
  });

  test('unreachable, provider_error and budget: run doctor, verified by reranker_health', () => {
    for (const r of ['unreachable', 'provider_error', 'budget'] as const) {
      const fix = renderNotice(notice(r), callable).fix!;
      expect(fix.next).toBe('run');
      expect(fix.mcp?.tool).toBe('run_doctor');
      expect(fix.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'reranker_health', '--json']);
    }
    expect(notice('unreachable').fix!.why).toContain('provider_base_urls');
    expect(notice('budget').fix!.why).toContain("the user's call");
  });

  test('auth: the user replaces the key (credentials), never a key on a command line', () => {
    const n = renderNotice(notice('auth'), callable);
    expect(n.fix!.next).toBe('tell_user_to_run');
    expect(n.fix!.consent).toEqual(['credentials']);
    expect(n.fix!.why).toContain('never on a command line');
    expect(n.user_message).toBeDefined();
  });

  test('a missing or unknown reason reads as provider_error; another stage that needs a fix keeps its fix', () => {
    expect(degradedRecallNotice([{ stage: 'rerank_failed' }], { transport: 'stdio' })!.why).toContain('rerank_failed: provider_error');
    const both = degradedRecallNotice([{ stage: 'expansion_failed', reason: 'timeout' }, { stage: 'rerank_failed', reason: 'timeout' }], { transport: 'stdio', retry: { op: 'search', args: {} } })!;
    expect(both.fix?.argv).toEqual(['gbrain', 'doctor', '--json']);
    expect(both.why).toContain('expansion_failed, rerank_failed: timeout');
  });
});

describe('dispatch: per-call meta and session count', () => {
  test('stdio: the notice shows once with the count, every call meta records reason, fallback and the running count', async () => {
    const noticeLedger = new NoticeLedger();
    nextReason = 'unreachable';
    const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default', noticeLedger };
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(await dispatchToolCall(engineStub, 'search', { query: 'which account' }, opts));
    const metas = outs.map(o => (o._meta as Record<string, any>).retrieval);
    expect(metas.map(m => m.rerank_degraded)).toEqual([1, 2, 3].map(n => ({ reason: 'unreachable', fallback: 'fused_order', calls_this_session: n })));
    expect(metas.every(m => m.degraded.some((d: { stage: string; reason: string }) => d.stage === 'rerank_failed' && d.reason === 'unreachable'))).toBe(true);
    expect(noticeBlock(outs[0])).toContain('rerank_failed: unreachable');
    expect(noticeBlock(outs[0])).toContain('reranker-degraded calls this session: 1');
    expect(noticeBlock(outs[1])).toBeUndefined();
    expect(noticeBlock(outs[2])).toBeUndefined();
  });

  test('HTTP: the notice rides every affected call with the session running count; a healthy call adds nothing', async () => {
    const noticeLedger = new NoticeLedger();
    const opts = { remote: true, transport: 'http' as const, sourceId: 'default', noticeLedger, auth: { clientId: 'client-a', scopes: ['read'] }, sessionId: 's1' };
    nextReason = 'timeout';
    const first = await dispatchToolCall(engineStub, 'search', { query: 'which account' }, opts as any);
    nextReason = undefined;
    const healthy = await dispatchToolCall(engineStub, 'search', { query: 'which account' }, opts as any);
    nextReason = 'timeout';
    const second = await dispatchToolCall(engineStub, 'search', { query: 'which account' }, opts as any);
    expect(noticeBlock(first)).toContain('reranker-degraded calls this session: 1');
    expect(noticeBlock(first)).toContain('next: wait');
    expect(noticeBlock(healthy)).toBeUndefined();
    expect((healthy._meta as Record<string, any>).retrieval.rerank_degraded).toBeUndefined();
    expect(noticeBlock(second)).toContain('reranker-degraded calls this session: 2');
    expect((second._meta as Record<string, any>).retrieval.rerank_degraded).toEqual({ reason: 'timeout', fallback: 'fused_order', calls_this_session: 2 });
    const other = await dispatchToolCall(engineStub, 'search', { query: 'which account' }, { ...opts, sessionId: 's2' } as any);
    expect((other._meta as Record<string, any>).retrieval.rerank_degraded.calls_this_session).toBe(1);
  });
});
