/**
 * GST-2407 (memory_propose test 21): the brain owner's review of memory proposals over the running server
 * (serve-http-access.ts mountAdminMemoryProposals) and the local command's exit code.
 *
 * 1. Protects: only an owner session lists, shows, approves or denies a proposal remotely; approve and deny run the
 *    command's own library path with decided_by admin-api (the command keeps cli:<writer>); a dry run changes nothing
 *    and leaves no audit row; each applied decision leaves exactly one access_admin audit row that never carries the
 *    proposed text; list and show give the proposed text only inside the transcript fence; a decision names exactly one
 *    request id; deny needs a reason; a closed proposal answers proposal_closed; a change that fails partway answers
 *    outcome unknown; an approve whose write did not commit says so (HTTP outcome failed, the command exits 1).
 * 2. Fails when: a route answers without the owner session, a preview writes or audits, an audit row is missing,
 *    duplicated or carries the proposed text, the text leaves the fence, a body names several ids, a reasonless deny
 *    lands, a failed write reads as success, or a partial failure reads as failed instead of unknown.
 * 3. Real seams: the routes mounted on an Express app over a real socket with the real requireAdmin; proposals made by
 *    an attested OAuth client-credentials token through MCP dispatch; publication through the persistence consumer;
 *    on a repo-less brain (PGLite, and Postgres when DATABASE_URL is set).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { linkMember } from '../src/core/access/actor.ts';
import * as persistenceService from '../src/core/persistence/service.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { mountAdminAccess, mountAdminMemoryProposals } from '../src/commands/serve-http-access.ts';
import { createRequireAdmin } from '../src/commands/serve-http-admin-api.ts';
import { runMemoryProposals } from '../src/commands/memory-proposals.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'source-a';
const ACME = 'companies/acme-example';
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'U0BOB';
const FENCE = String.fromCharCode(96).repeat(3);
const ATTEST_OPS = ['cancel_write_request', 'get_write_request', 'memory_propose', 'memory_recall', 'memory_write'];
const pageText = (title: string) => ['---', 'type: company', 'title: ' + title, '---', '# ' + title, '', 'Harbor ledger notes.'].join('\n');

for (const kind of testBackends()) {
  describe('owner HTTP review of memory proposals (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let server: Server;
    let base = '';
    let token = '';
    const sessions = new Map<string, number>();
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(method: 'GET' | 'POST', path: string, body?: unknown, owner = true) {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(owner ? { Cookie: 'gbrain_admin=owner-session' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text };
    }
    async function propose(actor: string, summary: string): Promise<string> {
      const out = await dispatchToolCall(engine, 'memory_propose', { idempotency_key: randomUUID(), kind: 'timeline', target: ACME, date: '2026-10-30', summary, source: 'slack:C0123/p1' }, {
        remote: true, transport: 'http', auth: await provider().verifyAccessToken(token) as unknown as AuthInfo, sourceId: SRC, takesHoldersAllowList: ['world'], actor: { header: actor } });
      expect(out.isError).not.toBe(true);
      return (out.structuredContent as Record<string, any>).request_id as string;
    }
    const proposalRow = async (id: string) => (await engine.executeRaw<Record<string, any>>('SELECT * FROM memory_proposals WHERE request_id = $1::uuid', [id]))[0]!;
    const journalRows = async (id: string) => engine.executeRaw<Record<string, any>>('SELECT state, error_code FROM persistence_requests WHERE request_id = $1::uuid', [id]);
    const audits = async () => (await engine.executeRaw<{ params: Record<string, unknown> | string }>("SELECT params FROM mcp_request_log WHERE operation = 'access_admin' ORDER BY id"))
      .map(r => typeof r.params === 'string' ? JSON.parse(r.params) : r.params) as Array<Record<string, unknown>>;
    const proposalAudits = async () => (await audits()).filter(a => String(a.action).startsWith('proposal_'));
    /** Runs inject inside the approval's own transaction (the one that admits the write), once, then restores the engine. */
    function onApprovalTransaction(inject: (tx: BrainEngine) => Promise<void>): () => void {
      const original = engine.transaction;
      const restore = () => { engine.transaction = original; };
      engine.transaction = (async (fn: (tx: BrainEngine) => Promise<unknown>) => original.call(engine, async (tx: BrainEngine) => {
        const out = await fn(tx);
        if (out && typeof out === 'object' && 'written' in out) { restore(); await inject(tx); }
        return out;
      })) as typeof engine.transaction;
      return restore;
    }
    /** Holds every proposal-closing conditional UPDATE until n of them have arrived, so concurrent decisions all pass their reads first. */
    function barrierOnClose(requestId: string, n: number): () => void {
      const original = engine.executeRaw;
      const held: Array<() => void> = [];
      let open = false;
      const release = () => { open = true; held.splice(0).forEach(go => go()); };
      const timer = setTimeout(release, 10_000);
      engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[], ...rest: unknown[]) {
        if (!open && params?.[2] === requestId && /^UPDATE memory_proposals SET state=\$4/.test(sql.trim())) {
          await new Promise<void>(go => { held.push(go); if (held.length >= n) release(); });
        }
        return (original as (...args: unknown[]) => Promise<unknown>).call(this, sql, params, ...rest);
      }) as typeof engine.executeRaw;
      return () => { clearTimeout(timer); engine.executeRaw = original; };
    }
    const unlinkInside = (externalId: string) => (tx: BrainEngine) => tx.executeRaw("DELETE FROM access_member_links WHERE system = 'qm' AND external_id = $1", [externalId]).then(() => undefined);
    async function cli(args: string[]) {
      const lines: string[] = [];
      const log = console.log, err = console.error;
      console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
      console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
      setCliExitVerdict(0);
      try { await runMemoryProposals(engine, args); return { out: lines.join('\n'), exit: currentExitCode() }; }
      finally { console.log = log; console.error = err; setCliExitVerdict(0); }
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, ACME, pageText('Acme Example'), { sourceId: SRC });
      for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
      const qm = await provider().registerClientManual('p-qm-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: qm.clientId }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      token = (await provider().exchangeClientCredentials(qm.clientId, qm.clientSecret ?? '')).access_token;
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
      sessions.set('owner-session', Date.now() + 3_600_000);
      const app = express();
      app.use(cookieParser());
      const requireAdmin = createRequireAdmin(sessions);
      mountAdminAccess(app, requireAdmin, engine);
      mountAdminMemoryProposals(app, requireAdmin, engine);
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>(r => server.once('listening', () => r()));
      base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    }, 120_000);
    afterAll(async () => {
      server?.closeAllConnections(); await new Promise<void>(r => server ? server.close(() => r()) : r());
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    });

    test('requireAdmin: every route refuses a request without the owner session and changes nothing', async () => {
      const id = await propose(ALICE_ID, 'Unauthorized canaryunauth');
      for (const [method, path, body] of [['GET', '/admin/api/memory-proposals'], ['GET', '/admin/api/memory-proposals/' + id],
        ['POST', '/admin/api/memory-proposals/' + id, { action: 'approve' }], ['POST', '/admin/api/memory-proposals/' + id, { action: 'deny', reason: 'no' }]] as const) {
        const res = await call(method, path, body, false);
        expect(res.status).toBe(401);
        expect(res.text).not.toContain('canaryunauth');
      }
      expect((await proposalRow(id)).state).toBe('awaiting_owner');
      expect(await journalRows(id)).toEqual([]);
      expect(await proposalAudits()).toEqual([]);
      await call('POST', '/admin/api/memory-proposals/' + id, { action: 'deny', reason: 'cleanup' });
    }, 60_000);

    test('list and show give the proposed text only inside the transcript fence; list pages oldest first by cursor', async () => {
      const id = await propose(BOB_ID, 'Owner view canaryhttpview');
      const shown = await call('GET', '/admin/api/memory-proposals/' + id);
      expect(shown.status).toBe(200);
      expect(shown.json).toMatchObject({ request_id: id, state: 'awaiting_owner', kind: 'timeline', target: ACME, member_id: 'bob-example', quoted: 'transcript' });
      expect(shown.json.payload.summary).toContain('canaryhttpview');
      expect(shown.json.payload.summary).not.toBe('Owner view canaryhttpview');
      expect(shown.json.payload.summary).toContain(FENCE);
      const listed = await call('GET', '/admin/api/memory-proposals?source=' + SRC);
      const mine = listed.json.proposals.find((p: { request_id: string }) => p.request_id === id);
      expect(mine).toMatchObject({ quoted: 'transcript' });
      expect(mine.payload.summary).toEqual(shown.json.payload.summary);
      expect(listed.json.next_cursor).toBeNull();
      expect((await call('GET', '/admin/api/memory-proposals?source=source-b')).json).toEqual({ proposals: [], next_cursor: null });
      expect((await call('GET', '/admin/api/memory-proposals?cursor=not-a-cursor')).json).toMatchObject({ code: 'invalid_params', outcome: 'failed' });
      expect((await call('GET', '/admin/api/memory-proposals/' + randomUUID())).json).toMatchObject({ code: 'not_found' });

      await engine.setConfig('proposals.max_pending_per_actor', '100');
      await engine.setConfig('proposals.max_pending_per_credential', '100');
      try {
        const made = [id];
        for (let i = 0; i < 51; i++) made.push(await propose(ALICE_ID, 'Paging canarypage ' + i));
        const first = await call('GET', '/admin/api/memory-proposals');
        expect(first.json.proposals).toHaveLength(50);
        expect(typeof first.json.next_cursor).toBe('string');
        const second = await call('GET', '/admin/api/memory-proposals?cursor=' + encodeURIComponent(first.json.next_cursor));
        const pages = [...first.json.proposals, ...second.json.proposals];
        const seen = pages.map((p: { request_id: string }) => p.request_id);
        expect(second.json.next_cursor).toBeNull();
        expect(new Set(seen).size).toBe(seen.length);
        expect([...seen].sort()).toEqual([...made].sort());
        const created = pages.map((p: { created_at: string }) => Date.parse(p.created_at));
        expect(created).toEqual([...created].sort((a, b) => a - b));
        for (const p of made) await call('POST', '/admin/api/memory-proposals/' + p, { action: 'deny', reason: 'paging cleanup' });
      } finally {
        await engine.executeRaw("DELETE FROM config WHERE key IN ('proposals.max_pending_per_actor', 'proposals.max_pending_per_credential')");
      }
    }, 180_000);

    test('dryRun changes nothing and writes no audit row; approve and deny apply with decided_by admin-api and exactly one audit row each, never the text', async () => {
      const before = (await proposalAudits()).length;
      const a = await propose(ALICE_ID, 'Approve me canaryhttpapprove');
      const d = await propose(BOB_ID, 'Deny me canaryhttpdeny');
      const previewApprove = await call('POST', '/admin/api/memory-proposals/' + a, { action: 'approve', dryRun: true });
      expect(previewApprove.json).toMatchObject({ applied: false, dry_run: true, would: 'approved' });
      const previewDeny = await call('POST', '/admin/api/memory-proposals/' + d, { action: 'deny', reason: 'Not now', dryRun: true });
      expect(previewDeny.json).toMatchObject({ applied: false, dry_run: true, would: 'denied' });
      for (const id of [a, d]) expect(await proposalRow(id)).toMatchObject({ state: 'awaiting_owner', decided_by: null });
      expect(await journalRows(a)).toEqual([]);
      expect((await proposalAudits()).length).toBe(before);

      const approved = await call('POST', '/admin/api/memory-proposals/' + a, { action: 'approve' });
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ applied: true, status: 'approved', request_id: a, write_request: { state: 'committed' } });
      expect(approved.json.outcome).toBeUndefined();
      expect((await proposalRow(a)).decided_by).toBe('admin-api');
      const denied = await call('POST', '/admin/api/memory-proposals/' + d, { action: 'deny', reason: 'Not confirmed' });
      expect(denied.json).toMatchObject({ applied: true, status: 'denied', reason: 'Not confirmed' });
      expect(await proposalRow(d)).toMatchObject({ state: 'denied', reason: 'Not confirmed', decided_by: 'admin-api' });

      const again = await call('POST', '/admin/api/memory-proposals/' + a, { action: 'approve' });
      expect(again.json).toMatchObject({ applied: false, status: 'approved', write_request: { state: 'committed' } });
      expect(await journalRows(a)).toHaveLength(1);
      const closed = await call('POST', '/admin/api/memory-proposals/' + d, { action: 'approve' });
      expect(closed.status).toBe(400);
      expect(closed.json).toMatchObject({ code: 'proposal_closed', outcome: 'failed' });

      expect((await proposalAudits()).slice(before)).toEqual([
        { actor: 'admin-api', action: 'proposal_approve', request_id: a, kind: 'timeline', slug: ACME, member: 'alice-example', state: 'approved' },
        { actor: 'admin-api', action: 'proposal_deny', request_id: d, kind: 'timeline', slug: ACME, member: 'bob-example', state: 'denied' },
      ]);
      const everything = JSON.stringify(await audits());
      for (const needle of ['canaryhttpapprove', 'canaryhttpdeny', 'slack:C0123', ALICE_ID, BOB_ID, 'Not confirmed']) expect(everything).not.toContain(needle);
    }, 90_000);

    test('decided_by from the command is cli:<writer>; deny needs a 1-500 character reason; one request id per decision', async () => {
      const viaCli = await propose(ALICE_ID, 'Command approve canaryclidecided');
      expect((await cli(['approve', viaCli])).exit).toBe(0);
      expect(await proposalRow(viaCli)).toMatchObject({ state: 'approved' });
      expect(String((await proposalRow(viaCli)).decided_by)).toMatch(/^cli/);

      const before = (await proposalAudits()).length;
      const id = await propose(BOB_ID, 'Reasonless canaryreason');
      const other = await propose(BOB_ID, 'Bulk canarybulk');
      expect((await call('POST', '/admin/api/memory-proposals/' + id, { action: 'deny' })).json).toMatchObject({ code: 'invalid_params', outcome: 'failed' });
      expect((await call('POST', '/admin/api/memory-proposals/' + id, { action: 'deny', reason: '   ' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/memory-proposals/' + id, { action: 'deny', reason: 'x'.repeat(501) })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/memory-proposals/' + id, { action: 'approve', reason: 'because' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/memory-proposals/' + id, { action: 'remove' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/memory-proposals/' + id, { action: 'approve', dryRun: 'yes' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/memory-proposals/' + id, { action: 'approve', request_ids: [id, other] })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/memory-proposals/' + id + ',' + other, { action: 'approve' })).json).toMatchObject({ code: 'not_found' });
      expect((await call('POST', '/admin/api/memory-proposals', { action: 'approve', request_id: id })).status).toBe(404);
      for (const p of [id, other]) expect(await proposalRow(p)).toMatchObject({ state: 'awaiting_owner', decided_by: null });
      expect(await journalRows(id)).toEqual([]);
      expect((await proposalAudits()).length).toBe(before);
      for (const p of [id, other]) await call('POST', '/admin/api/memory-proposals/' + p, { action: 'deny', reason: 'cleanup' });
    }, 90_000);

    test('an approve whose write did not commit says so: HTTP outcome failed, the command exits 1', async () => {
      await linkMember(engine, 'alice-example', 'qm', 'U0ALICE2');
      const viaCli = await propose('U0ALICE2', 'Command write fails canaryclifail');
      let restore = onApprovalTransaction(unlinkInside('U0ALICE2'));
      let ran: Awaited<ReturnType<typeof cli>>;
      try { ran = await cli(['approve', viaCli, '--json']); } finally { restore(); }
      expect((await proposalRow(viaCli)).state).toBe('approved');
      const [cliWrite] = await journalRows(viaCli);
      expect(['failed', 'conflict', 'cancelled']).toContain(cliWrite!.state);
      expect(ran.out).toContain(cliWrite!.state);
      expect(ran.exit).toBe(1);

      await linkMember(engine, 'alice-example', 'qm', 'U0ALICE3');
      const viaHttp = await propose('U0ALICE3', 'HTTP write fails canaryhttpfail');
      const before = (await proposalAudits()).length;
      restore = onApprovalTransaction(unlinkInside('U0ALICE3'));
      let res: Awaited<ReturnType<typeof call>>;
      try { res = await call('POST', '/admin/api/memory-proposals/' + viaHttp, { action: 'approve' }); } finally { restore(); }
      const [httpWrite] = await journalRows(viaHttp);
      expect(['failed', 'conflict', 'cancelled']).toContain(httpWrite!.state);
      expect(res.json).toMatchObject({ applied: true, status: 'approved', outcome: 'failed', write_request: { state: httpWrite!.state } });
      expect((await proposalAudits()).slice(before)).toEqual([
        { actor: 'admin-api', action: 'proposal_approve', request_id: viaHttp, kind: 'timeline', slug: ACME, member: 'alice-example', state: 'approved' },
      ]);
    }, 90_000);

    test('a change that fails partway answers outcome unknown, writes no audit row and leaves the proposal awaiting', async () => {
      const id = await propose(ALICE_ID, 'Partial failure canarypartial');
      const before = (await proposalAudits()).length;
      const restore = onApprovalTransaction(async () => { throw new Error('injected failure after admission'); });
      let res: Awaited<ReturnType<typeof call>>;
      try { res = await call('POST', '/admin/api/memory-proposals/' + id, { action: 'approve' }); } finally { restore(); }
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ code: 'administration_unavailable', outcome: 'unknown' });
      expect(res.text).not.toContain('injected');
      expect(await proposalRow(id)).toMatchObject({ state: 'awaiting_owner', decided_by: null });
      expect(await journalRows(id)).toEqual([]);
      expect((await proposalAudits()).length).toBe(before);
      expect((await call('POST', '/admin/api/memory-proposals/' + id, { action: 'approve' })).json).toMatchObject({ applied: true, status: 'approved' });
    }, 90_000);

    test('concurrent decisions on one proposal: exactly one is applied and audited, and both answers carry the stored decision', async () => {
      const id = await propose(BOB_ID, 'Race deny canaryracedeny');
      const before = (await proposalAudits()).length;
      let restore = barrierOnClose(id, 2);
      let answers: Array<Awaited<ReturnType<typeof call>>>;
      try {
        answers = await Promise.all([
          call('POST', '/admin/api/memory-proposals/' + id, { action: 'deny', reason: 'First reason' }),
          call('POST', '/admin/api/memory-proposals/' + id, { action: 'deny', reason: 'Second reason' }),
        ]);
      } finally { restore(); }
      const stored = await proposalRow(id);
      expect(stored.state).toBe('denied');
      expect(answers.filter(a => a.json.applied === true)).toHaveLength(1);
      for (const a of answers) expect(a.json).toMatchObject({ status: 'denied', reason: stored.reason });
      expect((await proposalAudits()).slice(before)).toEqual([
        { actor: 'admin-api', action: 'proposal_deny', request_id: id, kind: 'timeline', slug: ACME, member: 'bob-example', state: 'denied' },
      ]);

      await linkMember(engine, 'alice-example', 'qm', 'U0ALICE4');
      const refused = await propose('U0ALICE4', 'Race refused canaryracerefused');
      await engine.executeRaw("DELETE FROM access_member_links WHERE system = 'qm' AND external_id = 'U0ALICE4'");
      const mark = (await proposalAudits()).length;
      restore = barrierOnClose(refused, 2);
      try {
        answers = await Promise.all([
          call('POST', '/admin/api/memory-proposals/' + refused, { action: 'approve' }),
          call('POST', '/admin/api/memory-proposals/' + refused, { action: 'deny', reason: 'Owner said no' }),
        ]);
      } finally { restore(); }
      const after = await proposalRow(refused);
      expect(['failed', 'denied']).toContain(after.state);
      expect(answers.filter(a => a.json.applied === true)).toHaveLength(1);
      const audited = (await proposalAudits()).slice(mark);
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({ action: after.state === 'denied' ? 'proposal_deny' : 'proposal_approve', state: after.state, request_id: refused });
      for (const a of answers.filter(x => x.json.applied !== true)) expect(a.status === 400 ? a.json.code : a.json.status).toBe(a.status === 400 ? 'proposal_closed' : after.state);
    }, 90_000);

    test('a failure after the approval commits still answers applied with one audit row, and a retry writes none', async () => {
      const id = await propose(ALICE_ID, 'Post-commit failure canarypostcommit');
      const before = (await proposalAudits()).length;
      const waiting = spyOn(persistenceService, 'waitForWrite').mockImplementation(async () => { throw new Error('injected failure after commit'); });
      let res: Awaited<ReturnType<typeof call>>;
      try { res = await call('POST', '/admin/api/memory-proposals/' + id, { action: 'approve' }); } finally { waiting.mockRestore(); }
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ applied: true, status: 'approved', request_id: id, write_request: { request_id: id } });
      expect(res.text).not.toContain('injected');
      expect((await proposalRow(id))).toMatchObject({ state: 'approved', decided_by: 'admin-api' });
      expect(await journalRows(id)).toHaveLength(1);
      const retry = await call('POST', '/admin/api/memory-proposals/' + id, { action: 'approve' });
      expect(retry.json).toMatchObject({ applied: false, status: 'approved' });
      expect((await proposalAudits()).slice(before)).toEqual([
        { actor: 'admin-api', action: 'proposal_approve', request_id: id, kind: 'timeline', slug: ACME, member: 'alice-example', state: 'approved' },
      ]);
    }, 90_000);
  });
}
