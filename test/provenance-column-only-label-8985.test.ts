import { describe, expect, test } from 'bun:test';
import { analyzePageDrift } from '../src/core/trust/provenance-drift.ts';

describe('#8985 column-only stamp difference', () => {
  test('a stamp differing from the pages column with no version change is labelled as observed, not as an unattributed write', () => {
    const fm = { source_kind: 'api', ingested_via: 'mcp:put_page' };
    const chain = [{ frontmatter: fm, writer: 'remote' as const, request_id: 'r1' }, { frontmatter: fm, writer: 'remote' as const, request_id: 'r2' }];
    const verdict = analyzePageDrift({ chain, stored: 'unknown', columns: { source_kind: 'api', ingested_via: 'mcp:edit_page', ingested_at: null } });
    expect(verdict?.class).toBe('ambiguous');
    expect(String(verdict?.reason ?? '')).toContain('pages column');
  });
});
