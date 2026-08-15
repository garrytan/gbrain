/**
 * Tests for src/core/advisor/apply.ts — the --apply allowlist + injection guard
 * (E5/C5). The CLI confirms + spawns; this verifies WHAT is allowed to run.
 */
import { describe, test, expect } from 'bun:test';
import { resolveApplyTarget } from '../src/core/advisor/apply.ts';
import type { AdvisorFinding, AdvisorReport } from '../src/core/advisor/types.ts';

function report(findings: AdvisorFinding[]): AdvisorReport {
  return { version: '0.43.0.0', generated_at: 'x', findings, worst: 'info' };
}
function f(over: Partial<AdvisorFinding>): AdvisorFinding {
  return { id: 'x', severity: 'info', title: 't', fix: { command_argv: null }, collector: 'c', ask_user: true, ...over };
}

describe('resolveApplyTarget', () => {
  test('resolves an allowlisted finding to its argv', () => {
    const r = report([
      f({ id: 'mig', fix: { command_argv: ['gbrain', 'apply-migrations', '--yes'], dispatch_id: 'apply_migrations' } }),
    ]);
    const res = resolveApplyTarget(r, 'apply_migrations');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.argv).toEqual(['gbrain', 'apply-migrations', '--yes']);
  });

  test('rejects unknown id and lists runnable ids', () => {
    const r = report([
      f({ id: 'mig', fix: { command_argv: ['gbrain', 'apply-migrations', '--yes'], dispatch_id: 'apply_migrations' } }),
    ]);
    const res = resolveApplyTarget(r, 'nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.runnable).toEqual(['apply_migrations']);
  });

  test('a finding without dispatch_id is NOT runnable', () => {
    const r = report([f({ id: 'v', fix: { command_argv: ['gbrain', 'upgrade'] } })]); // no dispatch_id
    expect(resolveApplyTarget(r, 'v').ok).toBe(false);
  });

  test('rejects shell metacharacters in the argv (injection guard)', () => {
    const r = report([
      f({ id: 'evil', fix: { command_argv: ['gbrain', 'scaffold', 'foo; rm -rf /'], dispatch_id: 'evil' } }),
    ]);
    expect(resolveApplyTarget(r, 'evil').ok).toBe(false);
  });

  test('rejects a fix that does not invoke gbrain', () => {
    const r = report([f({ id: 'x', fix: { command_argv: ['rm', '-rf', '/'], dispatch_id: 'x' } })]);
    expect(resolveApplyTarget(r, 'x').ok).toBe(false);
  });
});
