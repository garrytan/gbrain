/**
 * BrainEngine parity: the doctor checks access_pages_read_by_nobody, owner_identity and owner_only_marks_triggers, which
 * a Rust brain stopped on a typed refusal (loss row 35 of docs/designs/RUST_ENGINE.md): the first two read through
 * `executeRaw`, the third through ownerOnlyMarkTriggers, which refused with raw_sql.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: over the same members, groups, labelled pages, folder rules, sources, member links and person pages, each
 *    check returns the same whole result (status, message, details and fix) on every engine arm (PGLite always; Postgres
 *    with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): the pages no enabled member reads with the leaver to
 *    hand them over from, the owner's identifiers, owner page and conflicts, and the owner-only delete triggers.
 *  - Regression: a Rust brain warned "does not support executeRaw yet" (health unknown) for the first two checks and
 *    "does not support ownerOnlyMarkTriggers yet" for the third while PGLite named the pages, the owner and the triggers.
 *  - Why existing coverage misses it: test/rust-cli-parity.serial.test.ts pinned the refusals by name, and the checks'
 *    own tests run on PGLite only.
 *  - Seam: none. Typed writes seed every arm (the harness's source and folder-rule helpers write raw SQL on the SQL
 *    arms and the store on Rust). The member-source binding write goes through raw SQL in core, so its case stops on
 *    the Rust arm: that refusal is why the Rust engine answers the binding read with none (rust/docs/store/access-doctor.md).
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, restrictFolder } from './harness.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { accessPagesReadByNobodyEntry } from '../../src/commands/doctor/checks/access-pages-read-by-nobody.ts';
import { ownerIdentityCheck } from '../../src/commands/doctor/checks/owner-identity.ts';
import { ownerOnlyMarksTriggersEntry } from '../../src/commands/doctor/checks/owner-only-marks-triggers.ts';
import { addGroup, addMember } from '../../src/core/access/members.ts';
import { bindMemberSource } from '../../src/core/access/member-sources.ts';
import { OWNER_MEMBER_KEY } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const ctx = (engine: BrainEngine) => ({ engine, progress: { heartbeat() {} } }) as unknown as DoctorContext;
const run = async (engine: BrainEngine, entry: { run: (c: DoctorContext) => Promise<unknown> }) => ((await entry.run(ctx(engine))) as Record<string, unknown>[])[0]!;

async function page(engine: BrainEngine, slug: string, frontmatter: Record<string, unknown>, opts: { sourceId?: string; type?: string } = {}): Promise<void> {
  await engine.putPage(slug, { type: (opts.type ?? 'note') as never, title: slug, compiled_truth: 'body', frontmatter }, opts.sourceId ? { sourceId: opts.sourceId } : undefined);
}

describe('doctor access checks', () => {
  parityTest(
    'access_pages_read_by_nobody: not applicable without members, then names the leaver\'s pages and the pages a folder rule admits no one to',
    { methods: ['readAccessMembers', 'listPagesReadByNobody', 'listSourceRecords', 'listAccessRules'] },
    async (engine, backend) => {
      const none = await run(engine, accessPagesReadByNobodyEntry);
      await createSource(engine, backend, 'work');
      await addMember(engine, 'alice', { kind: 'person' });
      await addMember(engine, 'bob', { kind: 'person' });
      await addGroup(engine, 'team', ['alice']);
      await engine.setAccessMemberDisabled('bob', true);
      await page(engine, 'notes/leaver', { readable_by: ['member:bob'] });
      await page(engine, 'notes/also-bob', { readable_by: 'member:bob' });
      await page(engine, 'notes/alice', { readable_by: ['member:alice'] });
      await page(engine, 'notes/team', { readable_by: 'group:team' });
      await page(engine, 'notes/closed', { readable_by: '!nobody' });
      await page(engine, 'memory/members/bob', { readable_by: ['member:bob'] });
      await page(engine, 'notes/gone', { readable_by: ['member:bob'] });
      await engine.softDeletePage('notes/gone');
      await page(engine, 'deals/a', {}, { sourceId: 'work' });
      await page(engine, 'deals/b', { readable_by: ['member:alice'] }, { sourceId: 'work' });
      await page(engine, 'deals/c', { readable_by: '!nobody' }, { sourceId: 'work' });
      await restrictFolder(engine, backend, 'work', 'deals/', 'rule', { ruleId: 'deals', readers: ['member:carol'] });
      const leaver = await run(engine, accessPagesReadByNobodyEntry);
      expect({ none: { status: none.status, message: none.message }, leaver: { status: leaver.status, details: leaver.details } }).toEqual({
        none: { status: 'ok', message: 'Not applicable: this brain has no members (gbrain access member add <id>).' },
        leaver: { status: 'warn', details: { count: 4, partial: false, sample: ['default:notes/also-bob', 'default:notes/leaver', 'work:deals/a', 'work:deals/b'] } },
      });
      return { none, leaver };
    },
  );

  parityTest(
    'owner_identity: no identifier on a fresh brain, then the owner by email, Google account and link with the person page, then a second person and a second owner page',
    { methods: ['readAccessMembers', 'listSourceRecords', 'listAccessMemberSources', 'listAccessMemberLinks', 'listExactIdentityCandidates'] },
    async (engine, backend) => {
      const fresh = await ownerIdentityCheck(engine);
      await addMember(engine, 'alice', { kind: 'person', email: 'Alice@Example.com' });
      await engine.setConfig(OWNER_MEMBER_KEY, 'alice');
      await engine.insertAccessMemberLink('qm', 'person-7', 'alice');
      await createSource(engine, backend, 'mail', { kind: 'google', g_account: 'alice.work@example.com' });
      await page(engine, 'people/alice-example', { email: 'alice@example.com' }, { type: 'person' });
      await page(engine, 'people/other-example', { email: 'other@example.com' }, { type: 'person' });
      const known = await ownerIdentityCheck(engine);
      await addMember(engine, 'bob', { kind: 'person', email: 'bob@example.com' });
      await page(engine, 'people/alice-again', { emails: ['alice@example.com', 'x@example.com'] }, { type: 'person' });
      await createSource(engine, backend, 'team-mail', { kind: 'google', g_account: 'team@example.com' });
      const shared = await ownerIdentityCheck(engine);
      expect([fresh, known, shared].map(c => ({ status: c.status, message: c.message }))).toEqual([
        { status: 'ok', message: 'No owner identifier yet: set the owner member\'s email (gbrain access member set <id> --email <addr>) or connect a Google source. The owner page is memory/owner.' },
        { status: 'ok', message: 'gbrain knows the owner by 3 identifier(s) (google_account, member_email, member_link). The owner page is people/alice-example.' },
        { status: 'warn', message: 'Owner identity is ambiguous: several person pages carry an owner email, so none is used as the owner page; 2 Google source(s) are bound to no member on a brain with several people, so their accounts are not counted. The owner page is memory/members/alice. Run gbrain identity to see each one.' },
      ]);
      return { fresh, known, shared };
    },
  );

  // The binding write runs raw SQL in core (src/core/access/member-sources.ts), so the Rust arm stops on it. That is why
  // the Rust engine answers listAccessMemberSources with none; when the write is served, this case runs on Rust and the
  // read has to be served from the store too.
  parityTest(
    'owner_identity: a Google source bound to another member is skipped',
    { methods: ['listAccessMemberSources'] },
    async (engine, backend) => {
      await addMember(engine, 'alice', { kind: 'person', email: 'alice@example.com' });
      await addMember(engine, 'bob', { kind: 'person' });
      await engine.setConfig(OWNER_MEMBER_KEY, 'alice');
      await createSource(engine, backend, 'bob-mail', { kind: 'google', g_account: 'bob@example.com' });
      await bindMemberSource(engine, 'bob', 'bob-mail');
      const bindings = await engine.listAccessMemberSources();
      const check = await ownerIdentityCheck(engine);
      expect({ bindings, status: check.status, message: check.message }).toEqual({
        bindings: [{ member_id: 'bob', source_id: 'bob-mail' }],
        status: 'ok', message: 'gbrain knows the owner by 1 identifier(s) (member_email). The owner page is memory/members/alice.',
      });
      return { bindings, check };
    },
  );

  parityTest(
    'owner_only_marks_triggers: every delete trigger exists on a fresh brain and after an owner-only page is deleted',
    { methods: ['ownerOnlyMarkTriggers'] },
    async (engine, backend) => {
      const fresh = await run(engine, ownerOnlyMarksTriggersEntry);
      await createSource(engine, backend, 'dms', { owner_only: true });
      await page(engine, 'notes/secret', {}, { sourceId: 'dms' });
      await engine.deletePage('notes/secret', { sourceId: 'dms' });
      const state = await engine.ownerOnlyMarkTriggers();
      const held = await run(engine, ownerOnlyMarksTriggersEntry);
      const ok = { name: 'owner_only_marks_triggers', status: 'ok', message: 'Every owner-only delete trigger exists, so rows derived from a removed owner-only source stay owner-only', details: { closed: false } };
      const answer = { fresh, held, state: { missing: state.missing, closed: state.closed, rowSecurity: state.rowSecurity, held: state.held, unflagged: state.unflagged, deniedLogins: state.deniedLogins, closedLogins: state.closedLogins } };
      expect(answer).toEqual({ fresh: ok, held: ok, state: { missing: [], closed: false, rowSecurity: false, held: true, unflagged: false, deniedLogins: [], closedLogins: [] } });
      return answer;
    },
  );
});
