/**
 * BrainEngine parity: three doctor checks from the rust-engine/main join (access_pages_read_by_nobody, owner_identity,
 * owner_only_marks_triggers), run through their doctor entries on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each check answers the same on PGLite, Postgres and Rust: status, message, details and fix, byte for
 *    byte. access_pages_read_by_nobody is not applicable with no members, ok while an enabled member reads every
 *    labelled page, and warns with a sample and the handover fix once a member is disabled or a folder rule admits no
 *    enabled reader. owner_identity names the owner page and counts the owner's identifiers by kind, and warns when an
 *    identifier is claimed twice, when several person pages carry the owner email, or when a Google source is bound to
 *    nobody on a brain with several people. owner_only_marks_triggers finds every delete trigger, before and after an
 *    owner-only source.
 *  - Regression: on a Rust brain the three checks read through executeRaw (raw_sql) or ownerOnlyMarkTriggers (raw_sql),
 *    so each warned "health is unknown" with the typed refusal where PGLite answered.
 *  - Why existing coverage misses it: test/doctor-access-pages-read-by-nobody.test.ts, test/doctor-owner-identity.test.ts
 *    and test/engine-parity/owner-only-marks.test.ts run on the SQL engines only, or call the member, not the check.
 *  - Seam: the checks' doctor entries with a minimal DoctorContext (engine, a no-op heartbeat). Sources are written
 *    through the harness fixture. Source ids include an archived source and the pair `a-z` / `ab`, which byte order
 *    (COLLATE "C") sorts one way and the en_US collation the other, so the live source list must keep byte order on
 *    every arm. Source ids are lower-case ASCII, digits and `-` on every engine (SOURCE_ID_RE; the Rust store refuses
 *    any other), so a mixed-case or non-ASCII id cannot be written on every arm. Member, group, rule and page ids are
 *    lower-case ASCII without `-` at a sort-deciding position, where byte order and the en_US collation agree.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { DoctorContext, DoctorEntry } from '../../src/commands/doctor/context.ts';
import { accessPagesReadByNobodyEntry } from '../../src/commands/doctor/checks/access-pages-read-by-nobody.ts';
import { ownerIdentityEntry } from '../../src/commands/doctor/checks/owner-identity.ts';
import { ownerOnlyMarksTriggersEntry } from '../../src/commands/doctor/checks/owner-only-marks-triggers.ts';
import { addMember, disableMember } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { archiveSource, createSource, parityArms, restrictFolder, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OWNER_MAIL = 'alice@example.com';

async function check(engine: BrainEngine, entry: DoctorEntry): Promise<Record<string, unknown>> {
  const ctx = { engine, progress: { heartbeat: () => undefined } } as unknown as DoctorContext;
  const checks = await entry.run(ctx);
  if (!Array.isArray(checks)) throw new Error(`${entry.name} stopped doctor`);
  const [only, ...rest] = checks;
  expect(rest).toEqual([]);
  return only as unknown as Record<string, unknown>;
}

/** Sources every case shares: an archived one, and live ids (`a-z`, `ab`) whose byte order differs from the en_US order. */
async function sources(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  for (const id of ['ab', 'alpha', 'a-z', 'zz-old']) await createSource(engine, backend, id);
  await archiveSource(engine, backend, 'zz-old');
}

const note = (title: string, readers?: string[]) => ({
  type: 'note', title, compiled_truth: `${title} notes.`, frontmatter: readers ? { readable_by: readers } : {},
}) as Parameters<BrainEngine['putPage']>[1];

describe('engine parity: doctor checks from the main join', () => {
  parityTest('access_pages_read_by_nobody: not applicable, ok, then the pages a disabled member and a folder rule leave unread',
    { methods: ['listAccessMemberStatuses', 'listAccessGroupMemberships', 'listPagesReadByNobody', 'listRulePagesReadByNobody', 'listAllSources', 'listAccessRules'] },
    async (engine, backend) => {
      await sources(engine, backend);
      const fresh = await check(engine, accessPagesReadByNobodyEntry);
      for (const id of ['owner-example', 'alice-example', 'bob-example', 'dave-example']) await addMember(engine, id);
      await engine.setConfig('access.owner_member', 'owner-example');
      await engine.addAccessGroupMembers('team-a', ['bob-example']);
      await engine.putPage('notes/bob-private-example', note('Bob private', ['bob-example']), { sourceId: 'default' });
      await engine.putPage('notes/team-a-example', note('Team A', ['group:team-a']), { sourceId: 'default' });
      await engine.putPage('calls/sync-example', note('Sync', ['bob-example', 'alice-example']), { sourceId: 'default' });
      await engine.putPage('memory/members/bob-example', note('Bob', ['bob-example']), { sourceId: 'default' });
      await engine.putPage('people/dave-example/onboarding', note('Onboarding', ['alice-example']), { sourceId: 'alpha' });
      await engine.putPage('closed/vault-example', note('Vault', ['!nobody']), { sourceId: 'default' });
      await engine.putPage('open/handbook-example', note('Handbook'), { sourceId: 'ab' });
      await engine.putPage('people/dave-example/old', note('Old onboarding'), { sourceId: 'zz-old' });
      const ok = await check(engine, accessPagesReadByNobodyEntry);
      await disableMember(engine, 'bob-example');
      await restrictFolder(engine, backend, 'alpha', 'people/dave-example/', 'rule',
        { ruleId: 'dave', readers: ['member:dave-example', 'member:owner-example'] });
      await restrictFolder(engine, backend, 'zz-old', 'people/dave-example/', 'rule', { ruleId: 'dave-old', readers: ['member:nobody-example'] });
      const leaver = await check(engine, accessPagesReadByNobodyEntry);
      await engine.tombstoneAccessMember('bob-example');
      await disableMember(engine, 'alice-example');
      const removed = await check(engine, accessPagesReadByNobodyEntry);
      expect(fresh).toMatchObject({ status: 'ok', readiness_state: 'not_applicable' });
      expect(ok).toMatchObject({ status: 'ok', details: { count: 0, partial: false } });
      expect(leaver).toMatchObject({ status: 'warn', details: { count: 3, partial: false,
        sample: ['alpha:people/dave-example/onboarding', 'default:notes/bob-private-example', 'default:notes/team-a-example'] } });
      expect((leaver.fix as { argv: string[] }).argv).toEqual(['gbrain', 'access', 'member', 'handover', 'bob-example']);
      expect(removed).toMatchObject({ status: 'warn' });
      return { fresh, ok, leaver, removed };
    });

  parityTest('owner_identity: the reserved page, an owner email, a shared identifier, an unbound Google source, several pages',
    { methods: ['listGoogleSourceMembers', 'listOwnerMemberLinks', 'listAllSources', 'listExactIdentityCandidates', 'readAccessMembers'] },
    async (engine, backend) => {
      await sources(engine, backend);
      const fresh = await check(engine, ownerIdentityEntry);
      await addMember(engine, 'owner-example', { email: OWNER_MAIL });
      await setOwner(engine, 'owner-example');
      await engine.insertAccessMemberLink('telegram', '1001', 'owner-example');
      await engine.insertAccessMemberLink('slack', 'U1', 'owner-example');
      const owner = await check(engine, ownerIdentityEntry);
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'A person.',
        frontmatter: { email: OWNER_MAIL } }, { sourceId: 'alpha' });
      const page = await check(engine, ownerIdentityEntry);
      await addMember(engine, 'bob-example', { email: 'bob@example.com' });
      await createSource(engine, backend, 'mail-b', { kind: 'google', g_account: 'BOB@example.com' });
      await createSource(engine, backend, 'mail-old', { kind: 'google', g_account: OWNER_MAIL });
      await archiveSource(engine, backend, 'mail-old');
      const unbound = await check(engine, ownerIdentityEntry);
      await engine.putPage('people/alice-example-work', { type: 'person', title: 'Alice Example', compiled_truth: 'A person.',
        frontmatter: { emails: [OWNER_MAIL] } }, { sourceId: 'a-z' });
      const several = await check(engine, ownerIdentityEntry);
      expect(fresh).toMatchObject({ status: 'ok', details: { owner_member_set: false, identifiers: 0, entity_basis: 'reserved_page' } });
      expect(owner).toMatchObject({ status: 'ok', details: { owner_member_set: true, identifiers: 3, identifier_kinds: ['member_email', 'member_link'], entity_basis: 'member_page' } });
      expect(page).toMatchObject({ status: 'ok', details: { entity_basis: 'identifier_page' } });
      expect(page.message).toContain('The owner page is people/alice-example.');
      expect(unbound).toMatchObject({ status: 'warn', details: { unbound_google_sources: 1 } });
      expect(several).toMatchObject({ status: 'warn', details: { several_pages: true, entity_basis: 'member_page' } });
      expect(JSON.stringify([owner, page, unbound, several])).not.toContain(OWNER_MAIL);
      return { fresh, owner, page, unbound, several };
    });

  parityTest('owner_only_marks_triggers: every delete trigger exists, before and after an owner-only source',
    { methods: ['ownerOnlyMarkTriggers', 'getConfig'] },
    async (engine, backend) => {
      const fresh = await check(engine, ownerOnlyMarksTriggersEntry);
      await createSource(engine, backend, 'diary', { owner_only: true });
      await engine.putPage('notes/diary-example', note('Diary'), { sourceId: 'diary' });
      const held = await check(engine, ownerOnlyMarksTriggersEntry);
      // `role` is left out: it is the database login (gbrain_test on CI Postgres, postgres elsewhere), which only the
      // fix line of a missing trigger prints.
      const { role: _role, ...state } = await engine.ownerOnlyMarkTriggers();
      expect(fresh).toMatchObject({ status: 'ok', details: { closed: false } });
      expect(held).toEqual(fresh);
      expect(state).toEqual({ missing: [], closed: false, rowSecurity: false, held: true, unflagged: false, deniedLogins: [], closedLogins: [] });
      return { fresh, held, state };
    });

  // Rust ignores `ensure` (the store has no triggers to create), so its answer must still be the whole state the SQL
  // engines return after their ensure pass, not a reply that looks like a write that did not happen.
  parityTest('ownerOnlyMarkTriggers with ensure returns the full state, before and after an owner-only source',
    { methods: ['ownerOnlyMarkTriggers'] },
    async (engine, backend) => {
      const ensured = async () => { const { role: _role, ...state } = await engine.ownerOnlyMarkTriggers({ ensure: true }); return state; };
      const fresh = await ensured();
      await createSource(engine, backend, 'diary', { owner_only: true });
      await engine.putPage('notes/diary-example', note('Diary'), { sourceId: 'diary' });
      const held = await ensured();
      const base = { missing: [], closed: false, rowSecurity: false, unflagged: false, deniedLogins: [], closedLogins: [] };
      expect(fresh).toEqual({ ...base, held: false });
      expect(held).toEqual({ ...base, held: true });
      return { fresh, held };
    });
});
