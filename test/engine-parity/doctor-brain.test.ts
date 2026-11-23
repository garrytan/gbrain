/**
 * BrainEngine parity: the doctor brain reads of engine-sql/doctor-brain.ts, which the storage-manifest,
 * conversation-archive, backup-coverage, git-hold and connector-checkpoint checks used to run through
 * `engine.executeRaw` over `pages`, `tags`, `facts`, `sources` and `op_checkpoints`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts). The members the store serves are seeded through the engine's own
 *    writers; the relations a Rust brain has no writer for (git-hold, managed-sync and connector checkpoints) read as
 *    the empty brain on every arm.
 *  - Regression: an engine whose read drifts (or does not serve it) gives a different doctor status or message per
 *    backend: a Rust brain warned that the storage shelf, the archive or the backup state "could not be read" where
 *    PGLite reported ok.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw) and the harness fixtures for sources. Timestamps are reduced to
 *    what the check uses (present or not), because each arm stamps its own clock.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string, extra: Partial<PageInput> = {}): PageInput => ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra });
const put = (engine: BrainEngine, slug: string, extra: Partial<PageInput> = {}, sourceId = 'default') => engine.putPage(slug, page(slug, extra), { sourceId });
const stamp = (value: string | Date | null) => (value === null ? null : Number.isFinite(new Date(value).getTime()));

describe('doctor brain reads', () => {
  parityTest(
    'listInterimStoredObjectCounts counts live, untagged stored objects outside the shelf per source',
    { methods: ['putPage', 'softDeletePage', 'addTag', 'listInterimStoredObjectCounts'] },
    async (engine, backend) => {
      const read = () => engine.listInterimStoredObjectCounts('stored-object', 'storage', 'storage-manifest/', 'adopted');
      const empty = await read();
      await createSource(engine, backend, 'zeta');
      await createSource(engine, backend, 'alpha');
      await createSource(engine, backend, 'storage');
      const stored = (slug: string, sourceId: string, type = 'stored-object') => put(engine, slug, { type: type as PageInput['type'] }, sourceId);
      await stored('storage-manifest/a', 'zeta');
      await stored('storage-manifest/b', 'zeta');
      await stored('storage-manifest/c', 'alpha');
      await stored('storage-manifest/shelf', 'storage');
      await stored('storage-manifest/index', 'alpha');
      await stored('elsewhere/d', 'alpha');
      await stored('storage-manifest/note', 'alpha', 'note');
      await stored('storage-manifest/gone', 'alpha');
      await engine.softDeletePage('storage-manifest/gone', { sourceId: 'alpha' });
      await stored('storage-manifest/adopted', 'alpha');
      await engine.addTag('storage-manifest/adopted', 'adopted', { sourceId: 'alpha' });
      const rows = await read();
      expect(empty).toEqual([]);
      expect(rows.map((r) => `${r.source_id}:${Number(r.n)}`)).toEqual(['alpha:1', 'zeta:2']);
      return { empty, rows: rows.map((r) => ({ source_id: r.source_id, n: Number(r.n) })) };
    },
  );

  parityTest(
    'readOldestSourceCreatedAt and readBrainMaturity count live pages and active facts and date the brain by its first source or page',
    { methods: ['putPage', 'softDeletePage', 'insertFact', 'expireFact', 'readOldestSourceCreatedAt', 'readBrainMaturity'] },
    async (engine, backend) => {
      const before = { oldest: stamp(await engine.readOldestSourceCreatedAt()), maturity: await engine.readBrainMaturity() };
      await createSource(engine, backend, 'later');
      await put(engine, 'notes/a');
      await put(engine, 'notes/b');
      await engine.softDeletePage('notes/b');
      await engine.insertFact({ fact: 'kept', entity_slug: null, visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
      const { id } = await engine.insertFact({ fact: 'gone', entity_slug: null, visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
      expect(await engine.expireFact(id)).toBe(true);
      const after = await engine.readBrainMaturity();
      const reduced = (row: typeof after) => (row ? { pages: Number(row.pages), facts: Number(row.facts), since: stamp(row.since) } : null);
      expect(reduced(after)).toEqual({ pages: 1, facts: 1, since: true });
      return { before: { oldest: before.oldest, maturity: reduced(before.maturity) }, after: reduced(after), oldest: stamp(await engine.readOldestSourceCreatedAt()) };
    },
  );

  parityTest(
    'listVisibilityCandidatePages lists live pages of live sources whose visibility key is not private, in source and slug order',
    { methods: ['putPage', 'softDeletePage', 'listVisibilityCandidatePages'] },
    async (engine, backend) => {
      const empty = await engine.listVisibilityCandidatePages(null);
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'old');
      await put(engine, 'b/public', { frontmatter: { visibility: 'public' } });
      await put(engine, 'a/shouty', { frontmatter: { Visibility: 'world' } });
      await put(engine, 'c/private', { frontmatter: { visibility: 'private' } });
      await put(engine, 'd/none', { frontmatter: { other: 1 } });
      await put(engine, 'e/null', { frontmatter: { visibility: null } });
      await put(engine, 'f/number', { frontmatter: { visibility: 3 } });
      await put(engine, 'g/gone', { frontmatter: { visibility: 'public' } });
      await engine.softDeletePage('g/gone');
      await put(engine, 'a/other', { frontmatter: { visibility: 'team' } }, 'other');
      await put(engine, 'a/archived', { frontmatter: { visibility: 'team' } }, 'old');
      await archiveSource(engine, backend, 'old');
      const all = await engine.listVisibilityCandidatePages(null);
      const narrowed = await engine.listVisibilityCandidatePages(['other']);
      expect(empty).toEqual([]);
      expect(all.map((r) => `${r.source_id}/${r.slug}`)).toEqual(['default/a/shouty', 'default/b/public', 'default/e/null', 'default/f/number', 'other/a/other']);
      expect(narrowed.map((r) => r.slug)).toEqual(['a/other']);
      return { empty, all: all.map(({ source_id, slug, frontmatter }) => ({ source_id, slug, frontmatter: typeof frontmatter === 'string' ? JSON.parse(frontmatter) : frontmatter })), narrowed: narrowed.map((r) => r.slug) };
    },
  );

  parityTest(
    'the git-hold, managed-sync receipt and connector checkpoint reads find no row on a brain nothing has written to',
    { methods: ['countVisibilityNoncanonicalHolds', 'listContentBlockedReceipts', 'listPassAdmittedReceipts', 'listOrphanConnectorCheckpoints'] },
    async (engine) => {
      const empty = {
        holds: await engine.countVisibilityNoncanonicalHolds('git-hold', null),
        holdsScoped: await engine.countVisibilityNoncanonicalHolds('git-hold', ['default']),
        blocked: await engine.listContentBlockedReceipts(),
        pass: await engine.listPassAdmittedReceipts('default', '00000000-0000-4000-8000-000000000001'),
        orphans: await engine.listOrphanConnectorCheckpoints(['default:1'], { before: null, minAgeDays: 7, stateOp: 'managed-connector-state' }, 101),
      };
      expect(empty).toEqual({ holds: 0, holdsScoped: 0, blocked: [], pass: [], orphans: [] });
      return empty;
    },
  );
});
