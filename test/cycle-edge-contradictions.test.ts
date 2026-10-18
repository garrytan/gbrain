/**
 * Dream phase edge_contradictions (temporal typed edges): the judge only flags
 * conflicts; date arithmetic picks the ending relationship and date. Covers
 * propose vs apply, accept/undo/reject, reverted-by-user, undated pairs,
 * malformed judge output, compatible caching and the budget cap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import {
  runPhaseEdgeContradictions, applyEdgeProposal, undoEdgeProposal, rejectEdgeProposal, parseEdgeJudgeOutput, type EdgeJudgeFn,
  isCertifiedApplyModel, loadEdgeContradictionsConfig,
} from '../src/core/cycle/edge-contradictions.ts';
import { relationshipFilterSql } from '../src/core/link-validity.ts';

setDefaultTimeout(60_000);
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });
beforeEach(async () => { await resetPgliteState(engine); resetGateway(); });

const ctx = (): OperationContext => ({ engine, config: { engine: 'pglite' as const }, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, sourceId: 'default' });
async function put(slug: string, fm: string, body: string) {
  const op = operations.find(o => o.name === 'put_page')!;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await op.handler(ctx(), { slug, ...(snapshot ? { expected_revision: snapshot.revision } : {}), content: `---\n${fm}\n---\n\n${body}` });
}
async function seed(timeline: string) {
  await put('companies/acme-example', 'type: company\ntitle: Acme', 'A company.');
  await put('companies/widget-co', 'type: company\ntitle: Widget', 'A company.');
  await put('people/alice-example', 'type: person\ntitle: Alice', `Alice works at [Acme](../companies/acme-example) and at [Widget](../companies/widget-co).\n\n## Timeline\n\n${timeline}`);
}
const DATED = '- **2019-02-01** | test — joined [Acme](../companies/acme-example)\n- **2024-05-01** | test — joined [Widget](../companies/widget-co)';
const conflict: EdgeJudgeFn = async () => [{ a: 1, b: 2, conflict: true, confidence: 0.9 }];
let calls = 0;
const counting = (fn: EdgeJudgeFn): EdgeJudgeFn => async (input) => { calls++; return fn(input); };
async function liveWorksAt() {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT t.slug FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'people/alice-example' AND l.link_type = 'works_at' AND ${relationshipFilterSql('l')} ORDER BY 1`);
  return rows.map(r => r.slug);
}
const proposals = () => engine.executeRaw<{ id: number; status: string; close_date: string | null; born_closed: boolean }>(`SELECT id, status, close_date::text AS close_date, born_closed FROM link_edge_proposals ORDER BY id`);

describe('edge_contradictions', () => {
  test('propose mode records a proposal and writes nothing canonical; accept applies; undo reopens', async () => {
    await engine.setConfig('dream.edge_contradictions.mode', 'propose');
    await seed(DATED);
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/widget-co']);
    const r = await runPhaseEdgeContradictions(engine, { judge: conflict });
    expect(r.totals).toMatchObject({ judged: 1, proposed: 1, applied: 0 });
    const [p] = await proposals();
    expect(p).toMatchObject({ status: 'proposed', close_date: '2024-05-01', born_closed: false });
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/widget-co']);

    expect(await applyEdgeProposal(engine, p.id)).toEqual({ status: 'applied' });
    expect(await liveWorksAt()).toEqual(['companies/widget-co']);
    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page?.timeline).toContain('gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)');
    expect(await applyEdgeProposal(engine, p.id)).toEqual({ status: 'applied', reason: 'already applied' });

    expect((await undoEdgeProposal(engine, p.id)).status).toBe('undone');
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/widget-co']);
  });

  test('apply mode applies; a hand-deleted closure line becomes reverted_by_user and is never re-proposed', async () => {
    await seed(DATED);
    await engine.setConfig('dream.edge_contradictions.mode', 'apply');
    try {
      const r = await runPhaseEdgeContradictions(engine, { judge: conflict });
      expect(r.totals).toMatchObject({ proposed: 1, applied: 1 });
      expect(await liveWorksAt()).toEqual(['companies/widget-co']);
      // The user deletes the line by rewriting the page without it.
      await seed(DATED);
      expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/widget-co']);
      calls = 0;
      const again = await runPhaseEdgeContradictions(engine, { judge: counting(conflict) });
      expect(again.totals).toMatchObject({ reverted: 1 });
      expect(calls).toBe(0);
      expect((await proposals()).map(p => p.status)).toEqual(['reverted_by_user']);
    } finally { await engine.setConfig('dream.edge_contradictions.mode', 'propose'); }
  });

  test('undated relationships are never closed; the proposal asks for a date', async () => {
    await seed('- **2024-05-01** | test — joined [Widget](../companies/widget-co)');
    const r = await runPhaseEdgeContradictions(engine, { judge: conflict });
    expect(r.totals).toMatchObject({ undated_unresolved: 1, proposed: 0 });
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/widget-co']);
  });

  test('compatible verdicts are cached: the same evidence is not judged twice', async () => {
    await seed(DATED);
    calls = 0;
    const compatible = counting(async () => [{ a: 1, b: 2, conflict: false, confidence: 0.8 }]);
    await runPhaseEdgeContradictions(engine, { judge: compatible });
    await runPhaseEdgeContradictions(engine, { judge: compatible });
    expect(calls).toBe(1);
    expect((await proposals()).map(p => p.status)).toEqual(['compatible']);
  });

  test('malformed judge output is an error row, never a closure', async () => {
    await seed(DATED);
    const r = await runPhaseEdgeContradictions(engine, { judge: async () => null });
    expect(r.totals).toMatchObject({ errors: 1, proposed: 0 });
    expect(r.status).toBe('partial');
    expect(parseEdgeJudgeOutput('I cannot help with that.', 2)).toBeNull();
    expect(parseEdgeJudgeOutput('{"pairs":[{"a":1,"b":9,"conflict":true}]}', 2)).toBeNull();
    expect(parseEdgeJudgeOutput('{"pairs":[{"a":1,"b":2,"conflict":true,"confidence":2}]}', 2)).toEqual([{ a: 1, b: 2, conflict: true, confidence: 1 }]);
  });

  describe('judge errors retry with a bounded backoff (#6311)', () => {
    const age = () => engine.executeRaw(`UPDATE link_edge_proposals SET updated_at = now() - interval '25 hours' WHERE status = 'error'`);
    const errorRows = () => engine.executeRaw<{ status: string; detail: string }>(`SELECT status, detail FROM link_edge_proposals ORDER BY id`);

    test('a transient error is skipped inside the backoff, then the next verdict replaces it', async () => {
      await engine.setConfig('dream.edge_contradictions.mode', 'propose');
      await seed(DATED);
      calls = 0;
      await runPhaseEdgeContradictions(engine, { judge: counting(async () => { throw new Error('upstream 529 overloaded'); }) });
      expect((await errorRows())[0]).toMatchObject({ status: 'error', detail: 'attempt 1/3; Error: upstream 529 overloaded' });
      await runPhaseEdgeContradictions(engine, { judge: counting(conflict) });
      expect(calls).toBe(1);
      await age();
      const r = await runPhaseEdgeContradictions(engine, { judge: counting(conflict) });
      expect(calls).toBe(2);
      expect(r.totals).toMatchObject({ proposed: 1 });
      expect((await proposals()).map(p => p.status)).toEqual(['proposed']);
    });

    test('three failed attempts hold the pair; no fourth call until retry --all-held', async () => {
      await engine.setConfig('dream.edge_contradictions.mode', 'propose');
      await seed(DATED);
      calls = 0;
      const failing = counting(async () => null);
      for (let i = 0; i < 3; i++) { await runPhaseEdgeContradictions(engine, { judge: failing }); await age(); }
      expect(calls).toBe(3);
      expect((await errorRows())[0].detail).toStartWith('held after 3 attempts; malformed');
      await runPhaseEdgeContradictions(engine, { judge: failing });
      expect(calls).toBe(3);
      const { runEdgeProposals } = await import('../src/commands/edge-proposals.ts');
      const log = console.log; console.log = () => {};
      try { await runEdgeProposals(engine, ['retry', '--all-held']); } finally { console.log = log; }
      await runPhaseEdgeContradictions(engine, { judge: counting(conflict) });
      expect(calls).toBe(4);
      expect((await proposals()).map(p => p.status)).toEqual(['proposed']);
    });

    test('a non-error row is never replaced', async () => {
      await seed(DATED);
      await runPhaseEdgeContradictions(engine, { judge: async () => [{ a: 1, b: 2, conflict: false, confidence: 0.9 }] });
      await engine.executeRaw(`UPDATE link_edge_proposals SET updated_at = now() - interval '25 hours'`);
      calls = 0;
      await runPhaseEdgeContradictions(engine, { judge: counting(conflict) });
      expect(calls).toBe(0);
      expect((await proposals()).map(p => p.status)).toEqual(['compatible']);
    });

    test('the stored detail is the error class and a redacted message of at most 200 characters', async () => {
      await seed(DATED);
      const key = 'sk-ant-api03-' + 'Ab1Cd2Ef3Gh4'.repeat(8) + 'AA';
      await runPhaseEdgeContradictions(engine, { judge: async () => { throw new TypeError(`bad key ${key} ` + 'x'.repeat(400)); } });
      const [row] = await errorRows();
      expect(row.detail).toStartWith('attempt 1/3; TypeError: ');
      expect(row.detail).not.toContain(key);
      expect(row.detail.length).toBeLessThanOrEqual('attempt 1/3; TypeError: '.length + 200);
    });
  });

  test('zero budget spends nothing', async () => {
    await seed(DATED);
    await engine.setConfig('dream.edge_contradictions.max_usd', '0');
    try {
      calls = 0;
      const r = await runPhaseEdgeContradictions(engine, { judge: counting(conflict) });
      expect(calls).toBe(0);
      expect(r.detail).toContain('budget exhausted');
    } finally { await engine.setConfig('dream.edge_contradictions.max_usd', '1'); }
  });

  test('reject keeps both relationships; mode off skips', async () => {
    await engine.setConfig('dream.edge_contradictions.mode', 'propose');
    await seed(DATED);
    await runPhaseEdgeContradictions(engine, { judge: conflict });
    const [p] = await proposals();
    expect((await rejectEdgeProposal(engine, p.id)).status).toBe('rejected');
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/widget-co']);
    await engine.setConfig('dream.edge_contradictions.mode', 'off');
    try { expect((await runPhaseEdgeContradictions(engine, { judge: conflict })).status).toBe('skipped'); }
    finally { await engine.setConfig('dream.edge_contradictions.mode', 'propose'); }
  });

  test('certified models default to apply; others to propose; an explicit mode wins', async () => {
    expect(isCertifiedApplyModel('anthropic:claude-haiku-4-5-20251001')).toBe(true);
    expect(isCertifiedApplyModel('openai:gpt-6.1-sol')).toBe(true);
    expect(isCertifiedApplyModel('claude-opus-5-5')).toBe(true);
    expect(isCertifiedApplyModel('gpt-5.4-mini')).toBe(false);
    expect((await loadEdgeContradictionsConfig(engine, 'anthropic:claude-haiku-4-5-20251001')).mode).toBe('apply');
    expect((await loadEdgeContradictionsConfig(engine, 'openai:gpt-5.4-mini')).mode).toBe('propose');
    await engine.setConfig('dream.edge_contradictions.mode', 'propose');
    expect((await loadEdgeContradictionsConfig(engine, 'claude-sonnet-5-5')).mode).toBe('propose');
  });
});
