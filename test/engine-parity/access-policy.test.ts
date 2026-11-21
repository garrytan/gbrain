/**
 * BrainEngine parity — the folder-rule policy members access/policy.ts runs (engine-sql/access-policy.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a folder rule added, approved for removal and applied through policy.ts (proposeRevision, previewApply,
 *    applyApproved, policyStatus, listRevisions, coverageRows) hides and shows the same pages, records the same
 *    revisions and the same pending prefix coverage on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm with GBRAIN_TEST_RUST_ARM=1). Two rule changes that both claim the next revision cannot both apply, and a
 *    rule change refused part way leaves no rule of itself behind.
 *  - Regression: a member that differs changes who can read a private folder: a rule that does not install leaves the
 *    folder open, a removal applied without approval opens it early, and a second change applied against the same
 *    revision installs a rulebook no revision records.
 *  - Why existing coverage misses it: policy.ts ran every statement through `executeRaw`, which the Rust engine refuses
 *    and the parity cases cannot call (D18), so only PGLite and Postgres changed rules and no case compared them.
 *  - Seam: `policySeams.afterInstall` reads the pending coverage between the install and the restamp. Generated values
 *    (timestamps, the local actor) are compared by presence, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { folderAccessFor } from '../../src/core/access/caller.ts';
import type { FolderRule } from '../../src/core/access/folder-rules.ts';
import { applyApproved, coverageRows, listRevisions, policySeams, policyStatus, previewApply, proposeRevision, restampSource } from '../../src/core/access/policy.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'work';
const rule = (id: string, prefix: string, readers: string[]): FolderRule => ({ id, prefix, readable_by: readers.map(r => `member:${r}`).sort() });
const DIARY = rule('diary', 'private/', ['alice-example']);

/** The work source with one page under private/ and one open page, both titled Acme Example. */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, SRC);
  for (const slug of ['private/acme-diary', 'notes/acme-open']) {
    await engine.putPage(slug, { type: 'note', title: 'Acme Example', compiled_truth: `body of ${slug}`, timeline: '' }, { sourceId: SRC });
  }
}

/** The slugs a member reads when served (private pages and unsatisfied folders hidden). */
async function served(engine: BrainEngine, member: string): Promise<string[]> {
  const identity = [`member:${member}`];
  const access = await folderAccessFor(engine, identity);
  return withCallerAccess({ identity, hidePrivate: true, ...access }, async () =>
    (await engine.findPagesByTitles(['acme example'], [SRC], ['note'], { excludePrivate: true })).map(r => r.slug).sort());
}

/** What a revision row records that is the same on every engine. */
const revisionView = (r: Awaited<ReturnType<typeof listRevisions>>[number]) => ({
  revision: r.revision, rules: r.rules, change_kind: r.change_kind, origin: r.origin, approved_by: r.approved_by,
  created: typeof r.created_at === 'string' && r.created_at.length > 0, applied: r.applied_at !== null, approved: r.approved_at !== null,
});

describe('access policy members (engine-sql/access-policy.ts)', () => {
  parityTest('adding a folder rule through policy.ts hides the folder from a member the rule does not name', { methods: ['applyAccessRuleChanges', 'insertAccessPolicyRevision', 'finishAccessRestamp'] }, async (engine, backend) => {
    await seed(engine, backend);
    const before = { restricted: await engine.isFolderRestricted(SRC, 'private/acme-diary'), carol: await served(engine, 'carol-example') };
    const added = await proposeRevision(engine, SRC, [DIARY], { origin: 'cli', store: 'database' });
    const after = {
      restricted: await engine.isFolderRestricted(SRC, 'private/acme-diary'), open: await engine.isFolderRestricted(SRC, 'notes/acme-open'),
      carol: await served(engine, 'carol-example'), alice: (await folderAccessFor(engine, ['member:alice-example'])).satisfiedRuleIds,
    };
    expect(before).toEqual({ restricted: false, carol: ['notes/acme-open', 'private/acme-diary'] });
    expect(added).toMatchObject({ state: 'applied', revision: 1, change_kind: 'narrowing', held: [] });
    expect(after).toEqual({ restricted: true, open: false, carol: ['notes/acme-open'], alice: [`${SRC}:diary`] });
    return { before, added: { state: added.state, revision: added.revision, change_kind: added.change_kind, changes: added.changes, pages_restamped: added.pages_restamped }, after,
      rules: (await policyStatus(engine, SRC)).rules };
  });

  parityTest('removing a folder rule waits for approval, then applyApproved shows the folder again', { methods: ['approveAccessPolicyRevision', 'listAccessPrefixSlugs', 'markAccessRevisionsApplied'] }, async (engine, backend) => {
    await seed(engine, backend);
    await proposeRevision(engine, SRC, [DIARY], { origin: 'cli', store: 'database' });
    const removed = await proposeRevision(engine, SRC, [], { origin: 'cli' });
    const held = { carol: await served(engine, 'carol-example'), rules: (await policyStatus(engine, SRC)).rules.map(r => r.id) };
    const preview = await previewApply(engine, SRC);
    const refused = await applyApproved(engine, SRC, { expect: 'not-the-plan' }).then(() => null, (e: { code?: string }) => e.code);
    const applied = await applyApproved(engine, SRC, { expect: preview.plan_hash! });
    const after = { carol: await served(engine, 'carol-example'), restricted: await engine.isFolderRestricted(SRC, 'private/acme-diary'),
      rules: (await policyStatus(engine, SRC)).rules };
    expect(removed).toMatchObject({ state: 'recorded', revision: 2 });
    expect(held).toEqual({ carol: ['notes/acme-open'], rules: ['diary'] });
    expect(refused).toBe('preview_changed');
    expect(applied.state).toBe('applied');
    expect(after).toEqual({ carol: ['notes/acme-open', 'private/acme-diary'], restricted: false, rules: [] });
    return { removed: { state: removed.state, revision: removed.revision, change_kind: removed.change_kind, held: removed.held }, held,
      widening: preview.widening, refused, applied: { state: applied.state, revision: applied.revision, pages_restamped: applied.pages_restamped }, after };
  });

  parityTest('a narrowing keeps its prefix pending between install and restamp, and the restamp clears it', { methods: ['applyAccessRuleChanges', 'listAccessCoverage', 'restampAccessWindow'] }, async (engine, backend) => {
    await seed(engine, backend);
    const seen: unknown[] = [];
    policySeams.afterInstall = async (sourceId) => {
      seen.push({ coverage: await coverageRows(engine, sourceId), restricted: await engine.isFolderRestricted(sourceId, 'private/acme-diary'),
        carol: await folderAccessFor(engine, ['member:carol-example']) });
    };
    try {
      await proposeRevision(engine, SRC, [DIARY], { origin: 'cli', store: 'database' });
    } finally {
      policySeams.afterInstall = undefined;
    }
    const after = { coverage: await coverageRows(engine, SRC), pending: (await policyStatus(engine, SRC)).pending };
    expect(seen).toEqual([{ coverage: [{ prefix: 'private/', reason: 'pending', revision: 1, detail: null }], restricted: true, carol: { satisfiedRuleIds: [], folderCoverage: [{ source_id: SRC, prefix: 'private/' }] } }]);
    expect(after).toEqual({ coverage: [], pending: [] });
    return { seen, after };
  });

  parityTest('each rule change records one revision, numbered in order, with what was applied and approved', { methods: ['readAccessPolicyRevisions', 'readAccessPolicyMarks'] }, async (engine, backend) => {
    await seed(engine, backend);
    const none = await listRevisions(engine, SRC);
    await proposeRevision(engine, SRC, [DIARY], { origin: 'cli', store: 'database', operationId: 'op-add' });
    const retried = await proposeRevision(engine, SRC, [DIARY], { origin: 'cli', operationId: 'op-add' });
    await proposeRevision(engine, SRC, [DIARY, rule('team', 'team/', ['bob-example'])], { origin: 'cli' });
    await proposeRevision(engine, SRC, [DIARY], { origin: 'cli' });
    const recorded = (await listRevisions(engine, SRC)).map(revisionView);
    const status = await policyStatus(engine, SRC, 'op-add');
    const marks = { applied: status.applied_revision, approved: status.approved_revision, desired: status.desired?.revision ?? null, operation: status.operation };
    expect(none).toEqual([]);
    expect(retried).toMatchObject({ reconciled: true, revision: 1 });
    expect(recorded.map(r => `${r.revision}:${r.change_kind}:${r.applied}:${r.approved}`)).toEqual(['3:widening:true:false', '2:narrowing:true:true', '1:narrowing:true:true']);
    expect(marks).toEqual({ applied: 3, approved: 2, desired: 3, operation: { operation_id: 'op-add', revision: 1, state: 'applied' } });
    return { recorded, marks, retried: { state: retried.state, revision: retried.revision } };
  });

  // Leak case: a rule change whose revision write is refused must not leave its rule installed with no revision.
  parityTest('a rule change refused part way leaves no partial rule', { methods: ['applyAccessRuleChanges', 'insertAccessPolicyRevision', 'listAccessRules'] }, async (engine, backend) => {
    await seed(engine, backend);
    await proposeRevision(engine, SRC, [DIARY], { origin: 'cli', store: 'database' });
    const refusal = await engine.transaction(async tx => {
      await tx.lockAccessPolicy(SRC);
      await tx.applyAccessRuleChanges(SRC, { remove: [], insert: [{ rule_id: 'team', prefix: 'team/', readable_by: ['member:bob-example'], covers_derived: false }], pending: ['team/'], revision: 1, actor: 'parity' });
      await tx.insertAccessPolicyRevision({ source_id: SRC, revision: 1, rules: [], digest: 'd', change_kind: 'narrowing', origin: 'parity', operation_id: null, proposed_by: 'parity', approved_by: null, approved: false });
    }).then(() => null, (e: unknown) => e);
    const left = { rules: (await engine.listAccessRules(SRC)).map(r => r.rule_id), coverage: await engine.listAccessCoverage(SRC),
      restricted: await engine.isFolderRestricted(SRC, 'team/x'), revisions: (await listRevisions(engine, SRC)).map(r => r.revision) };
    expect(refusal).not.toBeNull();
    expect(left).toEqual({ rules: ['diary'], coverage: [], restricted: false, revisions: [1] });
    return { refused: refusal !== null, left };
  });

  // Leak case: two rule changes that both read revision 0 must not both install; the store write transaction is the
  // row lock policy.ts's lockSource takes on PGLite and Postgres, and the revision key refuses the second claim.
  parityTest('two concurrent rule changes cannot both apply against the same revision', { methods: ['lockAccessPolicy', 'applyAccessRuleChanges', 'insertAccessPolicyRevision'] }, async (engine, backend) => {
    await seed(engine, backend);
    await engine.ensureAccessPolicyState(SRC);
    const change = (id: string) => engine.transaction(async tx => {
      await tx.lockAccessPolicy(SRC);
      await tx.applyAccessRuleChanges(SRC, { remove: [], insert: [{ rule_id: id, prefix: `${id}/`, readable_by: [`member:${id}-example`], covers_derived: false }], pending: [], revision: 1, actor: id });
      await tx.insertAccessPolicyRevision({ source_id: SRC, revision: 1, rules: [rule(id, `${id}/`, [`${id}-example`])], digest: id, change_kind: 'narrowing',
        origin: 'parity', operation_id: null, proposed_by: id, approved_by: 'auto:narrowing', approved: true });
      return id;
    });
    const outcomes = await Promise.allSettled([change('left'), change('right')]);
    const won = outcomes.flatMap(o => (o.status === 'fulfilled' ? [o.value] : []));
    const rules = (await engine.listAccessRules(SRC)).map(r => r.rule_id);
    const revisions = (await listRevisions(engine, SRC)).map(r => ({ revision: r.revision, digest: r.digest }));
    expect(won.length).toBe(1);
    expect(rules).toEqual(won);
    expect(revisions).toEqual([{ revision: 1, digest: won[0] }]);
    return { fulfilled: won.length, rejected: outcomes.length - won.length, rulesMatchWinner: rules.join() === won.join(), revisions: revisions.length };
  });

  parityTest('a page written or renamed under an applied rule is stamped as it is written, so a restamp counts no page', { methods: ['putPage', 'updateSlug', 'restampAccessWindow', 'finishAccessRestamp'] }, async (engine, backend) => {
    await seed(engine, backend);
    await proposeRevision(engine, SRC, [DIARY], { origin: 'cli', store: 'database' });
    const page = (slug: string, body: string) => engine.putPage(slug, { type: 'note', title: 'Acme Example', compiled_truth: body, timeline: '' }, { sourceId: SRC });
    await page('private/acme-new', 'a new page under the rule');
    await page('private/acme-diary', 'the diary, edited');
    await page('notes/acme-later', 'a new open page');
    const written = await restampSource(engine, SRC);
    await engine.updateSlug('notes/acme-open', 'private/acme-moved', { sourceId: SRC });
    await engine.updateSlug('private/acme-new', 'notes/acme-out', { sourceId: SRC });
    const renamed = await restampSource(engine, SRC);
    const carol = await served(engine, 'carol-example');
    expect(written).toEqual({ pages_scanned: 4, pages_restamped: 0 });
    expect(renamed).toEqual({ pages_scanned: 4, pages_restamped: 0 });
    expect(carol).toEqual(['notes/acme-later', 'notes/acme-out']);
    return { written, renamed, carol };
  });

  parityTest('a reader the rule names is served the folder, except while its prefix is still pending', { methods: ['findPagesByTitles', 'readFolderAccess', 'applyAccessRuleChanges'] }, async (engine, backend) => {
    await seed(engine, backend);
    const pending: unknown[] = [];
    policySeams.afterInstall = async () => {
      pending.push({ alice: await folderAccessFor(engine, ['member:alice-example']), served: await served(engine, 'alice-example') });
    };
    try {
      await proposeRevision(engine, SRC, [DIARY], { origin: 'cli', store: 'database' });
    } finally {
      policySeams.afterInstall = undefined;
    }
    const applied = { alice: await folderAccessFor(engine, ['member:alice-example']), served: await served(engine, 'alice-example'), carol: await served(engine, 'carol-example') };
    expect(pending).toEqual([{ alice: { satisfiedRuleIds: [`${SRC}:diary`], folderCoverage: [{ source_id: SRC, prefix: 'private/' }] }, served: ['notes/acme-open'] }]);
    expect(applied).toEqual({ alice: { satisfiedRuleIds: [`${SRC}:diary`], folderCoverage: [] }, served: ['notes/acme-open', 'private/acme-diary'], carol: ['notes/acme-open'] });
    return { pending, applied };
  });
});
