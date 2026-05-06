/**
 * E2E test for gdoc-ingest skill.
 *
 * Exercises the FULL pipeline against a real Google Drive document:
 *   parse URL → fetch via GAS → extract → classify → render → commit
 *
 * Skipped by default — requires:
 *   - GAS Workspace Bridge accessible (network, OAuth)
 *   - Postgres running with brain DB
 *   - The fixture URL still pointing to a real doc
 *
 * Run explicitly with:
 *   GDOC_INGEST_E2E=1 bun test test/e2e/gdoc-ingest.e2e.test.ts
 */
import { describe, expect, it } from 'bun:test';
import { ingest } from '../../skills/gdoc-ingest/scripts/gdoc-ingest.mjs';

const FIXTURE_URL = 'https://docs.google.com/spreadsheets/d/1IkhFDpuQiOpBeiPqkwQzcOlg1uP61pt1VZh93XzldD4/edit?pli=1&gid=319775915';

const skipReason = process.env.GDOC_INGEST_E2E !== '1'
  ? 'set GDOC_INGEST_E2E=1 to enable'
  : null;

describe.skipIf(!!skipReason)('gdoc-ingest E2E', () => {
  it('ingests a real Google Sheet end-to-end (no commit)', async () => {
    const r = await ingest({ url: FIXTURE_URL, indexedVia: 'e2e-test', commit: false });
    expect(r).toBeTruthy();
    expect(r.kind).toBe('sheet');
    expect(r.title).toContain('Gestão Contábil');
    expect(r.disciplina).toBe('ops');
    expect(r.tema).toBe('gestao');
    expect(r.charCount).toBeGreaterThan(1000);
    expect(r.slug).toBe('docs/inbox/gestao-contabil-2026');
    expect(r.proposedFinalSlug).toBe('docs/ops/gestao/gestao-contabil-2026');
    expect(r.slideStats?.totalTabs).toBeGreaterThanOrEqual(20);
    expect(r.slideStats?.priorityTab).toBe('Areas Rafa');
    // Sheet content should include real cells, not just metadata
    expect(r.content).toContain('### Tab: Areas Rafa');
    expect(r.content).toContain('Premissas');
  }, 120_000); // 2min timeout for GAS calls
});
