/**
 * GBrain Helper's Contacts write route as gbrain calls it (plan GST-3278, PR 1): the owner signature covers the batch route,
 * an enrichment call carries its bearer token, a retryable answer is re-sent with a fresh signature, helper refusals map
 * to apple_contacts_* codes, the socks5h path sends a POST body, and `gbrain apple-contacts write` refuses unless writes
 * are on. Every card, name and address here is a placeholder; nothing talks to a real Mac.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalSendString, sendKeyPairFromSeed } from '../src/core/apple/send-sign.ts';
import { CONTACTS_WRITE_ROUTE, readOwnerKey, readWriteToken, sendContactsBatch } from '../src/core/apple/contacts-write-client.ts';
import { changeKey, runAppleContacts } from '../src/commands/apple-contacts.ts';
import { canonicalPhone } from '../src/core/phone-key.ts';
import { Socks5Stub } from './helpers/apple-contacts-stub.ts';

interface Seen { method: string; path: string; authorization: string; body: string }

const TOKEN = ['tok', 'fixture', 'one'].join('-');
const SECRET_TOKEN = ['tok', 'fixture', 'hidden'].join('-');
const seed = Buffer.alloc(32, 7);
const pair = sendKeyPairFromSeed(seed);
const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pair.publicKey }, format: 'jwk' });
let dir = '';
let server: ReturnType<typeof Bun.serve>;
const seen: Seen[] = [];
let answers: Array<{ status: number; body: unknown }> = [];

const ok = (results: unknown[] = [{ key: 'k1', op: 'fill', status: 'applied', id: 'card-a', reason: null }]) =>
  ({ status: 200, body: { data: { batch: 'b-1', journal: 'j-1', results, stopped: null, side_effects: 'all', next: null } } });

function verifies(s: Seen, batch: string): boolean {
  const m = /^GBrain-Sign key=([^,]+), ts=(\d+), nonce=([0-9a-f]{32}), sig=(.+)$/.exec(s.authorization);
  if (!m) return false;
  const canonical = canonicalSendString({ timestamp: Number(m[2]), nonce: m[3]!, idempotencyKey: batch, body: s.body, route: CONTACTS_WRITE_ROUTE });
  return verify(null, Buffer.from(canonical), publicKey, Buffer.from(m[4]!, 'base64url'));
}

const cfg = () => ({ helperHost: '127.0.0.1', helperPort: server.port as number, proxy: undefined as string | undefined });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-acw-'));
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      seen.push({ method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get('authorization') ?? '', body: await req.text() });
      const a = answers.shift() ?? ok();
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
    },
  });
});
afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });

function file(name: string, content: string, mode = 0o600): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try { await (typeof p === 'function' ? p() : p); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

const change = { key: 'k1', op: 'fill' as const, id: 'card-a', field: 'job_title', value: 'Engineer' };

describe('sendContactsBatch', () => {
  test('an owner batch is a POST to the batch route whose signature covers that route and the exact body', async () => {
    seen.length = 0; answers = [ok()];
    const reply = await sendContactsBatch({ sourceId: 's', cfg: cfg(), batch: 'own-batch-1', countryCode: '1', changes: [change],
      auth: { kind: 'owner', keyName: 'box', privateKey: pair.privateKey, instruction: 'add the job title' } });
    expect(reply.results[0]).toMatchObject({ status: 'applied', id: 'card-a' });
    expect(reply.sideEffects).toBe('all');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', path: CONTACTS_WRITE_ROUTE });
    expect(verifies(seen[0]!, 'own-batch-1')).toBe(true);
    const sent = JSON.parse(seen[0]!.body);
    expect(sent).toMatchObject({ batch: 'own-batch-1', requested_by: 'owner', owner_instruction: 'add the job title', country_code: '1' });
    const sendRouteCanonical = canonicalSendString({ timestamp: 1, nonce: '0'.repeat(32), idempotencyKey: 'own-batch-1', body: '{}' });
    expect(sendRouteCanonical).not.toContain(CONTACTS_WRITE_ROUTE);
  });

  test('an enrichment batch sends the bearer token and no owner instruction', async () => {
    seen.length = 0; answers = [ok()];
    await sendContactsBatch({ sourceId: 's', cfg: cfg(), batch: 'enr-batch-1', countryCode: '1', changes: [change], auth: { kind: 'enrich', token: TOKEN } });
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(seen[0]!.body);
    expect(sent.requested_by).toBe('enrich');
    expect(sent.owner_instruction).toBeUndefined();
  });

  test('a retryable 503 is sent again with the same batch and a fresh signature', async () => {
    seen.length = 0; answers = [{ status: 503, body: { code: 'busy', retryable: true } }, ok()];
    await sendContactsBatch({ sourceId: 's', cfg: cfg(), batch: 'own-batch-2', countryCode: '1', changes: [change], sleep: async () => {}, retryDelaysMs: [1],
      auth: { kind: 'owner', keyName: 'box', privateKey: pair.privateKey, instruction: 'x' } });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body).toBe(seen[1]!.body);
    expect(seen[0]!.authorization).not.toBe(seen[1]!.authorization);
    expect(verifies(seen[1]!, 'own-batch-2')).toBe(true);
  });

  test('helper refusals map to apple_contacts codes, and the credential never appears in the error', async () => {
    const cases: Array<[string, string]> = [
      ['contacts_write_off', 'apple_contacts_write_off'], ['insufficient_scope', 'apple_contacts_unauthorized'],
      ['unauthorized', 'apple_contacts_unauthorized'], ['backup_failed', 'apple_contacts_backup_failed'],
      ['bad_param', 'apple_contacts_bad_request'], ['something_new', 'apple_contacts_helper_error'],
    ];
    for (const [helperCode, mapped] of cases) {
      answers = [{ status: helperCode === 'bad_param' ? 400 : 403, body: { code: helperCode, detail: 'd' } }];
      let err: { code?: string; message?: string } = {};
      try {
        await sendContactsBatch({ sourceId: 's', cfg: cfg(), batch: 'enr-batch-2', countryCode: '1', changes: [change], auth: { kind: 'enrich', token: SECRET_TOKEN } });
      } catch (error) { err = error as typeof err; }
      expect(err.code).toBe(mapped);
      expect(String(err.message)).not.toContain(SECRET_TOKEN);
    }
  });

  test('no answer at all is apple_contacts_unreachable and says some changes may have been applied', async () => {
    let err: { code?: string; message?: string } = {};
    try {
      await sendContactsBatch({ sourceId: 's', cfg: { helperHost: '127.0.0.1', helperPort: 1, proxy: undefined }, batch: 'enr-batch-3', countryCode: '1', changes: [change],
        sleep: async () => {}, retryDelaysMs: [], auth: { kind: 'enrich', token: TOKEN } });
    } catch (error) { err = error as typeof err; }
    expect(err.code).toBe('apple_contacts_unreachable');
    expect(err.message).toContain('may have been applied');
  });

  test('through a socks5h proxy the batch goes out as a POST with its body', async () => {
    const proxy = await new Socks5Stub().start();
    proxy.names.set('helper.example.invalid', '127.0.0.1');
    try {
      seen.length = 0; answers = [ok()];
      await sendContactsBatch({ sourceId: 's', cfg: { helperHost: 'helper.example.invalid', helperPort: server.port as number, proxy: 'socks5h://127.0.0.1:' + proxy.port },
        batch: 'own-batch-3', countryCode: '1', changes: [change], auth: { kind: 'owner', keyName: 'box', privateKey: pair.privateKey, instruction: 'x' } });
      expect(proxy.asked[0]!.host).toBe('helper.example.invalid');
      expect(seen[0]).toMatchObject({ method: 'POST', path: CONTACTS_WRITE_ROUTE });
      expect(verifies(seen[0]!, 'own-batch-3')).toBe(true);
    } finally { await proxy.stop(); }
  });
});

describe('credential files', () => {
  test('the owner key file must be 0600 JSON with a key name and a 32-byte seed', async () => {
    const good = file('owner.json', JSON.stringify({ key_name: 'box', seed: seed.toString('base64url') }));
    expect(readOwnerKey(good).keyName).toBe('box');
    expect(await codeOf(() => readOwnerKey(file('owner-open.json', JSON.stringify({ key_name: 'box', seed: seed.toString('base64url') }), 0o644)))).toBe('apple_contacts_owner_key_file');
    expect(await codeOf(() => readOwnerKey(file('owner-short.json', JSON.stringify({ key_name: 'box', seed: 'AAAA' }))))).toBe('apple_contacts_owner_key_file');
    expect(await codeOf(() => readOwnerKey('relative.json'))).toBe('apple_contacts_owner_key_file');
    let message = '';
    try { readOwnerKey(file('owner-bad.json', JSON.stringify({ key_name: 'bad name!', seed: seed.toString('base64url') }))); } catch (error) { message = String((error as Error).message); }
    expect(message).not.toContain(seed.toString('base64url'));
  });

  test('the write token file must be 0600 JSON with an accessToken', async () => {
    expect(readWriteToken(file('tok.json', JSON.stringify({ accessToken: TOKEN })))).toBe(TOKEN);
    expect(await codeOf(() => readWriteToken(file('tok-open.json', JSON.stringify({ accessToken: TOKEN }), 0o640)))).toBe('apple_contacts_write_token_file');
    expect(await codeOf(() => readWriteToken(file('tok-none.json', '{}')))).toBe('apple_contacts_write_token_file');
  });
});

function fakeEngine(config: Record<string, string>, sources: Array<{ id: string; config: unknown }> = []) {
  return {
    getConfig: async (key: string) => config[key] ?? null,
    // listSources reads the source rows through the typed members (e674407264), not executeRaw.
    listSourceRecords: async () => sources.map(s => ({ id: s.id, name: s.id, local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date(0), archived: false })),
    countSourcePages: async () => 0,
    getSource: async (id: string) => sources.find(s => s.id === id) ?? null,
  } as unknown as Parameters<typeof runAppleContacts>[0];
}

async function captured(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = log; }
  return lines.join('\n');
}

describe('gbrain apple-contacts write', () => {
  const fill = ['write', 'fill', '--card', 'card-a', '--field', 'job_title', '--value', 'Engineer', '--owner-instruction', 'add the title'];

  test('refuses while apple_contacts.write is off, which is the default', async () => {
    expect(await codeOf(runAppleContacts(fakeEngine({}), fill))).toBe('apple_contacts_write_off');
    expect(await codeOf(runAppleContacts(fakeEngine({ 'apple_contacts.write': 'off' }), fill))).toBe('apple_contacts_write_off');
  });

  test('refuses change verbs while apple_contacts.destructive_writes is not on', async () => {
    const del = ['write', 'delete', '--card', 'card-a', '--expect-json', '{"given_name":"Alice"}', '--owner-instruction', 'delete it'];
    expect(await codeOf(runAppleContacts(fakeEngine({ 'apple_contacts.write': 'on' }), del))).toBe('apple_contacts_destructive_off');
    const set = ['write', 'set', '--card', 'card-a', '--field', 'job_title', '--value', 'b', '--expect', 'a', '--owner-instruction', 'x'];
    expect(await codeOf(runAppleContacts(fakeEngine({ 'apple_contacts.write': 'dry_run', 'apple_contacts.destructive_writes': 'off' }), set))).toBe('apple_contacts_destructive_off');
  });

  test('refuses without --owner-instruction and refuses a malformed change', async () => {
    const on = fakeEngine({ 'apple_contacts.write': 'dry_run' });
    expect(await codeOf(runAppleContacts(on, fill.slice(0, 8)))).toBe('apple_contacts_bad_request');
    expect(await codeOf(runAppleContacts(on, ['write', 'fill', '--card', 'card-a', '--owner-instruction', 'x']))).toBe('apple_contacts_bad_request');
    expect(await codeOf(runAppleContacts(on, ['write', 'create', '--fields-json', '[1]', '--owner-instruction', 'x']))).toBe('apple_contacts_bad_request');
    expect(await codeOf(runAppleContacts(on, ['write', 'rename', '--owner-instruction', 'x']))).toBe('apple_contacts_bad_request');
  });

  test('dry_run prints the change it would send and sends nothing', async () => {
    seen.length = 0;
    const out = JSON.parse(await captured(() => runAppleContacts(fakeEngine({ 'apple_contacts.write': 'dry_run' }), fill)));
    expect(out.dry_run).toBe(true);
    expect(out.changes[0]).toMatchObject({ op: 'fill', id: 'card-a', field: 'job_title', value: 'Engineer' });
    expect(out.changes[0].key).toBe(changeKey('fill', [out.batch, 'card-a', undefined, 'job_title', 'Engineer', undefined, undefined, undefined]));
    expect(seen).toHaveLength(0);
  });

  test('a set carries the value it expects to replace', async () => {
    const out = JSON.parse(await captured(() => runAppleContacts(fakeEngine({ 'apple_contacts.write': 'dry_run', 'apple_contacts.destructive_writes': 'on' }),
      ['write', 'set', '--card', 'card-a', '--field', 'job_title', '--value', 'new', '--expect', 'old', '--owner-instruction', 'x'])));
    expect(out.changes[0]).toMatchObject({ op: 'set', expect: { job_title: 'old' } });
  });

  test('with writes on, the change goes to the helper owner-signed', async () => {
    seen.length = 0; answers = [ok()];
    const keyFile = file('owner-cli.json', JSON.stringify({ key_name: 'box', seed: seed.toString('base64url') }));
    const tokenFile = file('read-token.json', JSON.stringify({ accessToken: 'read-token-placeholder' }));
    const engine = fakeEngine({ 'apple_contacts.write': 'on', 'apple_contacts.owner_key_file': keyFile },
      [{ id: 'contacts', config: { kind: 'apple-contacts', ac_helper_host: '127.0.0.1', ac_helper_port: server.port, ac_token_file: tokenFile } }]);
    const out = await captured(() => runAppleContacts(engine, fill));
    expect(out).toContain('applied');
    const sent = JSON.parse(seen[0]!.body);
    expect(sent.owner_instruction).toBe('add the title');
    expect(verifies(seen[0]!, sent.batch)).toBe(true);
  });

  test('running the same command again sends a new change key, so the helper applies it instead of answering replayed', async () => {
    const engine = fakeEngine({ 'apple_contacts.write': 'dry_run', 'apple_contacts.destructive_writes': 'on' });
    const first = JSON.parse(await captured(() => runAppleContacts(engine, fill)));
    const again = JSON.parse(await captured(() => runAppleContacts(engine, fill)));
    expect(first.batch).not.toBe(again.batch);
    expect(first.changes[0].key).not.toBe(again.changes[0].key);
    const set = (old: string) => ['write', 'set', '--card', 'card-a', '--field', 'job_title', '--value', 'new', '--expect', old, '--owner-instruction', 'x'];
    const a = JSON.parse(await captured(() => runAppleContacts(engine, set('old'))));
    expect(a.changes[0].key).toBe(changeKey('set', [a.batch, 'card-a', undefined, 'job_title', 'new', undefined, undefined, JSON.stringify({ job_title: 'old' })]));
    expect(a.changes[0].key).not.toBe(changeKey('set', [a.batch, 'card-a', undefined, 'job_title', 'new', undefined, undefined, JSON.stringify({ job_title: 'older' })]));
  });

  test('change keys are deterministic, and differ when any part differs', () => {
    const a = changeKey('fill', ['card-a', undefined, 'job_title', 'Engineer']);
    expect(a).toBe(changeKey('fill', ['card-a', undefined, 'job_title', 'Engineer']));
    expect(a).toMatch(/^own-[0-9a-f]{40}$/);
    expect(a).not.toBe(changeKey('fill', ['card-a', undefined, 'job_title', 'Engineer2']));
    expect(a).not.toBe(changeKey('set', ['card-a', undefined, 'job_title', 'Engineer']));
  });
});

describe('phone keys the helper shares', () => {
  test('canonicalPhone matches the golden table the Swift port is tested against', () => {
    const rows = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'phone-canonical-golden.json'), 'utf8')) as Array<{ input: string; country: string; canonical: string | null }>;
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect([row.input, canonicalPhone(row.input, row.country)]).toEqual([row.input, row.canonical]);
  });
});

