import { describe, it, expect } from 'bun:test';
import { parsePromotionVerdict } from '../../src/core/auto-promote/verdict.ts';

describe('parsePromotionVerdict', () => {
  const ok = '{"decision":"promote","confidence":0.91,"reasoning":"direct user statement with source","source_refs":["user:msg:1"]}';
  it('parses clean JSON', () => {
    const v = parsePromotionVerdict(ok, 'cand-1');
    expect(v.ok).toBe(true);
    if (v.ok) { expect(v.verdict.decision).toBe('promote'); expect(v.verdict.candidate_id).toBe('cand-1'); }
  });
  it('parses fenced JSON', () => {
    const v = parsePromotionVerdict('```json\n' + ok + '\n```', 'cand-1');
    expect(v.ok).toBe(true);
  });
  it('tolerates trailing prose', () => {
    const v = parsePromotionVerdict(ok + '\n\nThat is my verdict.', 'cand-1');
    expect(v.ok).toBe(true);
  });
  it('fails closed on garbage (treated as no verdict, never promote)', () => {
    const v = parsePromotionVerdict('I think you should promote it!', 'cand-1');
    expect(v.ok).toBe(false);
  });
  it('rejects out-of-range confidence', () => {
    const v = parsePromotionVerdict('{"decision":"promote","confidence":2,"reasoning":"x","source_refs":[]}', 'cand-1');
    expect(v.ok).toBe(false);
  });
  it('rejects unknown decision', () => {
    const v = parsePromotionVerdict('{"decision":"file-it","confidence":0.9,"reasoning":"x","source_refs":[]}', 'cand-1');
    expect(v.ok).toBe(false);
  });
});
