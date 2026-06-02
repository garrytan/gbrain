import { describe, it, expect } from 'bun:test';
import {
  getRunnerToolAllowlist,
  evaluateRunnerToolCall,
} from '../../src/core/runners/runner-policy.ts';

describe('candidate_promotion_review task', () => {
  it('allows only emit_promotion_verdict', () => {
    expect(getRunnerToolAllowlist('candidate_promotion_review')).toEqual(['emit_promotion_verdict']);
  });
  it('allows the emit_promotion_verdict tool call', () => {
    const d = evaluateRunnerToolCall({ task_type: 'candidate_promotion_review', tool_name: 'emit_promotion_verdict' });
    expect(d.status).toBe('allowed');
    expect(d.canonical_mutation_allowed).toBe(false);
  });
  it('denies put_page for this task', () => {
    const d = evaluateRunnerToolCall({ task_type: 'candidate_promotion_review', tool_name: 'put_page' });
    expect(d.status).toBe('denied');
  });
});
