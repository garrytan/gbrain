/**
 * GST-3824 (agent platform L2): the action ledger and budget reservations.
 *
 * 1. Protects: an action is logged only through log_action (remote put_page onto an action page is refused); its
 *    frontmatter is validated strictly; the actor is stamped by gbrain; an amount needs readable evidence or
 *    estimated: true; a replay with the same request_id names the same action; a done action is never edited;
 *    totals split evidenced, user_confirmed and estimated, never total minutes_saved and skip superseded actions;
 *    a member reads only its own actions and a guest none; two concurrent reserves at a budget boundary cannot
 *    both be allowed; an expired hold counts toward nothing; a partial scan returns no totals.
 * 2. Fails when: any of those leaks, double counts, or lets an agent label its own amount confirmed.
 * 3. Real seams: PGLite and Postgres engines, MCP dispatchToolCall with remote=true, the real page write path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { applyPolicyChange } from '../src/core/policy/store.ts';
import { checkPolicy } from '../src/core/policy/check.ts';
import { evaluatePolicy } from '../src/core/policy/evaluate.ts';
import { parsePolicyFence, renderPolicyFence, type PolicyRule } from '../src/core/policy/fence.ts';
import type { TerminalProbe } from '../src/core/policy/authority.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { actionSlug, validateActionFrontmatter } from '../src/core/ledger/action.ts';
import { HOLD_TTL_MS, MAX_SINCE_DAYS, confirmAction, ledgerReader, ledgerReport, logAction, parseSince, policyReserve, usageLookup } from '../src/core/ledger/store.ts';
import { ledgerTotals, renderDigest, windowStart, type StoredAction } from '../src/core/ledger/totals.ts';
import { runLedger } from '../src/commands/ledger.ts';
import { ruleFromArgs } from '../src/commands/policy.ts';
import { caught } from './helpers/agent-envelope.ts';
import { withEnv } from './helpers/with-env.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const owner: TerminalProbe = { env: {}, stdinIsTTY: true, stderrIsTTY: true, readAnswer: async (p: string) => /Type ([0-9a-f]{8})/.exec(p)?.[1] ?? null };
const REMOTE = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
const ctxFor = (engine: BrainEngine, remote: boolean) => ({ engine, config: { engine: 'pglite' }, remote, dryRun: false, sourceId: 'default',
  logger: { info: () => {}, warn: () => {}, error: () => {} } }) as unknown as OperationContext;
const ALICE = { identity: ['member:alice-example'], audience: ['member:alice-example'], audienceIdentities: [['member:alice-example']] };
const BOB = { identity: ['member:bob-example'], audience: ['member:bob-example'], audienceIdentities: [['member:bob-example']] };
const GUEST = { identity: [], audience: ['guest'], audienceIdentities: [[]] };
const body = (out: { content: Array<{ text?: unknown }> }) => JSON.parse(out.content[0]!.text as string);

for (const kind of testBackends()) describe(`action ledger (L2, ${kind}, repo-less, keyless)`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | null = null;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    await submitPageMutation(ctxFor(engine, false), { operation: 'put_page', params: { slug: 'inbox/acme-example-receipt', content: '---\ntitle: Receipt\n---\n\nOrder total 40.00 USD\n' } });
  }, 60_000);
  afterAll(async () => { if (close) await close(); else if (engine) await engine.disconnect(); }, 60_000);
  beforeEach(() => _resetCliExitVerdictForTests());
  afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });

  test('log_action over MCP: stamps the actor, computes claim_basis, and a replay names the same action', async () => {
    const request_id = randomUUID();
    const args = { verb: 'spend', purpose: 'buy', summary: 'Bought printer ink', counterparty: 'acme-example', spent: 40, currency: 'USD', evidence: [{ ref: 'inbox/acme-example-receipt' }], request_id };
    const first = body(await dispatchToolCall(engine, 'log_action', args, REMOTE));
    expect(first.claim_basis).toBe('evidenced');
    expect(first.evidence).toEqual([{ ref: 'inbox/acme-example-receipt', resolved: true }]);
    const again = body(await dispatchToolCall(engine, 'log_action', args, REMOTE));
    expect(again.action_id).toBe(first.action_id);
    expect(again.replayed).toBe(true);
    const page = await engine.getPage(first.action_id, { sourceId: 'default' });
    expect(page!.type).toBe('agent_action');
    expect(page!.frontmatter.visibility).toBe('private');
    expect((page!.frontmatter.action as Record<string, unknown>).actor).not.toBe('');
    expect(page!.frontmatter.claim_basis).toBe('evidenced');
  });

  test('a retry while the first write is still pending answers write_pending, never a second, different write', async () => {
    const ctx = ctxFor(engine, false);
    const request_id = randomUUID();
    const input = { verb: 'book' as const, summary: 'Booked a court', estimated: true, request_id };
    const first = await logAction(ctx, input);
    await engine.executeRaw("UPDATE persistence_requests SET state='running' WHERE slug=$1", [first.action_id]);
    const pending = await caught(() => logAction(ctx, input));
    expect((pending as { code: string }).code).toBe('write_pending');
    await engine.executeRaw("UPDATE persistence_requests SET state='committed' WHERE slug=$1", [first.action_id]);
    expect(await logAction(ctx, input)).toMatchObject({ action_id: first.action_id, replayed: true });
  });

  test('an amount with no readable evidence and no estimated: true is refused (money_unevidenced); a URL is not evidence', async () => {
    const out = await dispatchToolCall(engine, 'log_action', { verb: 'spend', summary: 'Paid a bill', spent: 12, currency: 'USD', evidence: [{ ref: 'https://example.com/receipt' }], request_id: randomUUID() }, REMOTE);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toContain('money_unevidenced');
    const estimated = body(await dispatchToolCall(engine, 'log_action', { verb: 'spend', summary: 'Paid a bill', spent: 12, currency: 'USD', estimated: true, request_id: randomUUID() }, REMOTE));
    expect(estimated.claim_basis).toBe('estimated');
  });

  test('remote callers cannot write action pages directly; local writes are validated strictly', async () => {
    const slug = actionSlug(new Date(), 'agent', randomUUID());
    const fm = { type: 'agent_action', action: { verb: 'send', status: 'done', at: new Date().toISOString(), summary: 'x', actor: 'owner' }, evidence: [], approval: { by: 'owner' }, claim_basis: 'user_confirmed' };
    const content = `---\n${JSON.stringify(fm)}\n---\n\nx\n`;
    const remote = await dispatchToolCall(engine, 'put_page', { slug, content }, REMOTE);
    expect(remote.isError).toBe(true);
    expect(JSON.stringify(remote.content)).toContain('ledger_log_action_only');
    const retyped = await dispatchToolCall(engine, 'put_page', { slug: 'notes/not-an-action', content }, REMOTE);
    expect(retyped.isError).toBe(true);
    expect(JSON.stringify(retyped.content)).toContain('ledger_log_action_only');
    const bad = await caught(() => submitPageMutation(ctxFor(engine, false), { operation: 'put_page', params: { slug, content: content.replace('"claim_basis"', '"surprise":1,"claim_basis"') } }));
    expect((bad as { code: string }).code).toBe('action_invalid');
    expect(validateActionFrontmatter({ ...fm, money: { currency: 'USD', spent: 1, tip: 2 } })).toMatchObject({ ok: false, field: 'money.tip' });
  });

  test('a done action is never edited; it can be reversed, and a correction supersedes it', async () => {
    const ctx = ctxFor(engine, false);
    const a = await logAction(ctx, { verb: 'cancel', summary: 'Cancelled a trial', saved: 10, saved_period: 'monthly', currency: 'USD', estimated: true, counterparty: 'trial-example' });
    const edit = await caught(() => logAction(ctx, { verb: 'cancel', action_id: a.action_id, status: 'done', saved: 99, saved_period: 'monthly', currency: 'USD', estimated: true }));
    expect((edit as { code: string }).code).toBe('action_transition_invalid');
    const fixed = await logAction(ctx, { verb: 'cancel', summary: 'Cancelled a trial (corrected)', saved: 12, saved_period: 'monthly', currency: 'USD', estimated: true, counterparty: 'trial-example', supersedes: a.action_id });
    const report = await ledgerReport(engine, ledgerReader(false), { since: new Date(Date.now() - 3600_000), until: new Date(Date.now() + 1000), counterparty: 'trial-example' });
    expect(report.state).toBe('complete');
    if (report.state !== 'complete') return;
    expect(report.totals.saved.monthly.estimated).toEqual({ USD: 12 });
    const reversed = await logAction(ctx, { verb: 'cancel', action_id: fixed.action_id, status: 'reversed' });
    expect(reversed.status).toBe('reversed');
  });

  test('totals split by claim basis, user_confirmed only through gbrain ledger confirm, minutes_saved never totalled', async () => {
    const ctx = ctxFor(engine, false);
    const a = await logAction(ctx, { verb: 'dispute', summary: 'Disputed a duplicate charge', saved: 25, saved_period: 'one_time', currency: 'EUR', estimated: true, minutes_saved: 30, counterparty: 'bank-example' });
    await confirmAction(ctx, a.action_id);
    const report = await ledgerReport(engine, ledgerReader(false), { since: new Date(Date.now() - 3600_000), until: new Date(Date.now() + 1000), counterparty: 'bank-example' });
    if (report.state !== 'complete') throw new Error('partial');
    expect(report.totals.saved.one_time.user_confirmed).toEqual({ EUR: 25 });
    expect(JSON.stringify(report.totals)).not.toContain('minutes');
    const b = await logAction(ctx, { verb: 'dispute', summary: 'Disputed a late fee', saved: 5, saved_period: 'one_time', currency: 'EUR', estimated: true });
    await withEnv({ CLAUDECODE: '1' }, () => runLedger(engine, ['confirm', b.action_id]));
    expect(currentExitCode()).not.toBe(0);
    expect((await engine.getPage(b.action_id, { sourceId: 'default' }))!.frontmatter.claim_basis).toBe('estimated');
  });

  test('a member reads only its own actions; a guest reads none', async () => {
    const remote = ctxFor(engine, true);
    const owned = await logAction(ctxFor(engine, false), { verb: 'spend', summary: 'Paid the rent', counterparty: 'bank-example', spent: 900, currency: 'USD', estimated: true });
    expect((await engine.getPage(owned.action_id, { sourceId: 'default' }))!.frontmatter.readable_by).toBeUndefined();
    const mine = await withCallerAccess(ALICE, () => logAction(remote, { verb: 'book', summary: 'Booked a table', counterparty: 'bistro-example', spent: 30, currency: 'USD', estimated: true }));
    const page = await engine.getPage(mine.action_id, { sourceId: 'default' });
    expect(page!.frontmatter.readable_by).toContain('alice-example');
    const since = new Date(Date.now() - 3600_000); const until = new Date(Date.now() + 1000);
    const alice = await withCallerAccess(ALICE, () => ledgerReport(engine, ledgerReader(true), { since, until }));
    const bob = await withCallerAccess(BOB, () => ledgerReport(engine, ledgerReader(true), { since, until }));
    const guest = await withCallerAccess(GUEST, () => ledgerReport(engine, ledgerReader(true), { since, until }));
    if (alice.state !== 'complete' || bob.state !== 'complete' || guest.state !== 'complete') throw new Error('partial');
    expect(alice.scope).toBe('yours');
    expect(alice.totals.actions).toBe(1);
    expect(bob.totals.actions).toBe(0);
    expect(guest.scope).toBe('none');
    expect(guest.totals.actions).toBe(0);
    const steal = await caught(() => withCallerAccess(BOB, () => logAction(remote, { verb: 'book', action_id: mine.action_id, status: 'reversed' })));
    expect((steal as { code: string }).code).toBe('action_not_found');
  });

  test('a member cannot supersede, and so hide, an action it did not log', async () => {
    const owned = await logAction(ctxFor(engine, false), { verb: 'spend', summary: 'Paid the rent', counterparty: 'bank-example', spent: 900, currency: 'USD', estimated: true });
    const hide = await caught(() => withCallerAccess(ALICE, () => logAction(ctxFor(engine, true), { verb: 'spend', summary: 'Nothing', spent: 0, currency: 'USD', estimated: true, supersedes: owned.action_id })));
    expect((hide as { code: string }).code).toBe('action_not_found');
    const own = await withCallerAccess(ALICE, () => logAction(ctxFor(engine, true), { verb: 'spend', summary: 'Lunch', spent: 12, currency: 'USD', estimated: true }));
    const fixed = await withCallerAccess(ALICE, () => logAction(ctxFor(engine, true), { verb: 'spend', summary: 'Lunch, corrected', spent: 10, currency: 'USD', estimated: true, supersedes: own.action_id }));
    expect(fixed.status).toBe('done');
  });

  test('a caller that reads no actions gets ask on a budget, never allow', async () => {
    await applyPolicyChange(engine, { scope: 'owner', rules: [{ id: 'coffee-day', verb: 'spend', decision: 'allow', limit: { amount: 50, currency: 'USD' }, window: 'day' }], change: 'test budget', probe: owner });
    const answer = await withCallerAccess(GUEST, () => checkPolicy(engine, { verb: 'spend', amount: { amount: 5, currency: 'USD' } }, ['owner'], { usage: usageLookup(engine, ledgerReader(true), new Date()) }));
    expect(answer.decision).toBe('ask');
  });

  test('a connection that cannot read the default source reads no actions and no budget usage', async () => {
    const scoped = { ...ctxFor(engine, true), sourceId: 'source-a', auth: { sourceId: 'source-a', allowedSources: ['source-a'] } } as unknown as OperationContext;
    expect(withCallerAccess(ALICE, () => ledgerReader(true, scoped))).toEqual({ kind: 'none' });
    const federated = { ...ctxFor(engine, true), sourceId: 'source-a', auth: { sourceId: 'source-a', allowedSources: ['source-a', 'default'] } } as unknown as OperationContext;
    expect(withCallerAccess(ALICE, () => ledgerReader(true, federated)).kind).toBe('member');
    const out = body(await dispatchToolCall(engine, 'ledger', { since: '30d' }, { ...REMOTE, sourceId: 'source-a', auth: { sourceId: 'source-a', allowedSources: ['source-a'] } } as never));
    expect(out.scope).toBe('none');
    expect(out.totals.actions).toBe(0);
  });

  test('a connection whose write grant is another source records nothing', async () => {
    const elsewhere = { ...ctxFor(engine, true), auth: { sourceId: 'source-a' } } as unknown as OperationContext;
    const before = (await engine.listPages({ type: 'agent_action' as never, sourceId: 'default' })).length;
    const logged = await caught(() => withCallerAccess(ALICE, () => logAction(elsewhere, { verb: 'book', summary: 'Booked a table', spent: 30, currency: 'USD', estimated: true })));
    expect((logged as { code: string }).code).toBe('permission_denied');
    const reserved = await caught(() => withCallerAccess(ALICE, () => policyReserve(elsewhere, { verb: 'spend', amount: { amount: 5, currency: 'USD' }, summary: 'Coffee' })));
    expect((reserved as { code: string }).code).toBe('permission_denied');
    expect((await engine.listPages({ type: 'agent_action' as never, sourceId: 'default' })).length).toBe(before);
  });

  test('budgets: two concurrent reserves at the boundary cannot both be allowed; a settled hold counts its spend', async () => {
    const rules: PolicyRule[] = [
      { id: 'groceries-week', verb: 'spend', decision: 'allow', limit: { amount: 50, currency: 'USD' }, window: 'week', merchant: 'grocer-example' },
      { id: 'spend', verb: 'spend', decision: 'ask' },
    ];
    await applyPolicyChange(engine, { scope: 'owner', rules, change: 'test budget', probe: owner });
    const ctx = ctxFor(engine, false);
    const reserve = () => policyReserve(ctx, { verb: 'spend', amount: { amount: 30, currency: 'USD' }, merchant: 'grocer-example', summary: 'Weekly groceries' });
    const [x, y] = await Promise.all([reserve(), reserve()]);
    expect([x.decision, y.decision].sort()).toEqual(['allow', 'ask']);
    expect(x.reservation && y.reservation).toBeTruthy();
    const allowed = x.decision === 'allow' ? x : y;
    expect(allowed.budgets?.[0]).toMatchObject({ rule_id: 'groceries-week', window: 'week', spent: 0, held: 0, left: 50 });
    const check = await checkPolicy(engine, { verb: 'spend', amount: { amount: 10, currency: 'USD' }, merchant: 'grocer-example' }, ['owner'], { usage: usageLookup(engine, ledgerReader(false), new Date()) });
    expect(check.budgets?.[0]).toMatchObject({ held: 60, left: 0 });
    expect(check.requires_approval).toBe(true);
    const settled = await logAction(ctx, { verb: 'spend', action_id: allowed.reservation!.action_id, status: 'done', spent: 28, currency: 'USD', estimated: true });
    expect(settled.settled_hold).toBe(true);
    const after = await checkPolicy(engine, { verb: 'spend', amount: { amount: 10, currency: 'USD' }, merchant: 'grocer-example' }, ['owner'], { usage: usageLookup(engine, ledgerReader(false), new Date()) });
    expect(after.budgets?.[0]).toMatchObject({ spent: 28, held: 30 });
    for (const status of ['cancelled', 'failed'] as const) {
      const r = await policyReserve(ctx, { verb: 'spend', amount: { amount: 5, currency: 'USD' }, merchant: 'grocer-example', summary: 'Bread' });
      const released = await logAction(ctx, { verb: 'spend', action_id: r.reservation!.action_id, status });
      expect(released.settled_hold).toBe(true);
    }
    const bare = await policyReserve(ctx, { verb: 'spend', amount: { amount: 7, currency: 'USD' }, merchant: 'grocer-example', summary: 'Eggs' });
    const bareSettle = await logAction(ctx, { verb: 'spend', action_id: bare.reservation!.action_id, status: 'done' });
    expect(bareSettle).toMatchObject({ settled_hold: true, claim_basis: 'estimated' });
    const barePage = await engine.getPage(bare.reservation!.action_id, { sourceId: 'default' });
    expect(barePage!.frontmatter.money).toEqual({ currency: 'USD', spent: 7, estimated: true });
    const released = await checkPolicy(engine, { verb: 'spend', amount: { amount: 10, currency: 'USD' }, merchant: 'grocer-example' }, ['owner'], { usage: usageLookup(engine, ledgerReader(false), new Date()) });
    expect(released.budgets?.[0]).toMatchObject({ spent: 35, held: 30 });
  });

  test('a reserve retry returns the same reservation even when its own hold fills the budget; settling with its request_id is refused', async () => {
    await applyPolicyChange(engine, { scope: 'owner', rules: [{ id: 'books-day', verb: 'spend', decision: 'allow', limit: { amount: 50, currency: 'USD' }, window: 'day', merchant: 'bookshop-example' }, { id: 'spend', verb: 'spend', decision: 'deny' }], change: 'test budget', probe: owner });
    const ctx = ctxFor(engine, false);
    const rid = randomUUID();
    const input = { verb: 'spend' as const, amount: { amount: 40, currency: 'USD' }, merchant: 'bookshop-example', summary: 'A book', request_id: rid };
    const first = await policyReserve(ctx, input);
    expect(first.decision).toBe('allow');
    const again = await policyReserve(ctx, input);
    expect(again).toMatchObject({ decision: 'allow', replayed: true, reservation: { action_id: first.reservation!.action_id } });
    const misuse = await caught(() => logAction(ctx, { verb: 'spend', action_id: first.reservation!.action_id, status: 'done', spent: 40, currency: 'USD', estimated: true, request_id: rid }));
    expect((misuse as { code: string }).code).toBe('idempotency_conflict');
    const settled = await logAction(ctx, { verb: 'spend', action_id: first.reservation!.action_id, status: 'done', spent: 40, currency: 'USD', estimated: true });
    expect(settled.settled_hold).toBe(true);
    await applyPolicyChange(engine, { scope: 'owner', rules: [{ id: 'spend', verb: 'spend', decision: 'ask' }], change: 'restore', probe: owner });
  });

  test('policy_reserve over MCP returns the decision, requires_approval and a reservation that log_action settles', async () => {
    const out = body(await dispatchToolCall(engine, 'policy_reserve', { verb: 'spend', amount: 4, currency: 'USD', merchant: 'grocer-example', summary: 'Milk', request_id: randomUUID() }, REMOTE));
    expect(out.requires_approval).toBe(true);
    expect(out.reservation.action_id).toMatch(/^actions\/\d{4}\/\d{2}\//);
    const settled = body(await dispatchToolCall(engine, 'log_action', { verb: 'spend', action_id: out.reservation.action_id, status: 'done', spent: 4, currency: 'USD', estimated: true }, REMOTE));
    expect(settled.settled_hold).toBe(true);
    const bad = await dispatchToolCall(engine, 'policy_reserve', { verb: 'spend', amount: 4, summary: 'No currency' }, REMOTE);
    expect(bad.isError).toBe(true);
  });

  test('an expired hold counts toward nothing and is listed in the digest as unconfirmed; a deny holds nothing', async () => {
    const past = new Date(Date.now() - HOLD_TTL_MS - 60_000);
    const ctx = ctxFor(engine, false);
    await policyReserve(ctx, { verb: 'renew', amount: { amount: 5, currency: 'GBP' }, summary: 'Renew a domain' }, past);
    const report = await ledgerReport(engine, ledgerReader(false), { since: new Date(past.getTime() - 1000), until: new Date(Date.now() + 1000), verb: 'renew' });
    if (report.state !== 'complete') throw new Error('partial');
    expect(report.totals.holds).toMatchObject({ live: 0, expired_unconfirmed: 1 });
    await applyPolicyChange(engine, { scope: 'owner', rules: [{ id: 'no-delete', verb: 'delete', decision: 'deny' }], change: 'deny delete', probe: owner });
    const denied = await policyReserve(ctx, { verb: 'delete', amount: { amount: 1, currency: 'USD' }, summary: 'Delete an account' });
    expect(denied).toMatchObject({ decision: 'deny', reservation: null });
  });

  test('a read past the scan bound returns state partial with no totals and the narrower call', async () => {
    const report = await ledgerReport(engine, ledgerReader(false), { since: new Date(Date.now() - 86_400_000), until: new Date(Date.now() + 1000), max: 2 });
    expect(report.state).toBe('partial');
    if (report.state !== 'partial') return;
    expect(report.totals).toBeNull();
    expect(report.code).toBe('ledger_scan_too_large');
    expect(report.fix.argv).toContain('--since');
  });
});

describe('budget windows', () => {
  test('policy fences accept day, week and month budgets; gbrain policy builds them with distinct ids', () => {
    const rule = ruleFromArgs('allow', ['spend', '--amount', '100USD', '--window', 'month']);
    expect(rule).toMatchObject({ id: 'spend-upto-100usd-per-month', window: 'month', limit: { amount: 100, currency: 'USD' } });
    expect(parsePolicyFence(renderPolicyFence([rule]))).toMatchObject({ ok: true });
    expect(parsePolicyFence(renderPolicyFence([{ ...rule, window: 'year' as never }])).ok).toBe(false);
  });

  test('a budget gbrain could not read answers ask, never allow', () => {
    const rules: PolicyRule[] = [{ id: 'b', verb: 'spend', decision: 'allow', limit: { amount: 50, currency: 'USD' }, window: 'day' }];
    expect(evaluatePolicy(rules, { verb: 'spend', amount: { amount: 5, currency: 'USD' } }).decision).toBe('ask');
    expect(evaluatePolicy(rules, { verb: 'spend', amount: { amount: 5, currency: 'USD' } }, new Map([['b', { spent: 40, held: 0 }]])).decision).toBe('allow');
    expect(evaluatePolicy(rules, { verb: 'spend', amount: { amount: 15, currency: 'USD' } }, new Map([['b', { spent: 40, held: 0 }]])).decision).toBe('ask');
  });

  test('a ledger read reaches back at most MAX_SINCE_DAYS, so one call runs a bounded number of month queries', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    const earliest = now.getTime() - MAX_SINCE_DAYS * 86_400_000;
    expect(parseSince('9999d', now)!.getTime()).toBe(earliest);
    expect(parseSince('0001-01-01', now)!.getTime()).toBe(earliest);
    expect(parseSince('7d', now)!.getTime()).toBe(now.getTime() - 7 * 86_400_000);
  });

  test('weeks start Monday UTC and months on the first', () => {
    const wed = new Date('2026-11-25T15:00:00Z');
    expect(windowStart('week', wed).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(windowStart('month', wed).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(windowStart('day', wed).toISOString()).toBe('2026-11-25T00:00:00.000Z');
  });

  test('the digest is deterministic text from the same totals', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    const rows: StoredAction[] = [{ slug: 'actions/2026/11/01knzz0000000000000000000a', record: { action: { verb: 'cancel', status: 'done', at: '2026-11-24T10:00:00Z', summary: 'Cancelled a trial', actor: 'owner' },
      money: { currency: 'USD', saved: 9, saved_period: 'monthly' }, evidence: [], approval: { by: 'owner' }, claim_basis: 'estimated' } }];
    const a = renderDigest(rows, new Date('2026-11-18T12:00:00Z'), now, now);
    expect(a).toBe(renderDigest(rows, new Date('2026-11-18T12:00:00Z'), now, now));
    expect(a).toContain('Saved (monthly): with evidence none; confirmed by you none; estimated 9.00 USD.');
    expect(ledgerTotals(rows, now).saved.monthly.estimated).toEqual({ USD: 9 });
  });
});
