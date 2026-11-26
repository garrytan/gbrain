/**
 * W1b, the household template's privacy matrix (agent platform plan, H2): every household kind against every key the
 * template issues, on PGLite with remote=true over the HTTP dispatch path. The household is the synthetic one (invented
 * people only) plus one record about the child of each kind, seeded on a brain that serves one person; then
 * `householdTemplate` applies the default shape (another adult, a labelled-only helper, a labelled-only family chat as an
 * audience member) and issues the keys into 0600 files. Each key is read back from its file and checked for:
 * - direct reads: get_page on every record answers exactly the records its audience allows;
 * - derived reads: household_due's items, counts and digest hold nothing adults-only for the helper or the chat;
 * - the room: the owner's household_due in the family chat's room marks exactly the adults-only records unreadable.
 * The owner's own remote key reads every record (R94). Children get no member and no key.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { bindCredential, getMember, listGroups } from '../src/core/access/members.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { HOUSEHOLD_KINDS } from '../src/core/household/record.ts';
import { accessCheck } from '../src/commands/access.ts';
import { currentFolderRules } from '../src/commands/access-rules.ts';
import { householdTemplate, householdTemplateStatus, type TemplateResult } from '../src/commands/household-template.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { installTripwire, type Tripwire } from './helpers/ai-tripwire.ts';
import { ADULTS_ONLY, AS_OF, RECORDS, TIMEZONE, seedSyntheticHousehold } from './fixtures/synthetic-household/household.ts';

const OWNER = 'alice-example';
const ADULT = 'bob-example';
const HELPER = 'casey-example';
const CHAT = 'family-chat-example';
const PERSONAL = 'journal/2026-11-01';
const CHILD = 'people/robin-example';

/** One record about the child of each kind; the table keeps every one adults only. */
const CHILD_RECORDS: Array<Record<string, unknown>> = [
  { kind: 'supply', title: 'Robin school snacks', cadence: '7d', last_done: '2026-11-28' },
  { kind: 'birthday', title: 'Robin half birthday', on: '10-02' },
  { kind: 'bill', title: 'Robin swim lessons', due: '2026-12-04', recurs: 'monthly', amount: 40, currency: 'USD' },
  { kind: 'deadline', title: 'Robin camp form', due: '2026-12-05' },
  { kind: 'appointment', title: 'Robin eye exam', due: '2026-12-09' },
  { kind: 'return', title: 'Robin rain jacket return', due: '2026-12-06' },
  { kind: 'credit', title: 'Robin bookstore credit', due: '2027-02-01', amount: 15, currency: 'USD' },
].map(r => ({ ...r, about: [CHILD] }));

let engine: PGLiteEngine;
let tripwire: Tripwire;
let keyDir: string;
let receiptDir: string;
let applied: TemplateResult;
const slugs = new Map<string, string>();
const tokens: Record<string, string> = {};
const local = (op: string, params: Record<string, unknown>) => handleToolCall(engine, op, params) as Promise<any>;
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

async function remote(who: string, op: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'], ...extra } as never);
  const text = out.content.map((c: { text: string }) => c.text).join('\n');
  let json: any = {};
  try { json = JSON.parse(out.content[0]!.text); } catch { /* prose */ }
  return { isError: out.isError === true, text, json };
}

const adultsOnly = (title: string) => ADULTS_ONLY.includes(title) || CHILD_RECORDS.some(r => r.title === title);
const ARCHIVED = ['Old supply', 'Old birthday'];

beforeAll(async () => {
  tripwire = installTripwire();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('brain.timezone', TIMEZONE);
  for (const [title, slug] of await seedSyntheticHousehold(local)) slugs.set(title, slug);
  for (const r of CHILD_RECORDS) slugs.set(String(r.title), (await local('household_add', r)).slug);
  await local('put_page', { slug: PERSONAL, content: '---\ntitle: A private journal entry\ntype: note\n---\nAn entry that no rule and no readers list covers.' });
  keyDir = mkdtempSync(join(tmpdir(), 'gbrain-hh-keys-'));
  receiptDir = mkdtempSync(join(tmpdir(), 'gbrain-hh-receipts-'));
  applied = await householdTemplate(engine, { source: 'default', harness: 'claude-code', owner: OWNER, apply: true,
    members: `adult:${ADULT},helper:${HELPER},chat:${CHAT}`, keyDir, receiptDir });
  for (const k of applied.keys) tokens[k.member] = readFileSync(k.path, 'utf8').trim();
  const ownerKey = await mintLegacyToken(engine, { name: 'hh-owner-remote', scopes: ['read', 'write'], takesHolders: ['world'] });
  await bindCredential(engine, { kind: 'token', id: ownerKey.id }, { member: OWNER });
  tokens[OWNER] = ownerKey.token;
  __resetPrivateVisibilityCacheForTests();
}, 240_000);

afterAll(async () => {
  tripwire.dispose();
  await engine.disconnect();
});

describe('household template privacy matrix (W1b)', () => {
  test('the template applies with every step done and one key per member besides the owner, each in a 0600 file', () => {
    expect(applied.error).toBeUndefined();
    expect(applied.steps.map(s => [s.id, s.state])).toEqual(applied.steps.map(s => [s.id, 'done']));
    expect(applied.keys.map(k => [k.member, k.scopes.join(',')]).sort()).toEqual([[ADULT, 'read,write'], [HELPER, 'read'], [CHAT, 'read']].sort());
    for (const k of applied.keys) expect(statSync(k.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(keyDir).sort()).toEqual([ADULT, CHAT, HELPER].map(id => id + '.key').sort());
    expect(JSON.stringify(applied)).not.toContain(tokens[ADULT]!);
  });

  test('children get no member and no key', async () => {
    expect(await getMember(engine, 'robin-example')).toBeNull();
    expect(readdirSync(keyDir).some(f => f.includes('robin'))).toBe(false);
  });

  test('every rule the template wrote names the owner, so readers_omit_owner never fires', async () => {
    const rules = (await currentFolderRules(engine, 'default')).filter(r => r.prefix.startsWith('household/'));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect({ prefix: r.prefix, owner: r.readable_by.includes('member:' + OWNER) }).toEqual({ prefix: r.prefix, owner: true });
  });

  test('access check reads each key as its member, every one labelled-only, in their own groups', async () => {
    const groups = new Map((await listGroups(engine)).map(g => [g.id, g.members]));
    expect(groups.get('household-adults')).toEqual([OWNER, ADULT].sort());
    expect(groups.get('household-helpers')).toEqual([HELPER]);
    expect(groups.get('household-chats')).toEqual([CHAT]);
    for (const [who, labelled] of [[ADULT, true], [HELPER, true], [CHAT, true]] as const) {
      const c = await accessCheck(engine, { token: 'member-' + who });
      expect({ who, verdict: c.verdict, labelled: c.labelled_only, reads: c.reads_now }).toEqual({ who, verdict: 'reads_as_member', labelled, reads: ['default'] });
    }
    expect((await getMember(engine, CHAT))!.kind).toBe('audience');
  });

  test('a page outside the household that nothing labels stays the owner\'s: no member key reads it', async () => {
    expect((await remote(OWNER, 'get_page', { slug: PERSONAL })).isError).toBeFalsy();
    for (const who of [ADULT, HELPER, CHAT]) expect({ who, reads: !(await remote(who, 'get_page', { slug: PERSONAL })).isError }).toEqual({ who, reads: false });
  });

  test('direct reads: every record of every kind against every key', async () => {
    const titles = [...RECORDS.map(r => r.title), ...CHILD_RECORDS.map(r => String(r.title))];
    const kinds = new Set([...RECORDS, ...CHILD_RECORDS].filter(r => adultsOnly(String(r.title))).map(r => r.kind));
    expect([...kinds].sort()).toEqual([...HOUSEHOLD_KINDS].sort());
    for (const title of titles) {
      for (const who of [OWNER, ADULT, HELPER, CHAT]) {
        const got = await remote(who, 'get_page', { slug: slugs.get(title)! });
        const want = who === OWNER || who === ADULT || !adultsOnly(title);
        expect({ title, who, reads: !got.isError }).toEqual({ title, who, reads: want });
      }
    }
  }, 120_000);

  test('derived reads: household_due items, counts and digest hold only what each key may read', async () => {
    const live = [...RECORDS.map(r => r.title), ...CHILD_RECORDS.map(r => String(r.title))].filter(t => !ARCHIVED.includes(t));
    for (const who of [OWNER, ADULT, HELPER, CHAT]) {
      const due = await remote(who, 'household_due', { as_of: AS_OF, include: 'all', window_days: 366, limit: 100 });
      expect(due.isError).toBe(false);
      const want = live.filter(t => who === OWNER || who === ADULT || !adultsOnly(t)).sort();
      const items = (due.json.items as Array<{ title: string }>).map(i => i.title).sort();
      expect({ who, items }).toEqual({ who, items: want });
      const total = Object.entries(due.json.counts as Record<string, number>).filter(([k]) => k !== 'invalid').reduce((n, [, v]) => n + v, 0);
      expect({ who, total }).toEqual({ who, total: want.length });
      if (who === HELPER || who === CHAT) for (const t of live.filter(adultsOnly)) expect({ who, leaked: due.text.includes(t) }).toEqual({ who, leaked: false });
    }
  }, 120_000);

  test('the room: the owner in the family chat sees every item, and the adults-only ones are marked unreadable by the room', async () => {
    const due = await remote(OWNER, 'household_due', { as_of: AS_OF, include: 'all', window_days: 366, limit: 100 }, { room: { header: CHAT } });
    expect(due.isError).toBe(false);
    const marks = (due.json.items as Array<{ title: string; room_access: { readable: unknown } }>).map(i => [i.title, i.room_access?.readable]);
    expect(marks.length).toBeGreaterThan(0);
    for (const [title, readable] of marks) expect({ title, readable }).toEqual({ title, readable: !adultsOnly(String(title)) });
  }, 60_000);

  test('the status proof reads every key and finds each one reading exactly the set the table expects', async () => {
    const s = await householdTemplateStatus(engine, { receipt: applied.receipt_id!, source: 'default', harness: 'claude-code', receiptDir });
    expect(s.complete).toBe(true);
    expect(s.proof.map(p => ({ member: p.member, key: p.key, missing: p.missing, extra: p.extra, due_extra: p.due_extra, ok: p.ok })))
      .toEqual([ADULT, HELPER, CHAT].map(member => ({ member, key: 'delivered', missing: [], extra: [], due_extra: [], ok: true })));
    expect(s.proof.find(p => p.member === HELPER)!.expected).toBe(s.proof.find(p => p.member === CHAT)!.expected);
    expect(s.proof.find(p => p.member === HELPER)!.expected).toBeLessThan(s.proof.find(p => p.member === ADULT)!.expected);
    expect(s.ok).toBe(true);
  }, 120_000);

  test('no generative model call and no network besides page embedding', () => {
    expect(tripwire.generative()).toEqual([]);
    expect(tripwire.egress.filter(url => !url.endsWith('/embeddings'))).toEqual([]);
  });
});
