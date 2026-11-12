/**
 * GST-2521: the label hold, part 2 (stacked on GST-2518).
 *
 * 1. Protects: (A) labels the owner sets on a page through the owner's label door (`gbrain repair visibility`, its
 *    `--readers` setter) raise the page's label guard tier, so a later local write at the page's own (agent) tier that
 *    drops or widens them is held like a write below an owner page; (B) a local write below operator_curated whose
 *    `readable_by` would stop the brain owner reading a page the owner reads now publishes with the owner still a
 *    reader, and its `lower_page` item records the readers it asked for. An unbound remote read and a non-owner member
 *    read gain nothing; a credential bound to the owner reads before, during and after.
 * 2. Fails when: an equal-tier agent write drops an owner-set label, an agent write takes the owner out of the readers,
 *    accept does not apply the request, or something that should pass is held (the owner's readers setter, an agent
 *    narrowing that keeps the owner, the owner opt-in to read restricted pages).
 * 3. Real seams: local put_page through the write coordinator, `gbrain repair visibility` through runRepairCommand, remote
 *    reads through MCP dispatch with legacy tokens, owner decisions through decideTrustProposal, the managed-brain harness
 *    (Git commit) and a repo-less brain. PGLite, and Postgres with DATABASE_URL.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner, setOwnerReadsRestricted } from '../src/core/access/owner.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
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
import { privacyLabelGuard } from '../src/core/trust/page-write.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
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

interface Brain { engine: BrainEngine; ctx: OperationContext; sourceId: string; home: string }
type Reader = 'unbound' | 'bob' | 'owner';

async function seedOwnerPage(engine: BrainEngine, sourceId: string, slug: string, text: string) {
  expect((await importFromContent(engine, slug, text, { noEmbed: true, sourceId })).status).toBe('imported');
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => withTrustBackfill(tx, () => tx.executeRaw(
    "UPDATE pages SET trust_tier='operator_curated' WHERE source_id=$1 AND slug=$2", [sourceId, slug])), TEST_WRITE_ATTRIBUTION));
}
const pageRow = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.executeRaw<{ tier: string; frontmatter: Record<string, unknown>; revision: string; body: string }>(
  'SELECT trust_tier::text AS tier, frontmatter, knowledge_revision::text AS revision, compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]!;

/** Remote reads through MCP dispatch with a legacy token: unbound, bound to bob-example (a member, no reader), bound to the owner. */
async function remoteReaders(engine: BrainEngine, sourceId: string) {
  for (const member of ['alice-example', 'bob-example', OWNER]) await addMember(engine, member);
  await setOwner(engine, OWNER);
  const tokens: Record<Reader, string> = { unbound: '', bob: '', owner: '' };
  for (const [who, member] of [['unbound', null], ['bob', 'bob-example'], ['owner', OWNER]] as const) {
    const minted = await mintLegacyToken(engine, { name: 'reader-' + who, scopes: ['read'], takesHolders: ['world'], sourceGrant: [sourceId] });
    tokens[who] = minted.token;
    if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
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

/** `gbrain repair visibility` previewed, then applied with its preview hash, as the owner runs it on the brain host. */
async function repairVisibility(engine: BrainEngine, argv: string[]): Promise<Record<string, any>> {
  const run = async (args: string[]) => {
    const log = console.log;
    let printed = '';
    console.log = (...parts: unknown[]) => { printed += parts.join(' ') + NL; };
    try { await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => runRepairCommand(engine, [...args, '--json'])); } finally { console.log = log; _resetCliExitVerdictForTests(); }
    return JSON.parse(printed);
  };
  const preview = await run(['visibility', ...argv]);
  return run(['visibility', ...argv, '--apply', '--expect', preview.results?.[0]?.preview_hash ?? preview.preview_hash]);
}
const guardOf = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.executeRaw<{ tier: string }>(
  'SELECT g.tier FROM page_label_guards g JOIN pages p ON p.id = g.page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, slug]))[0]?.tier ?? null;
const labelsOf = (fm: Record<string, unknown>) => Object.fromEntries(['visibility', 'access', 'confidentiality', 'readable_by'].filter(k => fm[k] !== undefined).map(k => [k, fm[k]]));
const readsOf = async (reads: (who: Reader, slug: string, canary: string) => Promise<boolean>, slug: string, canary: string) =>
  ({ unbound: await reads('unbound', slug, canary), bob: await reads('bob', slug, canary), owner: await reads('owner', slug, canary) });

for (const backend of testBackends()) describe('[' + backend + '] owner-set labels and the owner as a reader, on a repo-less brain', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const SRC = 'guard-src';
  async function repoless(fn: (b: Brain, reads: Awaited<ReturnType<typeof remoteReaders>>) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-owner-guard-'));
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

  test('A: the owner makes an agent page private; an agent write at the page\'s tier that drops the label is held until accept', () => repoless(async (b, reads) => {
    const slug = 'notes/owner-private-example', canary = 'canaryownerprivate';
    await call(b, 'put_page', { slug, content: file(slug, [], canary) });
    expect((await pageRow(b.engine, SRC, slug)).tier).toBe('agent_written');
    await repairVisibility(b.engine, ['--source', SRC, '--slug', slug]);
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.visibility).toBe('private');
    expect((await pageRow(b.engine, SRC, slug)).tier).toBe('agent_written');
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
    const written = await put(b, slug, file(slug, [], canary, 'An agent rewrote it.'));
    expect(written.privacy_labels_kept?.keys).toEqual(['visibility']);
    const held = await pageRow(b.engine, SRC, slug);
    expect(held.frontmatter.visibility).toBe('private');
    expect(held.body).toContain('An agent rewrote it.');
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
    expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'accept')).toMatchObject({ status: 'accepted', detail: { status: 'labelled', tier: 'agent_written' } });
    const accepted = await pageRow(b.engine, SRC, slug);
    expect(accepted.tier).toBe('agent_written');
    expect(accepted.frontmatter.visibility).toBeUndefined();
    expect(accepted.body).toContain('An agent rewrote it.');
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: true, bob: true, owner: true });
  }), 180_000);

  test('A: readers the owner sets with --readers on an agent page are not widened by an equal-tier agent write; reject keeps them', () => repoless(async (b, reads) => {
    const slug = 'notes/owner-readers-example', canary = 'canaryownerreaders';
    await call(b, 'put_page', { slug, content: file(slug, [], canary) });
    await repairVisibility(b.engine, ['--source', SRC, '--slug', slug, '--readers', 'alice-example,' + OWNER]);
    expect((await pageRow(b.engine, SRC, slug)).tier).toBe('agent_written');
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
    const written = await put(b, slug, file(slug, ['readable_by: [alice-example, bob-example, ' + OWNER + ']'], canary, 'Rewritten.'));
    expect(written.privacy_labels_kept?.keys).toEqual(['readable_by']);
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
    expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'reject')).toMatchObject({ status: 'rejected' });
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.readable_by).toEqual(['alice-example', OWNER]);
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
  }), 180_000);

  test('B: an agent write that takes the owner out of the readers keeps the owner a reader until accept', () => repoless(async (b, reads) => {
    const slug = 'notes/owner-dropped-example', canary = 'canaryownerdropped';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, ['readable_by: [alice-example, ' + OWNER + ']'], canary));
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
    const written = await put(b, slug, file(slug, ['readable_by: [alice-example]'], canary, 'Narrowed.'));
    expect(written.privacy_labels_kept?.keys).toEqual(['readable_by']);
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.readable_by).toEqual(['alice-example', OWNER]);
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
    const [proposal] = await proposalsOf(b, slug);
    expect(proposal!.after_state.labels).toMatchObject({ keys: ['readable_by'], requested: { readable_by: ['alice-example'] } });
    expect(await decide(b, written.privacy_labels_kept.proposal_ref, 'accept')).toMatchObject({ status: 'accepted', detail: { status: 'confirmed' } });
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.readable_by).toEqual(['alice-example']);
    expect((await pageRow(b.engine, SRC, slug)).tier).toBe('user_confirmed');
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: false });
  }), 180_000);

  test('B: on an agent\'s own page, and when an agent restricts a page that named no readers, the owner stays a reader', () => repoless(async (b, reads) => {
    const own = 'notes/agent-readers-example', canary = 'canaryagentreaders';
    await call(b, 'put_page', { slug: own, content: file(own, ['readable_by: [alice-example, ' + OWNER + ']'], canary) });
    const narrowed = await put(b, own, file(own, ['readable_by: [alice-example]'], canary, 'Narrowed.'));
    expect(narrowed.privacy_labels_kept?.keys).toEqual(['readable_by']);
    expect(await readsOf(reads, own, canary)).toEqual({ unbound: false, bob: false, owner: true });
    expect(await decide(b, narrowed.privacy_labels_kept.proposal_ref, 'accept')).toMatchObject({ status: 'accepted', detail: { status: 'labelled' } });
    expect(await pageRow(b.engine, SRC, own)).toMatchObject({ tier: 'agent_written', frontmatter: { readable_by: ['alice-example'] } });
    expect(await readsOf(reads, own, canary)).toEqual({ unbound: false, bob: false, owner: false });
    expect(await decide(b, narrowed.privacy_labels_kept.proposal_ref, 'undo')).toMatchObject({ status: 'undone' });
    expect(await pageRow(b.engine, SRC, own)).toMatchObject({ tier: 'agent_written', frontmatter: { readable_by: ['alice-example', OWNER] } });
    expect(await readsOf(reads, own, canary)).toEqual({ unbound: false, bob: false, owner: true });

    const open = 'notes/open-example', openCanary = 'canaryopen';
    await seedOwnerPage(b.engine, SRC, open, file(open, [], openCanary));
    expect(await readsOf(reads, open, openCanary)).toEqual({ unbound: true, bob: true, owner: true });
    const restricted = await put(b, open, file(open, ['readable_by: [alice-example]'], openCanary, 'Restricted.'));
    expect(restricted.privacy_labels_kept?.keys).toEqual(['readable_by']);
    expect((await pageRow(b.engine, SRC, open)).frontmatter.readable_by).toEqual(['alice-example', OWNER]);
    expect(await readsOf(reads, open, openCanary)).toEqual({ unbound: false, bob: false, owner: true });
  }), 180_000);

  test('B fails closed: an error reading the owner refuses the write instead of dropping the owner', () => repoless(async (b) => {
    const slug = 'notes/owner-read-error-example', canary = 'canaryownererror';
    await seedOwnerPage(b.engine, SRC, slug, file(slug, ['readable_by: [alice-example, ' + OWNER + ']'], canary));
    const [page] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SRC, slug]);
    const failing = new Proxy(b.engine, { get(target, key, receiver) {
      if (key !== 'executeRaw') return Reflect.get(target, key, receiver);
      return (sql: string, params?: unknown[]) => /access_members/.test(sql) ? Promise.reject(new Error('connection reset')) : target.executeRaw(sql, params);
    } });
    const row = { operation: 'put_page', intent: {}, authority: { remote: false } } as any;
    await expect(privacyLabelGuard(failing, row, { tier: 'agent_written' } as any, { id: Number(page!.id), frontmatter: { readable_by: ['alice-example', OWNER] } },
      'operator_curated', { readable_by: ['alice-example'] })).rejects.toThrow('connection reset');
  }), 120_000);

  test('re-running the label repair on a page that already has the labels raises the guard without changing them', () => repoless(async (b, reads) => {
    const slug = 'notes/already-labelled-example', canary = 'canaryalready';
    await call(b, 'put_page', { slug, content: file(slug, ['visibility: private', 'readable_by: [alice-example, ' + OWNER + ']'], canary) });
    const before = await pageRow(b.engine, SRC, slug);
    const revision = async () => (await b.engine.readPageSnapshot(slug, { sourceId: SRC }))?.revision;
    const written = await revision();
    expect(await guardOf(b.engine, SRC, slug)).toBeNull();
    await repairVisibility(b.engine, ['--source', SRC, '--slug', slug]);
    expect(await guardOf(b.engine, SRC, slug)).toBe('operator_curated');
    await b.engine.executeRaw('DELETE FROM page_label_guards');
    await repairVisibility(b.engine, ['--source', SRC, '--slug', slug, '--readers', 'alice-example,' + OWNER]);
    expect(await guardOf(b.engine, SRC, slug)).toBe('operator_curated');
    expect(await revision()).toBe(written);
    const after = await pageRow(b.engine, SRC, slug);
    expect(labelsOf(after.frontmatter)).toEqual(labelsOf(before.frontmatter));
    expect(after.tier).toBe('agent_written');
    const dropped = await put(b, slug, file(slug, [], canary, 'Dropped both.'));
    expect([...dropped.privacy_labels_kept?.keys ?? []].sort()).toEqual(['readable_by', 'visibility']);
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
  }), 180_000);

  test('a labels-only accept keeps the owner tier an earlier dropped lowering left: a later agent drop is still held', () => repoless(async (b, reads) => {
    const slug = 'notes/accept-after-drop-example', canary = 'canaryacceptdrop';
    const labels = ['visibility: private', 'readable_by: [alice-example, ' + OWNER + ']'];
    await seedOwnerPage(b.engine, SRC, slug, file(slug, labels, canary));
    const rewrite = await put(b, slug, file(slug, labels, canary, 'An agent rewrote the body.'));
    await decide(b, rewrite.trust_lowered.proposal_ref, 'reject');
    expect((await pageRow(b.engine, SRC, slug)).tier).toBe('agent_written');
    const widened = await put(b, slug, file(slug, ['visibility: private', 'readable_by: [alice-example, bob-example, ' + OWNER + ']'], canary, 'An agent rewrote the body.'));
    const accepted = await decide(b, widened.privacy_labels_kept.proposal_ref, 'accept');
    expect(accepted.detail).toMatchObject({ status: 'labelled', tier: 'agent_written' });
    const dropped = await put(b, slug, file(slug, [], canary, 'An agent dropped the labels.'));
    expect([...dropped.privacy_labels_kept?.keys ?? []].sort()).toEqual(['readable_by', 'visibility']);
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
  }), 180_000);

  test('an agent write prepared before a guard-only raise does not publish unheld: it refuses revision_conflict', () => repoless(async (b, reads) => {
    const slug = 'notes/raise-race-example', canary = 'canaryraiserace';
    await call(b, 'put_page', { slug, content: file(slug, ['visibility: private'], canary) });
    expect((await pageRow(b.engine, SRC, slug)).tier).toBe('agent_written');
    await disposePersistenceConsumer(b.engine);
    const [source] = await b.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SRC]);
    const authority = await submissionAuthority(b.ctx, 'put_page', SRC, source!.incarnation, slug);
    const dropped = file(slug, [], canary, 'An agent dropped the label.');
    const pageId = (await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SRC, slug]))[0]!.id;
    await admitWrite(b.engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: SRC, sourceIncarnation: source!.incarnation,
      slug, pageId: Number(pageId), requestId: randomUUID(), callerIntent: { content: dropped, expected_revision: (await pageRow(b.engine, SRC, slug)).revision },
      intent: { content: dropped, expected_revision: (await pageRow(b.engine, SRC, slug)).revision } });
    const row = (await claimNextWrite(b.engine, localHostId()))!;
    const prepared = await preparePageMutation(b.engine, row, b.ctx.config);
    await repairVisibility(b.engine, ['--source', SRC, '--slug', slug]);
    expect(await guardOf(b.engine, SRC, slug)).toBe('operator_curated');
    const published = await publishMutation(b.engine, row, prepared).then(r => r, (error: unknown) => error);
    expect((published as { code?: string }).code ?? (published as { error_code?: string }).error_code).toBe('revision_conflict');
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.visibility).toBe('private');
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
    const retried = await put(b, slug, dropped);
    expect(retried.privacy_labels_kept?.keys).toEqual(['visibility']);
  }), 180_000);

  test('an agent write prepared while the owner read past readers does not drop the owner once the opt-in is off: it refuses revision_conflict', () => repoless(async (b, reads) => {
    const slug = 'notes/owner-race-example', canary = 'canaryownerrace';
    await call(b, 'put_page', { slug, content: file(slug, ['readable_by: [alice-example, ' + OWNER + ']'], canary) });
    await setOwnerReadsRestricted(b.engine, true, { remote: false });
    await disposePersistenceConsumer(b.engine);
    const [source] = await b.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SRC]);
    const authority = await submissionAuthority(b.ctx, 'put_page', SRC, source!.incarnation, slug);
    const dropped = file(slug, ['readable_by: [alice-example]'], canary, 'An agent took the owner out.');
    const page = await pageRow(b.engine, SRC, slug);
    const pageId = (await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SRC, slug]))[0]!.id;
    await admitWrite(b.engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: SRC, sourceIncarnation: source!.incarnation,
      slug, pageId: Number(pageId), requestId: randomUUID(), callerIntent: { content: dropped, expected_revision: page.revision },
      intent: { content: dropped, expected_revision: page.revision } });
    const row = (await claimNextWrite(b.engine, localHostId()))!;
    const prepared = await preparePageMutation(b.engine, row, b.ctx.config);
    await setOwnerReadsRestricted(b.engine, false, { remote: false });
    const published = await publishMutation(b.engine, row, prepared).then(r => r, (error: unknown) => error);
    expect((published as { code?: string }).code ?? (published as { error_code?: string }).error_code).toBe('revision_conflict');
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.readable_by).toEqual(['alice-example', OWNER]);
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
    const retried = await put(b, slug, dropped);
    expect(retried.privacy_labels_kept?.keys).toEqual(['readable_by']);
    expect(await reads('owner', slug, canary)).toBe(true);
  }), 180_000);

  test('a label door that clears the labels leaves no guard: the agent\'s own later label is its own to drop', () => repoless(async (b) => {
    const slug = 'notes/cleared-example', canary = 'canarycleared';
    await call(b, 'put_page', { slug, content: file(slug, ['readable_by: [alice-example, ' + OWNER + ']'], canary) });
    await repairVisibility(b.engine, ['--source', SRC, '--slug', slug, '--readers', 'none']);
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.readable_by).toBeUndefined();
    await put(b, slug, file(slug, ['visibility: private'], canary, 'The agent made it private.'));
    const dropped = await put(b, slug, file(slug, [], canary, 'The agent opened it again.'));
    expect(dropped.privacy_labels_kept).toBeUndefined();
    expect((await pageRow(b.engine, SRC, slug)).frontmatter.visibility).toBeUndefined();
  }), 120_000);

  test('nothing is held that should not be: an agent narrowing that keeps the owner, the owner\'s readers setter, the owner opt-in', () => repoless(async (b, reads) => {
    const keep = 'notes/keeps-owner-example', canary = 'canarykeepsowner';
    await seedOwnerPage(b.engine, SRC, keep, file(keep, ['readable_by: [alice-example, bob-example, ' + OWNER + ']'], canary));
    const narrowed = await put(b, keep, file(keep, ['readable_by: [alice-example, ' + OWNER + ']'], canary, 'Narrowed.'));
    expect(narrowed.privacy_labels_kept).toBeUndefined();
    expect(await readsOf(reads, keep, canary)).toEqual({ unbound: false, bob: false, owner: true });

    const setter = 'notes/setter-example', setterCanary = 'canarysetter';
    await seedOwnerPage(b.engine, SRC, setter, file(setter, ['readable_by: [alice-example, ' + OWNER + ']'], setterCanary));
    await repairVisibility(b.engine, ['--source', SRC, '--slug', setter, '--readers', 'alice-example', '--allow-without-owner']);
    expect((await pageRow(b.engine, SRC, setter)).frontmatter.readable_by).toEqual(['alice-example']);
    expect(await proposalsOf(b, setter)).toEqual([]);

    await setOwnerReadsRestricted(b.engine, true, { remote: false });
    const opted = 'notes/opted-example', optedCanary = 'canaryopted';
    await seedOwnerPage(b.engine, SRC, opted, file(opted, ['readable_by: [alice-example, ' + OWNER + ']'], optedCanary));
    const dropped = await put(b, opted, file(opted, ['readable_by: [alice-example]'], optedCanary, 'Narrowed.'));
    expect(dropped.privacy_labels_kept).toBeUndefined();
    expect(await reads('owner', opted, optedCanary)).toBe(true);
  }), 180_000);
});

for (const backend of testBackends()) describe('[' + backend + '] owner-set labels on an agent page, on a managed git source', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), 'archive/' + NL); durableGitRepo(root, ['.gitignore']); };

  test('A and B: the committed file keeps the owner\'s label and the owner as a reader', () => managedBrain(async ({ engine, ctx, root }) => {
    const b: Brain = { engine, ctx, sourceId: 'default', home: root };
    const reads = await remoteReaders(engine, 'default');
    mkdirSync(join(root, 'notes'), { recursive: true });
    const slug = 'notes/managed-owner-example', canary = 'canarymanaged';
    await call(b, 'put_page', { slug, content: file(slug, [], canary) });
    await settleManagedGitEffects(engine);
    await repairVisibility(engine, ['--source', 'default', '--slug', slug, '--readers', 'alice-example,' + OWNER]);
    await settleManagedGitEffects(engine);
    expect((await pageRow(engine, 'default', slug)).tier).toBe('agent_written');
    const committed = () => git(root, 'show', 'HEAD:' + slug + '.md');
    expect(committed()).toContain('readable_by:');
    const widened = await put(b, slug, file(slug, [], canary, 'An agent rewrote it.'));
    expect(widened.privacy_labels_kept?.keys).toEqual(['readable_by']);
    await settleManagedGitEffects(engine);
    expect(committed()).toContain('An agent rewrote it.');
    expect((await pageRow(engine, 'default', slug)).frontmatter.readable_by).toEqual(['alice-example', OWNER]);
    expect(committed()).toContain(OWNER);
    const narrowed = await put(b, slug, file(slug, ['readable_by: [alice-example]'], canary, 'An agent narrowed it.'));
    expect(narrowed.privacy_labels_kept?.keys).toEqual(['readable_by']);
    await settleManagedGitEffects(engine);
    expect(committed()).toContain('An agent narrowed it.');
    expect(committed()).toContain(OWNER);
    expect(await readsOf(reads, slug, canary)).toEqual({ unbound: false, bob: false, owner: true });
  }, { databaseUrl, setup }), 240_000);

  test('re-running the readers repair on pages that already name those readers raises their guards with no commit', () => managedBrain(async ({ engine, ctx, root }) => {
    const b: Brain = { engine, ctx, sourceId: 'default', home: root };
    await remoteReaders(engine, 'default');
    mkdirSync(join(root, 'notes'), { recursive: true });
    const slugs = ['notes/rerun-a-example', 'notes/rerun-b-example'];
    for (const slug of slugs) await call(b, 'put_page', { slug, content: file(slug, ['readable_by: [alice-example, ' + OWNER + ']'], 'canaryrerun') });
    await settleManagedGitEffects(engine);
    const head = git(root, 'rev-parse', 'HEAD');
    await repairVisibility(engine, ['--source', 'default', ...slugs.flatMap(slug => ['--slug', slug]), '--readers', 'alice-example,' + OWNER]);
    await settleManagedGitEffects(engine);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    for (const slug of slugs) {
      expect(await guardOf(engine, 'default', slug)).toBe('operator_curated');
      expect((await pageRow(engine, 'default', slug)).frontmatter.readable_by).toEqual(['alice-example', OWNER]);
    }
    const narrowed = await put(b, slugs[0]!, file(slugs[0]!, ['readable_by: [alice-example]'], 'canaryrerun', 'An agent narrowed it.'));
    expect(narrowed.privacy_labels_kept?.keys).toEqual(['readable_by']);
  }, { databaseUrl, setup }), 240_000);
});
