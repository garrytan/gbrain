/**
 * Standing-rule correction trust hardening (GST-4000): the fact's own page is the only entity a correction writes to,
 * a redirect never lands a fact on a rule page, a host resume of a remote owner's fact change asks at the terminal, a
 * resumed activation finishes under another connection, guests and member-less callers cannot save rules for
 * themselves, receipts are kept per audience, a team rule is never narrowed to its writer, and an approval saved
 * before its receipt moved on still finishes.
 *
 * Keyless repo-less PGLite brain (and Postgres with DATABASE_URL), no model calls (tripwire). Synthetic names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { __correctFaults, approveRule, localRulesCtx, RECEIPT_PREFIX, retireRule, runCorrect } from '../src/core/rules/correct.ts';
import { renderRulePage } from '../src/core/rules/record.ts';
import { CONFIRM_CODE_LENGTH, type TerminalProbe } from '../src/core/policy/authority.ts';
import { installTripwire, type Tripwire } from './helpers/ai-tripwire.ts';

const OWNER = 'alice-example';
const MEMBER = 'bob-example';
const THIRD = 'carol-example';
let engine: BrainEngine;
let close: (() => Promise<void>) | undefined;
let tripwire: Tripwire;
const tokens: Record<string, string> = {};

const local = (op: string, params: Record<string, unknown>) => (handleToolCall(engine, op, params) as Promise<any>).catch(e => e);
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

async function remote(who: string, op: string, params: Record<string, unknown>, audience?: string[], guest?: string): Promise<{ isError: boolean; text: string; json: any }> {
  const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'], inboundFrameBytes: 4 * 1024 * 1024,
    ...(audience ? { onBehalfOf: { requestMeta: { on_behalf_of: audience } } } : {}), ...(guest ? { guest: { header: guest } } : {}) } as never);
  const text = out.content.map((c: { text: string }) => c.text).join('\n');
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* prose */ }
  return { isError: out.isError === true, text, json };
}

const ownerTty = (): TerminalProbe => ({ env: {}, stdinIsTTY: true, stderrIsTTY: true,
  readAnswer: async prompt => /Type ([0-9a-f]+) /.exec(prompt)![1]!.slice(0, CONFIRM_CODE_LENGTH) });
const noTty: TerminalProbe = { env: {}, stdinIsTTY: false, stderrIsTTY: false };
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = () => true;
  try { return await fn(); } finally { (process.stderr as any).write = orig; }
};
const approve = (ref: string) => quiet(() => approveRule(engine, ref, { probe: ownerTty() }).catch(e => e)) as Promise<any>;
const hostResume = (id: string, probe: TerminalProbe) => quiet(() => (runCorrect(localRulesCtx(engine), { receipt_id: id, resume: true }, { probe }) as Promise<any>).catch(e => e));

let seq = 0;
async function seedFact(text: string, entity: string | null = 'people/alice-example'): Promise<string> {
  const r = await local('remember', { fact: text, ...(entity ? { entity } : { infer_entity: false }), provenance: 'test seed', request_id: 'gst4000-seed-' + (++seq) });
  return String(r.id);
}
async function factRow(id: string) {
  const [row] = await engine.executeRaw<{ expired_at: string | null; entity_slug: string | null }>('SELECT expired_at::text, entity_slug FROM facts WHERE id=$1', [Number(id)]);
  return row;
}
const liveFacts = async (entity: string) => (await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE entity_slug=$1 AND expired_at IS NULL ORDER BY id', [entity])).map(r => r.fact);
const frontmatter = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter as Record<string, unknown> | undefined;

for (const kind of testBackends()) describe('correct trust hardening (' + kind + ')', () => {
beforeAll(async () => {
  tripwire = installTripwire();
  if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
  for (const m of [OWNER, MEMBER, THIRD]) await addMember(engine, m, { remote: false });
  await setOwner(engine, OWNER);
  for (const who of [OWNER, MEMBER, THIRD]) {
    const minted = await mintLegacyToken(engine, { name: 'g4-' + who, scopes: ['read', 'write'], takesHolders: ['world'] });
    await bindCredential(engine, { kind: 'token', id: minted.id }, { member: who });
    tokens[who] = minted.token;
  }
  const bot = await mintLegacyToken(engine, { name: 'g4-bot', scopes: ['read', 'write'], takesHolders: ['world'] });
  await bindCredential(engine, { kind: 'token', id: bot.id }, { mayActFor: ['guest', 'member:' + MEMBER, 'member:' + THIRD] });
  tokens.bot = bot.token;
  const ownerBot = await mintLegacyToken(engine, { name: 'g4-owner-bot', scopes: ['read', 'write'], takesHolders: ['world'] });
  await bindCredential(engine, { kind: 'token', id: ownerBot.id }, { member: OWNER, mayActFor: ['member:' + OWNER] });
  tokens.ownerBot = ownerBot.token;
  const loose = await mintLegacyToken(engine, { name: 'g4-loose', scopes: ['read', 'write'], takesHolders: ['world'] });
  tokens.loose = loose.token;
  for (const p of ['alice-example', 'bob-example', 'carol-example']) {
    await local('put_page', { slug: 'people/' + p, content: '---\ntype: person\ntitle: ' + p + '\n---\n\n' + p + ' works on the platform group.' });
  }
  __resetPrivateVisibilityCacheForTests();
}, 120_000);

afterAll(async () => {
  __correctFaults.after = undefined;
  __correctFaults.before = undefined;
  tripwire.dispose();
  await close?.();
});

describe('the fact\'s own page is the only entity', () => {
  test('a fact on no page refuses an entity, and nothing is proposed', async () => {
    const loose = await seedFact('The quarterly review moved to Thursday.', null);
    expect((await factRow(loose))!.entity_slug).toBeNull();
    const r = await remote(MEMBER, 'correct', { rule: 'The quarterly review is on Friday.', fact_id: loose, corrected_fact: 'The quarterly review is on Friday.', entity: 'people/carol-example', scope: 'team' });
    expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'invalid_params' });
    expect(await liveFacts('people/carol-example')).toEqual([]);
  });

  test('a replacement with entity omitted is saved on the fact\'s own page', async () => {
    const wrong = await seedFact('Alice Example sits by the east window.');
    const right = 'She sits by the west window now.';
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example sits by the west window.', fact_id: wrong, corrected_fact: right, scope: 'team' });
    expect(r.json.state).toBe('proposed');
    const ok = await approve(r.json.rule_id + '@' + r.json.revision);
    expect(ok.approved).toBe(true);
    expect(await liveFacts('people/alice-example')).toContain(right);
    expect((await factRow(wrong))!.expired_at).not.toBeNull();
  });

  test('a withdrawal of a fact on the caller\'s own member page never names the page it is about', async () => {
    await local('put_page', { slug: 'people/hidden-example', content: '---\ntype: person\ntitle: hidden-example\nvisibility: private\n---\n\nKept private.' });
    const saved = await remote(MEMBER, 'remember', { fact: 'The hidden contact prefers green tea.', entity: 'people/hidden-example', visibility: 'private', provenance: 'test', content_origin: 'user_said' });
    expect(saved.isError).toBe(false);
    const id = /"id":\s*"(\d+)"/.exec(saved.text)![1]!;
    expect((await factRow(id))!.entity_slug).toBe('people/hidden-example');
    const r = await remote(MEMBER, 'correct', { rule: 'The hidden contact prefers black tea.', fact_id: id, entity: 'people/carol-example', scope: 'me' });
    expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'invalid_params' });
    expect(r.text).not.toContain('hidden-example');
  });

  test('a member cannot replace a fact on its own member page, only withdraw it', async () => {
    const saved = await remote(MEMBER, 'remember', { fact: 'Alice Example drinks green tea at noon.', entity: 'people/alice-example', visibility: 'private', provenance: 'test', content_origin: 'user_said' });
    const id = /"id":\s*"(\d+)"/.exec(saved.text)![1]!;
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example drinks black tea at noon.', fact_id: id, corrected_fact: 'Alice Example drinks black tea at noon.', scope: 'me' });
    expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'fact_not_found' });
    expect((await factRow(id))!.expired_at).toBeNull();
  });

  test('a fact never lands on a rule page through a retired page\'s redirect', async () => {
    const made = await runCorrect(localRulesCtx(engine), { rule: 'Deploys wait for a green build.', scope: 'team' }) as any;
    expect(made.state).toBe('committed');
    const slug = 'rules/' + made.rule_id;
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    await local('put_page', { slug: 'people/old-desk-example', content: '---\ntype: person\ntitle: old-desk-example\nsuperseded_by: ' + slug + '\n---\n\nRetired.' });
    const out = await local('remember', { fact: 'Deploys skip the build.', entity: 'people/old-desk-example', provenance: 'test', request_id: 'gst4000-redirect' });
    expect(JSON.stringify(out)).toMatch(/rule_owner_only|"state":"failed"/);
    expect(await liveFacts(slug)).toEqual([]);
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(before);
  });
});

describe('host resume and resumed activation', () => {
  test('a host resume of a remote owner\'s stopped fact change asks at the terminal first', async () => {
    const wrong = await seedFact('Alice Example commutes by bus.');
    const right = 'Alice Example commutes by bike.';
    __correctFaults.before = s => { if (s === 'fact') throw new Error('stopped before the fact'); };
    let r: any;
    try { r = await remote(OWNER, 'correct', { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team' }); } finally { __correctFaults.before = undefined; }
    expect(r.json.state).toBe('partial');
    const refused = await hostResume(r.json.receipt_id, noTty);
    expect(refused.code).toBe('policy_confirm_required');
    expect((await factRow(wrong))!.expired_at).toBeNull();
    const done = await hostResume(r.json.receipt_id, ownerTty());
    expect(done.state).toBe('committed');
    expect(await liveFacts('people/alice-example')).toContain(right);
  });

  test('a host resume of a remote owner\'s stopped withdrawal asks at the terminal, then withdraws the fact', async () => {
    const wrong = await seedFact('Alice Example owns a scooter.');
    __correctFaults.before = s => { if (s === 'fact') throw new Error('stopped before the fact'); };
    let r: any;
    try { r = await remote(OWNER, 'correct', { rule: 'Alice Example owns no scooter.', fact_id: wrong, scope: 'team' }); } finally { __correctFaults.before = undefined; }
    expect(r.json.state).toBe('partial');
    expect((await hostResume(r.json.receipt_id, noTty)).code).toBe('policy_confirm_required');
    expect((await factRow(wrong))!.expired_at).toBeNull();
    expect((await hostResume(r.json.receipt_id, ownerTty())).state).toBe('committed');
    expect((await factRow(wrong))!.expired_at).not.toBeNull();
  });

  test('a host resume of a remote owner\'s rule with no fact change still asks before making it active', async () => {
    __correctFaults.before = s => { if (s === 'activate') throw new Error('stopped before activation'); };
    let r: any;
    try { r = await remote(OWNER, 'correct', { rule: 'Retros run every second Friday.', scope: 'team' }); } finally { __correctFaults.before = undefined; }
    expect(r.json.state).toBe('partial');
    expect((await hostResume(r.json.receipt_id, noTty)).code).toBe('policy_confirm_required');
    expect((await frontmatter('rules/' + r.json.rule_id))?.status).toBe('proposed');
    expect((await hostResume(r.json.receipt_id, ownerTty())).state).toBe('committed');
  });

  test('a receipt edited while the owner answers a host resume is refused and changes nothing', async () => {
    const a = await seedFact('Alice Example uses desk one.');
    const b = await seedFact('Alice Example uses desk two.');
    __correctFaults.before = s => { if (s === 'fact') throw new Error('stopped before the fact'); };
    let r: any;
    try { r = await remote(OWNER, 'correct', { rule: 'Alice Example uses desk three.', fact_id: a, corrected_fact: 'Alice Example uses desk three.', scope: 'team' }); } finally { __correctFaults.before = undefined; }
    const key = RECEIPT_PREFIX + r.json.receipt_id;
    const probe: TerminalProbe = { ...ownerTty(), readAnswer: async p => {
      const s = JSON.parse((await engine.getConfig(key))!);
      s.fact = { ...s.fact, action: 'withdraw', id: b, text: null };
      await engine.setConfig(key, JSON.stringify(s));
      return /Type ([0-9a-f]+) /.exec(p)![1]!.slice(0, CONFIRM_CODE_LENGTH);
    } };
    expect((await hostResume(r.json.receipt_id, probe)).code).toBe('rule_transition');
    expect((await factRow(a))!.expired_at).toBeNull();
    expect((await factRow(b))!.expired_at).toBeNull();
  });

  test('an activation stopped after its write finishes when resumed from another connection', async () => {
    let fired = false;
    __correctFaults.after = s => { if (s === 'activate' && !fired) { fired = true; throw new Error('stopped after activation'); } };
    let r: any;
    try { r = await remote(OWNER, 'correct', { rule: 'Standups start at nine.', scope: 'team' }); } finally { __correctFaults.after = undefined; }
    expect(r.json.state).toBe('partial');
    const done = await hostResume(r.json.receipt_id, ownerTty());
    expect(done.state).toBe('committed');
  });
});

describe('who may save a rule, and whose receipt it is', () => {
  test('the owner\'s credential acting for an audience proposes, and its own rule stays private to the owner', async () => {
    const wrong = await seedFact('Alice Example sits in row one.');
    const r = await remote('ownerBot', 'correct', { rule: 'Alice Example sits in row two.', fact_id: wrong, corrected_fact: 'Alice Example sits in row two.', scope: 'team' }, [OWNER]);
    expect(r.json.state).toBe('proposed');
    expect((await factRow(wrong))!.expired_at).toBeNull();
    const mine = await remote('ownerBot', 'correct', { rule: 'I take calls after ten.', scope: 'me' }, [OWNER]);
    expect(mine.json.state).toBe('proposed');
    const fm = await frontmatter('rules/' + mine.json.rule_id);
    expect({ visibility: fm?.visibility, readable_by: fm?.readable_by }).toEqual({ visibility: 'private', readable_by: undefined });
  });

  test('a call made for a guest audience is refused', async () => {
    const r = await remote('bot', 'correct', { rule: 'Guests get the lobby wifi.', scope: 'team' }, ['guest']);
    expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'correct_guest_refused' });
  });

  test('a call carrying a guest attribution is refused, even for a member audience', async () => {
    const r = await remote('bot', 'correct', { rule: 'The guest room has a projector.', scope: 'team' }, [MEMBER], 'visitor-example');
    expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'correct_guest_refused' });
  });

  test('a remote owner cannot propose replacing a fact only the host can replace', async () => {
    const hidden = await local('remember', { fact: 'Alice Example keeps a spare key.', entity: 'people/alice-example', visibility: 'private', provenance: 'test seed', request_id: 'gst4000-private-1' });
    const r = await remote(OWNER, 'correct', { rule: 'Alice Example keeps no spare key.', fact_id: String(hidden.id), corrected_fact: 'Alice Example keeps no spare key.', scope: 'team' });
    expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'fact_not_found' });
    expect((await factRow(String(hidden.id)))!.expired_at).toBeNull();
  });

  test('the owner speaking for itself replaces a private fact on its own member page', async () => {
    const saved = await remote(OWNER, 'remember', { fact: 'Alice Example parks on level two.', entity: 'people/alice-example', visibility: 'private', provenance: 'test', content_origin: 'user_said' });
    expect(saved.isError).toBe(false);
    const id = /"id":\s*"(\d+)"/.exec(saved.text)![1]!;
    const right = 'Alice Example parks on level three.';
    const r = await remote(OWNER, 'correct', { rule: right, fact_id: id, corrected_fact: right, scope: 'team' });
    expect({ isError: r.isError, state: r.json.state }).toEqual({ isError: false, state: 'committed' });
    expect((await factRow(id))!.expired_at).not.toBeNull();
    const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE fact=$1 AND expired_at IS NULL', [right]);
    expect(row!.n).toBe(1);
  });

  test('a correction never names a fact in another member\'s personal source', async () => {
    const seeded = await seedFact('Alice Example keeps a diary in the top drawer.');
    await engine.executeRaw("INSERT INTO access_member_sources (member_id, source_id) VALUES ($1, 'default')", [THIRD]);
    try {
      const r = await remote(MEMBER, 'correct', { rule: 'Alice Example keeps a diary in the bottom drawer.', fact_id: seeded, scope: 'team', dry_run: true });
      expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'fact_not_found' });
      expect(r.text).not.toContain('people/alice-example');
    } finally {
      await engine.executeRaw("DELETE FROM access_member_sources WHERE source_id = 'default'");
    }
  });

  test('a withdrawn fact cannot be named by a new correction', async () => {
    const gone = await seedFact('Alice Example rides the night bus.');
    const out = await local('forget', { id: gone, reason: 'test' });
    expect((await factRow(gone))!.expired_at).not.toBeNull();
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example rides the day bus.', fact_id: gone, corrected_fact: 'Alice Example rides the day bus.', scope: 'team' });
    expect({ out: !!out, isError: r.isError, code: r.json.code }).toEqual({ out: true, isError: true, code: 'fact_not_found' });
  });

  test('a retry of an approved correction returns its receipt after the fact is withdrawn', async () => {
    const wrong = await seedFact('Alice Example walks to work.');
    const call = { rule: 'Alice Example cycles to work.', fact_id: wrong, scope: 'team', request_id: 'gst4000-retry-1' };
    const r = await remote(MEMBER, 'correct', call);
    expect((await approve(r.json.rule_id + '@' + r.json.revision)).approved).toBe(true);
    expect((await factRow(wrong))!.expired_at).not.toBeNull();
    const again = await remote(MEMBER, 'correct', call);
    expect({ isError: again.isError, receipt_id: again.json.receipt_id, state: again.json.state }).toEqual({ isError: false, receipt_id: r.json.receipt_id, state: 'committed' });
  });

  test('a dry run saves no rule and changes no fact', async () => {
    const wrong = await seedFact('Alice Example takes the early train.');
    const rules = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'rules/%'"))[0]!.n;
    const before = await rules();
    const r = await remote(OWNER, 'correct', { rule: 'Alice Example takes the late train.', fact_id: wrong, corrected_fact: 'Alice Example takes the late train.', scope: 'team', dry_run: true });
    expect({ isError: r.isError, dry_run: r.json.dry_run }).toEqual({ isError: false, dry_run: true });
    expect(await rules()).toBe(before);
    expect((await factRow(wrong))!.expired_at).toBeNull();
  });

  test('a scope me rule from a connection that acts for no member is refused', async () => {
    const r = await remote('loose', 'correct', { rule: 'I like the standing desk.', scope: 'me' });
    expect({ isError: r.isError, code: r.json.code }).toEqual({ isError: true, code: 'invalid_params' });
  });

  test('a shared credential keeps each audience\'s receipts apart', async () => {
    const made = await remote('bot', 'correct', { rule: 'The kitchen closes at six.', scope: 'team', request_id: 'gst4000-shared' }, [MEMBER]);
    expect(made.json.state).toBe('proposed');
    const other = await remote('bot', 'correct', { receipt_id: made.json.receipt_id }, [THIRD]);
    expect({ isError: other.isError, code: other.json.code }).toEqual({ isError: true, code: 'correct_receipt_not_found' });
    const same = await remote('bot', 'correct', { receipt_id: made.json.receipt_id }, [MEMBER]);
    expect(same.json.state).toBe('proposed');
  });
});

describe('team rules and approvals', () => {
  test('a member\'s team rule is never narrowed to its writer', async () => {
    const r = await remote(MEMBER, 'correct', { rule: 'Lunch orders close at eleven.', scope: 'team' });
    expect(r.json.state).toBe('proposed');
    const slug = 'rules/' + r.json.rule_id;
    expect((await frontmatter(slug))?.readable_by).toBeUndefined();
    const ok = await approve(r.json.rule_id + '@' + r.json.revision);
    expect(ok.approved).toBe(true);
    expect((await frontmatter(slug))?.readable_by).toBeUndefined();
  });

  test('an approval saved before its receipt moved on finishes on the member\'s next read', async () => {
    const wrong = await seedFact('Alice Example waters the ferns on Monday.');
    const right = 'Alice Example waters the ferns on Wednesday.';
    const r = await remote(MEMBER, 'correct', { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team' });
    let fired = false;
    __correctFaults.before = s => { if (s === 'fact' && !fired) { fired = true; throw new Error('stopped during approval'); } };
    let ok: any;
    try { ok = await approve(r.json.rule_id + '@' + r.json.revision); } finally { __correctFaults.before = undefined; }
    expect(ok.approved).toBe(false);
    const read = await remote(MEMBER, 'correct', { receipt_id: r.json.receipt_id });
    expect(read.json.state).toBe('committed');
    expect(await liveFacts('people/alice-example')).toContain(right);
  });

  test('a proposed rule page with no stored receipt is approved, then retired', async () => {
    await local('put_page', { slug: 'rules/team/hand-written-example', content: renderRulePage({ scope: 'team', status: 'proposed', text: 'Badges stay visible.', corrects: null,
      attribution: 'written by hand', receipt: '', checks: [] } as never) });
    const rev = String((await engine.readPageSnapshot('rules/team/hand-written-example', { sourceId: 'default' }))!.revision);
    const ok = await approve('team/hand-written-example@' + rev);
    expect(ok).toMatchObject({ approved: true, confirmed: true });
    expect((await frontmatter('rules/team/hand-written-example'))?.status).toBe('active');
    const gone = await retireRule(engine, 'team/hand-written-example');
    expect(gone.retired).toBe(true);
    expect((await frontmatter('rules/team/hand-written-example'))?.status).toBe('retired');
  });
});
});
