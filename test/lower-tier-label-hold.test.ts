/**
 * GST-2518: a lower-tier local page write that drops or widens a privacy label keeps the page's earlier privacy until
 * the owner accepts.
 *
 * 1. Protects: a local put_page (agent_written) over a more trusted page that drops or widens `visibility`, `access`,
 *    `confidentiality` or `readable_by` publishes with the stored labels kept, in the database row and in the committed
 *    file, and its `lower_page` proposal carries the labels it asked for. Accept applies exactly those labels (while the
 *    page is still at the held revision), reject keeps the earlier ones, undo restores them. An unbound remote read and a
 *    non-owner member read see nothing before accept; a credential bound to the owner reads the page before, during and
 *    after the hold. A later lower-tier write that puts the label back withdraws the widening; an earlier body edit that
 *    lowered the page, a rejected widening, a delete, or an unclassified (unknown) tier does not open a bypass; a derived
 *    maintenance publication is held like a content write; undo applies only to the page its accept wrote.
 * 2. Fails when: the held write publishes the wider label, the proposal loses the requested labels, accept widens a
 *    withdrawn or changed page, reject or undo leaves the page wider, or a write that should pass is held (the owner's
 *    own sync, an equal-tier writer, a narrowing, a label-neutral edit, the operator readers setter).
 * 3. Real seams: local put_page (remote:false) through the write coordinator, remote reads through MCP dispatch with
 *    legacy tokens (unbound, bound to a member, bound to the owner), owner decisions through decideTrustProposal, the
 *    managed-brain harness (claimed Git worktree, managed sync, the Git effect) and a repo-less brain. PGLite, and
 *    Postgres with DATABASE_URL.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { listTrustProposals, parseTrustProposalRef, type TrustProposalRow } from '../src/core/trust/proposals.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { maintenancePreflight, publishMaintenancePages } from '../src/core/persistence/prepared-maintenance.ts';
import { declareDerivation } from '../src/core/trust/taint.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const NL = String.fromCharCode(10);
const putPage = operations.find(op => op.name === 'put_page')!;
const OWNER = 'owner-example';
const owner = { confirmation: { via: 'tty' as const } };
/** A page file with its label lines and a canary word in the body. */
const file = (slug: string, labels: string[], canary: string, body = 'Second paragraph.') =>
  ['---', 'title: Example Page', 'type: note', ...labels, 'tags:', '  - alpha', '---', '', 'Body line one of ' + slug + ' ' + canary + '.', '', body, ''].join(NL);
/** A canary counts only as a whole token. */
const has = (text: string, canary: string) => new RegExp(canary + '(?![A-Za-z0-9])').test(text);
const READERS = 'readable_by: [alice-example, ' + OWNER + ']';

/** Each label, dropped and widened: the stored line, the line the writer sends (none = dropped), and who reads after accept. */
const CASES = [
  { label: 'visibility', stored: 'visibility: private', sent: null, keys: ['visibility'] },
  { label: 'visibility', stored: 'visibility: private', sent: 'visibility: world', keys: ['visibility'] },
  { label: 'access', stored: 'access: private', sent: null, keys: ['access'] },
  { label: 'access', stored: 'access: private', sent: 'access: public', keys: ['access'] },
  { label: 'confidentiality', stored: 'confidentiality: secret', sent: null, keys: ['confidentiality'] },
  { label: 'confidentiality', stored: 'confidentiality: secret', sent: 'confidentiality: public', keys: ['confidentiality'] },
  { label: 'readable_by', stored: READERS, sent: null, keys: ['readable_by'] },
  { label: 'readable_by', stored: READERS, sent: 'readable_by: [alice-example, bob-example, ' + OWNER + ']', keys: ['readable_by'] },
] as const;

interface Brain { engine: BrainEngine; ctx: OperationContext; sourceId: string; home: string }
type Reader = 'unbound' | 'bob' | 'owner';

async function seedOwnerPage(engine: BrainEngine, sourceId: string, slug: string, text: string) {
  expect((await importFromContent(engine, slug, text, { noEmbed: true, sourceId })).status).toBe('imported');
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => withTrustBackfill(tx, () => tx.executeRaw(
    "UPDATE pages SET trust_tier='operator_curated' WHERE source_id=$1 AND slug=$2", [sourceId, slug])), TEST_WRITE_ATTRIBUTION));
}
const pageRow = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.executeRaw<{ tier: string; frontmatter: Record<string, unknown>; revision: string; body: string }>(
  'SELECT trust_tier::text AS tier, frontmatter, knowledge_revision::text AS revision, compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]!;
const labelsOf = (fm: Record<string, unknown>) => Object.fromEntries(['visibility', 'access', 'confidentiality', 'readable_by'].filter(k => fm[k] !== undefined).map(k => [k, fm[k]]));
const lineLabels = (line: string | null) => line === null ? {} : (() => {
  const [key, value] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()];
  return { [key]: value.startsWith('[') ? value.slice(1, -1).split(',').map(s => s.trim()) : value };
})();

/** Remote reads through MCP dispatch with a legacy token: unbound, bound to bob-example (a member, no reader), bound to the owner. */
async function remoteReaders(engine: BrainEngine, sourceId: string) {
  for (const member of ['alice-example', 'bob-example', OWNER]) await addMember(engine, member);
  await setOwner(engine, OWNER);
  const tokens: Record<Reader, string> = { unbound: '', bob: '', owner: '' };
  for (const [who, member] of [['unbound', null], ['bob', 'bob-example'], ['owner', OWNER]] as const) {
    const minted = await mintLegacyToken(engine, { name: 'reader-' + who, scopes: ['read'], takesHolders: ['world'], sourceGrant: [sourceId] });
    tokens[who] = minted.token;
    if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
    else await readsUnscopedOnPurpose(engine, minted.id);
  }
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  return async (who: Reader, slug: string, canary: string): Promise<boolean> => {
    const auth = await provider.verifyAccessToken(tokens[who]) as unknown as AuthInfo;
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, auth.sourceId ?? sourceId);
    const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? sourceId,
      takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
    return has(out.content.map(c => c.text).join(NL), canary);
  };
}

async function put(b: Brain, slug: string, content: string): Promise<Record<string, any>> {
  return await putPage.handler(b.ctx, { slug, content, request_id: randomUUID(), wait_ms: 30_000,
    expected_revision: (await pageRow(b.engine, b.sourceId, slug)).revision }) as Record<string, any>;
}
const proposalsOf = async (b: Brain, slug: string): Promise<TrustProposalRow[]> =>
  (await listTrustProposals(b.engine, { sourceId: b.sourceId, status: 'all' })).filter(p => p.action === 'lower_page' && p.before_state.slug === slug);
const decide = (b: Brain, ref: string, decision: 'accept' | 'reject' | 'undo') => decideTrustProposal(b.engine, parseTrustProposalRef(ref)!, decision, owner);
async function call(b: Brain, name: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  return await operations.find(op => op.name === name)!.handler(b.ctx, { request_id: randomUUID(), wait_ms: 30_000, ...params }) as Record<string, any>;
}

/** A repo-less brain (no managed persistence, no checkout: the default keyless install) is the database record. */
for (const backend of testBackends()) describe('[' + backend + '] a lower-tier local write that widens a privacy label, on a repo-less brain', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const SRC = 'labels-src';
  async function repoless(fn: (b: Brain, reads: Awaited<ReturnType<typeof remoteReaders>>) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-label-hold-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          __resetPrivateVisibilityCacheForTests();
          await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
          const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: SRC, remote: false, dryRun: false,
            logger: { info() {}, warn() {}, error() {} } };
          await fn({ engine, ctx, sourceId: SRC, home }, await remoteReaders(engine, SRC));
        } finally { await disposePersistenceConsumer(engine); await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  test('each label dropped and widened: nothing reaches an unbound or non-owner read until accept, the owner reads throughout, accept applies exactly the request', () => repoless(async (b, reads) => {
    for (const [i, c] of CASES.entries()) {
      const slug = 'notes/held-' + i + '-example', canary = 'canaryhold' + i;
      await seedOwnerPage(b.engine, SRC, slug, file(slug, [c.stored], canary));
      const before = { unbound: await reads('unbound', slug, canary), bob: await reads('bob', slug, canary), owner: await reads('owner', slug, canary) };
      expect(before).toEqual({ unbound: false, bob: false, owner: true });
      // The first case changes only the label; the others rewrite the body too.
      const body = i === 0 ? 'Second paragraph.' : 'An agent rewrote this paragraph.';
      const written = await put(b, slug, file(slug, c.sent ? [c.sent] : [], canary, body));
      expect({ unbound: await reads('unbound', slug, canary), bob: await reads('bob', slug, canary), owner: await reads('owner', slug, canary) }).toEqual(before);
      expect(written.privacy_labels_kept).toEqual({ keys: [...c.keys], proposal_ref: expect.stringMatching(/^tp\d+$/) });
      const held = await pageRow(b.engine, SRC, slug);
      expect(labelsOf(held.frontmatter)).toEqual(lineLabels(c.stored));
      expect(held.body).toContain(body);
      // A label-only write publishes nothing once its label is kept, so it lowers nothing; its request still waits for the owner.
      expect(held.tier).toBe(i === 0 ? 'operator_curated' : 'agent_written');
      const [proposal] = await proposalsOf(b, slug);
      expect(proposal!.after_state.labels).toMatchObject({ keys: [...c.keys], kept: lineLabels(c.stored) });
      expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'accept')).toMatchObject({ status: 'accepted' });
      const accepted = await pageRow(b.engine, SRC, slug);
      expect(labelsOf(accepted.frontmatter)).toEqual(lineLabels(c.sent));
      expect(accepted.tier).toBe('user_confirmed');
      const widenedReaders = c.label === 'readable_by' && c.sent !== null;
      expect({ unbound: await reads('unbound', slug, canary), bob: await reads('bob', slug, canary), owner: await reads('owner', slug, canary) })
        .toEqual({ unbound: !widenedReaders, bob: true, owner: true });
    }
  }), 300_000);

  test('reject keeps the earlier label, and a later lower-tier write that drops it again is held again', () => repoless(async (b, reads) => {
    const slug = 'notes/reject-example', canary = 'canaryreject';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, ['visibility: private'], canary));
    const first = await put(b, slug, file(slug, [], canary, 'Rewritten once.'));
    expect(await decide(b, first.privacy_labels_kept.proposal_ref, 'reject')).toMatchObject({ status: 'rejected' });
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.visibility).toBe('private');
    expect(await reads('unbound', slug, canary)).toBe(false);
    // The page is at agent_written now; the owner's rejected decision still guards its label.
    const again = await put(b, slug, file(slug, ['visibility: world'], canary, 'Rewritten twice.'));
    expect(again.privacy_labels_kept?.keys).toEqual(['visibility']);
    expect(again.privacy_labels_kept.proposal_ref).not.toBe(first.privacy_labels_kept.proposal_ref);
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.visibility).toBe('private');
    expect(await reads('unbound', slug, canary)).toBe(false);
    expect(await reads('owner', slug, canary)).toBe(true);
    expect((await proposalsOf(b, slug)).map(p => p.status)).toEqual(['rejected', 'pending']);
  }), 180_000);

  test('undo restores the earlier label and the edited tier; a later lower-tier write stays held', () => repoless(async (b, reads) => {
    const slug = 'notes/undo-example', canary = 'canaryundo';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, [READERS], canary));
    const written = await put(b, slug, file(slug, [], canary, 'Rewritten.'));
    const ref = written.privacy_labels_kept.proposal_ref;
    expect(await decide(b, ref, 'accept')).toMatchObject({ status: 'accepted' });
    expect(await reads('bob', slug, canary)).toBe(true);
    expect(await decide(b, ref, 'undo')).toMatchObject({ status: 'undone' });
    const undone = await pageRow(b.engine, SRC, slug);
    expect(undone.frontmatter.readable_by).toEqual(['alice-example', OWNER]);
    expect(undone.tier).toBe('agent_written');
    expect(undone.body).toContain('Rewritten.');
    expect({ unbound: await reads('unbound', slug, canary), bob: await reads('bob', slug, canary), owner: await reads('owner', slug, canary) })
      .toEqual({ unbound: false, bob: false, owner: true });
    const later = await put(b, slug, file(slug, [], canary, 'Rewritten again.'));
    expect(later.privacy_labels_kept?.keys).toEqual(['readable_by']);
    expect(await reads('bob', slug, canary)).toBe(false);
  }), 180_000);

  test('a write that puts the label back withdraws the widening: accept then widens nothing', () => repoless(async (b, reads) => {
    const slug = 'notes/withdrawn-example', canary = 'canarywithdrawn';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, ['visibility: private'], canary));
    const widened = await put(b, slug, file(slug, [], canary, 'Rewritten.'));
    const back = await put(b, slug, file(slug, ['visibility: private'], canary, 'Rewritten with the label.'));
    expect(back.privacy_labels_kept).toBeUndefined();
    const [proposal, ...rest] = await proposalsOf(b, slug);
    expect(rest).toEqual([]);
    expect(proposal!.after_state.labels).toBeUndefined();
    expect(await decide(b, widened.privacy_labels_kept.proposal_ref, 'accept')).toMatchObject({ status: 'accepted' });
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.visibility).toBe('private');
    expect(await reads('unbound', slug, canary)).toBe(false);
  }), 180_000);

  test('a body edit that lowers the page first does not let a second write drop the label', () => repoless(async (b, reads) => {
    const slug = 'notes/two-step-example', canary = 'canarytwostep';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, ['visibility: private'], canary));
    const first = await put(b, slug, file(slug, ['visibility: private'], canary, 'Edited body only.'));
    expect(first.privacy_labels_kept).toBeUndefined();
    expect((await pageRow(b.engine, SRC, slug)).tier).toBe('agent_written');
    const second = await put(b, slug, file(slug, [], canary, 'Edited body only.'));
    expect(second.privacy_labels_kept).toEqual({ keys: ['visibility'], proposal_ref: first.trust_lowered.proposal_ref });
    expect(await reads('unbound', slug, canary)).toBe(false);
    expect((await proposalsOf(b, slug)).map(p => p.status)).toEqual(['pending']);
  }), 180_000);

  test('a rejected widening, then a lowering body edit, does not let a later write drop the label', () => repoless(async (b, reads) => {
    const slug = 'notes/rejected-example', canary = 'canaryrejected';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, ['visibility: private'], canary));
    const first = await put(b, slug, file(slug, [], canary, 'Rewritten once.'));
    expect(await decide(b, first.privacy_labels_kept.proposal_ref, 'reject')).toMatchObject({ status: 'rejected' });
    await call(b, 'put_page', { slug, content: file(slug, ['visibility: private'], canary, 'A tool output edit.'), content_origin: 'tool_output',
      expected_revision: (await pageRow(b.engine, SRC, slug)).revision });
    const third = await put(b, slug, file(slug, [], canary, 'Rewritten again.'));
    expect(third.privacy_labels_kept?.keys).toEqual(['visibility']);
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.visibility).toBe('private');
    expect({ unbound: await reads('unbound', slug, canary), bob: await reads('bob', slug, canary), owner: await reads('owner', slug, canary) })
      .toEqual({ unbound: false, bob: false, owner: true });
  }), 180_000);

  test('a delete keeps the tombstone\'s tier, so a write over the tombstone keeps the label', () => repoless(async (b, reads) => {
    const slug = 'notes/tombstone-example', canary = 'canarytombstone';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, ['visibility: private'], canary));
    await call(b, 'delete_page', { slug, expected_revision: (await pageRow(b.engine, SRC, slug)).revision });
    const [tombstone] = await b.engine.executeRaw<{ revision: string; tier: string }>(
      'SELECT knowledge_revision::text AS revision, trust_tier::text AS tier FROM pages WHERE source_id=$1 AND slug=$2', [SRC, slug]);
    expect(tombstone!.tier).toBe('operator_curated');
    const written = await call(b, 'put_page', { slug, content: file(slug, [], canary, 'Recreated.'), expected_revision: tombstone!.revision });
    expect(written.privacy_labels_kept?.keys).toEqual(['visibility']);
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.visibility).toBe('private');
    expect({ unbound: await reads('unbound', slug, canary), owner: await reads('owner', slug, canary) }).toEqual({ unbound: false, owner: true });
  }), 180_000);

  test('an unclassified (unknown tier) private page is held like an owner page', () => repoless(async (b, reads) => {
    const slug = 'notes/unknown-example', canary = 'canaryunknown';
    await importFromContent(b.engine, slug, file(slug, ['visibility: private'], canary), { noEmbed: true, sourceId: SRC });
    expect((await pageRow(b.engine, SRC, slug)).tier).toBe('unknown');
    const written = await put(b, slug, file(slug, [], canary, 'An agent rewrote it.'));
    expect(written.privacy_labels_kept?.keys).toEqual(['visibility']);
    expect({ unbound: await reads('unbound', slug, canary), owner: await reads('owner', slug, canary) }).toEqual({ unbound: false, owner: true });
    expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'accept')).toMatchObject({ status: 'accepted' });
    expect(await reads('unbound', slug, canary)).toBe(true);
  }), 180_000);

  test('undo after the page changed since accept is stale and changes nothing', () => repoless(async (b) => {
    const slug = 'notes/undo-stale-example', canary = 'canaryundostale';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, ['visibility: private'], canary));
    const written = await put(b, slug, file(slug, [], canary, 'Agent text.'));
    expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'accept')).toMatchObject({ status: 'accepted' });
    await seedOwnerPage(b.engine, SRC, slug, file(slug, [], canary, 'The owner rewrote it later.'));
    expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'undo')).toMatchObject({ status: 'stale' });
    const page = await pageRow(b.engine, SRC, slug);
    expect(page.tier).toBe('operator_curated');
    expect(page.frontmatter.visibility).toBeUndefined();
  }), 180_000);

  test('nothing is held that should not be: an equal-tier writer, a narrowing, a label-neutral edit, the owner readers setter', () => repoless(async (b, reads) => {
    // An equal-tier writer: a page an agent wrote (agent_written) and labelled, then dropped by the same tier.
    const own = 'notes/agent-own-example';
    await putPage.handler(b.ctx, { slug: own, content: file(own, ['visibility: private'], 'canaryown'), request_id: randomUUID(), wait_ms: 30_000 });
    expect((await pageRow(b.engine, SRC, own)).tier).toBe('agent_written');
    const dropped = await put(b, own, file(own, [], 'canaryown'));
    expect(dropped.privacy_labels_kept).toBeUndefined();
    expect(labelsOf((await pageRow(b.engine, SRC, own)).frontmatter)).toEqual({});
    expect(await reads('unbound', own, 'canaryown')).toBe(true);
    // A narrowing: a world owner page made private, and a readers list cut to the owner.
    const narrowed = 'notes/narrowed-example', readers = 'notes/readers-narrowed-example';
    await seedOwnerPage(b.engine, SRC, narrowed, file(narrowed, [], 'canarynarrow'));
    expect((await put(b, narrowed, file(narrowed, ['visibility: private'], 'canarynarrow'))).privacy_labels_kept).toBeUndefined();
    expect((await pageRow(b.engine, SRC, narrowed)).frontmatter.visibility).toBe('private');
    await seedOwnerPage(b.engine, SRC, readers, file(readers, [READERS], 'canaryreaders'));
    expect((await put(b, readers, file(readers, ['readable_by: [' + OWNER + ']'], 'canaryreaders'))).privacy_labels_kept).toBeUndefined();
    expect((await pageRow(b.engine, SRC, readers)).frontmatter.readable_by).toEqual([OWNER]);
    // A label-neutral edit of a private owner page.
    const neutral = 'notes/neutral-example';
    await seedOwnerPage(b.engine, SRC, neutral, file(neutral, ['visibility: private', READERS], 'canaryneutral'));
    const edited = await put(b, neutral, file(neutral, ['visibility: private', READERS], 'canaryneutral', 'Edited.'));
    expect(edited.privacy_labels_kept).toBeUndefined();
    expect((await proposalsOf(b, neutral))[0]!.after_state.labels).toBeUndefined();
    // The brain host's readers setter (gbrain repair visibility --readers) widens a page's readers without a hold.
    const host = 'notes/host-example';
    await seedOwnerPage(b.engine, SRC, host, file(host, [READERS], 'canaryhost'));
    const out = async (argv: string[]) => { const log = console.log; let printed = ''; console.log = (...p: unknown[]) => { printed += p.join(' ') + NL; };
      try { await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => runRepairCommand(b.engine, [...argv, '--json'])); } finally { console.log = log; _resetCliExitVerdictForTests(); }
      return JSON.parse(printed).results[0]; };
    const argv = ['visibility', '--source', SRC, '--slug', host, '--readers', 'alice-example,bob-example,' + OWNER];
    const preview = await out(argv);
    expect((await out([...argv, '--apply', '--expect', preview.preview_hash])).applied).toBe(1);
    expect((await pageRow(b.engine, SRC, host)).frontmatter.readable_by).toEqual(['alice-example', 'bob-example', OWNER]);
    expect(await reads('bob', host, 'canaryhost')).toBe(true);
    expect(await proposalsOf(b, host)).toEqual([]);
  }), 240_000);
});

for (const backend of testBackends()) describe('[' + backend + '] a lower-tier local write that widens a privacy label, on a managed git source', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), 'archive/' + NL); durableGitRepo(root, ['.gitignore']); };
  const commitAndSync = async (engine: BrainEngine, root: string, files: Record<string, string>) => {
    mkdirSync(join(root, 'notes'), { recursive: true });
    for (const [slug, text] of Object.entries(files)) writeFileSync(join(root, slug + '.md'), text);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'owner notes');
    await performManagedSync(engine, OPTS);
    await settleManagedGitEffects(engine);
  };
  const committed = (root: string, slug: string) => git(root, 'show', 'HEAD:' + slug + '.md');

  test('the committed file carries the kept label until accept; accept and undo commit the label change; the owner\'s own sync is not held', () => managedBrain(async ({ engine, ctx, root }) => {
    const b: Brain = { engine, ctx, sourceId: 'default', home: root };
    const slug = 'notes/git-example', canary = 'canarygit';
    await commitAndSync(engine, root, { [slug]: file(slug, ['visibility: private'], canary) });
    expect((await pageRow(engine, 'default', slug)).tier).toBe('operator_curated');
    const written = await put(b, slug, file(slug, [], canary, 'An agent rewrote this paragraph.'));
    expect(written.privacy_labels_kept?.keys).toEqual(['visibility']);
    await settleManagedGitEffects(engine);
    expect(committed(root, slug)).toContain(NL + 'visibility: private' + NL);
    expect(committed(root, slug)).toContain('An agent rewrote this paragraph.');
    expect(readFileSync(join(root, slug + '.md'), 'utf8')).toBe(committed(root, slug));
    expect((await pageRow(engine, 'default', slug)).frontmatter.visibility).toBe('private');
    expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'accept')).toMatchObject({ status: 'accepted' });
    await settleManagedGitEffects(engine);
    expect(committed(root, slug)).not.toContain('visibility:');
    expect(committed(root, slug)).toContain('An agent rewrote this paragraph.');
    expect((await pageRow(engine, 'default', slug)).frontmatter.visibility).toBeUndefined();
    expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'undo')).toMatchObject({ status: 'undone' });
    await settleManagedGitEffects(engine);
    expect(committed(root, slug)).toContain(NL + 'visibility: private' + NL);
    expect((await pageRow(engine, 'default', slug)).frontmatter.visibility).toBe('private');
    expect(git(root, 'status', '--porcelain', '--', slug + '.md').trim()).toBe('');

    // The owner's own write: the file edited and committed in the checkout, then synced (operator_curated), drops the label.
    const mine = 'notes/owner-example';
    await commitAndSync(engine, root, { [mine]: file(mine, ['visibility: private'], 'canarymine') });
    await commitAndSync(engine, root, { [mine]: file(mine, [], 'canarymine') });
    expect((await pageRow(engine, 'default', mine)).frontmatter.visibility).toBeUndefined();
    expect((await pageRow(engine, 'default', mine)).tier).toBe('operator_curated');
    expect(await proposalsOf(b, mine)).toEqual([]);
  }, { databaseUrl, setup }), 240_000);

  test('a derived maintenance publication (dream patterns) keeps the label in the commit and files it for the owner', () => managedBrain(async ({ engine, ctx, root }) => {
    const b: Brain = { engine, ctx, sourceId: 'default', home: root };
    const reads = await remoteReaders(engine, 'default');
    const slug = 'notes/derived-example', canary = 'canaryderived';
    await commitAndSync(engine, root, { [slug]: file(slug, ['visibility: private'], canary) });
    const derivation = declareDerivation({ tier: 'agent_written', origin: { channel: 'derive:patterns' } }, []);
    await publishMaintenancePages(engine, (await maintenancePreflight(engine, 'default'))!, [{ slug, content: file(slug, [], canary, 'A derived rewrite.'),
      expectedRevision: (await pageRow(engine, 'default', slug)).revision, derivation }]);
    await settleManagedGitEffects(engine);
    expect(committed(root, slug)).toContain(NL + 'visibility: private' + NL);
    expect(committed(root, slug)).toContain('A derived rewrite.');
    expect({ unbound: await reads('unbound', slug, canary), owner: await reads('owner', slug, canary) }).toEqual({ unbound: false, owner: true });
    const [proposal, ...rest] = await proposalsOf(b, slug);
    expect(rest).toEqual([]);
    expect(proposal!.after_state.labels).toMatchObject({ keys: ['visibility'], kept: { visibility: 'private' } });
  }, { databaseUrl, setup }), 240_000);
});
