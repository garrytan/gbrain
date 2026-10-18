/**
 * Line-grammar toggle scenarios shared by the PGLite tests and their Postgres
 * E2E arm (test/line-grammar-toggle.test.ts, test/e2e/line-grammar-toggle-postgres.test.ts).
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { extractManagedStaleLinks } from '../../src/core/persistence/links-maintenance.ts';
import { prepareAutomaticLinks } from '../../src/core/persistence/links-preparation.ts';
import { applyLineGrammarConfigChange, describeLineGrammarChange } from '../../src/core/line-grammar-config.ts';
import { effectiveLinkExtractorWatermark } from '../../src/core/link-extraction-watermark.ts';
import { LINK_EXTRACTION_GENERATION_KEY } from '../../src/core/line-grammar.ts';
import { managedBrain } from './managed-brain.ts';

const put = (ctx: OperationContext, slug: string, body: string, type = 'person') =>
  submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    content: `---\ntype: ${type}\ntitle: ${slug}\n---\n\n${body}\n` } }) as Promise<Record<string, any>>;

const aliceTypes = async (engine: BrainEngine) => (await engine.executeRaw<{ link_type: string }>(`SELECT DISTINCT l.link_type FROM links l
  JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
  WHERE f.slug='people/alice-example' AND t.slug='companies/acme-example' ORDER BY 1`)).map(r => r.link_type);

const stale = async (engine: BrainEngine) => engine.countStalePagesForExtraction({ versionTs: await effectiveLinkExtractorWatermark(engine) });

async function seed(engine: BrainEngine, ctx: OperationContext) {
  await put(ctx, 'companies/acme-example', 'Acme.', 'company');
  await put(ctx, 'people/alice-example', 'Alice builds things.\n\n- works_at [[companies/acme-example]]');
  await extractManagedStaleLinks(engine, { mentions: false });
}

export async function enableThenDisableConverges(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await seed(engine, ctx);
    expect(await aliceTypes(engine)).not.toContain('works_at');
    expect(await stale(engine)).toBe(0);

    const on = await applyLineGrammarConfigChange(engine, tx => tx.setConfig('line_grammar.enabled', 'true'));
    expect(on.changed).toBe(true);
    expect(await engine.getConfig(LINK_EXTRACTION_GENERATION_KEY)).toBe(on.generation);
    expect(await stale(engine)).toBeGreaterThanOrEqual(2);
    const described = await describeLineGrammarChange(engine, on);
    expect(described.lines.join('\n')).toContain('gbrain extract --stale');
    expect(described.json).toMatchObject({ changed: true, effective: { enabled: true } });
    await extractManagedStaleLinks(engine, { mentions: false });
    expect(await stale(engine)).toBe(0);
    expect(await aliceTypes(engine)).toContain('works_at');

    const off = await applyLineGrammarConfigChange(engine, tx => tx.setConfig('line_grammar.enabled', 'false'));
    expect(off.changed).toBe(true);
    expect(Date.parse(off.generation!)).toBeGreaterThanOrEqual(Date.parse(on.generation!));
    expect(await stale(engine)).toBeGreaterThanOrEqual(2);
    await extractManagedStaleLinks(engine, { mentions: false });
    expect(await stale(engine)).toBe(0);
    expect(await aliceTypes(engine)).not.toContain('works_at');
  }, { databaseUrl });
}

export async function noOpChangesKeepTheGeneration(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await seed(engine, ctx);
    for (const mutate of [
      (tx: BrainEngine) => tx.setConfig('line_grammar.enabled', 'false'),
      (tx: BrainEngine) => tx.setConfig('line_grammar.enabled', 'off'),
      async (tx: BrainEngine) => { await tx.unsetConfig('line_grammar.enabled'); },
      (tx: BrainEngine) => tx.setConfig('line_grammar.effective_ranges', 'false'),
      (tx: BrainEngine) => tx.setConfig('line_grammar.allow_undeclared_types', 'true'),
    ]) {
      const change = await applyLineGrammarConfigChange(engine, mutate);
      expect(change.changed).toBe(false);
    }
    expect(await engine.getConfig(LINK_EXTRACTION_GENERATION_KEY)).toBeNull();
    expect(await stale(engine)).toBe(0);
  }, { databaseUrl });
}

export async function preparedBeforeChangeStaysStale(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await seed(engine, ctx);
    const snapshot = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' });
    const prepared = await prepareAutomaticLinks(engine, 'people/alice-example', snapshot!.page, 'default');
    expect(prepared.settings?.enabled).toBe(false);
    await applyLineGrammarConfigChange(engine, tx => tx.setConfig('line_grammar.enabled', 'true'));
    const written = await engine.transaction(tx => prepared.apply(tx));
    expect(written.errors).toBe(1);
    expect(await stale(engine)).toBeGreaterThanOrEqual(2);
    await extractManagedStaleLinks(engine, { mentions: false });
    expect(await aliceTypes(engine)).toContain('works_at');
  }, { databaseUrl });
}

/** A toggle racing an extraction: whatever interleaving happens, one more extraction converges to the final setting. */
export async function concurrentToggleConverges(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await seed(engine, ctx);
    for (let i = 0; i < 20; i++) await put(ctx, `people/extra-${i}`, `- works_at [[companies/acme-example]]\n\nExtra ${i}.`);
    await Promise.all([
      extractManagedStaleLinks(engine, { mentions: false }),
      applyLineGrammarConfigChange(engine, tx => tx.setConfig('line_grammar.enabled', 'true')),
    ]);
    await extractManagedStaleLinks(engine, { mentions: false });
    expect(await stale(engine)).toBe(0);
    expect(await aliceTypes(engine)).toContain('works_at');
  }, { databaseUrl });
}
