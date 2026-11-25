/**
 * GST-3849 (g2-d8, g2-d4): the supported cutover from the shared gbrain.io
 * relay to the account's own OAuth client, rehearsed on a seeded brain.
 *
 * A Google source on `g_access: gbrainio` imports a synthetic mailbox (one
 * private sender), `sources set-access <id> vault` moves it onto a byo vault
 * entry, and a REST sync against a fake Gmail serving the same threads plus a
 * new one must land on the same source and the same pages: no duplicate, none
 * lost, the private thread still private, tiers still on, every page listed
 * by listGoogleProvenance, and the gbrain.io reader never called again. The
 * refusals (non-Google source, no or relay vault entry, no refresh token,
 * unsupported target, managed brain without --yes) write nothing.
 *
 * Synthetic data only.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { gbrainioRunner, type GbrainioRun, type GbrainioRunResult } from '../src/core/google/gbrainio-gmail.ts';
import { listGoogleProvenance } from '../src/core/google/provenance.ts';
import { setSourceAccess } from '../src/commands/sources-set-access.ts';
import { parseSourceConfig } from '../src/core/sources-load.ts';
import type { FetchImpl } from '../src/core/google/google-clients.ts';
import type { CredentialEntry, CredentialMeta, CredentialVault, ProviderClientRecord } from '../src/core/creds/vault.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, githubConfig, json, options, settleConnectorWrites, withGoogleAccount } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const OWNER = 'owner@example.invalid';
const CLIENT_ID = '000-example.apps.googleusercontent.com';
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const realRun = gbrainioRunner.run;
afterEach(() => { gbrainioRunner.run = realRun; });

interface Msg { id: string; tid: string; ms: number; from: string; to: string; subject: string; sent?: boolean }

const MAIL: Msg[] = [
  { id: 'a1a1a1a1a1a1a101', tid: 'a1a1a1a1a1a1a100', ms: NOW_MS - 5 * HOUR, from: 'Peer Example <peer@example.invalid>', to: OWNER, subject: 'Lunch plan' },
  { id: 'a1a1a1a1a1a1a102', tid: 'a1a1a1a1a1a1a100', ms: NOW_MS - 4 * HOUR, from: OWNER, to: 'peer@example.invalid', subject: 'Re: Lunch plan', sent: true },
  { id: 'b2b2b2b2b2b2b201', tid: 'b2b2b2b2b2b2b200', ms: NOW_MS - 2 * DAY, from: 'Stranger Example <stranger@example.invalid>', to: OWNER, subject: 'Quick question' },
  { id: 'f6f6f6f6f6f6f601', tid: 'f6f6f6f6f6f6f600', ms: NOW_MS - 6 * DAY, from: 'Alice Example <alice@example.com>', to: OWNER, subject: 'Personal' },
];
const NEW_THREAD: Msg = { id: '9a9a9a9a9a9a9a01', tid: '9a9a9a9a9a9a9a00', ms: NOW_MS - 1 * HOUR, from: 'Acme Example <team@acme-example.invalid>', to: OWNER, subject: 'Kickoff' };
const PRIVATE_TID = 'f6f6f6f6f6f6f600';

/** A synthetic gbrain.io terminal over the mailbox (search by epoch window, thread show, labels, send-as). */
function fakeGbrainio(mail: Msg[]) {
  const calls: string[][] = [];
  const run: GbrainioRun = async (_command, args) => {
    calls.push(args);
    const account = args[args.indexOf('-a') + 1]!;
    const out = (body: Record<string, unknown>): GbrainioRunResult => ({ exitCode: 0, stdout: JSON.stringify({ account, ...body }), stderr: '' });
    const row = (m: Msg) => ({ account, id: m.id, thread_id: m.tid, received_at: new Date(m.ms).toISOString(), from: m.from, to: m.to, cc: '',
      subject: m.subject, state: m.sent ? 'sent' : 'received' });
    const [, , verb, sub] = args;
    if (verb === 'label' && sub === 'ls') return out({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] });
    if (verb === 'send-as' && sub === 'ls') return out({ send_as: [{ email: account }] });
    if (verb === 'message' && sub === 'search') {
      const q = args[4]!;
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const tag = q.replace(/after:\d+|before:\d+/g, '').trim();
      const hits = tag ? [] : mail.filter((m) => m.ms / 1000 >= after && m.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
      return out({ count: hits.length, more: false, next_cursor: null, messages: hits.map(row) });
    }
    if (verb === 'thread' && sub === 'show') {
      const messages = mail.filter((m) => m.tid === args[4]).sort((a, b) => a.ms - b.ms);
      if (messages.length === 0) return { exitCode: 3, stdout: '', stderr: 'not found' };
      return out({ thread_id: args[4], count: messages.length, messages: messages.map((m) => ({ ...row(m), body: 'Body of ' + m.subject + '.', attachments: [] })) });
    }
    return { exitCode: 2, stdout: '', stderr: 'unexpected fixture command' };
  };
  gbrainioRunner.run = run;
  return calls;
}

/** A fake Gmail REST API serving the same mailbox (profile, message list by window, history, thread get). */
function fakeGmailRest(mail: Msg[]): { fetchImpl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const inner = async (url: string): Promise<Response> => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: OWNER, historyId: '5000' });
    if (u.pathname.endsWith('/users/me/settings/sendAs')) return json({ sendAs: [{ sendAsEmail: OWNER, isPrimary: true }] });
    if (u.pathname.endsWith('/users/me/labels')) return json({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] });
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '5000', history: [] });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = mail.filter((m) => Math.floor(m.ms / 1000) >= after && Math.floor(m.ms / 1000) < before).sort((a, b) => b.ms - a.ms);
      return json({ messages: hits.map((m) => ({ id: m.id, threadId: m.tid })) });
    }
    const thread = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (thread) {
      const msgs = mail.filter((m) => m.tid === thread[1]).sort((a, b) => b.ms - a.ms);
      if (msgs.length === 0) return json({ error: { code: 404, message: 'not found' } }, 404);
      return json({ id: thread[1], messages: msgs.map((m) => ({ id: m.id, threadId: m.tid, labelIds: m.sent ? ['SENT'] : ['INBOX'], internalDate: String(m.ms),
        payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject },
          { name: 'Date', value: new Date(m.ms).toUTCString() }], parts: [{ mimeType: 'text/plain', body: { data: b64url('Body of ' + m.subject + '.') } }] } })) });
    }
    return json({ error: { message: `unhandled ${u.pathname}` } }, 400);
  };
  return { fetchImpl: withGoogleAccount(inner, OWNER) as FetchImpl, calls };
}

class MemoryVault implements CredentialVault {
  entries = new Map<string, CredentialEntry>();
  clients = new Map<string, ProviderClientRecord>();
  async get(id: string) { return this.entries.get(id) ?? null; }
  async put(entry: CredentialEntry) { this.entries.set(entry.id, entry); }
  async list(): Promise<CredentialMeta[]> { return []; }
  async delete(id: string) { return this.entries.delete(id); }
  async getClient(provider: string) { return this.clients.get(provider) ?? null; }
  async putClient(rec: ProviderClientRecord) { this.clients.set(rec.provider, rec); }
  async deleteClient(provider: string) { return this.clients.delete(provider); }
}

function vaultWith(entry: { client_ref: 'byo' | 'hosted-relay'; refresh?: boolean; scopes?: string[] } | null): MemoryVault {
  const v = new MemoryVault();
  if (!entry) return v;
  v.entries.set(`google:${OWNER}`, { id: `google:${OWNER}`, provider: 'google', kind: 'oauth2', client_ref: entry.client_ref,
    secret: { access_token: 'synthetic-access', ...(entry.refresh === false ? {} : { refresh_token: 'synthetic-refresh' }), expiry: new Date(Date.now() + HOUR).toISOString() },
    meta: { account: OWNER, client_id: CLIENT_ID, connected_at: new Date().toISOString(),
      scopes: entry.scopes ?? ['https://www.googleapis.com/auth/gmail.readonly'] } });
  v.clients.set('google', { provider: 'google', client_id: CLIENT_ID, client_secret: 'synthetic-client-secret', created_at: new Date().toISOString() });
  return v;
}

function privateList(lines: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'cutover-private-')), 'private-senders.txt');
  writeFileSync(file, lines.join('\n'));
  return file;
}

const gbrainioConfig = (extra: Record<string, unknown> = {}) => ({ kind: 'google', g_account: OWNER, g_access: 'gbrainio', g_history_days: 30, ...extra });

async function readConfig(engine: BrainEngine, id: string) {
  const src = (await engine.listAllSources()).find((s) => s.id === id);
  return parseSourceConfig(src?.config ?? {});
}

async function emailPages(engine: BrainEngine, id: string) {
  await settleConnectorWrites(engine, id);
  const rows = await engine.executeRaw<{ slug: string; frontmatter: unknown }>(
    "SELECT slug, frontmatter FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug LIKE 'emails/%'", [id]);
  return rows.map((r) => ({ slug: r.slug, fm: (typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter) as Record<string, unknown> }));
}

async function refusal(run: Promise<unknown>) {
  const e = await run.then(() => null, (err: unknown) => err as { code?: string; message: string; fix?: { argv?: string[] } });
  expect(e).not.toBeNull();
  return e!;
}

test('relay to vault cutover: same source, same pages, private stays private, tiers stay on, gbrain.io never read again', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const file = privateList(['# owner-only senders', 'alice@example.com']);
    const f = await source(engine, gbrainioConfig({ g_private_senders_file: file }));
    const mail = MAIL.map((m) => ({ ...m }));
    fakeGbrainio(mail);
    const relayCfg = parseGoogleSourceConfig(await readConfig(engine, f.id), f.dir);
    expect(relayCfg.ingestTiers).toBe(true);
    expect((await runGoogleSync(engine, f.id, relayCfg, options)).status).not.toBe('partial');

    const before = await emailPages(engine, f.id);
    const threads = [...new Set(MAIL.map((m) => m.tid))].sort();
    expect(before.map((p) => String(p.fm.thread_id)).sort()).toEqual(threads);
    expect(before.find((p) => p.fm.thread_id === PRIVATE_TID)?.fm.visibility).toBe('private');
    const beforeProv = await listGoogleProvenance(engine, { account: OWNER });
    for (const p of before) expect(beforeProv).toContainEqual({ source_id: f.id, slug: p.slug, provider: 'google', account: OWNER, kind: 'gmail' });

    const vault = vaultWith({ client_ref: 'byo' });
    const moved = await setSourceAccess(engine, { id: f.id, target: 'vault', yes: true, vault });
    expect(moved).toMatchObject({ source_id: f.id, requested_access: 'vault', previous_access: 'gbrainio', effective_access: 'vault', changed: true,
      ingest_tiers: true, private_senders_file: file, services: ['gmail'] });
    const stored = await readConfig(engine, f.id);
    expect(stored).toMatchObject({ kind: 'google', g_account: OWNER, g_ingest_tiers: true, g_services: 'gmail', g_private_senders_file: file });
    expect(stored.g_access ?? null).toBeNull();
    expect(stored.g_gbrainio_command ?? null).toBeNull();
    expect(await setSourceAccess(engine, { id: f.id, target: 'vault', vault })).toMatchObject({ changed: false, effective_access: 'vault' });

    const relayCalls: string[][] = [];
    gbrainioRunner.run = async (_command, args) => { relayCalls.push(args); return { exitCode: 2, stdout: '', stderr: 'relay must not be called after the cutover' }; };
    mail.push({ ...NEW_THREAD });
    const rest = fakeGmailRest(mail);
    const vaultCfg = parseGoogleSourceConfig(stored, f.dir);
    expect(vaultCfg.access).toBe('vault');
    expect(vaultCfg.services).toEqual(['gmail']);
    expect((await runGoogleSync(engine, f.id, vaultCfg, options, rest.fetchImpl, vault)).status).not.toBe('partial');
    expect(relayCalls).toEqual([]);
    expect(rest.calls).toContain('/gmail/v1/users/me/history');
    expect(rest.calls).toContain(`/gmail/v1/users/me/threads/${NEW_THREAD.tid}`);
    rest.calls.length = 0;
    expect((await runGoogleSync(engine, f.id, vaultCfg, options, rest.fetchImpl, vault)).status).not.toBe('partial');
    expect(rest.calls.filter((c) => c.includes('/users/me/threads/'))).toEqual([]);
    expect(relayCalls).toEqual([]);

    const after = await emailPages(engine, f.id);
    const afterThreads = after.map((p) => String(p.fm.thread_id)).sort();
    expect(afterThreads).toEqual([...threads, NEW_THREAD.tid].sort());
    expect(new Set(afterThreads).size).toBe(afterThreads.length);
    for (const p of before) expect(after.map((a) => a.slug)).toContain(p.slug);
    expect(after.find((p) => p.fm.thread_id === PRIVATE_TID)?.fm.visibility).toBe('private');
    expect(after.find((p) => p.fm.thread_id === PRIVATE_TID)?.fm.ingest_tier).toBe('private');
    for (const p of after) expect(typeof p.fm.ingest_tier).toBe('string');
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM sources WHERE id=$1', [f.id]);
    expect(n).toBe(1);

    const afterProv = await listGoogleProvenance(engine, { account: OWNER, sourceId: f.id });
    for (const p of after) expect(afterProv).toContainEqual({ source_id: f.id, slug: p.slug, provider: 'google', account: OWNER, kind: 'gmail' });
    expect(await listGoogleProvenance(engine, { account: 'someone-else@example.invalid', sourceId: f.id })).toEqual([]);
  }
}), 240_000);

test('set-access refuses before any write: non-Google source, unsupported target, no or relay vault entry, no refresh token, managed brain without --yes', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const gh = await source(engine, githubConfig);
    expect((await refusal(setSourceAccess(engine, { id: gh.id, target: 'vault', yes: true, vault: vaultWith({ client_ref: 'byo' }) }))).message).toContain('not a Google source');
    expect((await refusal(setSourceAccess(engine, { id: 'no-such-source', target: 'vault', vault: vaultWith({ client_ref: 'byo' }) }))).code).toBe('not_found');

    const f = await source(engine, gbrainioConfig({ g_private_senders_file: privateList(['alice@example.com']) }));
    const original = await readConfig(engine, f.id);
    const unsupported = await refusal(setSourceAccess(engine, { id: f.id, target: 'command', yes: true, vault: vaultWith({ client_ref: 'byo' }) }));
    expect(unsupported.code).toBe('invalid_params');
    expect(unsupported.message).toContain('only vault is supported');

    for (const vault of [vaultWith(null), vaultWith({ client_ref: 'hosted-relay' })]) {
      const e = await refusal(setSourceAccess(engine, { id: f.id, target: 'vault', yes: true, vault }));
      expect(e.code).toBe('not_connected');
      expect(e.fix?.argv).toEqual(['gbrain', 'google', 'setup', '--personal', '--account', OWNER]);
    }
    const noRefresh = await refusal(setSourceAccess(engine, { id: f.id, target: 'vault', yes: true, vault: vaultWith({ client_ref: 'byo', refresh: false }) }));
    expect(noRefresh.code).toBe('no_refresh_token');
    expect(noRefresh.fix?.argv).toContain('--personal');
    const noGmail = await refusal(setSourceAccess(engine, { id: f.id, target: 'vault', yes: true, vault: vaultWith({ client_ref: 'byo', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }) }));
    expect(noGmail.code).toBe('scope_missing');
    expect(noGmail.message).toContain('gmail');
    expect(noGmail.fix?.argv).toContain('--personal');

    const managed = await refusal(setSourceAccess(engine, { id: f.id, target: 'vault', vault: vaultWith({ client_ref: 'byo' }) }));
    expect(managed.code).toBe('confirmation_required');
    expect(managed.fix?.argv).toEqual(['gbrain', 'sources', 'set-access', f.id, 'vault', '--yes']);

    expect(await readConfig(engine, f.id)).toEqual(original);
  }
}), 120_000);
