import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { exportDatabaseContent } from '../src/core/shared-skills/migration-export.ts';
import { prepareCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

const body = [
  renderTakesFence([{ rowNum: 1, claim: 'Synthetic prediction', kind: 'bet', holder: 'brain', weight: 0.9, active: true,
    sinceDate: '2025-01-01', untilDate: '2027-01-01', source: 'Private synthetic provenance',
    resolvedAt: '2026-01-01T00:00:00.000Z', resolvedQuality: 'correct', resolvedEvidence: 'Private synthetic evidence',
    resolvedValue: 10, resolvedUnit: 'USD', resolvedBy: 'brain' }]),
  renderFactsTable([{ rowNum: 1, claim: 'Synthetic metric', kind: 'fact', confidence: 0.8, visibility: 'private', notability: 'medium',
    validFrom: '2025-01-01', source: 'Synthetic provenance', context: 'Private synthetic context', active: true,
    claimMetric: 'mrr', claimValue: 100, claimUnit: 'USD', claimPeriod: 'monthly' }]),
].join('\n\n').trim();

async function fixture(run: (ctx: OperationContext, root: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-export-projection-'));
  const databaseUrl = process.env.SHARED_SKILLS_EXPORT_DATABASE_URL;
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: { visibility: 'private' } }, { sourceId: 'default' });
      const page = (await engine.getPage('notes/example', { sourceId: 'default' }))!;
      const parsed = parseMarkdown(serializePageToMarkdown(page, []), 'notes/example.md');
      await engine.transaction(tx => prepareCanonicalProjections(parsed, page.slug, 'default')(tx));
      await run({ engine, config: { engine: databaseUrl ? 'postgres' : 'pglite', mcp: { publish_skills: false } }, sourceId: 'default', remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } }, join(home, 'content'));
    } finally { await close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test('export rejects every changed canonical take field before binding and leaves private resolution intact', () => fixture(async (ctx, root) => {
  const changes: Record<string, unknown> = { claim: 'Changed claim', kind: 'fact', holder: 'world', weight: 0.5,
    since_date: '2024-01-01', until_date: null, source: 'Changed provenance', superseded_by: 7, active: false,
    resolved_at: null, resolved_quality: null, resolved_outcome: null, resolved_source: null,
    resolved_value: null, resolved_unit: null, resolved_by: null };
  for (const [field, value] of Object.entries(changes)) {
    const rollback = new Error(`rollback ${field}`);
    await expect(ctx.engine.transaction(async tx => {
      await tx.executeRaw(`UPDATE takes SET ${field}=$1`, [value]);
      const before = await tx.executeRaw('SELECT * FROM takes');
      const result = await exportDatabaseContent({ ...ctx, engine: tx }, { sourceId: 'default', root, confirmQuiesced: true, backup: 'operator_verified' });
      expect(result.status).toBe('conflict');
      expect(result.conflicts[0].reason).toContain(field);
      expect(existsSync(root)).toBe(false);
      expect(await tx.executeRaw('SELECT * FROM takes')).toEqual(before);
      expect((await tx.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0].local_path).toBeNull();
      throw rollback;
    })).rejects.toBe(rollback);
  }
}), 120_000);

test('export rejects every changed canonical fact field including provenance, confidence, dates and metrics', () => fixture(async (ctx, root) => {
  const [fact] = await ctx.engine.executeRaw<{ id: number }>('SELECT id FROM facts');
  const changes: Record<string, unknown> = { fact: 'Changed fact', kind: 'preference', visibility: 'world', entity_slug: 'notes/other',
    notability: 'high', context: 'Changed context', source: 'Changed provenance', confidence: 0.2,
    valid_from: '2024-01-01', valid_until: '2027-01-01', expired_at: '2026-01-01',
    claim_metric: 'arr', claim_value: 999, claim_unit: 'EUR', claim_period: 'yearly', superseded_by: fact.id };
  for (const [field, value] of Object.entries(changes)) {
    const rollback = new Error(`rollback ${field}`);
    await expect(ctx.engine.transaction(async tx => {
      await tx.executeRaw(`UPDATE facts SET ${field}=$1`, [value]);
      const before = await tx.executeRaw('SELECT * FROM facts');
      const result = await exportDatabaseContent({ ...ctx, engine: tx }, { sourceId: 'default', root, confirmQuiesced: true, backup: 'operator_verified' });
      expect(result.status).toBe('conflict');
      expect(result.conflicts[0].reason).toContain(field);
      expect(existsSync(root)).toBe(false);
      expect(await tx.executeRaw('SELECT * FROM facts')).toEqual(before);
      expect((await tx.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0].local_path).toBeNull();
      throw rollback;
    })).rejects.toBe(rollback);
  }
}), 120_000);

test('a verified export followed by an ordinary page edit preserves private take and fact semantics', () => fixture(async (ctx, root) => {
  const takeSql = `SELECT row_num,claim,kind,holder,weight,since_date,until_date,source,superseded_by,active,
    resolved_at,resolved_quality,resolved_outcome,resolved_source,resolved_value,resolved_unit,resolved_by FROM takes`;
  const factSql = `SELECT row_num,fact,kind,entity_slug,visibility,notability,context,source,confidence,
    valid_from,valid_until,expired_at,claim_metric,claim_value,claim_unit,claim_period,superseded_by FROM facts`;
  const beforeTakes = await ctx.engine.executeRaw(takeSql), beforeFacts = await ctx.engine.executeRaw(factSql);
  const result = await exportDatabaseContent(ctx, { sourceId: 'default', root, confirmQuiesced: true, backup: 'operator_verified' });
  expect(result.conflicts).toEqual([]);
  expect(result.status).toBe('complete');
  const snapshot = (await ctx.engine.readPageSnapshot('notes/example', { sourceId: 'default' }))!;
  const edited = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/example', content: serializePageToMarkdown({ ...snapshot.page, title: 'Edited title' }, snapshot.tags), expected_revision: snapshot.revision } });
  expect(edited.state).toBe('committed');
  expect(await ctx.engine.executeRaw(takeSql)).toEqual(beforeTakes);
  expect(await ctx.engine.executeRaw(factSql)).toEqual(beforeFacts);
}), 120_000);

test('an incomplete resolution cannot invent a resolver during export validation', () => fixture(async (ctx, root) => {
  const incomplete = renderTakesFence([{ rowNum: 1, claim: 'Synthetic incomplete resolution', kind: 'bet', holder: 'brain', weight: 0.9, active: true,
    resolvedAt: '2026-01-01', resolvedQuality: 'correct', resolvedEvidence: 'Synthetic evidence without attribution' }]).trim();
  await ctx.engine.putPage('notes/incomplete', { type: 'note', title: 'Incomplete', compiled_truth: incomplete, timeline: '', frontmatter: {} }, { sourceId: 'default' });
  const page = (await ctx.engine.getPage('notes/incomplete', { sourceId: 'default' }))!;
  await ctx.engine.transaction(tx => prepareCanonicalProjections(parseMarkdown(serializePageToMarkdown(page, []), 'notes/incomplete.md'), page.slug, 'default')(tx));
  const before = await ctx.engine.executeRaw('SELECT * FROM takes ORDER BY id');
  const result = await exportDatabaseContent(ctx, { sourceId: 'default', root, confirmQuiesced: true, backup: 'operator_verified' });
  expect(result.status).toBe('conflict');
  expect(result.conflicts.find(conflict => conflict.slug === 'notes/incomplete')?.reason).toContain('resolved_by');
  expect(existsSync(root)).toBe(false);
  expect(await ctx.engine.executeRaw('SELECT * FROM takes ORDER BY id')).toEqual(before);
}), 120_000);
