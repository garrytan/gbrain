import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { OrphanResult } from '../src/commands/orphans.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const [A, B, FOREIGN] = ['orphan-public-a', 'orphan-public-b', 'orphan-foreign'];
const PRIVATE = 'PRIVATE_ORPHAN_AGGREGATE_CANARY';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function page(slug: string, sourceId: string, hidden = false) {
  return engine.putPage(slug, {
    type: 'note', title: hidden ? PRIVATE : slug,
    compiled_truth: hidden ? PRIVATE : 'Public orphan fixture.',
    frontmatter: { visibility: hidden ? 'private' : 'world' },
  }, { sourceId });
}

beforeEach(async () => {
  await resetPgliteState(engine);
  for (const source of [A, B, FOREIGN]) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [source]);
  }
  await page('notes/shared-example', A);
  await page('templates/public-example', A); // Excluded from linkable pages by default.
  await page('notes/second-example', B);
  await page('notes/foreign-example', FOREIGN);
});

function context(remote: boolean | undefined, sourceId: string, allowedSources?: string[]): OperationContext {
  return {
    engine, config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false, remote: remote as boolean, sourceId,
    ...(allowedSources !== undefined ? {
      auth: { token: 'fixture', clientId: 'orphan-reader-example', scopes: ['read'], allowedSources },
    } : {}),
  };
}

async function read(ctx: OperationContext, includePseudo = false): Promise<OrphanResult> {
  return operationsByName.find_orphans.handler(ctx, { include_pseudo: includePseudo }) as Promise<OrphanResult>;
}

describe('orphan aggregate privacy through the operation boundary', () => {
  for (const remote of [true, undefined]) {
    for (const scope of [
      { name: 'scalar', sourceId: A, allowedSources: undefined, publicPages: 2, localPages: 4 },
      { name: 'federated grant overrides scalar', sourceId: FOREIGN, allowedSources: [A, B], publicPages: 3, localPages: 7 },
      { name: 'empty grant falls back to scalar', sourceId: A, allowedSources: [], publicPages: 2, localPages: 4 },
    ]) {
      test(`remote=${String(remote)}, ${scope.name}: private mutations cannot change totals or denominators`, async () => {
        const ctx = context(remote, scope.sourceId, scope.allowedSources);
        const before = await read(ctx);
        const beforeWithPseudo = await read(ctx, true);
        expect(before).toMatchObject({
          total_pages: scope.publicPages, total_linkable: scope.publicPages - 1,
          total_orphans: scope.publicPages - 1, excluded: 1,
        });
        expect(before.orphans.map(row => row.slug)).toContain('notes/shared-example');
        expect(beforeWithPseudo).toMatchObject({
          total_pages: scope.publicPages, total_linkable: scope.publicPages,
          total_orphans: scope.publicPages, excluded: 0,
        });

        const hidden = await page('notes/private-example', A, true);
        await page('templates/private-example', A, true);
        // A public namesake cannot authorize the private row in the other source.
        await page('notes/shared-example', B, true);
        await page('notes/private-second-example', B, true);
        await page('notes/private-foreign-example', FOREIGN, true);
        expect(await read(ctx)).toEqual(before);
        expect(await read(ctx, true)).toEqual(beforeWithPseudo);
        expect(JSON.stringify(await read(ctx))).not.toContain(PRIVATE);

        // Both a hidden body edit and removal must remain unobservable in the
        // separately computed totals, even though local readers see the rows.
        await engine.executeRaw('UPDATE pages SET title = $1 WHERE id = $2', [`${PRIVATE}_EDITED`, hidden.id]);
        expect(await read(ctx)).toEqual(before);
        const localCtx = context(false, scope.sourceId, scope.allowedSources);
        const local = await read(localCtx);
        expect(local).toMatchObject({
          total_pages: scope.localPages, total_linkable: scope.localPages - 2,
          total_orphans: scope.localPages - 2, excluded: 2,
        });
        expect(JSON.stringify(local.orphans)).toContain(PRIVATE);
        expect((await read(localCtx, true)).total_linkable).toBe(scope.localPages);

        await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [hidden.id]);
        expect(await read(ctx)).toEqual(before);
        expect(await read(ctx, true)).toEqual(beforeWithPseudo);
        expect((await read(localCtx)).total_pages).toBe(scope.localPages - 1);
      });
    }
  }
});
