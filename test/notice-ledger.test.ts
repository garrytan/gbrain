/**
 * Notice dedupe, coaching budget and mute (agent operator contract v1, A6).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoticeLedger, mutedNoticeCodes, setNoticeMuted } from '../src/core/notice-ledger.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { withEnv } from './helpers/with-env.ts';

const n = (code: string, kind: Notice['kind']): Notice => ({ code, kind, why: code });

describe('NoticeLedger', () => {
  test('stdio dedupes per process; per-call notices always ride', () => {
    const l = new NoticeLedger();
    const a = { transport: 'stdio' as const };
    expect(l.admit([n('backup_coverage', 'coaching'), n('empty_retrieval', 'info')], a).map(x => x.code)).toEqual(['backup_coverage', 'empty_retrieval']);
    expect(l.admit([n('backup_coverage', 'coaching'), n('empty_retrieval', 'info')], a).map(x => x.code)).toEqual(['empty_retrieval']);
  });

  test('HTTP: degraded and safety are never deduped; sessions and principals are separate', () => {
    const l = new NoticeLedger();
    const s1 = { transport: 'http' as const, principal: 'client-a', sessionId: 's1' };
    for (let i = 0; i < 3; i++) expect(l.admit([n('keyword_only', 'degraded'), n('s', 'safety')], s1)).toHaveLength(2);
    expect(l.admit([n('tip', 'info')], s1)).toHaveLength(1);
    expect(l.admit([n('tip', 'info')], s1)).toHaveLength(0);
    expect(l.admit([n('tip', 'info')], { ...s1, sessionId: 's2' })).toHaveLength(1);
    expect(l.admit([n('tip', 'info')], { ...s1, principal: 'client-b' })).toHaveLength(1);
  });

  test('degraded_recall rides every call on stdio and CLI; a dedupe_key dedupes it per session per key; HTTP ignores the key', () => {
    const d = (dedupe_key?: string): Notice => ({ ...n('degraded_recall', 'degraded'), ...(dedupe_key ? { dedupe_key } : {}) });
    for (const transport of ['stdio', 'cli'] as const) {
      const l = new NoticeLedger();
      const a = { transport };
      for (let i = 0; i < 3; i++) expect(l.admit([d()], a)).toHaveLength(1);
      expect(l.admit([d('embed_unavailable:no_provider')], a)).toHaveLength(1);
      expect(l.admit([d('embed_unavailable:no_provider')], a)).toHaveLength(0);
      expect(l.admit([d('embed_unavailable:embedding_disabled')], a)).toHaveLength(1);
      expect(l.admit([d()], a)).toHaveLength(1);
      expect(l.admit([d('embed_unavailable:no_provider')], { transport, sessionId: 'other' })).toHaveLength(1);
    }
    const http = new NoticeLedger();
    for (let i = 0; i < 3; i++) expect(http.admit([d('embed_unavailable:no_provider')], { transport: 'http', principal: 'p' })).toHaveLength(1);
  });

  test('a dedupe_key on a non-per-call code dedupes under the key instead of the code', () => {
    const l = new NoticeLedger();
    const a = { transport: 'stdio' as const };
    expect(l.admit([{ ...n('tip', 'info'), dedupe_key: 'a' }], a)).toHaveLength(1);
    expect(l.admit([{ ...n('tip', 'info'), dedupe_key: 'a' }], a)).toHaveLength(0);
    expect(l.admit([{ ...n('tip', 'info'), dedupe_key: 'b' }], a)).toHaveLength(1);
  });

  test('at most 2 coaching notices per session', () => {
    const l = new NoticeLedger();
    const a = { transport: 'http' as const, principal: 'p' };
    const got = l.admit([n('c1', 'coaching'), n('c2', 'coaching'), n('c3', 'coaching')], a);
    expect(got.map(x => x.code)).toEqual(['c1', 'c2']);
    expect(l.admit([n('c4', 'coaching')], a)).toHaveLength(0);
  });

  test('mute drops coaching/info only', () => {
    const l = new NoticeLedger();
    const muted = new Set(['m1', 'm2', 'm3']);
    const got = l.admit([n('m1', 'coaching'), n('m2', 'info'), n('m3', 'safety')], { transport: 'stdio' }, muted);
    expect(got.map(x => x.code)).toEqual(['m3']);
  });

  test('entries expire after 24 h', () => {
    let now = 0;
    const l = new NoticeLedger(() => now);
    const a = { transport: 'stdio' as const };
    expect(l.admit([n('tip', 'info')], a)).toHaveLength(1);
    now = 25 * 60 * 60 * 1000;
    l.admit([n('other', 'info')], a);
    expect(l.admit([n('tip', 'info')], a)).toHaveLength(1);
  });
});

describe('mute store', () => {
  test('owner mutes are global; client mutes are per principal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-mute-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, () => {
        setNoticeMuted('backup_coverage', true);
        setNoticeMuted('unknown_param', true, 'client-a');
        expect([...mutedNoticeCodes()]).toEqual(['backup_coverage']);
        expect([...mutedNoticeCodes('client-a')].sort()).toEqual(['backup_coverage', 'unknown_param']);
        expect([...mutedNoticeCodes('client-b')]).toEqual(['backup_coverage']);
        setNoticeMuted('backup_coverage', false);
        expect([...mutedNoticeCodes()]).toEqual([]);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('mute_notice op', () => {
  test('remote callers mute for their own client; non-muteable codes refuse with the valid list', async () => {
    const { noticesOperations } = await import('../src/core/ops/notices.ts');
    const op = noticesOperations.find(o => o.name === 'mute_notice')!;
    expect([op.mutating, op.idempotent, op.scope]).toEqual([true, true, 'write']);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-mute-op-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const ctx = { remote: true, auth: { clientId: 'client-a' } } as never;
        expect(await op.handler(ctx, { code: 'backup_coverage' })).toMatchObject({ muted: true, scope: 'client', muted_codes: ['backup_coverage'] });
        expect([...mutedNoticeCodes()]).toEqual([]);
        expect([...mutedNoticeCodes('client-a')]).toEqual(['backup_coverage']);
        await expect(op.handler(ctx, { code: 'keyword_only' })).rejects.toMatchObject({ code: 'invalid_params' });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('claim, memoize and self-deduped codes (D4)', () => {
  test('claim is true once per key; memoize computes once per key', async () => {
    const ledger = new NoticeLedger();
    expect([ledger.claim('a'), ledger.claim('a'), ledger.claim('b')]).toEqual([true, false, true]);
    let calls = 0;
    const compute = async () => ++calls;
    expect([await ledger.memoize('k', compute), await ledger.memoize('k', compute), await ledger.memoize('j', compute)]).toEqual([1, 1, 2]);
  });

  test('a self-deduped code skips admit\'s per-code dedupe but still honors mute', () => {
    const ledger = new NoticeLedger();
    const n = { code: 'grant_blocked_operations', kind: 'info' as const, why: 'w' };
    const audience = { transport: 'http' as const, principal: 'p' };
    expect(ledger.admit([n], audience)).toHaveLength(1);
    expect(ledger.admit([n], audience)).toHaveLength(1);
    expect(ledger.admit([n], audience, new Set(['grant_blocked_operations']))).toHaveLength(0);
  });
});
