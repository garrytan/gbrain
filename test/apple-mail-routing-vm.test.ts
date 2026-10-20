/**
 * The REAL scripts/apple/mail.js routing/mailbox-selection protocol in a synthetic vm Mail.app. These are hermetic: no
 * macOS, no Apple app, no private data. The fake Mail account traps EVERY getter outside id/serverName/accountType/enabled.
 * Tests cover documented Google-only, mixed, disabled, malformed metadata, role ambiguity, unified Inbox/Sent exclusion,
 * per-account mailbox deduplication and provider changes under the same stable id.
 */
import { describe, expect, test } from 'bun:test';
import { buildMailRouting } from '../src/core/apple/mail-routing.ts';
import { FORBIDDEN_ACCOUNT_GETTERS, ROUTE_ACCOUNT, ROUTE_ARGV, runMailHelper, vmAccount, vmMailbox } from './helpers/apple-mail-vm.ts';

const DATES = Object.fromEntries([0, 1, 2].map((i) => [i, new Date(Date.UTC(2026, 9, 10, 8, i))]));
const route = (id: string, host: string, type: string) => buildMailRouting([{ id, serverName: host, accountType: type, enabled: true }]);
const routeArgs = (r: ReturnType<typeof route>) => ['--routing', JSON.stringify({ eligible: r.eligible.map((a) => ({ id: a.id, server_name: a.serverName, account_type: a.accountType })), account_ids: r.accountIds, observed: r.observed.map((a) => ({ id: a.id, server_name: a.serverName, account_type: a.accountType, enabled: a.enabled })) })];
const argv = (routing: string[] = ROUTE_ARGV) => ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX', ...routing];
const app = (accounts: unknown[], unified: Record<string, unknown> = {}) => ({ running: () => true, accounts: () => accounts, ...unified });
const mailbox = (ids: number[], name = 'INBOX', calls: number[][] = []) => Object.assign(vmMailbox(name, ids, DATES, { contentCalls: calls }), { name: () => name, id: () => `${name}-app-id` });

describe('public account metadata only', () => {
  test('--accounts emits only id/server_name/account_type/enabled; no username/address/full-name/password getter is touched', () => {
    const forbidden: string[] = [];
    const acct = vmAccount({ id: 'a1', serverName: 'imap.example.com', accountType: 'imap', enabled: true, mailboxes: [] }, forbidden);
    const { doc, exitCode } = runMailHelper(app([acct]), ['--accounts']);
    expect(exitCode).toBe(0);
    expect(doc.accounts).toEqual([{ id: 'a1', server_name: 'imap.example.com', account_type: 'imap', enabled: true }]);
    expect(Object.keys(doc.accounts[0]).sort()).toEqual(['account_type', 'enabled', 'id', 'server_name']);
    expect(forbidden).toEqual([]);
    for (const getter of FORBIDDEN_ACCOUNT_GETTERS.filter((x) => x !== 'name')) expect(JSON.stringify(doc)).not.toContain(getter);
  });

  test('a failed public getter becomes null (unknown upstream), not a guessed value', () => {
    const acct = vmAccount({ id: 'a1', serverName: 'imap.example.com', accountType: 'imap', enabled: true, throwOn: ['serverName'], mailboxes: [] });
    expect(runMailHelper(app([acct]), ['--accounts']).doc.accounts[0]).toEqual({ id: 'a1', server_name: null, account_type: 'imap', enabled: true });
  });
});

describe('Google exclusion and per-account mailbox scope', () => {
  test('a Google-hosted IMAP account is not in an Apple routing; an attempted Google-only read without a routing is refused', () => {
    const google = vmAccount({ id: 'acct-google', serverName: 'imap.gmail.com', accountType: 'imap', mailboxes: [['INBOX', mailbox([0])], ['Sent', mailbox([1], 'Sent')]] });
    const { doc, exitCode } = runMailHelper(app([google]), ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX']);
    expect(exitCode).toBe(2);
    expect(doc.error.code).toBe('helper_failed');
    const routing = route('acct-google', 'imap.gmail.com', 'imap');
    expect(routing.google).toEqual(['acct-google']);
    expect(routing.eligible).toEqual([]);
    // `readMail()` never calls the helper when `routing.eligible` is empty. If a caller bypasses that and passes the
    // empty list directly, the helper also refuses (never means "all accounts").
    const emptyArgs = ['--routing', JSON.stringify({ eligible: [], account_ids: ['acct-google'], observed: [{ id: 'acct-google', server_name: 'imap.gmail.com', account_type: 'imap', enabled: true }] })];
    const { doc: empty, exitCode: emptyCode } = runMailHelper(app([google]), argv(emptyArgs));
    expect(emptyCode).toBe(2);
    expect(empty.error.code).toBe('helper_failed');
  });

  test('mixed account read touches Apple-hosted INBOX only; the Google-hosted INBOX/Sent and unified app mailboxes are never queried', () => {
    const calls: number[][] = [];
    const aInbox = mailbox([0, 2], 'INBOX', calls);
    const aSent = mailbox([1], 'Sent', calls);
    const googleInbox = mailbox([0], 'INBOX');
    const googleSent = mailbox([1], 'Sent');
    const apple = vmAccount({ id: ROUTE_ACCOUNT.id, serverName: ROUTE_ACCOUNT.server_name, accountType: ROUTE_ACCOUNT.account_type, mailboxes: [['INBOX', aInbox], ['Sent', aSent]] });
    const google = vmAccount({ id: 'acct-google', serverName: 'imap.gmail.com', accountType: 'imap', mailboxes: [['INBOX', googleInbox], ['Sent', googleSent]] });
    // If the helper touches a unified application mailbox, it gets [99], making the assertion fail conspicuously.
    const unified = { inbox: mailbox([99]), sentMailbox: mailbox([99], 'Sent'), draftsMailbox: mailbox([99], 'Drafts'), junkMailbox: mailbox([99], 'Junk'), trash: mailbox([99], 'Trash'), outbox: mailbox([99], 'Outbox') };
    const rr = route(ROUTE_ACCOUNT.id, ROUTE_ACCOUNT.server_name, 'imap');
    rr.accountIds = ['acct-example-1', 'acct-google'];
    rr.observed.push({ id: 'acct-google', serverName: 'imap.gmail.com', accountType: 'imap', enabled: true });
    const { doc, exitCode } = runMailHelper(app([apple, google], unified), argv(routeArgs(rr)));
    expect(exitCode).toBe(0);
    expect(doc.items.map((m: { id: string }) => m.id)).toEqual(['<INBOX-0>', '<INBOX-2>']);
    expect(calls.flat()).toEqual([0, 2]);
  });

  test('a missing role in any eligible account is an explicit error; a Google account missing Sent is irrelevant', () => {
    const apple = vmAccount({ id: ROUTE_ACCOUNT.id, serverName: ROUTE_ACCOUNT.server_name, accountType: 'imap', mailboxes: [['INBOX', mailbox([0])]] });
    const google = vmAccount({ id: 'acct-google', serverName: 'imap.gmail.com', accountType: 'imap', mailboxes: [['INBOX', mailbox([99])]] });
    const { doc, exitCode } = runMailHelper(app([apple, google]), ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX,Sent', '--routing', JSON.stringify({ eligible: [ROUTE_ACCOUNT], account_ids: [ROUTE_ACCOUNT.id, 'acct-google'], observed: [{ id: ROUTE_ACCOUNT.id, server_name: ROUTE_ACCOUNT.server_name, account_type: 'imap', enabled: true }, { id: 'acct-google', server_name: 'imap.gmail.com', account_type: 'imap', enabled: true }] })]);
    expect(exitCode).toBe(1);
    expect(doc.error.code).toBe('selection_not_found');
    expect(doc.error.message).toContain('acct-example-1');
  });

  test('two Sent role candidates in one eligible account are explicit ambiguity, never guessed', () => {
    const s1 = mailbox([], 'Sent');
    const s2 = mailbox([], 'Sent Messages');
    const a = vmAccount({ id: ROUTE_ACCOUNT.id, serverName: ROUTE_ACCOUNT.server_name, accountType: 'imap', mailboxes: [['INBOX', mailbox([0])], ['Sent', s1]], children: [['Sent Messages', s2]] });
    const { doc, exitCode } = runMailHelper(app([a]), ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX,Sent', '--routing', JSON.stringify({ eligible: [ROUTE_ACCOUNT], account_ids: [ROUTE_ACCOUNT.id], observed: [{ id: ROUTE_ACCOUNT.id, server_name: ROUTE_ACCOUNT.server_name, account_type: 'imap', enabled: true }] })]);
    expect(exitCode).toBe(1);
    expect(doc.error.code).toBe('selection_ambiguous');
  });

  test('two accounts with the same app id inside the same role mailbox are separate candidates (no cross-account dedupe)', () => {
    const callsA: number[][] = []; const callsB: number[][] = [];
    const a1 = vmAccount({ id: 'acct-a', serverName: 'imap.one.example', accountType: 'imap', mailboxes: [['INBOX', mailbox([0], 'INBOX', callsA)], ['Sent', mailbox([], 'Sent')]] });
    const a2 = vmAccount({ id: 'acct-b', serverName: 'imap.two.example', accountType: 'imap', mailboxes: [['INBOX', mailbox([0], 'INBOX', callsB)], ['Sent', mailbox([], 'Sent')]] });
    const routing = buildMailRouting([a1, a2].map((_, i) => ({ id: `acct-${i ? 'b' : 'a'}`, serverName: i ? 'imap.two.example' : 'imap.one.example', accountType: 'imap', enabled: true })));
    const { doc, exitCode } = runMailHelper(app([a1, a2]), ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX', ...routeArgs(routing)]);
    expect(exitCode).toBe(0);
    expect(doc.items.map((m: { id: string }) => m.id)).toEqual(['<INBOX-0>', '<INBOX-0>']);
    expect(callsA.flat()).toEqual([0]);
    expect(callsB.flat()).toEqual([0]);
  });

  test('a mailbox from an account added after the route was resolved refuses the whole read', () => {
    const a1 = vmAccount({ id: ROUTE_ACCOUNT.id, serverName: ROUTE_ACCOUNT.server_name, accountType: 'imap', mailboxes: [['INBOX', mailbox([0])]] });
    const a2 = vmAccount({ id: 'acct-new', serverName: 'imap.other.example', accountType: 'imap', mailboxes: [['INBOX', mailbox([1])]] });
    const { doc, exitCode } = runMailHelper(app([a1, a2]), argv());
    expect(exitCode).toBe(1);
    expect(doc.error.code).toBe('mail_routing_changed');
  });

  test('a Google account changed to an Apple host under the same id after routing was resolved refuses the stale read', () => {
    const acct = vmAccount({ id: 'acct-google', serverName: 'imap.example.com', accountType: 'imap', mailboxes: [['INBOX', mailbox([0])]] });
    const other = vmAccount({ id: 'acct-apple', serverName: 'imap.other.example', accountType: 'imap', mailboxes: [['INBOX', mailbox([1])]] });
    const googleAtProbe = buildMailRouting([
      { id: 'acct-google', serverName: 'imap.gmail.com', accountType: 'imap', enabled: true },
      { id: 'acct-apple', serverName: 'imap.other.example', accountType: 'imap', enabled: true },
    ]);
    expect(googleAtProbe.google).toEqual(['acct-google']);
    const { doc, exitCode } = runMailHelper(app([acct, other]), ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX', ...routeArgs(googleAtProbe)]);
    expect(exitCode).toBe(1);
    expect(doc.error.code).toBe('mail_routing_changed');
    expect(doc.items).toBeUndefined(); // no stale decision can start reading that account
  });

  test('a changed provider under the same id refuses the stale route; the next route may intentionally exclude it as Google', () => {
    const calls: number[][] = [];
    const changed = vmAccount({ id: ROUTE_ACCOUNT.id, serverName: 'imap.gmail.com', accountType: 'imap', mailboxes: [['INBOX', mailbox([0], 'INBOX', calls)]] });
    const { doc, exitCode } = runMailHelper(app([changed]), argv());
    expect(exitCode).toBe(1);
    expect(doc.error.code).toBe('mail_routing_changed');
    expect(calls).toEqual([]);
  });

  test('per-account mailbox selections dedupe by account id plus mailbox id', () => {
    const calls: number[][] = [];
    const inbox = mailbox([0], 'INBOX', calls);
    const sent = mailbox([1], 'Sent', calls);
    const a = vmAccount({ id: ROUTE_ACCOUNT.id, serverName: ROUTE_ACCOUNT.server_name, accountType: 'imap', mailboxes: [['INBOX', inbox], ['Sent', sent]] });
    const { doc } = runMailHelper(app([a]), ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX,Sent', '--routing', JSON.stringify({ eligible: [ROUTE_ACCOUNT], account_ids: [ROUTE_ACCOUNT.id], observed: [{ id: ROUTE_ACCOUNT.id, server_name: ROUTE_ACCOUNT.server_name, account_type: 'imap', enabled: true }] })]);
    expect(doc.items.map((m: { id: string }) => m.id)).toEqual(['<INBOX-0>', '<Sent-1>']);
    expect(calls.flat()).toEqual([0, 1]);
  });
});
