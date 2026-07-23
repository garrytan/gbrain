import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { makeContext } from '../src/cli.ts';
import { operations, sourceScopeOpts } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  delete process.env.GBRAIN_SOURCE;
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();

  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES
       ('team-meetings', 'Team meetings', '{"federated":true}'::jsonb),
       ('private-drafts', 'Private drafts', '{"federated":false}'::jsonb)`,
  );

  await engine.putPage('people/alice-example', {
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'Thin canonical person page.',
  }, { sourceId: 'default' });
  await engine.putPage('meetings/alice-planning', {
    type: 'meeting',
    title: 'Alice planning',
    compiled_truth: 'Alice owns the planning workflow.',
  }, { sourceId: 'team-meetings' });
  await engine.putPage('drafts/alice-private', {
    type: 'note',
    title: 'Alice private draft',
    compiled_truth: 'This isolated source must not join unqualified reads.',
  }, { sourceId: 'private-drafts' });

}, 60_000);

afterAll(async () => {
  delete process.env.GBRAIN_SOURCE;
  await engine.disconnect();
});

describe('local CLI federated read context', () => {
  test('unqualified reads span federated sources but exclude isolated sources', async () => {
    const ctx = await makeContext(engine, {}, 'read');

    expect(ctx.sourceId).toBe('default');
    expect(ctx.localReadSourceIds?.sort()).toEqual(['default', 'team-meetings']);
    expect(sourceScopeOpts(ctx)).toEqual({
      sourceIds: ['default', 'team-meetings'],
    });

    const listPages = operations.find((op) => op.name === 'list_pages');
    expect(listPages).toBeDefined();
    const results = await listPages!.handler(ctx, { limit: 20, sort: 'slug' }) as Array<{
      slug: string;
      source_id: string;
    }>;
    const slugs = results.map((row) => row.slug);

    expect(slugs).toContain('people/alice-example');
    expect(slugs).toContain('meetings/alice-planning');
    expect(slugs).not.toContain('drafts/alice-private');
  });

  test('an explicit source pin narrows a read to that source', async () => {
    const ctx = await makeContext(engine, { source: 'team-meetings' }, 'read');

    expect(ctx.sourceId).toBe('team-meetings');
    expect(ctx.localReadSourceIds).toBeUndefined();
    expect(sourceScopeOpts(ctx)).toEqual({ sourceId: 'team-meetings' });
  });

  test('writes keep the scalar default and never inherit federated read scope', async () => {
    const ctx = await makeContext(engine, {}, 'write');

    expect(ctx.sourceId).toBe('default');
    expect(ctx.localReadSourceIds).toBeUndefined();
  });
});
