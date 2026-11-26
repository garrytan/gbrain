/**
 * BrainEngine parity — the core edit notices a remote edit of a core page leaves for the owner (`core_edit_notices`),
 * and the commands that read and close them: `gbrain core diff`, `core ack`, `core remove` and `core status`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; Rust with GBRAIN_TEST_RUST_ARM=1, plain and
 *    managed) a remote edit under `memory.core.remote_edit = notify` records one notice; `core diff` shows its base text, actor
 *    and time; `core ack` by revision and for all prints the same counts; `core remove` closes the page's pending notices;
 *    a fact purge blanks the base text that quotes the purged claim; a page purge and a source removal delete the notices
 *    they own; `core status` and the pending list name the newest pending notice of each page, in byte order.
 *  - Regression: a Rust brain kept no notices. A remote edit of a core page under `notify` was refused at publication and
 *    changed nothing, `core diff` and `core ack` refused, `core remove` skipped the close, and every purge answered 0
 *    for a store whose rows PGLite and Postgres would have blanked or deleted.
 *  - Why existing coverage misses it: the notice rows were written and read through `executeRaw`, which a parity case
 *    can run only on the SQL arms (D18), so no case compared the notice store itself across engines.
 *  - Seam: `console` and the CLI exit verdict are captured around `runCore`. The edit goes through the real `edit_page`
 *    dispatch as a remote caller. Notices are written and read through the typed members only. Generated values (ids and
 *    times) are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { runCore } from '../../src/commands/core.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withEnv } from '../helpers/with-env.ts';
import { refusingEngine } from '../helpers/refusing-engine.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'vault';
/** `timestamptz::text`: `2026-11-26 10:00:00.123456+00` (the fraction and the offset's minutes are optional). */
const TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const TIMESTAMPTZ_IN_TEXT = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?/g;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const core = (body = 'About the user.') =>
  ({ type: 'note' as const, title: 'Core', compiled_truth: body, timeline: '', frontmatter: { always_load: true } });

interface Notice { sourceId?: string; slug: string; revision?: string | null; baseText?: string | null; actor?: string; baseRevision?: string | null; pageId?: number | null }

/** One notice through the typed insert. */
async function notify(engine: BrainEngine, n: Notice): Promise<void> {
  await engine.insertCoreEditNotice({
    sourceId: n.sourceId ?? SRC, slug: n.slug, pageId: n.pageId ?? null, revision: n.revision === undefined ? null : n.revision,
    baseRevision: n.baseRevision ?? null, baseText: n.baseText === undefined ? null : n.baseText, actor: n.actor ?? 'remote:agent-1',
  });
}

/** The pending notices of every source, as `source:slug@revision by actor`, in the order the engine lists them. */
async function pending(engine: BrainEngine, sourceIds: readonly string[] | null = null): Promise<string[]> {
  return (await engine.listPendingCoreEditNotices(sourceIds)).map(n => `${n.source_id}:${n.slug}@${n.revision ?? '-'} by ${n.actor}`);
}

/** What `runCore` printed and how it exited; timestamps in the text become `<time>` (and the count of them is returned) and a page revision `<revision>`. */
async function cli(engine: BrainEngine, args: string[]): Promise<{ exit: number; out: string[]; err: string[]; times: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  _resetCliExitVerdictForTests();
  try {
    await runCore(engine, args);
  } finally {
    console.log = log;
    console.error = error;
  }
  const exit = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
  let times = 0;
  const scrub = (line: string) => line.replace(TIMESTAMPTZ_IN_TEXT, () => { times++; return '<time>'; }).replace(UUID, '<revision>');
  return { exit, out: out.map(scrub), err: err.map(scrub), times };
}

describe('engine parity: core edit notices', () => {
  parityTest('a notice is recorded unacknowledged, and the pending list shows the newest per page in byte order, at most 50, for the sources asked',
    { methods: ['insertCoreEditNotice', 'listPendingCoreEditNotices', 'readOldestPendingCoreEditNotice'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      await notify(engine, { slug: 'core/b', revision: 'b-1', actor: 'remote:one' });
      await notify(engine, { slug: 'core/b', revision: 'b-2', actor: 'remote:two' });
      await notify(engine, { slug: 'core/a', revision: null, actor: 'remote:one' });
      // Byte order: an upper-case slug sorts before a lower-case one, as COLLATE "C" does.
      await notify(engine, { slug: 'core/B', revision: 'upper', actor: 'remote:three' });
      await notify(engine, { sourceId: OTHER, slug: 'core/a', revision: 'v-1', actor: 'remote:vault' });
      const all = await engine.listPendingCoreEditNotices(null);
      expect(all.every(n => TIMESTAMPTZ_TEXT.test(n.created_at))).toBe(true);
      const oldest = await engine.readOldestPendingCoreEditNotice(SRC, 'core/b');
      expect(oldest).not.toBeNull();
      expect(TIMESTAMPTZ_TEXT.test(oldest!.created_at)).toBe(true);
      const out = {
        all: await pending(engine),
        shape: Object.keys(all[0]!).sort(),
        defaultOnly: await pending(engine, [SRC]),
        vaultOnly: await pending(engine, [OTHER]),
        none: await pending(engine, []),
        unknownSource: await pending(engine, ['nobody']),
        oldestIsFirst: { actor: oldest!.actor, baseText: oldest!.base_text },
        noneForOtherPage: await engine.readOldestPendingCoreEditNotice(SRC, 'core/missing'),
      };
      expect(out).toEqual({
        all: ['default:core/B@upper by remote:three', 'default:core/a@- by remote:one', 'default:core/b@b-2 by remote:two', 'vault:core/a@v-1 by remote:vault'],
        shape: ['actor', 'created_at', 'revision', 'slug', 'source_id'],
        defaultOnly: ['default:core/B@upper by remote:three', 'default:core/a@- by remote:one', 'default:core/b@b-2 by remote:two'],
        vaultOnly: ['vault:core/a@v-1 by remote:vault'],
        none: [],
        unknownSource: [],
        oldestIsFirst: { actor: 'remote:one', baseText: null },
        noneForOtherPage: null,
      });
      return out;
    });

  parityTest('the pending list stops at 50 pages, by source then slug',
    { methods: ['insertCoreEditNotice', 'listPendingCoreEditNotices'], timeout: 120_000 },
    async (engine) => {
      for (let i = 0; i < 55; i++) await notify(engine, { slug: `core/p${String(i).padStart(2, '0')}`, revision: `r${i}` });
      const listed = await engine.listPendingCoreEditNotices(null);
      const out = { count: listed.length, first: listed[0]!.slug, last: listed[listed.length - 1]!.slug };
      expect(out).toEqual({ count: 50, first: 'core/p00', last: 'core/p49' });
      return out;
    });

  parityTest('the oldest pending notice carries the base text, actor and time of the first unacknowledged edit',
    { methods: ['insertCoreEditNotice', 'readOldestPendingCoreEditNotice', 'ackCoreEditNotices'] },
    async (engine) => {
      await notify(engine, { slug: 'core/about', revision: 'r1', baseText: 'first base\nwith a second line', actor: 'remote:first', baseRevision: 'r0', pageId: 7 });
      await notify(engine, { slug: 'core/about', revision: 'r2', baseText: 'second base', actor: 'remote:second' });
      const first = await engine.readOldestPendingCoreEditNotice(SRC, 'core/about');
      expect(first && TIMESTAMPTZ_TEXT.test(first.created_at)).toBe(true);
      // Closing the first notice moves the oldest to the second.
      const closedFirst = await engine.ackCoreEditNotices(SRC, 'core/about', 0);
      const stillFirst = await engine.readOldestPendingCoreEditNotice(SRC, 'core/about');
      const out = {
        first: first && { base_text: first.base_text, actor: first.actor },
        closedBelowAnyId: closedFirst,
        unchanged: stillFirst?.actor,
        closedAll: await engine.ackCoreEditNotices(SRC, 'core/about', null),
        afterClose: await engine.readOldestPendingCoreEditNotice(SRC, 'core/about'),
      };
      expect(out).toEqual({ first: { base_text: 'first base\nwith a second line', actor: 'remote:first' }, closedBelowAnyId: 0, unchanged: 'remote:first', closedAll: 2, afterClose: null });
      return out;
    });

  parityTest('ack by revision closes the notices up to the newest one for that revision and returns the same counts as ack all',
    { methods: ['insertCoreEditNotice', 'findCoreEditNoticeIdByRevision', 'ackCoreEditNotices', 'listPendingCoreEditNotices'] },
    async (engine) => {
      for (const revision of ['r1', 'r2', 'r2', 'r3']) await notify(engine, { slug: 'core/about', revision, actor: `remote:${revision}` });
      await notify(engine, { slug: 'core/other', revision: 'r2', actor: 'remote:other' });
      const id = async (revision: string, slug = 'core/about', sourceId = SRC) => engine.findCoreEditNoticeIdByRevision(sourceId, slug, revision);
      const ids = { r1: await id('r1'), r2: await id('r2'), r3: await id('r3'), none: await id('nope'), otherPage: await id('r1', 'core/other'), otherSource: await id('r1', 'core/about', OTHER) };
      // The highest id wins when a revision repeats; ids rise with insertion order.
      expect(ids.r1! < ids.r2! && ids.r2! < ids.r3!).toBe(true);
      expect([ids.none, ids.otherPage, ids.otherSource]).toEqual([null, null, null]);
      const upToR2 = await engine.ackCoreEditNotices(SRC, 'core/about', ids.r2!);
      const afterR2 = await pending(engine);
      // An acknowledged notice is still found by its revision.
      const foundAfterAck = (await id('r1')) === ids.r1;
      const all = await engine.ackCoreEditNotices(SRC, 'core/about', null);
      const out = { upToR2, afterR2, foundAfterAck, all, afterAll: await pending(engine), again: await engine.ackCoreEditNotices(SRC, 'core/about', null) };
      expect(out).toEqual({
        upToR2: 3, afterR2: ['default:core/about@r3 by remote:r3', 'default:core/other@r2 by remote:other'], foundAfterAck: true,
        all: 1, afterAll: ['default:core/other@r2 by remote:other'], again: 0,
      });
      return out;
    });

  parityTest('acknowledging one page touches no other page and no other source',
    { methods: ['insertCoreEditNotice', 'ackCoreEditNotices', 'listPendingCoreEditNotices'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      await notify(engine, { slug: 'core/about', revision: 'r1' });
      await notify(engine, { slug: 'core/more', revision: 'm1' });
      await notify(engine, { sourceId: OTHER, slug: 'core/about', revision: 'v1' });
      const out = { acked: await engine.ackCoreEditNotices(SRC, 'core/about', null), left: await pending(engine), missing: await engine.ackCoreEditNotices(SRC, 'core/none', null) };
      expect(out).toEqual({ acked: 1, left: ['default:core/more@m1 by remote:agent-1', 'vault:core/about@v1 by remote:agent-1'], missing: 0 });
      return out;
    });

  parityTest('a notice written in a transaction that rolls back is not kept',
    { methods: ['transaction', 'insertCoreEditNotice', 'listPendingCoreEditNotices'] },
    async (engine) => {
      await notify(engine, { slug: 'core/kept', revision: 'k1' });
      const failure = await engine.transaction(async tx => {
        await notify(tx, { slug: 'core/rolled-back', revision: 'x1' });
        throw new Error('roll back');
      }).then(() => null, (e: Error) => e.message);
      const committed = await engine.transaction(async tx => { await notify(tx, { slug: 'core/committed', revision: 'c1' }); return 'ok'; });
      const out = { failure, committed, left: await pending(engine) };
      expect(out).toEqual({ failure: 'roll back', committed: 'ok', left: ['default:core/committed@c1 by remote:agent-1', 'default:core/kept@k1 by remote:agent-1'] });
      return out;
    });

  parityTest('a fact purge blanks the base text that quotes the claim, matching without regard to case, and nothing else',
    { methods: ['insertCoreEditNotice', 'blankPurgeCoreEditNotices', 'readOldestPendingCoreEditNotice', 'listPendingCoreEditNotices', 'transaction'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      await notify(engine, { slug: 'core/quotes', revision: 'q1', baseText: 'Notes: Alice Likes Tea, and more.' });
      await notify(engine, { slug: 'core/plain', revision: 'p1', baseText: 'Nothing about the claim.' });
      await notify(engine, { slug: 'core/blank', revision: 'n1', baseText: null });
      await notify(engine, { sourceId: OTHER, slug: 'core/quotes', revision: 'v1', baseText: 'alice likes tea too' });
      const text = async (sourceId: string, slug: string) => (await engine.readOldestPendingCoreEditNotice(sourceId, slug))?.base_text;
      const out = await engine.transaction(async tx => {
        const nobody = await tx.blankPurgeCoreEditNotices(SRC, 'a claim nobody quoted');
        const blanked = await tx.blankPurgeCoreEditNotices(SRC, 'alice likes tea');
        const again = await tx.blankPurgeCoreEditNotices(SRC, 'alice likes tea');
        return { nobody, blanked, again };
      });
      const seen = {
        ...out,
        quotes: await text(SRC, 'core/quotes'), plain: await text(SRC, 'core/plain'), nullStays: await text(SRC, 'core/blank'), otherSource: await text(OTHER, 'core/quotes'),
        stillPending: (await pending(engine)).length,
      };
      expect(seen).toEqual({ nobody: 0, blanked: 1, again: 0, quotes: null, plain: 'Nothing about the claim.', nullStays: null, otherSource: 'alice likes tea too', stillPending: 4 });
      // The empty needle matches every base text that is not null, as strpos does.
      const everything = await engine.transaction(tx => tx.blankPurgeCoreEditNotices(SRC, ''));
      expect(everything).toBe(1);
      return { ...seen, everything, plainAfter: await text(SRC, 'core/plain') };
    });

  parityTest('a page purge deletes the page\'s notices, pending or acknowledged, and counts them; other pages and sources keep theirs',
    { methods: ['insertCoreEditNotice', 'ackCoreEditNotices', 'deletePurgedSlugStoreRows', 'listPendingCoreEditNotices', 'findCoreEditNoticeIdByRevision'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      await notify(engine, { slug: 'core/gone', revision: 'g1' });
      await notify(engine, { slug: 'core/gone', revision: 'g2' });
      await engine.ackCoreEditNotices(SRC, 'core/gone', null);
      await notify(engine, { slug: 'core/gone', revision: 'g3' });
      await notify(engine, { slug: 'core/kept', revision: 'k1' });
      await notify(engine, { sourceId: OTHER, slug: 'core/gone', revision: 'v1' });
      const removed = await engine.deletePurgedSlugStoreRows(SRC, ['core/gone']);
      const out = {
        removed: removed.removed.core_edit_notices,
        left: await pending(engine),
        goneRevisions: [await engine.findCoreEditNoticeIdByRevision(SRC, 'core/gone', 'g1'), await engine.findCoreEditNoticeIdByRevision(SRC, 'core/gone', 'g3')],
        again: (await engine.deletePurgedSlugStoreRows(SRC, ['core/gone'])).removed.core_edit_notices,
      };
      expect(out).toEqual({ removed: 3, left: ['default:core/kept@k1 by remote:agent-1', 'vault:core/gone@v1 by remote:agent-1'], goneRevisions: [null, null], again: 0 });
      return out;
    });

  parityTest('removing a source deletes its notices, and a new source with the same id starts with none',
    { methods: ['insertCoreEditNotice', 'listPendingCoreEditNotices', 'deleteSourceRecord'], timeout: 120_000 },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER, { federated: false });
      await createSource(engine, backend, 'keeper', { federated: false });
      for (const sourceId of [OTHER, 'keeper']) {
        await notify(engine, { sourceId, slug: 'core/about', revision: `${sourceId}-1` });
        await notify(engine, { sourceId, slug: 'core/more', revision: `${sourceId}-2` });
      }
      const before = await pending(engine);
      await engine.deleteSourceRecord(OTHER);
      const after = await pending(engine);
      await engine.insertSource({ id: OTHER, name: OTHER, local_path: null, config: {} });
      const reborn = await pending(engine, [OTHER]);
      expect(before.length).toBe(4);
      expect({ after, reborn }).toEqual({ after: ['keeper:core/about@keeper-1 by remote:agent-1', 'keeper:core/more@keeper-2 by remote:agent-1'], reborn: [] });
      return { after, reborn };
    });

  parityTest('core diff shows the first pending edit\'s time, actor and the lines that changed; core ack by revision and for all print the same counts',
    { methods: ['putPage', 'insertCoreEditNotice', 'readPageSnapshot', 'readOldestPendingCoreEditNotice', 'findCoreEditNoticeIdByRevision', 'ackCoreEditNotices', 'listPendingCoreEditNotices'] },
    async (engine) => {
      await engine.putPage('core/about', core('Likes tea.\nLives in Lisbon.'), { sourceId: SRC });
      const none = await cli(engine, ['diff', 'core/about']);
      await notify(engine, { slug: 'core/about', revision: 'r1', baseText: '# Core\n\nLikes coffee.\nLives in Lisbon.', actor: 'remote:first' });
      await notify(engine, { slug: 'core/about', revision: 'r2', baseText: '# Core\n\nLikes tea.', actor: 'remote:second' });
      await notify(engine, { slug: 'core/about', revision: 'r3', baseText: '# Core\n\nLikes tea.\nLives in Lisbon.', actor: 'remote:third' });
      const diff = await cli(engine, ['diff', 'core/about']);
      const unknown = await cli(engine, ['ack', 'core/about', '--revision', 'not-a-revision']);
      const missingRevision = await cli(engine, ['ack', 'core/about']);
      const upTo = await cli(engine, ['ack', 'core/about', '--revision', 'r2']);
      const left = await pending(engine);
      const all = await cli(engine, ['ack', 'core/about', '--revision', 'latest']);
      const afterAll = await cli(engine, ['diff', 'core/about']);
      const out = { none, diff, unknown, missingRevision, upTo, left, all, afterAll };
      expect(diff.times).toBe(1);
      expect(diff.out[0]).toMatch(/^Remote edits to default:core\/about since <time> \(first by remote:first\):\n/);
      expect(diff.out[0]).toContain('- Likes coffee.');
      expect(diff.out[0]).toContain('gbrain core ack --source default core/about --revision <revision>');
      expect({ none: none.out, unknown: unknown.err, upTo: upTo.out, all: all.out, afterAll: afterAll.out, left }).toEqual({
        none: ['No unacknowledged remote edits to default:core/about.'],
        unknown: ['[core] Revision not-a-revision is not a reviewed edit of default:core/about.', '[core] Next: gbrain core diff --source default core/about'],
        upTo: ['Acknowledged 2 edit(s) up to r2; later edits stay pending.'],
        all: ['Acknowledged 1 edit(s) to default:core/about.'],
        afterAll: ['No unacknowledged remote edits to default:core/about.'],
        left: ['default:core/about@r3 by remote:third'],
      });
      expect([none.exit, diff.exit, unknown.exit, missingRevision.exit, upTo.exit, all.exit]).toEqual([0, 0, 1, 1, 0, 0]);
      return out;
    });

  parityTest('core status names the newest pending notice of each page, and none once it is acknowledged',
    { methods: ['insertCoreEditNotice', 'ackCoreEditNotices', 'listPendingCoreEditNotices', 'putPage'] },
    async (engine) => {
      await engine.setConfig('memory.core.enabled', 'true');
      await engine.putPage('core/about', core(), { sourceId: SRC });
      await notify(engine, { slug: 'core/about', revision: 'r1', actor: 'remote:first' });
      await notify(engine, { slug: 'core/about', revision: 'r2', actor: 'remote:second' });
      const noticeLines = (r: { out: string[] }) => r.out.join('\n').split('\n').filter(l => l.includes('notice:'));
      const before = noticeLines(await cli(engine, ['status']));
      await engine.ackCoreEditNotices(SRC, 'core/about', null);
      const after = noticeLines(await cli(engine, ['status']));
      const out = { before, after };
      expect(out).toEqual({
        before: ['  notice: Core page default:core/about was edited remotely by remote:second. The user should review it: gbrain core diff --source default core/about, then gbrain core ack --source default core/about --revision r2.'],
        after: [],
      });
      return out;
    });

  parityTest('a remote edit of a core page under remote_edit notify commits and records one notice that core diff and core ack then read',
    { methods: ['putPage', 'readPageSnapshot', 'listPendingCoreEditNotices', 'readOldestPendingCoreEditNotice', 'ackCoreEditNotices'], timeout: 120_000 },
    async (engine, backend) => {
      await engine.putPage('core/about', core(), { sourceId: SRC });
      const before = await engine.readPageSnapshot('core/about', { sourceId: SRC });
      const home = mkdtempSync(join(tmpdir(), 'gb-core-notices-'));
      try {
        return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
          try {
            const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: SRC };
            const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'edit_page', {
              slug: 'core/about', expected_revision: before!.revision, edits: [{ old_text: 'About the user.', new_text: 'About the user, edited remotely.' }], request_id: randomUUID(),
            }, { remote: true, config: { engine: backend === 'rust' ? 'rust' : 'pglite' }, sourceId: SRC, auth, logger: { info() {}, warn() {}, error() {} } } as never));
            const after = await engine.readPageSnapshot('core/about', { sourceId: SRC });
            const listed = await engine.listPendingCoreEditNotices([SRC]);
            const oldest = await engine.readOldestPendingCoreEditNotice(SRC, 'core/about');
            const diff = await cli(engine, ['diff', 'core/about']);
            const acked = await cli(engine, ['ack', 'core/about', '--revision', listed[0]?.revision ?? 'latest']);
            const out = {
              isError: response.isError === true,
              changed: after?.page.compiled_truth !== before?.page.compiled_truth,
              notices: listed.length,
              revisionIsTheEdits: listed[0]?.revision === after?.revision,
              actorNamed: /^[a-z_]+:/.test(listed[0]?.actor ?? ''),
              baseHasTheOldBody: oldest?.base_text?.includes('About the user.') === true && oldest.base_text.includes('edited remotely') === false,
              diffShows: diff.out[0]?.includes('+ About the user, edited remotely.') === true,
              acked: acked.out,
              left: await pending(engine),
            };
            expect(out).toEqual({
              isError: false, changed: true, notices: 1, revisionIsTheEdits: true, actorNamed: true, baseHasTheOldBody: true, diffShows: true,
              acked: ['Acknowledged 1 edit(s) to default:core/about.'], left: [],
            });
            return out;
          } finally { await disposePersistenceConsumer(engine); }
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

  parityTest('a refusal at the typed notice insert fails the remote edit of a core page and leaves the page and the notices as they were',
    { methods: ['putPage', 'readPageSnapshot', 'transaction', 'listPendingCoreEditNotices'], timeout: 120_000 },
    async (engine, backend) => {
      await engine.putPage('core/about', core(), { sourceId: SRC });
      const before = await engine.readPageSnapshot('core/about', { sourceId: SRC });
      // Every transaction the write opens hands out a tx whose insertCoreEditNotice refuses, as an engine that cannot keep
      // notices would; the page write itself runs on the real tx.
      const refusal = () => capabilityMissing('raw_sql', 'insertCoreEditNotice (core_edit_notices)');
      const refusing = new Proxy(engine, {
        get(target, property) {
          if (property === 'transaction') {
            return (fn: (tx: BrainEngine) => Promise<unknown>, ...rest: unknown[]) =>
              (target.transaction as (...a: unknown[]) => Promise<unknown>).call(target, (tx: BrainEngine) => fn(refusingEngine(tx, { needle: null, members: ['insertCoreEditNotice'], error: refusal })), ...rest);
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const home = mkdtempSync(join(tmpdir(), 'gb-core-notices-'));
      try {
        return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const registration = await registerLocalWriter(refusing, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
          try {
            const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: SRC };
            const response = await withVerifiedLocalRegistration(refusing, registration, () => dispatchToolCall(refusing, 'edit_page', {
              slug: 'core/about', expected_revision: before!.revision, edits: [{ old_text: 'About the user.', new_text: 'About the user, edited remotely.' }], request_id: randomUUID(),
            }, { remote: true, config: { engine: backend === 'rust' ? 'rust' : 'pglite' }, sourceId: SRC, auth, logger: { info() {}, warn() {}, error() {} } } as never));
            const after = await engine.readPageSnapshot('core/about', { sourceId: SRC });
            const text = JSON.stringify(response.content ?? response);
            const out = {
              isError: response.isError === true,
              namesTheRefusal: text.includes('engine_capability_missing') && text.includes('core_edit_notices'),
              body: after?.page.compiled_truth,
              sameRevision: after?.revision === before?.revision,
              notices: await pending(engine),
            };
            expect(out).toEqual({ isError: true, namesTheRefusal: true, body: 'About the user.', sameRevision: true, notices: [] });
            return out;
          } finally { await disposePersistenceConsumer(refusing); }
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
});
