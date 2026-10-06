/**
 * Engine-parametrized scenarios for put_page's similar-pages advisory
 * (test/put-page-similar-pages.test.ts on PGLite, test/e2e/p5-graph-postgres.test.ts on Postgres).
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { managedBrain } from './managed-brain.ts';

const put = async (ctx: OperationContext, slug: string, title: string, extra = '', expectedRevision?: string) => {
  const written = await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
    content: `---\ntype: note\ntitle: ${title}\n${extra}---\n\nBody of ${slug}.\n` } }) as Record<string, any>;
  return written.outcome ?? written;
};

/** Off by default (held-out verdict H5b); once on, creates get lexical candidates with their evidence and updates and distinct pages get none. */
export async function similarPagesOnCreate(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    const acme = await put(ctx, 'companies/acme-example', 'Acme Example', 'aliases: [Acme Corp]\n');
    expect(acme.similar_pages).toBeUndefined();
    const { findSimilarPages } = await import('../../src/core/similar-pages.ts');
    expect(await findSimilarPages(engine, { sourceId: 'default', slug: 'companies/acme-example-2', title: 'Acme Example', excludePrivate: false })).toBeNull();
    await engine.setConfig('put_page.similar_pages', 'true');
    expect((await put(ctx, 'companies/acme-example-2', 'Acme Example')).similar_pages)
      .toMatchObject({ candidates: [{ slug: 'companies/acme-example', source_id: 'default', evidence: 'exact_title' }], semantic: 'not_checked' });
    const aliasHit = await put(ctx, 'companies/acme-corp', 'Acme Corp');
    expect(aliasHit.similar_pages.candidates).toContainEqual({ slug: 'companies/acme-example', source_id: 'default', evidence: 'alias' });
    expect((await put(ctx, 'notes/acme-example', 'Meeting notes')).similar_pages.candidates)
      .toContainEqual({ slug: 'companies/acme-example', source_id: 'default', evidence: 'same_name_other_directory' });
    await put(ctx, 'concepts/retrieval-augmented-generation', 'Retrieval Augmented Generation');
    expect((await put(ctx, 'concepts/rag', 'Retrieval-Augmented Generation')).similar_pages.candidates)
      .toContainEqual({ slug: 'concepts/retrieval-augmented-generation', source_id: 'default', evidence: 'similar_title' });
    expect((await put(ctx, 'concepts/vector-databases', 'Vector databases')).similar_pages).toBeUndefined();
    expect((await put(ctx, 'companies/acme-example', 'Acme Example', 'aliases: [Acme Corp]\n', acme.revision)).similar_pages).toBeUndefined();
    const advisory = (await put(ctx, 'companies/acme-example-3', 'Acme Example')).similar_pages;
    expect(advisory.candidates.length).toBeLessThanOrEqual(3);
    expect(advisory.fix).toMatchObject({ mcp: { tool: 'get_page' } });
    expect(JSON.stringify(advisory.candidates)).not.toContain('Body of');
    await engine.setConfig('put_page.similar_pages', 'false');
    expect((await put(ctx, 'companies/acme-example-4', 'Acme Example')).similar_pages).toBeUndefined();
  }, { databaseUrl });
}

/** A caller that may not read private pages is never pointed at one. */
export async function similarPagesSkipPrivate(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('put_page.similar_pages', 'true');
    await put(ctx, 'people/secret-example', 'Secret Example', 'visibility: private\n');
    const local = await put(ctx, 'people/secret-example-2', 'Secret Example');
    expect(local.similar_pages.candidates).toContainEqual(expect.objectContaining({ slug: 'people/secret-example' }));
    const { findSimilarPages } = await import('../../src/core/similar-pages.ts');
    const remote = await findSimilarPages(ctx.engine, { sourceId: 'default', slug: 'people/secret-example-3', title: 'Secret Example', excludePrivate: true });
    expect(remote!.candidates.map(c => c.slug)).toEqual(['people/secret-example-2']);
  }, { databaseUrl });
}
