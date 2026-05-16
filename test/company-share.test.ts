import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import {
  buildCompanyShareExport,
  importCompanyShareRecords,
  sanitizeCompanyShareContent,
  setCompanyShareSecret,
  setPageShareMode,
  setSourceShareDefault,
  verifyCompanyShareExport,
  type CompanyShareMember,
} from '../src/core/company-share.ts';

let individual: PGLiteEngine;
let company: PGLiteEngine;

beforeAll(async () => {
  individual = new PGLiteEngine();
  await individual.connect({});
  await individual.initSchema();

  company = new PGLiteEngine();
  await company.connect({});
  await company.initSchema();
});

afterAll(async () => {
  await individual.disconnect();
  await company.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(individual);
  await resetPgliteState(company);
  await setCompanyShareSecret(individual, 'test-shared-secret');
});

const member: CompanyShareMember = {
  id: 'alice',
  issuer_url: 'http://127.0.0.1:3001',
  mcp_url: 'http://127.0.0.1:3001/mcp',
  oauth_client_id: 'client',
  oauth_client_secret: 'secret',
  manifest_secret: 'test-shared-secret',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

describe('company-share export policy', () => {
  test('defaults to private until source or page opts in', async () => {
    await individual.putPage('notes/private-default', {
      type: 'note',
      title: 'Private Default',
      compiled_truth: 'this should stay private',
      frontmatter: {},
    });

    const exported = await buildCompanyShareExport(individual, { memberId: 'alice' });

    expect(exported.records).toHaveLength(0);
    verifyCompanyShareExport(exported, member);
  });

  test('uses page override before source default before private fallback', async () => {
    await individual.putPage('notes/source-summary', {
      type: 'note',
      title: 'Source Summary',
      compiled_truth: 'summary source default content',
      frontmatter: {},
    });
    await individual.putPage('notes/page-private', {
      type: 'note',
      title: 'Page Private',
      compiled_truth: 'private page override content',
      frontmatter: {},
    });
    await individual.putPage('notes/page-full', {
      type: 'note',
      title: 'Page Full',
      compiled_truth: 'full page override content',
      frontmatter: {},
    });

    await setSourceShareDefault(individual, 'default', 'summary');
    await setPageShareMode(individual, 'notes/page-private', 'private');
    await setPageShareMode(individual, 'notes/page-full', 'full');

    const exported = await buildCompanyShareExport(individual, { memberId: 'alice' });
    const bySlug = new Map(exported.records.map(r => [r.slug, r]));

    expect(bySlug.get('notes/source-summary')?.mode).toBe('summary');
    expect(bySlug.has('notes/page-private')).toBe(false);
    expect(bySlug.get('notes/page-full')?.mode).toBe('full');
    verifyCompanyShareExport(exported, member);
  });
});

describe('company-share sanitization', () => {
  test('strips private fences, citations, frontmatter-shaped data, and script HTML', async () => {
    const raw = `---
secret: do-not-export
---

Visible paragraph. [Source: internal://crm]

<script>alert('x')</script>

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Private fact should not export | fact | 1.0 | private | medium | 2026-01-01 | | manual | |
| 2 | World fact can export | fact | 1.0 | world | medium | 2026-01-01 | | manual | |
${FACTS_FENCE_END}

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|---|---|---|---|---|---|
| 1 | Internal take should not export | take | brain | 0.9 | 2026-01-01 | manual |
${TAKES_FENCE_END}`;

    const clean = sanitizeCompanyShareContent(raw);

    expect(clean).toContain('Visible paragraph.');
    expect(clean).toContain('World fact can export');
    expect(clean).not.toContain('do-not-export');
    expect(clean).not.toContain('[Source:');
    expect(clean).not.toContain('<script>');
    expect(clean).not.toContain('Private fact should not export');
    expect(clean).not.toContain('Internal take should not export');
  });

  test('exports only sanitized full content and safe metadata', async () => {
    await individual.putPage('notes/unsafe', {
      type: 'note',
      title: 'Unsafe',
      compiled_truth: 'Hello <script>steal()</script> secret [Source: private]',
      frontmatter: { company_share: 'full', secret: 'frontmatter-secret' },
    });

    const exported = await buildCompanyShareExport(individual, { memberId: 'alice' });

    expect(exported.records).toHaveLength(1);
    expect(exported.records[0].content).toContain('Hello');
    expect(exported.records[0].content).not.toContain('steal');
    expect(exported.records[0].content).not.toContain('Source:');
    expect(JSON.stringify(exported)).not.toContain('frontmatter-secret');
    verifyCompanyShareExport(exported, member);
  });
});

describe('company-share company import', () => {
  test('imports records into a dedicated member source idempotently', async () => {
    await individual.putPage('notes/shared', {
      type: 'note',
      title: 'Shared',
      compiled_truth: 'shared content',
      frontmatter: { company_share: 'full' },
    });
    const exported = await buildCompanyShareExport(individual, { memberId: 'alice' });
    verifyCompanyShareExport(exported, member);

    const first = await importCompanyShareRecords(company, 'alice', [exported]);
    const second = await importCompanyShareRecords(company, 'alice', [exported]);
    const rows = await company.executeRaw<{ source_id: string; slug: string; compiled_truth: string }>(
      `SELECT source_id, slug, compiled_truth FROM pages WHERE slug = $1`,
      ['notes/shared'],
    );

    expect(first.source_id).toBe('member-alice');
    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe('member-alice');
    expect(rows[0].compiled_truth).toBe('shared content');
  });

  test('soft-deletes a previously imported page only after a successful export omits it', async () => {
    await individual.putPage('notes/shared', {
      type: 'note',
      title: 'Shared',
      compiled_truth: 'shared content',
      frontmatter: { company_share: 'full' },
    });
    const shared = await buildCompanyShareExport(individual, { memberId: 'alice' });
    await importCompanyShareRecords(company, 'alice', [shared]);

    await setPageShareMode(individual, 'notes/shared', 'private');
    const unshared = await buildCompanyShareExport(individual, { memberId: 'alice' });
    const result = await importCompanyShareRecords(company, 'alice', [unshared]);
    const page = await company.getPage('notes/shared', { sourceId: 'member-alice', includeDeleted: true });

    expect(result.soft_deleted).toBe(1);
    expect(page?.deleted_at).toBeInstanceOf(Date);
  });
});
