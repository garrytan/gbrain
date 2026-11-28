/**
 * BrainEngine parity: the doctor reads over `sources` of engine-sql/doctor-sources.ts, which doctor checks used to run
 * through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every variant of readDoctorSources, and the roster members, answer the same rows on each engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts) for a brain with
 *    live, archived, path-less, connector, guest, git-canonical and claimed sources, so a doctor check reads the same finding.
 *  - Regression: an engine whose read drifts (a live filter dropped, an archived source counted, a row order lost)
 *    gives a different doctor status or message per backend.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: fixtures only (createSource/archiveSource); every read is a typed method (no executeRaw in the scenario).
 *  - Persistence-backed members (listOwnedContentRows, the worktree half of listCheckoutRoots) are asserted for the
 *    unmanaged brain only: no persistence tables hold a row there.
 */
import { describe, expect } from 'bun:test';
import type { DoctorSourceVariant } from '../../src/core/engine-sql/doctor-sources.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOST = '00000000-0000-4000-8000-000000000001';
/** Variants a statement answers without a scope. */
const UNSCOPED: readonly DoctorSourceVariant[] = [
  'roots_live_ordered', 'roots_live_fallback', 'relative_paths', 'pathless_live', 'strict_git', 'google_connectors', 'guest_marked_ids',
  'first_two_ids', 'all_ids', 'ids_with_live_pages', 'local_path_state', 'brain_writer_live', 'live_incarnations', 'connector_keys',
  'config_shape', 'synopsis_ids', 'claim_candidates', 'drift_roster',
];

type Row = Record<string, unknown>;

/** The incarnation is a per-brain uuid: keep that it is present, not its value. Unordered statements sort by id. */
function normal(rows: Row[]): Row[] {
  const out = rows.map((row) => ('incarnation' in row ? { ...row, incarnation: typeof row.incarnation === 'string' && row.incarnation.length > 0 } : row));
  return out.sort((a, b) => String(a.id ?? a.local_path ?? '').localeCompare(String(b.id ?? b.local_path ?? '')));
}

describe('doctor source reads', () => {
  parityTest(
    'every readDoctorSources variant answers the same rows over live, archived, path-less, connector, guest, git and claimed sources',
    { methods: ['putPage', 'readDoctorSources'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'docs', {}, '/srv/brain/docs');
      await createSource(engine, backend, 'notes', { strategy: 'code', canonical: 'git' }, '/srv/brain/notes');
      await createSource(engine, backend, 'gmail', { kind: 'google', g_dir: '/srv/google' }, '/srv/google');
      await createSource(engine, backend, 'slack-team', { kind: 'slack', s_dir: '/srv/slack' }, '/srv/slack');
      await createSource(engine, backend, 'guestbook', { guest: true });
      await createSource(engine, backend, 'curated', { trust_claimed_at: '2026-01-01T00:00:00Z', trust_tier: 'operator_curated', trust_claim_lifted_at: '2026-01-02T00:00:00Z' });
      await createSource(engine, backend, 'half-claimed', { trust_claimed_at: '2026-01-01T00:00:00Z', trust_tier: 'operator_curated' });
      await createSource(engine, backend, 'retired', { canonical: 'git' }, '/srv/brain/retired');
      await createSource(engine, backend, 'relative', {}, 'relative/dir');
      await createSource(engine, backend, 'storage', {}, '/srv/storage');
      await archiveSource(engine, backend, 'retired');
      await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice body', timeline: '' }, { sourceId: 'docs' });
      await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: 'Bob body', timeline: '' });

      const answers: Record<string, Row[]> = {};
      for (const variant of UNSCOPED) answers[variant] = normal(await engine.readDoctorSources(variant) as unknown as Row[]);
      const scopedIds = ['docs', 'retired', 'gmail'];
      answers['live_path_ids:scoped'] = normal(await engine.readDoctorSources('live_path_ids', { sourceIds: scopedIds }) as unknown as Row[]);
      answers['live_path_ids'] = normal(await engine.readDoctorSources('live_path_ids') as unknown as Row[]);
      answers['paths_scoped:scoped'] = normal(await engine.readDoctorSources('paths_scoped', { sourceIds: scopedIds }) as unknown as Row[]);
      answers['paths_scoped'] = normal(await engine.readDoctorSources('paths_scoped', { sourceIds: null }) as unknown as Row[]);
      answers['freshness:scoped'] = normal(await engine.readDoctorSources('freshness', { sourceIds: scopedIds }) as unknown as Row[]);
      answers['freshness'] = normal(await engine.readDoctorSources('freshness') as unknown as Row[]);
      answers['drift_roster:scoped'] = normal(await engine.readDoctorSources('drift_roster', { sourceIds: scopedIds }) as unknown as Row[]);
      answers['drift_roster:none'] = normal(await engine.readDoctorSources('drift_roster', { sourceIds: [] }) as unknown as Row[]);
      for (const id of ['storage', 'retired', 'gmail', 'missing']) {
        for (const variant of ['storage_shelf', 'brain_writer_by_id', 'shared_skills_view', 'detached'] as const) {
          answers[`${variant}:${id}`] = normal(await engine.readDoctorSources(variant, { sourceId: id }) as unknown as Row[]);
        }
      }
      expect(answers['all_ids']!.map((r) => r.id)).toEqual(['curated', 'default', 'docs', 'gmail', 'guestbook', 'half-claimed', 'notes', 'relative', 'retired', 'slack-team', 'storage']);
      expect(answers['ids_with_live_pages']!.map((r) => r.id)).toEqual(['default', 'docs']);
      expect(answers['strict_git']!.map((r) => r.id)).toEqual(['notes']);
      expect(answers['guest_marked_ids']!.map((r) => r.id)).toEqual(['guestbook']);
      expect(answers['claim_candidates']!.map((r) => [r.id, r.claimed, r.lifted])).toContainEqual(['half-claimed', true, false]);
      expect(answers['storage_shelf:retired']).toEqual([]);
      expect(answers['brain_writer_by_id:retired']!.length).toBe(1);
      expect(answers['drift_roster:scoped']!.map((r) => r.id)).toEqual(['docs', 'gmail', 'retired']);
      expect(answers['drift_roster:none']).toEqual([]);
      expect(answers['relative_paths']!.map((r) => r.id)).toEqual(['docs', 'gmail', 'notes', 'relative', 'slack-team', 'storage']);
      return answers;
    },
  );

  parityTest(
    'the roster members answer the same rows, and an unmanaged brain has no owned content or worktree roots',
    { methods: ['listGuestSourceRows', 'listCheckoutRoots', 'listPendingRoster', 'listOwnedContentRows', 'countDefaultSourceFiles', 'putPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'docs', {}, '/srv/brain/docs');
      await createSource(engine, backend, 'guestbook', { guest: true }, '/srv/guest');
      await createSource(engine, backend, 'retired', {}, '/srv/brain/retired');
      await createSource(engine, backend, 'pathless', {});
      await archiveSource(engine, backend, 'retired');
      await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: 'Bob body', timeline: '' });

      const guests = (await engine.listGuestSourceRows()).map((g) => ({ id: g.id, local_path: g.local_path, config: g.config }));
      const roots = (await engine.listCheckoutRoots(HOST)).map((r) => ({ ...r })).sort((a, b) => a.root.localeCompare(b.root));
      const roster = (await engine.listPendingRoster(null, HOST)).map((r) => ({ id: r.id, managed: r.managed, root: r.root, config: r.config }));
      const rosterScoped = (await engine.listPendingRoster(['docs', 'retired', 'pathless'], HOST)).map((r) => r.id);
      const owned = await engine.listOwnedContentRows(null, false);
      const files = await engine.countDefaultSourceFiles();
      expect(owned).toEqual([]);
      expect(rosterScoped).toEqual(['docs']);
      expect(files).toEqual({ live: 1, file_backed: 0 });
      return { guests, roots, roster: roster.sort((a, b) => a.id.localeCompare(b.id)), rosterScoped, files };
    },
  );
});
