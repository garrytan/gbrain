/**
 * GST-1158 (GBRA-284): memory_propose, QM's held timeline entries and links, approved by the brain owner.
 *
 * 1. Protects: an attested proposal is checked before anything is held and is held in memory_proposals, never in the
 *    journal, git, an export or a recall, until the owner approves it; approval re-checks the person, the grant, the page
 *    revision and a link's target under the stored authority and admits the write into the journal in the same
 *    transaction that marks the proposal approved; deny, expiry, the proposer's cancel and refused checks close it with a
 *    reason; QM reads one request id from proposal to publication through get_write_request; the caps, the payload cap,
 *    the TTL and the retention purge hold; the published provenance names the member, never the external id.
 * 2. Fails when: a proposal publishes without the owner, an unlinked person's or a changed page's proposal publishes, a
 *    second approve writes twice, a cap or the payload cap can be passed, another member under the same credential reads
 *    or cancels it, a held receipt or an export or a recall carries the proposed text, a closed row outlives retention,
 *    or the journal's state lists change.
 * 3. Existing coverage: test/qm-memory-tools.test.ts (memory_write), test/access-qm-actor.test.ts (F9 deferred ops).
 * 4. Real seams: OAuth client-credentials tokens verified by the provider and dispatched through MCP dispatch on a
 *    repo-less brain; owner actions through the library and the gbrain memory-proposals command module; publication
 *    through the persistence consumer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential, disableMember, enableMember } from '../src/core/access/members.ts';
import { linkMember, unlinkMember } from '../src/core/access/actor.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { WRITE_REQUEST_STATES } from '../src/core/persistence/types.ts';
import { DELETION_INVENTORY_BY_TABLE } from '../src/core/deletion-inventory.ts';
import {
  approveMemoryProposal, denyMemoryProposal, listMemoryProposals, pendingProposalSummary, proposalRequestId, runMemoryProposalUpkeep, PROPOSAL_LIMIT_KEYS, PROPOSAL_RETRY_AFTER_MS, PROPOSAL_STATES,
} from '../src/core/persistence/memory-proposals.ts';
import { QM_CONTRACT_PATHS } from '../scripts/build-qm-memory-contract.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'qm-propose';
const ALICE_ID = 'alice-example@acme.test';
const BOB_ID = 'U0BOB';
const CAROL_ID = 'U0CAROL';
const ACME = 'companies/acme-example';
const GLOBEX = 'companies/globex-example';
const INITECH = 'companies/initech-example';
const QUIET = 'notes/quiet-example';
const BOBONLY = 'notes/bob-only-example';
const ATTEST_OPS = ['cancel_write_request', 'get_write_request', 'list_write_requests', 'memory_propose', 'memory_recall', 'memory_write'];

const pageText = (title: string, extra: string[] = [], body = 'Harbor ledger notes.') => ['---', 'type: company', 'title: ' + title, ...extra, '---', '# ' + title, '', body].join('\n');

for (const kind of testBackends()) {
  describe('memory_propose (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let qmClient: string;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const tokens: Record<string, string> = {};
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;
    type Who = { token: string; actor?: string };
    const alice: Who = { token: 'qm', actor: ALICE_ID };
    const bob: Who = { token: 'qm', actor: BOB_ID };
    const carol: Who = { token: 'qm', actor: CAROL_ID };

    async function call(as: Who, op: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth: await verify(tokens[as.token]!), sourceId: SRC, takesHoldersAllowList: ['world'],
        ...(as.actor !== undefined ? { actor: { header: as.actor } } : {}), ...extra,
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch { /* plain text */ }
      return { isError: out.isError === true, text, json, structured: out.structuredContent as Record<string, any> | undefined,
        all: text + JSON.stringify(out._meta ?? {}) + JSON.stringify(out.structuredContent ?? {}) };
    }
    const propose = (as: Who, params: Record<string, unknown>, key: string = randomUUID()) => call(as, 'memory_propose', { idempotency_key: key, ...params });
    const timeline = (as: Who, summary: string, extra: Record<string, unknown> = {}, key?: string) =>
      propose(as, { kind: 'timeline', target: ACME, date: '2026-10-30', summary, source: 'slack:C0123/p1', ...extra }, key);
    const receipt = (as: Who, id: string) => call(as, 'get_write_request', { request_id: id });
    const owner = (extra: Partial<OperationContext> = {}) => ({ engine, config: { engine: kind } as never, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } as never, ...extra }) as OperationContext;
    const approve = (id: string, extra: Partial<OperationContext> = {}) => approveMemoryProposal(owner(extra), id, { decidedBy: 'cli:test', waitMs: 30_000 });
    const timelineRows = async (needle: string) => engine.executeRaw<{ summary: string; source: string }>(
      'SELECT t.summary, t.source FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 AND t.summary LIKE $2', [SRC, '%' + needle + '%']);
    const proposalRow = async (id: string) => (await engine.executeRaw<Record<string, any>>('SELECT * FROM memory_proposals WHERE request_id = $1::uuid', [id]))[0];
    const journalRows = async (id: string) => engine.executeRaw<Record<string, any>>('SELECT * FROM persistence_requests WHERE request_id = $1::uuid', [id]);
    const setConfig = (key: string, value: string | null) => value === null
      ? engine.executeRaw('DELETE FROM config WHERE key = $1', [key]) : engine.setConfig(key, value);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
      await importFromContent(engine, ACME, pageText('Acme Example'), { sourceId: SRC });
      await importFromContent(engine, GLOBEX, pageText('Globex Example'), { sourceId: SRC });
      await importFromContent(engine, INITECH, pageText('Initech Example'), { sourceId: SRC });
      await importFromContent(engine, QUIET, pageText('Quiet Example', ['visibility: private']), { sourceId: SRC });
      await importFromContent(engine, BOBONLY, pageText('Bob Only Example', ['readable_by: [bob-example]']), { sourceId: SRC });
      const register = async (name: string) => {
        const c = await provider().registerClientManual('p-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        return { id: c.clientId, secret: c.clientSecret ?? '' };
      };
      const qm = await register('qm');
      qmClient = qm.id;
      await bindCredential(engine, { kind: 'client', id: qm.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      const plain = await register('plain');
      for (const [name, c] of [['qm', qm], ['plain', plain]] as const) tokens[name] = (await provider().exchangeClientCredentials(c.id, c.secret)).access_token;
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
      await linkMember(engine, 'carol-example', 'qm', CAROL_ID);
    }, 120_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    });

    test('approve: a held timeline entry publishes once with member provenance, never the external id; one request id throughout', async () => {
      const key = randomUUID();
      const held = await timeline(alice, 'Acme signed the harbor lease canaryapprove', {}, key);
      expect(held.isError).toBe(false);
      const id = held.structured!.request_id as string;
      expect(id).toBe(proposalRequestId({ kind: 'oauth_client', id: qmClient }, 'alice-example', key));
      expect(held.structured).toMatchObject({ status: 'awaiting_owner', request_id: id, kind: 'timeline', target: ACME, expires_at: expect.any(String) });
      expect(await timelineRows('canaryapprove')).toHaveLength(0);
      expect(await journalRows(id)).toHaveLength(0);
      const waiting = await receipt(alice, id);
      expect(waiting.json).toMatchObject({ request_id: id, state: 'awaiting_owner', proposal: { kind: 'timeline', target: ACME } });
      expect(waiting.json.retry_after_ms).toBeGreaterThan(0);
      expect(waiting.all).not.toContain('canaryapprove');
      const out = await approve(id);
      expect(out).toMatchObject({ status: 'approved', request_id: id, write_request: { state: 'committed' } });
      const rows = await timelineRows('canaryapprove');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toContain('member:alice-example');
      expect(rows[0]!.source).toContain('slack:C0123/p1');
      expect(rows[0]!.source).not.toContain(ALICE_ID);
      const page = await engine.getPage(ACME, { sourceId: SRC });
      expect(JSON.stringify(page)).not.toContain(ALICE_ID);
      const done = await receipt(alice, id);
      expect(done.json).toMatchObject({ request_id: id, state: 'committed', proposal: { kind: 'timeline', target: ACME } });
      const again = await approve(id);
      expect(again).toMatchObject({ status: 'approved', request_id: id, write_request: { state: 'committed' } });
      expect(await timelineRows('canaryapprove')).toHaveLength(1);
      expect(await journalRows(id)).toHaveLength(1);
      expect((await proposalRow(id))!.decided_by).toBe('cli:test');
    }, 90_000);

    test('the request id is uuidv5 of the credential, member and key, apart from memory_write ids and other members', async () => {
      const key = 'same-key-' + randomUUID();
      const a = await timeline(alice, 'Key derivation canarykeyid a', {}, key);
      const b = await timeline(bob, 'Key derivation canarykeyid a', {}, key);
      const qm = { kind: 'oauth_client', id: qmClient } as const;
      expect(a.structured!.request_id).toBe(proposalRequestId(qm, 'alice-example', key));
      expect(b.structured!.request_id).toBe(proposalRequestId(qm, 'bob-example', key));
      expect(a.structured!.request_id).not.toBe(b.structured!.request_id);
      const { memoryWriteRequestId } = await import('../src/core/ops/qm-memory.ts');
      expect(await memoryWriteRequestId('alice-example', key, 0)).not.toBe(a.structured!.request_id);
    }, 60_000);

    test('two credentials proposing for one member with one key get two request ids, and the owner decides each', async () => {
      const c = await provider().registerClientManual('p-qm2-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      tokens.qm2 = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      const key = 'shared-key-' + randomUUID();
      const a = (await timeline(alice, 'Two credentials canarytwocreds one', {}, key)).structured!.request_id as string;
      const b = (await timeline({ token: 'qm2', actor: ALICE_ID }, 'Two credentials canarytwocreds two', {}, key)).structured!.request_id as string;
      expect(a).not.toBe(b);
      expect(b).toBe(proposalRequestId({ kind: 'oauth_client', id: c.clientId }, 'alice-example', key));
      expect(await approve(a)).toMatchObject({ status: 'approved', write_request: { state: 'committed' } });
      expect(await denyMemoryProposal(owner(), b, 'Duplicate', { decidedBy: 'cli:test' })).toMatchObject({ status: 'denied' });
      expect((await timelineRows('canarytwocreds')).map(r => r.summary)).toEqual(['Two credentials canarytwocreds one']);
    }, 90_000);

    test('link deny, expiry and cancel close the proposal and write no link and no journal row', async () => {
      const links = async () => engine.executeRaw('SELECT 1 FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE f.slug = $1 AND t.slug = $2 AND f.source_id = $3 AND l.context LIKE $4',
        [GLOBEX, INITECH, SRC, '%canarylinkclose%']);
      const link = async () => (await propose(alice, { kind: 'link', target: GLOBEX, to: INITECH, context: 'canarylinkclose' })).structured!.request_id as string;
      const denied = await link();
      expect(await denyMemoryProposal(owner(), denied, 'no', { decidedBy: 'cli:test' })).toMatchObject({ status: 'denied' });
      const expired = await link();
      await engine.executeRaw("UPDATE memory_proposals SET expires_at = now() - interval '1 minute' WHERE request_id = $1::uuid", [expired]);
      await runMemoryProposalUpkeep(engine);
      const cancelled = await link();
      expect((await call(alice, 'cancel_write_request', { request_id: cancelled })).json).toMatchObject({ state: 'cancelled' });
      for (const [id, state] of [[denied, 'denied'], [expired, 'expired'], [cancelled, 'cancelled']] as const) {
        expect((await proposalRow(id))!.state).toBe(state);
        expect(await journalRows(id)).toHaveLength(0);
      }
      expect(await links()).toHaveLength(0);
    }, 90_000);

    test('link approval carries the proposal revision to publication: a page moved after the yes is a conflict, never a silent upsert', async () => {
      const id = (await propose(alice, { kind: 'link', target: ACME, to: INITECH, context: 'canarylinkpin' })).structured!.request_id as string;
      const held = (await proposalRow(id))!;
      expect(typeof held.expected_revision).toBe('string');
      const from = (await engine.getPage(ACME, { sourceId: SRC }))!;
      const row = { request_id: id, operation: 'add_link', source_id: SRC, slug: ACME, page_id: from.id,
        intent: { to: INITECH, link_type: '', link_source: 'qm-proposal', context: 'canarylinkpin', expected_revision: 'not-the-revision' }, authority: { ...held.authority, attestedOp: 'memory_propose' } };
      const { prepareManualLinkMutation } = await import('../src/core/persistence/manual-links.ts');
      await expect(prepareManualLinkMutation(engine, row as never, { engine: engine.kind } as never)).rejects.toMatchObject({ code: 'revision_conflict' });
      const current = await prepareManualLinkMutation(engine, { ...row, intent: { ...row.intent, expected_revision: held.expected_revision } } as never, { engine: engine.kind } as never)
        .then(() => 'prepared', (e: { code?: string }) => e.code);
      expect(current).not.toBe('revision_conflict');
      expect(await approve(id)).toMatchObject({ status: 'approved', write_request: { state: 'committed' } });
      expect((await journalRows(id))[0]!.intent).toMatchObject({ expected_revision: held.expected_revision });
    }, 90_000);

    test('deny: the receipt says denied with the reason, the page is unchanged, approve afterwards is proposal_closed', async () => {
      const held = await timeline(alice, 'Acme moved offices canarydeny');
      const id = held.structured!.request_id as string;
      await expect(denyMemoryProposal(owner(), id, '   ', { decidedBy: 'cli:test' })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(denyMemoryProposal(owner(), id, 'x'.repeat(501), { decidedBy: 'cli:test' })).rejects.toMatchObject({ code: 'invalid_params' });
      const dry = await denyMemoryProposal(owner({ dryRun: true }), id, 'Not accurate', { decidedBy: 'cli:test' });
      expect(dry).toMatchObject({ dry_run: true, would: 'denied' });
      expect((await proposalRow(id))!.state).toBe('awaiting_owner');
      const out = await denyMemoryProposal(owner(), id, 'Not accurate', { decidedBy: 'cli:test' });
      expect(out).toMatchObject({ status: 'denied', reason: 'Not accurate' });
      const r = await receipt(alice, id);
      expect(r.json).toMatchObject({ state: 'denied', retry_after_ms: null, decision: { reason: 'Not accurate' } });
      expect(r.all).not.toContain('canarydeny');
      expect(await timelineRows('canarydeny')).toHaveLength(0);
      await expect(approve(id)).rejects.toMatchObject({ code: 'proposal_closed' });
      await expect(denyMemoryProposal(owner(), id, 'again', { decidedBy: 'cli:test' })).rejects.toMatchObject({ code: 'proposal_closed' });
    }, 60_000);

    test('expiry: the upkeep pass expires an overdue proposal; approve refuses an overdue one even when no pass ran', async () => {
      const a = (await timeline(alice, 'Expiry one canaryexpire')).structured!.request_id as string;
      const b = (await timeline(alice, 'Expiry two canaryexpire')).structured!.request_id as string;
      await engine.executeRaw("UPDATE memory_proposals SET expires_at = now() - interval '1 minute' WHERE request_id = ANY($1::uuid[])", [[a, b]]);
      await expect(approve(b)).rejects.toMatchObject({ code: 'proposal_expired' });
      expect((await proposalRow(b))!.state).toBe('expired');
      const pass = await runMemoryProposalUpkeep(engine);
      expect(pass.expired).toBeGreaterThanOrEqual(1);
      const r = await receipt(alice, a);
      expect(r.json).toMatchObject({ state: 'expired', decision: { reason: expect.stringContaining('No owner decision') } });
      expect(await timelineRows('canaryexpire')).toHaveLength(0);
      await expect(approve(a)).rejects.toMatchObject({ code: 'proposal_closed' });
    }, 60_000);

    test('replay: the same key and fields return the same proposal even after the page moved; other fields are idempotency_conflict', async () => {
      const key = 'replay-' + randomUUID();
      const first = await timeline(alice, 'Replay canaryreplay', {}, key);
      await importFromContent(engine, ACME, pageText('Acme Example', [], 'Harbor ledger notes, revised ' + randomUUID()), { sourceId: SRC });
      const again = await timeline(alice, 'Replay canaryreplay', {}, key);
      expect(again.isError).toBe(false);
      expect(again.structured).toMatchObject({ status: 'awaiting_owner', request_id: first.structured!.request_id });
      const changed = await timeline(alice, 'Replay changed canaryreplay', {}, key);
      expect(changed.isError).toBe(true);
      expect(changed.json.code).toBe('idempotency_conflict');
      expect(await engine.executeRaw('SELECT 1 FROM memory_proposals WHERE request_id = $1::uuid', [first.structured!.request_id])).toHaveLength(1);
    }, 60_000);

    test('page changed while waiting: timeline and link proposals close as conflict revision_changed', async () => {
      const t = (await timeline(alice, 'Revision canaryrevision')).structured!.request_id as string;
      const l = (await propose(alice, { kind: 'link', target: GLOBEX, to: INITECH, context: 'partner canaryrevisionlink' })).structured!.request_id as string;
      await importFromContent(engine, ACME, pageText('Acme Example', [], 'Edited while held ' + randomUUID()), { sourceId: SRC });
      await importFromContent(engine, GLOBEX, pageText('Globex Example', [], 'Edited while held ' + randomUUID()), { sourceId: SRC });
      expect(await approve(t)).toMatchObject({ status: 'conflict', error_code: 'revision_changed' });
      expect(await approve(l)).toMatchObject({ status: 'conflict', error_code: 'revision_changed' });
      expect((await receipt(alice, t)).json).toMatchObject({ state: 'conflict', write_error: 'revision_changed' });
      expect(await timelineRows('canaryrevision')).toHaveLength(0);
      expect(await journalRows(t)).toHaveLength(0);
    }, 60_000);

    test('a sent expected_revision that is not current is refused before anything is held', async () => {
      const out = await timeline(alice, 'Stale revision canarystalerev', { expected_revision: 'not-the-revision' });
      expect(out.isError).toBe(true);
      expect({ code: out.json.code, reason: out.json.reason }).toEqual({ code: 'invalid_params', reason: 'proposal_revision_changed' });
      expect(await engine.executeRaw("SELECT 1 FROM memory_proposals WHERE payload::text LIKE '%canarystalerev%'")).toHaveLength(0);
    }, 60_000);

    test('link approve: the link publishes to the from page with qm-proposal provenance on a repo-less unmanaged brain', async () => {
      const held = await propose(alice, { kind: 'link', target: GLOBEX, to: INITECH, link_type: '', context: 'supplier canarylink' });
      expect(held.isError).toBe(false);
      const id = held.structured!.request_id as string;
      const out = await approve(id);
      expect(out).toMatchObject({ status: 'approved', write_request: { state: 'committed' } });
      const links = await engine.executeRaw<{ link_source: string; context: string }>(
        'SELECT l.link_source, l.context FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE f.slug = $1 AND t.slug = $2 AND f.source_id = $3',
        [GLOBEX, INITECH, SRC]);
      expect(links.some(l => l.link_source === 'qm-proposal' && l.context.includes('member:alice-example'))).toBe(true);
      expect(JSON.stringify(links)).not.toContain(ALICE_ID);
    }, 90_000);

    test('link target deleted or turned private while held: conflict link_target_changed, and the slug never reaches the fence', async () => {
      const gone = 'companies/gone-example';
      const hidden = 'companies/hidden-example';
      await importFromContent(engine, gone, pageText('Gone Example'), { sourceId: SRC });
      await importFromContent(engine, hidden, pageText('Hidden Example'), { sourceId: SRC });
      const a = (await propose(alice, { kind: 'link', target: ACME, to: gone })).structured!.request_id as string;
      const b = (await propose(alice, { kind: 'link', target: ACME, to: hidden })).structured!.request_id as string;
      await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND slug = $2', [SRC, gone]);
      await importFromContent(engine, hidden, pageText('Hidden Example', ['visibility: private']), { sourceId: SRC });
      expect(await approve(a)).toMatchObject({ status: 'conflict', error_code: 'link_target_changed' });
      expect(await approve(b)).toMatchObject({ status: 'conflict', error_code: 'link_target_changed' });
      const page = await engine.getPage(ACME, { sourceId: SRC });
      expect(JSON.stringify(page)).not.toContain(hidden);
      expect(JSON.stringify(page)).not.toContain(gone);
    }, 60_000);

    test('publish re-check (OV3): a proposed link whose target went away after the yes refuses page_not_found at publish', async () => {
      const late = 'companies/late-example';
      await importFromContent(engine, late, pageText('Late Example'), { sourceId: SRC });
      const id = (await propose(alice, { kind: 'link', target: ACME, to: late })).structured!.request_id as string;
      const held = (await proposalRow(id))!;
      const from = (await engine.getPage(ACME, { sourceId: SRC }))!;
      const row = { request_id: id, operation: 'add_link', source_id: SRC, slug: ACME, page_id: from.id,
        intent: { to: late, link_type: '', link_source: 'qm-proposal' }, authority: { ...held.authority, attestedOp: 'memory_propose' } };
      const { prepareManualLinkMutation } = await import('../src/core/persistence/manual-links.ts');
      await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND slug = $2', [SRC, late]);
      await expect(prepareManualLinkMutation(engine, row as never, { engine: engine.kind } as never)).rejects.toMatchObject({ code: 'page_not_found' });
      const plain = await prepareManualLinkMutation(engine, { ...row, authority: { ...row.authority, attestedOp: 'add_link' } } as never, { engine: engine.kind } as never)
        .then(() => 'prepared', (e: { code?: string }) => e.code);
      expect(plain).not.toBe('page_not_found');
      await call(alice, 'cancel_write_request', { request_id: id });
    }, 60_000);

    test('proposer cancel: cancel_write_request closes it cancelled; approve afterwards is proposal_closed', async () => {
      const id = (await timeline(alice, 'Cancel me canarycancel')).structured!.request_id as string;
      const out = await call(alice, 'cancel_write_request', { request_id: id });
      expect(out.isError).toBe(false);
      expect(out.json).toMatchObject({ request_id: id, state: 'cancelled' });
      await expect(approve(id)).rejects.toMatchObject({ code: 'proposal_closed' });
      expect(await timelineRows('canarycancel')).toHaveLength(0);
    }, 60_000);

    test('the answers match contract v4: the held result, the proposal receipt, and the cancel that answers JSON in content alone (GST-2407)', async () => {
      const contract = JSON.parse(readFileSync(QM_CONTRACT_PATHS[4], 'utf8')).memory_propose;
      const held = await timeline(alice, 'Contract shape canarycontractshape');
      expect(Object.keys(held.structured!).sort()).toEqual(Object.keys(contract.awaiting.structuredContent).sort());
      expect(JSON.parse(held.text)).toEqual(held.structured);
      const id = held.structured!.request_id as string;
      const waiting = await receipt(alice, id);
      for (const key of Object.keys(contract.receipt.structured_content)) expect(waiting.structured).toHaveProperty(key);
      expect(Object.keys(waiting.structured!).filter(k => !(k in contract.receipt.structured_content) && !(k in contract.receipt.optional))).toEqual([]);
      expect(Object.keys(waiting.structured!.proposal).sort()).toEqual(Object.keys(contract.receipt.structured_content.proposal).sort());
      expect(contract.receipt.states.known).toContain(waiting.structured!.state);
      expect(waiting.structured!.retry_after_ms).toBeLessThanOrEqual(PROPOSAL_RETRY_AFTER_MS);
      for (const _ of [0, 1]) {
        const out = await call(alice, 'cancel_write_request', { request_id: id });
        expect({ isError: out.isError, state: out.json.state, structured: out.structured }).toEqual({ isError: false, state: 'cancelled', structured: undefined });
        expect(out.json).toMatchObject({ decision: { reason: expect.any(String) } });
      }
    }, 60_000);

    test('another member under the same credential gets not_found for get and cancel', async () => {
      const id = (await timeline(alice, 'Private to alice canaryforeign')).structured!.request_id as string;
      const get = await receipt(bob, id);
      expect({ isError: get.isError, code: get.json.code }).toEqual({ isError: true, code: 'not_found' });
      const cancel = await call(bob, 'cancel_write_request', { request_id: id });
      expect({ isError: cancel.isError, code: cancel.json.code }).toEqual({ isError: true, code: 'not_found' });
      expect((await proposalRow(id))!.state).toBe('awaiting_owner');
      expect(get.all + cancel.all).not.toContain('canaryforeign');
    }, 60_000);

    test('caps: per person and per credential; an overdue row frees its slot at the next proposal', async () => {
      await engine.executeRaw("UPDATE memory_proposals SET state = 'cancelled', decided_at = now() WHERE state = 'awaiting_owner'");
      await setConfig('proposals.max_pending_per_actor', '2');
      await setConfig('proposals.max_pending_per_credential', '3');
      try {
        const ids = [];
        for (let i = 0; i < 2; i++) ids.push((await timeline(carol, 'Cap ' + i + ' canarycap')).structured!.request_id);
        const third = await timeline(carol, 'Cap 2 canarycap');
        expect({ isError: third.isError, code: third.json.code, reason: third.json.reason }).toEqual({ isError: true, code: 'proposals_pending_limit', reason: 'actor' });
        await timeline(bob, 'Cap bob canarycap');
        const fourth = await timeline(alice, 'Cap alice canarycap');
        expect({ code: fourth.json.code, reason: fourth.json.reason }).toEqual({ code: 'proposals_pending_limit', reason: 'credential' });
        await engine.executeRaw("UPDATE memory_proposals SET expires_at = now() - interval '1 minute' WHERE request_id = $1::uuid", [ids[0]]);
        const freed = await timeline(carol, 'Cap freed canarycap');
        expect(freed.isError).toBe(false);
        expect((await proposalRow(ids[0] as string))!.state).toBe('expired');
        if (kind === 'postgres') {
          await engine.executeRaw("UPDATE memory_proposals SET state = 'cancelled', decided_at = now() WHERE state = 'awaiting_owner'");
          const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => timeline(carol, 'Burst ' + i + ' canaryburst')));
          expect(burst.filter(b => !b.isError)).toHaveLength(2);
          expect(burst.filter(b => b.json.code === 'proposals_pending_limit')).toHaveLength(4);
        }
      } finally {
        await setConfig('proposals.max_pending_per_actor', null);
        await setConfig('proposals.max_pending_per_credential', null);
        await engine.executeRaw("UPDATE memory_proposals SET state = 'cancelled', decided_at = now() WHERE state = 'awaiting_owner'");
      }
    }, 90_000);

    test('payload cap: 1,001 characters refused proposal_too_large, exactly 1,000 accepted', async () => {
      const base = 'canarycap1000 ';
      const fill = (n: number) => base + 'x'.repeat(n - base.length - 'slack:C0123/p1'.length);
      const over = await timeline(alice, fill(1001));
      expect({ code: over.json.code, reason: over.json.reason }).toEqual({ code: 'invalid_params', reason: 'proposal_too_large' });
      const at = await timeline(alice, fill(1000));
      expect(at.isError).toBe(false);
      await call(alice, 'cancel_write_request', { request_id: at.structured!.request_id });
    }, 60_000);

    test('refusals: no actor, the trusted local CLI, fields of the other kind, a bad date, a private or unreadable target', async () => {
      const none = await call({ token: 'qm' }, 'memory_propose', { idempotency_key: randomUUID(), kind: 'timeline', target: ACME, date: '2026-10-30', summary: 'x' });
      expect({ code: none.json.code, reason: none.json.reason }).toEqual({ code: 'actor_not_attested', reason: 'actor_required' });
      const { operationsByName } = await import('../src/core/operations.ts');
      await expect(operationsByName.memory_propose!.handler(owner(), { idempotency_key: 'k', kind: 'timeline', target: ACME, date: '2026-10-30', summary: 'x' }))
        .rejects.toMatchObject({ code: 'actor_not_attested' });
      const mixed = await propose(alice, { kind: 'timeline', target: ACME, date: '2026-10-30', summary: 'x', to: GLOBEX });
      expect({ code: mixed.json.code, reason: mixed.json.reason }).toEqual({ code: 'invalid_params', reason: 'proposal_kind_field' });
      const badDate = await propose(alice, { kind: 'timeline', target: ACME, date: '2026-02-30', summary: 'x' });
      expect(badDate.json.code).toBe('invalid_params');
      const twoLines = await propose(alice, { kind: 'timeline', target: ACME, date: '2026-10-30', summary: 'a\nb' });
      expect(twoLines.json.code).toBe('invalid_params');
      const quiet = await timeline(alice, 'Quiet canaryquiet', { target: QUIET });
      expect(quiet.json.code).toBe('page_not_found');
      const unreadable = await timeline(alice, 'Bob only canarybobonly', { target: BOBONLY });
      expect(unreadable.json.code).toBe('page_not_found');
      const toQuiet = await propose(alice, { kind: 'link', target: ACME, to: QUIET });
      expect(toQuiet.json.code).toBe('page_not_found');
      expect(await engine.executeRaw("SELECT 1 FROM memory_proposals WHERE payload::text LIKE '%canaryquiet%' OR payload::text LIKE '%canarybobonly%' OR to_slug = $1", [QUIET])).toHaveLength(0);
      const direct = await call(alice, 'add_timeline_entry', { slug: ACME, date: '2026-10-30', summary: 'direct canarydirect' });
      expect(direct.json.code).toBe('actor_not_attested');
    }, 60_000);

    test('unlinked, disabled or no longer attested at approval: failed with that code, nothing written', async () => {
      const a = (await timeline(alice, 'Unlinked canaryunlinked')).structured!.request_id as string;
      await unlinkMember(engine, 'qm', ALICE_ID);
      try { expect(await approve(a)).toMatchObject({ status: 'failed', error_code: 'actor_unlinked' }); }
      finally { await linkMember(engine, 'alice-example', 'qm', ALICE_ID); }
      const b = (await timeline(alice, 'Disabled canarydisabled')).structured!.request_id as string;
      await disableMember(engine, 'alice-example');
      try { expect(await approve(b)).toMatchObject({ status: 'failed', error_code: 'actor_unlinked' }); }
      finally { await enableMember(engine, 'alice-example'); }
      const c = (await timeline(alice, 'Revoked canaryrevoked')).structured!.request_id as string;
      await bindCredential(engine, { kind: 'client', id: qmClient }, { attestActor: 'qm', attestOps: ATTEST_OPS.filter(o => o !== 'memory_propose') });
      try {
        // OV8: the proposer still reads and cancels its held rows after memory_propose is revoked.
        expect((await receipt(alice, c)).json).toMatchObject({ state: 'awaiting_owner' });
        expect(await approve(c)).toMatchObject({ status: 'failed', error_code: 'actor_not_attested' });
      } finally { await bindCredential(engine, { kind: 'client', id: qmClient }, { attestActor: 'qm', attestOps: ATTEST_OPS }); }
      for (const n of ['canaryunlinked', 'canarydisabled', 'canaryrevoked']) expect(await timelineRows(n)).toHaveLength(0);
    }, 90_000);

    test('revoked op: the upkeep pass closes held rows failed; the proposer reads and cancels meanwhile', async () => {
      const a = (await timeline(bob, 'Held one canaryheldrevoke')).structured!.request_id as string;
      const b = (await timeline(bob, 'Held two canaryheldrevoke')).structured!.request_id as string;
      await bindCredential(engine, { kind: 'client', id: qmClient }, { attestActor: 'qm', attestOps: ATTEST_OPS.filter(o => o !== 'memory_propose') });
      try {
        const cancelled = await call(bob, 'cancel_write_request', { request_id: a });
        expect(cancelled.json).toMatchObject({ state: 'cancelled' });
        await runMemoryProposalUpkeep(engine);
        expect((await proposalRow(b))!).toMatchObject({ state: 'failed', error_code: 'actor_not_attested' });
        expect((await receipt(bob, b)).json).toMatchObject({ state: 'failed', write_error: 'actor_not_attested' });
      } finally { await bindCredential(engine, { kind: 'client', id: qmClient }, { attestActor: 'qm', attestOps: ATTEST_OPS }); }
    }, 60_000);

    test('race: approve, deny, cancel and the upkeep pass on one proposal end in exactly one outcome and at most one write', async () => {
      const id = (await timeline(bob, 'Race canaryrace')).structured!.request_id as string;
      const results = await Promise.allSettled([
        approve(id), denyMemoryProposal(owner(), id, 'race', { decidedBy: 'cli:test' }), call(bob, 'cancel_write_request', { request_id: id }), runMemoryProposalUpkeep(engine),
      ]);
      const row = (await proposalRow(id))!;
      expect(['approved', 'denied', 'cancelled']).toContain(row.state);
      expect((await journalRows(id)).length).toBe(row.state === 'approved' ? 1 : 0);
      expect((await timelineRows('canaryrace')).length).toBeLessThanOrEqual(1);
      expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThan(0);
    }, 90_000);

    test('fresh admission: the approved write gets a sequence admitted at approval, after every write since the proposal', async () => {
      const id = (await timeline(bob, 'Fresh canaryfresh')).structured!.request_id as string;
      await call(bob, 'memory_write', { facts: [{ fact: 'Bob noted a later fact canaryfreshfact', provenance: 'turn 2' }], idempotency_key: randomUUID() }, { writeWaitMs: 30_000 });
      const [{ max }] = await engine.executeRaw<{ max: string }>('SELECT max(sequence)::text AS max FROM persistence_requests');
      await approve(id);
      const [row] = await journalRows(id);
      expect(BigInt(row!.sequence)).toBeGreaterThan(BigInt(max));
      expect(row!.authority.attestedOp).toBe('memory_propose');
    }, 90_000);

    test('list_write_requests shows an approved proposal to a client whose allowed operations name memory_propose, not add_timeline_entry', async () => {
      await engine.executeRaw('UPDATE oauth_clients SET allowed_operations = $2 WHERE client_id = $1',
        [qmClient, ['cancel_write_request', 'get_write_request', 'list_write_requests', 'memory_propose', 'memory_recall', 'memory_write']]);
      try {
        const id = (await timeline(bob, 'Narrow grant canarynarrow')).structured!.request_id as string;
        await approve(id);
        const list = await call(bob, 'list_write_requests', { source_id: SRC, limit: 100 });
        expect(list.isError).toBe(false);
        expect(list.json.requests.map((r: { request_id: string }) => r.request_id)).toContain(id);
      } finally { await engine.executeRaw('UPDATE oauth_clients SET allowed_operations = NULL WHERE client_id = $1', [qmClient]); }
    }, 90_000);

    test('unapproved text never reaches recall, search or an export; doctor and status count the pending proposals', async () => {
      const id = (await timeline(bob, 'Held secret canaryneverout')).structured!.request_id as string;
      const recall = await call(bob, 'memory_recall', { query: 'canaryneverout held secret' });
      expect(recall.all).not.toContain('canaryneverout');
      const search = await call(bob, 'search', { query: 'canaryneverout' });
      expect(search.all).not.toContain('canaryneverout');
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-propose-export-'));
      try {
        const { runExport } = await import('../src/commands/export.ts');
        const log = console.log; console.log = () => {};
        try { await runExport(engine, ['--dir', dir, '--source', SRC]); } finally { console.log = log; }
        const walk = (d: string): string[] => readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
        const files = walk(dir);
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) expect(readFileSync(f, 'utf-8')).not.toContain('canaryneverout');
      } finally { rmSync(dir, { recursive: true, force: true }); }
      const summary = await pendingProposalSummary(engine);
      expect(summary.pending).toBeGreaterThanOrEqual(1);
      const { runMemoryProposalsDoctor } = await import('../src/commands/doctor/checks/memory-proposals.ts');
      const [check] = await runMemoryProposalsDoctor({ engine } as never);
      expect(check).toMatchObject({ name: 'memory_proposals_pending', status: 'warn' });
      expect(String(check!.message)).toContain('gbrain memory-proposals list');
      const { runStatus } = await import('../src/commands/status.ts');
      let human = '';
      const status = await runStatus(engine, [], { stdout: (s) => { human += s; }, stderr: () => {} });
      expect(status.report!.memory_proposals).toMatchObject({ pending: summary.pending });
      expect(human).toContain(`Memory proposals: ${summary.pending} awaiting the owner`);
      expect(human).toContain('review: gbrain memory-proposals list');
      expect(human).not.toContain('canaryneverout');
      await call(bob, 'cancel_write_request', { request_id: id });
      let after = '';
      await runStatus(engine, [], { stdout: (s) => { after += s; }, stderr: () => {} });
      if ((await pendingProposalSummary(engine)).pending === 0) expect(after).not.toContain('Memory proposals:');
    }, 90_000);

    test('retention: every closed row is purged after proposals.retention_days; awaiting rows stay', async () => {
      const held = (await timeline(bob, 'Stays canarypurge')).structured!.request_id as string;
      const closed = (await timeline(bob, 'Purged canarypurge')).structured!.request_id as string;
      await denyMemoryProposal(owner(), closed, 'no', { decidedBy: 'cli:test' });
      await engine.executeRaw("UPDATE memory_proposals SET decided_at = now() - interval '29 days' WHERE request_id = $1::uuid", [closed]);
      await runMemoryProposalUpkeep(engine);
      expect(await proposalRow(closed)).toBeDefined();
      await engine.executeRaw("UPDATE memory_proposals SET decided_at = now() - interval '31 days' WHERE request_id = $1::uuid", [closed]);
      const pass = await runMemoryProposalUpkeep(engine);
      expect(pass.purged).toBeGreaterThanOrEqual(1);
      expect(await proposalRow(closed)).toBeUndefined();
      expect((await proposalRow(held))!.state).toBe('awaiting_owner');
      const purged = await receipt(bob, closed);
      expect(purged.json.code).toBe('not_found');
      await call(bob, 'cancel_write_request', { request_id: held });
    }, 60_000);

    test('owner command: list and show fence the proposed text, approve takes one id, deny needs --reason', async () => {
      const id = (await timeline(bob, 'Owner view canaryownerview')).structured!.request_id as string;
      const { runMemoryProposals } = await import('../src/commands/memory-proposals.ts');
      const lines: string[] = [];
      const log = console.log, err = console.error;
      console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
      console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
      try {
        await runMemoryProposals(engine, ['list', '--json']);
        const listed = JSON.parse(lines.join('\n'));
        const mine = listed.proposals.find((p: { request_id: string }) => p.request_id === id);
        expect(mine.payload.summary).toContain('canaryownerview');
        expect(mine.payload.summary).not.toBe('Owner view canaryownerview');
        expect(mine.quoted).toBe('transcript');
        lines.length = 0;
        await runMemoryProposals(engine, ['deny', id]);
        expect(lines.join('\n')).toContain('--reason');
        expect(currentExitCode()).toBe(2);
        setCliExitVerdict(0);
        expect((await proposalRow(id))!.state).toBe('awaiting_owner');
        lines.length = 0;
        await runMemoryProposals(engine, ['approve', id, '--dry-run']);
        expect((await proposalRow(id))!.state).toBe('awaiting_owner');
        lines.length = 0;
        await runMemoryProposals(engine, ['deny', id, '--reason', 'Not now']);
        expect((await proposalRow(id))!).toMatchObject({ state: 'denied', reason: 'Not now' });
        expect(String((await proposalRow(id))!.decided_by)).toMatch(/^cli/);
        expect(currentExitCode()).toBe(0);
      } finally { console.log = log; console.error = err; setCliExitVerdict(0); }
    }, 60_000);

    test('source removal cascades; the table is classified for deletion; journal state lists stay as they were', async () => {
      expect(DELETION_INVENTORY_BY_TABLE.get('memory_proposals')).toMatchObject({ class: 'out_of_scope', reason: 'probed_reported', probe: ['payload', 'reason'] });
      expect([...WRITE_REQUEST_STATES]).toEqual(['queued', 'running', 'recovering', 'committed', 'conflict', 'failed', 'cancelled']);
      expect([...PROPOSAL_STATES]).toEqual(['awaiting_owner', 'approved', 'denied', 'expired', 'cancelled', 'failed', 'conflict']);
      const held = (await timeline(alice, 'Cascade held canarycascade')).structured!.request_id as string;
      const closed = (await timeline(bob, 'Cascade closed canarycascade')).structured!.request_id as string;
      await denyMemoryProposal(owner(), closed, 'no', { decidedBy: 'cli:test' });
      expect((await proposalRow(held))!.state).toBe('awaiting_owner');
      expect((await proposalRow(closed))!.state).toBe('denied');
      const n = Number((await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM memory_proposals WHERE source_id = $1', [SRC]))[0]!.n);
      expect(n).toBeGreaterThan(0);
      const listed = await listMemoryProposals(engine, { all: true, limit: 500 });
      expect(listed.length).toBeGreaterThan(0);
      await engine.executeRaw('DELETE FROM oauth_clients WHERE source_id = $1', [SRC]);
      expect(await deleteSourceRow(engine, SRC)).toBe(true);
      expect(Number((await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM memory_proposals WHERE source_id = $1', [SRC]))[0]!.n)).toBe(0);
      expect(await proposalRow(held)).toBeUndefined();
      expect(await proposalRow(closed)).toBeUndefined();
    }, 60_000);
  });
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe('memory_propose (' + backend + ', managed git brain)', () => {
    test('held text never reaches git; an approved timeline entry and link land in the page file and a commit, a denied one never does', () => managedBrain(async ({ engine, ctx, root }) => {
      __resetPrivateVisibilityCacheForTests();
      const put = (slug: string, title: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: pageText(title) } });
      await put(ACME, 'Acme Example');
      await put(GLOBEX, 'Globex Example');
      await settleManagedGitEffects(engine);
      await addMember(engine, 'alice-example');
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const c = await provider.registerClientManual('p-qm-git-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], 'default');
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      const token = (await provider.exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      const propose = async (params: Record<string, unknown>) => {
        const out = await dispatchToolCall(engine, 'memory_propose', { idempotency_key: randomUUID(), ...params }, {
          remote: true, transport: 'http', auth: await provider.verifyAccessToken(token) as unknown as AuthInfo, sourceId: 'default', actor: { header: ALICE_ID } });
        expect(out.isError).not.toBe(true);
        return (out.structuredContent as Record<string, any>).request_id as string;
      };
      const history = () => git(root, 'log', '-p', '--all') + git(root, 'status', '--porcelain') + readFileSync(join(root, ACME + '.md'), 'utf8') + readFileSync(join(root, GLOBEX + '.md'), 'utf8');
      const owner = { ...ctx, config: { ...ctx.config } } as OperationContext;
      const t = await propose({ kind: 'timeline', target: ACME, date: '2026-10-30', summary: 'Signed canarygitheld', source: 'slack:C0123/p1' });
      const l = await propose({ kind: 'link', target: GLOBEX, to: ACME, context: 'supplier canarylinkheld' });
      const d = await propose({ kind: 'timeline', target: ACME, date: '2026-10-31', summary: 'Rumor canarygitdenied' });
      await settleManagedGitEffects(engine);
      for (const needle of ['canarygitheld', 'canarylinkheld', 'canarygitdenied']) expect(history()).not.toContain(needle);
      expect(await approveMemoryProposal(owner, t, { decidedBy: 'cli:test', waitMs: 30_000 })).toMatchObject({ status: 'approved', write_request: { state: 'committed' } });
      expect(await approveMemoryProposal(owner, l, { decidedBy: 'cli:test', waitMs: 30_000 })).toMatchObject({ status: 'approved', write_request: { state: 'committed' } });
      await denyMemoryProposal(owner, d, 'Not confirmed', { decidedBy: 'cli:test' });
      await settleManagedGitEffects(engine);
      const file = readFileSync(join(root, ACME + '.md'), 'utf8');
      expect(file).toContain('canarygitheld');
      expect(readFileSync(join(root, GLOBEX + '.md'), 'utf8')).toContain(ACME);
      expect(git(root, 'log', '-p', '--all')).toContain('canarygitheld');
      expect(git(root, 'log', '-p', '--all')).toContain('canarylinkheld');
      expect(git(root, 'status', '--porcelain', '--', ACME + '.md').trim()).toBe('');
      expect(history()).not.toContain('canarygitdenied');
      expect(history()).not.toContain(ALICE_ID);
    }, { databaseUrl, setup: ({ root }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); } }), 120_000);
  });
}

describe('memory_propose limits', () => {
  test('every proposals.* limit is a registered config key, so the operator can tune it without --force', () => {
    for (const spec of Object.values(PROPOSAL_LIMIT_KEYS)) expect(KNOWN_CONFIG_KEYS).toContain(spec.key);
  });
});
