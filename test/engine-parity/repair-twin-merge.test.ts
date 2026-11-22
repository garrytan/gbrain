/**
 * BrainEngine parity — batch 6b: the twin merge (persistence/twin-merge.ts `mergeTwinInto`, its moves in
 * engine-sql/twin-merge-moves.ts) and the origin-twins merge mode on an engine without its store side, the moved-pages
 * fold's version move (`movePageVersions`) and the secret-spans scan's named stop.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite and Postgres the merge moves the twin to the survivor and soft-deletes it; the Rust engine stops
 *    the merge by name ("repair twin merge") before it reads or writes anything, so the twin keeps its page and the
 *    survivor gains no page version. origin-twins in merge mode stops by name on Rust the same way; detach mode stays
 *    served. On every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts).
 *  - Regression: the merge wrote a page version and detached the twin's origin before its first raw statement, where the
 *    Rust engine refused it with an unnamed executeRaw error.
 *  - Why existing coverage misses it: test/origin-twins-6948.test.ts runs on PGLite and Postgres only.
 *    The fold moves every page version of the old page to the survivor on every engine (a missing survivor refuses), and
 *    secret-spans previews a named page on PGLite and Postgres while the Rust engine stops it by name ("repair
 *    secret-spans scan") before any read.
 *  - Seam: none. The merge runs in the engine's own transaction.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { mergeTwinInto } from '../../src/core/persistence/twin-merge.ts';
import { resolveOriginTwin, type OriginTwinPair } from '../../src/core/repair/origin-twins.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

async function seedPair(engine: BrainEngine) {
  const note = (slug: string) => ({ type: 'note' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '' });
  const survivor = await engine.putPage('notes/twin-survivor', { ...note('notes/twin-survivor'), source_path: 'notes/twin-survivor.md' }, { sourceId: 'default' });
  const twin = await engine.putPage('notes/twin-copy', note('notes/twin-copy'), { sourceId: 'default' });
  return { survivor: { page_id: Number(survivor.id), slug: survivor.slug }, twin: { page_id: Number(twin.id), slug: twin.slug } };
}

/** What the merge would change: whether the twin is live, and each page's version count. */
async function state(engine: BrainEngine) {
  const live = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' })) !== null;
  const versions = async (slug: string) => (await engine.getVersions(slug, { sourceId: 'default' })).length;
  return { twinLive: await live('notes/twin-copy'), survivorLive: await live('notes/twin-survivor'),
    twinVersions: await versions('notes/twin-copy'), survivorVersions: await versions('notes/twin-survivor') };
}

describe('engine parity: the twin merge on every engine', () => {
  parityTest('mergeTwinInto merges the twin on the SQL engines, and the Rust engine stops it by name before any write', {
    methods: ['putPage', 'transaction', 'getPage', 'getVersions'], requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => {
    const pair = await seedPair(engine);
    const before = await state(engine);
    try {
      const source = await engine.readSourceIncarnation('default');
      const merged = await engine.transaction(tx => mergeTwinInto(tx, { sourceId: 'default', incarnation: source!.incarnation, ...pair }));
      const after = await state(engine);
      expect(after).toEqual({ ...before, twinLive: false, twinVersions: before.twinVersions + 1 });
      return { merged: { ...merged, links_moved: merged.links_moved.length, facts_moved: merged.facts_moved.length }, before, after };
    } catch (err) {
      if (backend === 'rust') {
        expect(refusalText(err)).toContain('repair twin merge');
        expect(await state(engine)).toEqual(before);
      }
      throw err;
    }
  });

  parityTest('origin-twins merge mode stops by name on the Rust engine before it reads the pair', {
    methods: ['putPage'], requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => {
    const seeded = await seedPair(engine);
    const pair: OriginTwinPair = { source_id: 'default', source_path: 'notes/twin-survivor.md', twin_path: 'notes/twin-survivor.md',
      survivor: { ...seeded.survivor, revision: '0' } as never, twin: { ...seeded.twin, revision: '0' } as never, mode: 'merge' };
    const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as never;
    const before = await state(engine);
    try {
      const outcome = await resolveOriginTwin(ctx, pair, null, async () => 'c0000000-0000-4000-8000-0000000000e1');
      expect(await state(engine)).toEqual(before);
      return outcome;
    } catch (err) {
      if (backend === 'rust') {
        expect(refusalText(err)).toContain('repair twin merge');
        expect(await state(engine)).toEqual(before);
      }
      throw err;
    }
  });

  parityTest('movePageVersions moves every version of the old page to the survivor, and refuses a missing survivor', {
    methods: ['putPage', 'createVersion', 'getVersions', 'movePageVersions'], timeout: 60_000,
  }, async (engine) => {
    const pair = await seedPair(engine);
    await engine.createVersion(pair.twin.slug, { sourceId: 'default' });
    await engine.createVersion(pair.twin.slug, { sourceId: 'default' });
    await engine.createVersion(pair.survivor.slug, { sourceId: 'default' });
    const moved = await engine.movePageVersions(pair.twin.page_id, pair.survivor.page_id);
    const none = await engine.movePageVersions(pair.twin.page_id, pair.survivor.page_id);
    await engine.createVersion(pair.twin.slug, { sourceId: 'default' });
    const missing = await engine.movePageVersions(pair.twin.page_id, 987_654).then(() => 'moved', () => 'refused');
    const count = async (slug: string) => (await engine.getVersions(slug, { sourceId: 'default' })).length;
    const answers = { moved: moved.length, ascending: moved.every((id, i) => i === 0 || id > moved[i - 1]!), none, missing,
      twin: await count(pair.twin.slug), survivor: await count(pair.survivor.slug) };
    expect(answers).toEqual({ moved: 2, ascending: true, none: [], missing: 'refused', twin: 1, survivor: 3 });
    return answers;
  });

  parityTest('secret-spans previews a named page on the SQL engines, and the Rust engine stops the scan by name', {
    methods: ['putPage'], requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => {
    await seedPair(engine);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-b6b-home-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        try {
          const result = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: { info() {}, warn() {}, error() {} } as never }))
            .run('secret-spans', await resolveRepairScope(engine, 'default'), { explicit: true, remote: false, slugs: ['notes/twin-copy'] } as never);
          return { affected: result.affected, residuals: result.residuals };
        } catch (err) {
          if (backend === 'rust') expect(refusalText(err)).toContain('repair secret-spans scan');
          throw err;
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  parityTest('the twin-merge moves move the twin\'s rows on the SQL engines, and the Rust engine refuses them by name', {
    methods: ['putPage', 'transaction', 'moveTwinRelationships', 'moveTwinPageChildren', 'moveTwinFacts', 'insertFacts', 'addTag', 'getTags'],
    requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => {
    const pair = await seedPair(engine);
    await engine.addTag(pair.twin.slug, 'shared-tag', { sourceId: 'default' } as never);
    await engine.insertFacts([{ kind: 'fact', visibility: 'private', fact: 'Twin fact', entity_slug: pair.twin.slug, row_num: null,
      source_markdown_slug: 'notes/elsewhere', source: 'mcp:extract_facts' }] as never, { source_id: 'default' });
    try {
      const moves = await engine.transaction(async tx => {
        const ids = { twinId: pair.twin.page_id, survivorId: pair.survivor.page_id };
        const relationships = await tx.moveTwinRelationships(ids);
        const tags = await tx.moveTwinPageChildren({ ...ids, sourceId: 'default', twinSlug: pair.twin.slug, survivorSlug: pair.survivor.slug });
        const facts = await tx.moveTwinFacts('default', pair.twin.slug, pair.survivor.slug);
        return { relationships: { ...relationships, linksMoved: relationships.linksMoved.length }, tags, facts: facts.length };
      });
      const survivorTags = await engine.getTags(pair.survivor.slug, { sourceId: 'default' } as never);
      expect({ tags: moves.tags, facts: moves.facts, survivorTags }).toEqual({ tags: ['shared-tag'], facts: 1, survivorTags: ['shared-tag'] });
      return moves;
    } catch (err) {
      if (backend === 'rust') expect(refusalText(err)).toContain('repair twin merge');
      throw err;
    }
  });
});

