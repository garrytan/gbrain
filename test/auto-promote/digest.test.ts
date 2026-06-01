import { describe, it, expect } from 'bun:test';
import { formatMemoryReviewReport, buildMemoryReviewReport } from '../../src/core/services/memory-review-report-service.ts';

describe('auto-promote digest section', () => {
  it('renders the auto-promote summary when present', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: '2026-06-01T00:00:00Z',
      auto_promote_summary: { auto_promoted: 3, escalated: 1, deferred: 2, excluded: 4, generated_at: '2026-06-01T00:00:00Z' },
    } as any);
    const text = formatMemoryReviewReport(report);
    expect(text).toContain('Auto-promoted');
    expect(text).toContain('3');
  });
  it('omits the section when not provided', () => {
    const report = buildMemoryReviewReport({ scope_id: 'workspace:default', generated_at: '2026-06-01T00:00:00Z' } as any);
    const text = formatMemoryReviewReport(report);
    expect(text).not.toContain('Auto-promoted');
  });
});
