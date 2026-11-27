/**
 * BrainEngine parity — a MIXED valid/invalid identity or satisfied-rule set handed to a Rust store member that forwards it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the SQL text empties the WHOLE identity (or satisfied) set when any one entry is not a valid principal
 *    (accessAllowedSql / readersAllowedSql -> validIdentity; folderRulesAllowedSql -> validQualifiedRuleId), so a page that
 *    names readers or sits under a folder rule is NOT admitted. Every arm answers what PGLite answers: not admitted.
 *    Covered members: readPageAccessAllowed and readPageFolderRulesAllowed (whoCanRead's two reads), and readLinkTargetPages
 *    under a writer policy whose one identity mixes a valid and an invalid entry (the remote put_page rewrite's page read).
 *  - Regression (suspected, not yet reproduced when this was written): rust-engine/store-members/list-reads.ts
 *    (memberAccessPolicy, readPageAccessAllowed, readPageFolderRulesAllowed) and remote-links.ts (unlabelledWriterPolicy's
 *    oneIdentity) forward `[...identity]` / `[...satisfied]` raw, so the store would match the valid entries one by one and
 *    admit what the SQL text denies.
 *  - Reachability: see the last case. An invalid entry cannot be stored (CHECK access_groups_id_check / access_members_id_check on
 *    every arm, and addMember's assertAccessId), so the end-to-end paths (whoCanRead over listMembers, a remote put_page by an
 *    attested actor whose linkedMember groups feed identityFor) cannot be seeded with a mixed set. The first cases therefore call the
 *    engine members with the explicit mixed argument, as whoCanRead / writerReadPolicy would pass it.
 *  - Why existing coverage misses it: list-reads-sql-pin.test.ts calls readPageAccessAllowed with a valid identity only, and
 *    labelled-only-policy.test.ts builds writer identities from real members.
 *  - Seam: none for the cases; the barrier case attempts a harness-level raw / store member write of a bad group and expects refusal.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createMember, createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { addMember } from '../../src/core/access/members.ts';
import { whoCanRead } from '../../src/commands/access.ts';
import { schemaVersionNow, withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'work';
const ALICE = 'alice-example';
const BAD = 'Bad Id';

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  await proposeRevision(engine, SRC, [{ id: 'team-rule', prefix: 'team/', readable_by: [`member:${ALICE}`] }], { origin: 'cli', store: 'database' });
  await engine.putPage('notes/named', { type: 'note', title: 'Named', compiled_truth: 'x', timeline: '', frontmatter: { readable_by: [`member:${ALICE}`] } }, { sourceId: SRC });
  await engine.putPage('team/ruled', { type: 'note', title: 'Ruled', compiled_truth: 'x', timeline: '', frontmatter: {} }, { sourceId: SRC });
}

/** whoCanRead's record: restricted, the member's own identity (valid), the remote policy of a real remote read. */
async function asMember<T>(engine: BrainEngine, identity: string[], satisfiedRuleIds: string[], run: () => Promise<T>): Promise<T> {
  const schema = await schemaVersionNow(engine);
  return withCallerAccess({ identity, satisfiedRuleIds, folderCoverage: [], restricted: true, owner: false, remotePolicy: { privacyRelaxed: false, restricted: true, ...schema } }, run);
}

describe('engine parity: a mixed valid/invalid set forwarded to a Rust store member', () => {
  parityTest('readPageAccessAllowed with an identity that mixes a valid and an invalid entry admits nothing on every arm (PGLite: the SQL text empties the whole set)', { methods: ['readPageAccessAllowed'] }, async (engine, backend) => {
    await seed(engine, backend);
    const valid = await asMember(engine, [`member:${ALICE}`], [], () => engine.readPageAccessAllowed(SRC, 'notes/named', [`member:${ALICE}`]));
    const mixed = await asMember(engine, [`member:${ALICE}`], [], () => engine.readPageAccessAllowed(SRC, 'notes/named', [`member:${ALICE}`, BAD]));
    expect({ valid, mixed }).toEqual({ valid: true, mixed: false });
    return { valid, mixed };
  });

  parityTest('readPageFolderRulesAllowed with a satisfied set that mixes a valid and an invalid rule id admits nothing on every arm', { methods: ['readPageFolderRulesAllowed'] }, async (engine, backend) => {
    await seed(engine, backend);
    const rule = `${SRC}:team-rule`;
    const valid = await asMember(engine, [`member:${ALICE}`], [rule], () => engine.readPageFolderRulesAllowed(SRC, 'team/ruled', [rule]));
    const mixed = await asMember(engine, [`member:${ALICE}`], [rule], () => engine.readPageFolderRulesAllowed(SRC, 'team/ruled', [rule, BAD]));
    expect({ valid, mixed }).toEqual({ valid: true, mixed: false });
    return { valid, mixed };
  });

  parityTest('readLinkTargetPages under a writer policy whose one identity mixes a valid and an invalid entry reads no page on every arm', { methods: ['readLinkTargetPages'] }, async (engine, backend) => {
    await seed(engine, backend);
    const policy = (identity: string[]) => ({ identities: [identity], satisfiedRuleIds: [] as string[], folderCoverage: [], owner: false, labelledOnly: false });
    const valid = await engine.readLinkTargetPages(SRC, ['notes/named'], policy([`member:${ALICE}`]));
    const mixed = await engine.readLinkTargetPages(SRC, ['notes/named'], policy([`member:${ALICE}`, BAD]));
    expect({ valid: valid.map(p => p.readable), mixed: mixed.map(p => p.readable) }).toEqual({ valid: [true], mixed: [false] });
    return { valid, mixed };
  });

  parityTest('no path stores a group id that fails the identity alphabet: addMember, a raw insert and the store member each refuse it, and whoCanRead is unchanged', { methods: ['readAccessMembers'] }, async (engine, backend) => {
    await seed(engine, backend);
    await createMember(engine, backend, { id: ALICE, groups: ['team-a'] });
    const refused = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch { return true; } };
    const out = {
      publicApi: await refused(() => addMember(engine, 'carol-example', { groups: [BAD] })),
      seedHelper: await refused(() => createMember(engine, backend, { id: 'dave-example', groups: [BAD] })),
    };
    expect(out).toEqual({ publicApi: true, seedHelper: true });
    // A refused seed may leave the member row (the member insert precedes its groups); what must never exist is the bad group.
    const members = (await engine.readAccessMembers({ includeRemoved: true })).map(m => [m.id, m.groups]);
    expect(members.filter(([id]) => id === ALICE)).toEqual([[ALICE, ['team-a']]]);
    expect(members.flatMap(([, groups]) => groups as string[]).includes(BAD)).toBe(false);
    const readers = (await whoCanRead(engine, 'notes/named', SRC)).map(e => e.members);
    return { out, alice: members.filter(([id]) => id === ALICE), readers };
  });
});
