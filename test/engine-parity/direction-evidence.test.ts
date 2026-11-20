/**
 * BrainEngine parity: the direction-evidence reads and the mirror page mark (engine-sql/direction-evidence.ts) that
 * persistence/git-gap.ts `readDirectionEvidence` and persistence/mirror-read-only.ts `classifyMirrorPage` used to run
 * through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PGLite and Postgres return the same version origins (distinct, empty paths left out), the same live page
 *    states (soft-deleted pages left out, the gap flag), the newest N versions per page newest first with their size and
 *    readability, the same version bodies; the mark changes only a page with no reason and no recorded file, once. The
 *    Rust engine refuses every member by name, never an empty evidence set a caller would read as "no history".
 *  - Regression: a Rust brain refused these reads on raw SQL with no member name.
 *  - Why existing coverage misses it: test/sources-git-gap*.test.ts and the mirror tests run on PGLite only.
 *  - Seam: version paths, the gap stamp, a recorded file and a withdrawn version are set with raw SQL fixtures.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const MEMBERS = ['listEvidenceVersionOrigins', 'readEvidencePageStates', 'listEvidenceVersionMeta', 'readEvidenceVersionBodies', 'markMirrorReadOnlyPage'] as const;
const SRC = 'de';

async function refusals(engine: BrainEngine): Promise<unknown[]> {
  const calls: Array<() => Promise<unknown>> = [
    () => engine.listEvidenceVersionOrigins(['1']),
    () => engine.readEvidencePageStates(['1']),
    () => engine.listEvidenceVersionMeta(['1'], 2),
    () => engine.readEvidenceVersionBodies(['1']),
    () => engine.markMirrorReadOnlyPage(SRC, 'notes/alpha'),
  ];
  return Promise.all(calls.map(call => call().then(() => null, (e: unknown) => e)));
}

const EXPECTED = {
  // Distinct (page, path) pairs; the empty path is left out, the soft-deleted page's version path still counts.
  origins: [{ page: 'notes/alpha', slug: 'notes/alpha', path: 'notes/alpha.md' }, { page: 'notes/beta', slug: 'notes/beta', path: 'notes/beta.md' },
    { page: 'notes/alpha', slug: 'notes/alpha', path: 'old/Alpha.md' }],
  // notes/gone is soft-deleted: no state.
  states: [{ page: 'notes/alpha', revision: 'string', gap: false }, { page: 'notes/beta', revision: 'string', gap: true }, { page: 'notes/filed', revision: 'string', gap: false }],
  // Depth 2: alpha's oldest of three versions is left out; a withdrawn version is not readable.
  metaView: [{ version: 'notes/alpha#0', bytes: 14, readable: true }, { version: 'notes/alpha#1', bytes: 14, readable: true },
    { version: 'notes/beta#0', bytes: 13, readable: false }, { version: 'notes/gone#0', bytes: 13, readable: true }],
  bodies: [{ version: 'notes/alpha#0', page: 'notes/alpha', body: 'notes/alpha v3', title: 'notes/alpha', type: 'note', timeline: '' },
    { version: 'notes/alpha#1', page: 'notes/alpha', body: 'notes/alpha v2', title: 'notes/alpha', type: 'note', timeline: '' },
    { version: 'notes/beta#0', page: 'notes/beta', body: 'notes/beta v1', title: 'notes/beta', type: 'note', timeline: '' },
    { version: 'notes/gone#0', page: 'notes/gone', body: 'notes/gone v1', title: 'notes/gone', type: 'note', timeline: '' }],
  empty: { origins: [], states: [], meta: [], bodies: [] },
  // Once on a fileless page; never on a page with a file, in another source, or missing.
  marks: [1, 0, 0, 0, 0],
  reasons: [{ slug: 'notes/alpha', database_only_reason: null }, { slug: 'notes/beta', database_only_reason: 'mirror_read_only' },
    { slug: 'notes/filed', database_only_reason: null }, { slug: 'notes/gone', database_only_reason: null }],
};

const put = (engine: BrainEngine, slug: string, body: string) =>
  engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {} } as never, { sourceId: SRC });

describe('direction evidence', () => {
  parityTest(
    'the evidence reads list versions per page, skip deleted pages, and the mirror mark changes a fileless page once; Rust refuses by name',
    { methods: ['listEvidenceVersionOrigins', 'readEvidencePageStates', 'listEvidenceVersionMeta', 'readEvidenceVersionBodies', 'markMirrorReadOnlyPage'] },
    async (engine, backend) => {
      if (backend === 'rust') {
        const errors = await refusals(engine);
        expect(errors.map((e, i) => {
          const refusal = e as { code?: string; detail?: string } | null;
          return { code: refusal?.code, named: refusal?.detail?.includes(`member=${MEMBERS[i]} `) };
        })).toEqual(MEMBERS.map(() => ({ code: 'engine_capability_missing', named: true })));
        throw errors[0];
      }
      await createSource(engine, backend, SRC);
      const ids: Record<string, string> = {};
      for (const slug of ['notes/alpha', 'notes/beta', 'notes/gone', 'notes/filed']) ids[slug] = String((await put(engine, slug, `${slug} v1`)).id);
      for (const n of [2, 3, 4]) {
        await engine.createVersion('notes/alpha', { sourceId: SRC });
        await put(engine, 'notes/alpha', `notes/alpha v${n}`);
      }
      await engine.createVersion('notes/beta', { sourceId: SRC });
      await engine.createVersion('notes/gone', { sourceId: SRC });
      await engine.softDeletePage('notes/gone', { sourceId: SRC });
      const slugOf = new Map(Object.entries(ids).map(([slug, id]) => [id, slug]));
      const alpha = await engine.executeRaw<{ id: number }>('SELECT id FROM page_versions WHERE page_id = $1 ORDER BY id', [Number(ids['notes/alpha'])]);
      await engine.executeRaw(`UPDATE page_versions SET source_path = CASE WHEN id = $1 THEN 'notes/alpha.md' WHEN id = $2 THEN 'old/Alpha.md' ELSE '' END WHERE page_id = $3`,
        [alpha[0]!.id, alpha[1]!.id, Number(ids['notes/alpha'])]);
      await engine.executeRaw(`UPDATE page_versions SET source_path = 'notes/beta.md', is_deleted = true WHERE page_id = $1`, [Number(ids['notes/beta'])]);
      await engine.executeRaw('UPDATE pages SET version_history_gap_at = now() WHERE id = $1', [Number(ids['notes/beta'])]);
      await engine.executeRaw(`UPDATE pages SET source_path = 'notes/filed.md' WHERE id = $1`, [Number(ids['notes/filed'])]);

      const all = Object.values(ids);
      const origins = (await engine.listEvidenceVersionOrigins(all)).map(o => ({ page: slugOf.get(o.page_id), slug: o.slug, path: o.source_path }))
        .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      const states = (await engine.readEvidencePageStates(all)).map(s => ({ page: slugOf.get(s.id), revision: typeof s.revision, gap: s.gap }))
        .sort((a, b) => Buffer.compare(Buffer.from(a.page ?? ''), Buffer.from(b.page ?? '')));
      const meta = await engine.listEvidenceVersionMeta(all, 2);
      const versionRank = new Map(meta.map(m => [String(m.id), `${slugOf.get(m.page_id)}#${meta.filter(o => o.page_id === m.page_id && Number(o.id) > Number(m.id)).length}`]));
      const metaView = meta.map(m => ({ version: versionRank.get(String(m.id)), bytes: Number(m.bytes), readable: m.readable }));
      const bodies = (await engine.readEvidenceVersionBodies(meta.map(m => m.id))).map(b => ({ version: versionRank.get(String(b.id)), page: slugOf.get(b.page_id),
        body: b.compiled_truth, title: b.title, type: b.type, timeline: b.timeline }))
        .sort((a, b) => Buffer.compare(Buffer.from(a.version ?? ''), Buffer.from(b.version ?? '')));
      const empty = { origins: await engine.listEvidenceVersionOrigins([]), states: await engine.readEvidencePageStates([]), meta: await engine.listEvidenceVersionMeta([], 2),
        bodies: await engine.readEvidenceVersionBodies([]) };

      const marks = [await engine.markMirrorReadOnlyPage(SRC, 'notes/beta'), await engine.markMirrorReadOnlyPage(SRC, 'notes/beta'),
        await engine.markMirrorReadOnlyPage(SRC, 'notes/filed'), await engine.markMirrorReadOnlyPage('default', 'notes/alpha'), await engine.markMirrorReadOnlyPage(SRC, 'notes/never')];
      const reasons = await engine.executeRaw<{ slug: string; database_only_reason: string | null }>(
        'SELECT slug, database_only_reason FROM pages WHERE source_id = $1 ORDER BY slug COLLATE "C"', [SRC]);
      const result = { origins, states, metaView, bodies, empty, marks, reasons };
      expect(result as unknown).toEqual(EXPECTED);
      return result;
    },
  );
});
