/**
 * BrainEngine parity: `readPageSnapshot` with `resolveAlias`, the read behind `gbrain get` and `get_page`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an alias-resolving snapshot read returns the page at the exact slug when one is in scope, else the
 *    page a slug alias of the same source names; the read keeps the caller's source scope and soft-delete rule.
 *  - Regression: an engine that refuses the option (every `gbrain get` on a Rust brain stopped on it), ignores the
 *    alias, lets an alias outrank an exact slug, follows an alias across sources, or returns a deleted canonical page.
 *  - Why existing coverage misses it: sync-aliases.test.ts checks that a rename keeps the old-slug alias through
 *    getPage and resolveSlugs, never through the snapshot read `get_page` makes.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageSnapshotOptions } from '../../src/core/page-state/types.ts';

const { parityTest } = parityArms(testBackends());

/** The slug and source of the page the read returned, or null. */
async function hit(engine: BrainEngine, slug: string, opts: PageSnapshotOptions): Promise<string | null> {
  const snapshot = await engine.readPageSnapshot(slug, opts);
  return snapshot ? `${snapshot.page.source_id}:${snapshot.page.slug}` : null;
}

const page = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title}.`, timeline: '' });

describe('engine parity: readPageSnapshot resolveAlias', () => {
  parityTest('an alias read follows a rename alias, an exact slug wins, and a slug with neither reads null',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await engine.putPage('notes/old-name', page('Movable'));
      await engine.updateSlug('notes/old-name', 'notes/new-name');
      const result: Record<string, string | null> = {
        alias: await hit(engine, 'notes/old-name', { resolveAlias: true }),
        aliasScoped: await hit(engine, 'notes/old-name', { resolveAlias: true, sourceId: 'default' }),
        exactOnly: await hit(engine, 'notes/old-name', {}),
        canonical: await hit(engine, 'notes/new-name', { resolveAlias: true }),
        neither: await hit(engine, 'notes/never-existed', { resolveAlias: true }),
      };
      await engine.putPage('notes/old-name', page('Squatter'));
      result.exactWins = await hit(engine, 'notes/old-name', { resolveAlias: true });
      expect(result).toEqual({ alias: 'default:notes/new-name', aliasScoped: 'default:notes/new-name', exactOnly: null,
        canonical: 'default:notes/new-name', neither: null, exactWins: 'default:notes/old-name' });
      return result;
    });

  parityTest('an alias read keeps the source scope and skips a deleted canonical page unless deleted pages are asked for',
    { methods: ['putPage', 'updateSlug', 'softDeletePage', 'readPageSnapshot'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'snap-alias-other');
      await engine.putPage('notes/was', page('Elsewhere'), { sourceId: 'snap-alias-other' });
      await engine.updateSlug('notes/was', 'notes/now', { sourceId: 'snap-alias-other' });
      const result: Record<string, string | null> = {
        otherScope: await hit(engine, 'notes/was', { resolveAlias: true, sourceId: 'snap-alias-other' }),
        defaultScope: await hit(engine, 'notes/was', { resolveAlias: true, sourceId: 'default' }),
        listScope: await hit(engine, 'notes/was', { resolveAlias: true, sourceIds: ['default', 'snap-alias-other'] }),
        unscoped: await hit(engine, 'notes/was', { resolveAlias: true }),
      };
      await engine.softDeletePage('notes/now', { sourceId: 'snap-alias-other' });
      result.deleted = await hit(engine, 'notes/was', { resolveAlias: true, sourceId: 'snap-alias-other' });
      result.withDeleted = await hit(engine, 'notes/was', { resolveAlias: true, sourceId: 'snap-alias-other', includeDeleted: true });
      const other = 'snap-alias-other:notes/now';
      expect(result).toEqual({ otherScope: other, defaultScope: null, listScope: other, unscoped: other, deleted: null, withDeleted: other });
      return result;
    });
});
