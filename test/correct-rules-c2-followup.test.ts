/**
 * Agent platform C2 follow-up: the correct verb's deferred review findings and open notes.
 *
 * An owner approval interrupted by a pending write finishes later; retire and approve never interleave; the first
 * rule write never replaces another proposal; a retried withdrawal reports only its own change; open proposals are
 * capped per caller; approval shows and checks the entity; rules check refuses an unknown id and doctor reads every
 * source, and notes the pages remote writers can no longer change.
 *
 * Keyless repo-less PGLite brain, no model calls (tripwire). Synthetic names only.
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
import { OperationError, type AuthInfo } from '../src/core/ops/contract.ts';
import { __correctFaults, approveRule, localRulesCtx, OPEN_RECEIPTS_PER_PRINCIPAL, retireRule, runCorrect } from '../src/core/rules/correct.ts';
import { approvalDigest } from '../src/core/rules/confirm.ts';
import { readRule, renderRulePage, ruleDigest } from '../src/core/rules/record.ts';
import { withRegisteredLocalWriter } from '../src/core/persistence/identity.ts';
import { withRemoteCaller } from '../src/core/remote-caller.ts';
import { runRulesCheck } from '../src/core/rules/check.ts';
import { runRulesRegressionDoctor } from '../src/commands/doctor/checks/rules-regression.ts';
import { CONFIRM_CODE_LENGTH, type TerminalProbe } from '../src/core/policy/authority.ts';
import { installTripwire, type Tripwire } from './helpers/ai-tripwire.ts';

const OWNER = 'alice-example';
const MEMBER = 'bob-example';
const THIRD = 'carol-example';
let engine: BrainEngine;
let close: (() => Promise<void>) | undefined;
let tripwire: Tripwire;
const tokens: Record<string, string> = {};

const local = (op: string, params: Record<string, unknown>) => handleToolCall(engine, op, params) as Promise<any>;
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function remote(who: string, op: string, params: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }> {
  const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'], inboundFrameBytes: 4 * 1024 * 1024 } as never);
  const text = out.content.map((c: { text: string }) => c.text).join('\n');
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* prose */ }
  return { isError: out.isError === true, text, json };
}

const ownerTty = (): TerminalProbe => ({ env: {}, stdinIsTTY: true, stderrIsTTY: true,
  readAnswer: async prompt => /Type ([0-9a-f]+) /.exec(prompt)![1]!.slice(0, CONFIRM_CODE_LENGTH) });
const noTty: TerminalProbe = { env: {}, stdinIsTTY: false, stderrIsTTY: false };

async function approveShowing(ref: string): Promise<{ out: any; shown: string }> {
  const written: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: string) => { written.push(String(s)); return true; };
  try {
    const out = await approveRule(engine, ref, { probe: ownerTty() }).catch(e => e);
    return { out, shown: written.join('') };
  } finally { (process.stderr as any).write = orig; }
}

let factSeq = 0;
async function seedFact(text: string, entity = 'people/alice-example'): Promise<string> {
  const r = await local('remember', { fact: text, entity, provenance: 'test seed', request_id: `seed-f-${++factSeq}` });
  return String(r.id);
}
async function factRow(id: string) {
  const [row] = await engine.executeRaw<{ expired_at: string | null }>('SELECT expired_at::text FROM facts WHERE id=$1', [Number(id)]);
  return row;
}
async function liveFacts(entity = 'people/alice-example') {
  return (await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE entity_slug=$1 AND expired_at IS NULL ORDER BY id', [entity])).map(r => r.fact);
}
const doctorCtx = () => ({ engine, args: [], jsonOutput: true, fastMode: false, doFix: false, dryRun: false }) as never;

for (const kind of testBackends()) describe(`correct follow-up (${kind})`, () => {
beforeAll(async () => {
  tripwire = installTripwire();
  if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
  for (const m of [OWNER, MEMBER, THIRD]) await addMember(engine, m, { remote: false });
  await setOwner(engine, OWNER);
  await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('source-a', 'source-a', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
  for (const who of [OWNER, MEMBER, THIRD]) {
    const minted = await mintLegacyToken(engine, { name: 'c2f-' + who, scopes: ['read', 'write'], takesHolders: ['world'] });
    await bindCredential(engine, { kind: 'token', id: minted.id }, { member: who });
    tokens[who] = minted.token;
  }
  for (const p of ['alice-example', 'bob-example']) {
    await local('put_page', { slug: `people/${p}`, content: `---\ntype: person\ntitle: ${p}\n---\n\n${p} works on the platform group.` });
  }
  __resetPrivateVisibilityCacheForTests();
}, 120_000);

afterAll(async () => {
  __correctFaults.after = undefined;
  __correctFaults.before = undefined;
  __correctFaults.claimed = undefined;
  tripwire.dispose();
  await close?.();
});

describe('an owner approval interrupted by a pending write', () => {
  for (const poller of ['member', 'host'] as const) {
    test(`finishes on the next ${poller} status read, writing the fact once`, async () => {
      const wrong = await seedFact(`Alice Example parks in lot ${poller}-a.`);
      const right = `Alice Example parks in lot ${poller}-c.`;
      const r = await remote(MEMBER, 'correct', { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team' });
      expect(r.json.state).toBe('proposed');
      let fired = false;
      __correctFaults.after = s => { if (s === 'fact' && !fired) { fired = true; throw new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt again.'); } };
      let ok: any;
      try { ok = await approveRule(engine, `${r.json.rule_id}@${r.json.revision}`, { probe: ownerTty() }); } finally { __correctFaults.after = undefined; }
      expect(ok).toMatchObject({ approved: false, receipt: { state: 'pending', step: 'fact' } });
      const polled = poller === 'member'
        ? (await remote(MEMBER, 'correct', { receipt_id: r.json.receipt_id })).json
        : await runCorrect(localRulesCtx(engine), { receipt_id: r.json.receipt_id }) as any;
      expect(polled).toMatchObject({ state: 'committed', confirmed: true, effect: { rule: 'active', fact: 'replaced', standing: true } });
      expect((await liveFacts()).filter(f => f === right)).toHaveLength(1);
      expect((await factRow(wrong))!.expired_at).not.toBeNull();
    });
  }

  test('a member receipt with no owner approval still never advances on a host read', async () => {
    const wrong = await seedFact('Alice Example parks in lot z.');
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example parks in lot y.', fact_id: wrong, corrected_fact: 'Alice Example parks in lot y.', scope: 'team' });
    const read = await runCorrect(localRulesCtx(engine), { receipt_id: r.json.receipt_id, resume: true }) as any;
    expect(read.state).toBe('proposed');
    expect((await factRow(wrong))!.expired_at).toBeNull();
  });
});

describe('retire and approve never interleave', () => {
  test('a retire started while an approval runs waits for it, then retires the finished rule', async () => {
    const wrong = await seedFact('Alice Example rides a green bike.');
    const right = 'Alice Example rides a grey bike.';
    const r = await remote(MEMBER, 'correct', { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team' });
    let retiring: Promise<any> | null = null;
    __correctFaults.before = async s => {
      if (s !== 'fact' || retiring) return;
      retiring = retireRule(engine, r.json.rule_id);
      await Promise.race([retiring, sleep(3000)]);
    };
    let ok: any;
    try { ok = await approveRule(engine, `${r.json.rule_id}@${r.json.revision}`, { probe: ownerTty() }); } finally { __correctFaults.before = undefined; }
    expect(await retiring).toMatchObject({ retired: true });
    expect(ok).toMatchObject({ approved: true });
    const receipt = (await remote(MEMBER, 'correct', { receipt_id: r.json.receipt_id })).json;
    expect(receipt).toMatchObject({ state: 'committed', effect: { fact: 'replaced' } });
    expect((await engine.getPage(`rules/${r.json.rule_id}`))!.frontmatter.status).toBe('retired');
    expect((await liveFacts()).filter(f => f === right)).toHaveLength(1);
  });
});

describe('the first rule write is create-only', () => {
  test('a same-slug page that appears before the write is never replaced', async () => {
    const text = 'Planning notes for alice-example go in the team folder.';
    const other = '---\ntype: rule\ntitle: other\nscope: team\nstatus: proposed\nrule: Planning notes for alice-example go in the team folder.\nattribution: saved by another agent\nreceipt: cr-00000000000000aa\n---\n\nAnother proposal.';
    let slug = '';
    __correctFaults.before = async (s, receipt) => {
      if (s !== 'rule' || slug) return;
      slug = receipt.rule.slug;
      await local('put_page', { slug, content: other });
    };
    let out: any;
    try { out = await runCorrect(localRulesCtx(engine), { rule: text, scope: 'team' }, { probe: noTty }).catch(e => e); } finally { __correctFaults.before = undefined; }
    expect(out.code).toBe('rule_exists');
    const page = await engine.getPage(slug);
    expect(page!.frontmatter).toMatchObject({ receipt: 'cr-00000000000000aa', attribution: 'saved by another agent' });
  });
});

describe('a retried withdrawal reports only its own change', () => {
  test('a fact withdrawn by something else is reported as already withdrawn', async () => {
    const wrong = await seedFact('Alice Example owns a kayak.');
    __correctFaults.before = s => { if (s === 'fact') throw new Error('killed'); };
    let first: any;
    try { first = await runCorrect(localRulesCtx(engine), { rule: 'Alice Example owns no kayak.', fact_id: wrong, request_id: 'withdraw-other' }, { probe: noTty }); } finally { __correctFaults.before = undefined; }
    expect(first).toMatchObject({ state: 'partial', step: 'fact' });
    await local('forget', { id: wrong, reason: 'someone else' });
    const resumed = await runCorrect(localRulesCtx(engine), { receipt_id: first.receipt_id, resume: true }) as any;
    expect(resumed.state).toBe('committed');
    expect(resumed.effect.fact).toBe('already_withdrawn');
  });

  test('its own withdrawal, committed before a stop, is still reported as withdrawn', async () => {
    const wrong = await seedFact('Alice Example owns a canoe.');
    __correctFaults.after = s => { if (s === 'fact') throw new Error('killed'); };
    let first: any;
    try { first = await runCorrect(localRulesCtx(engine), { rule: 'Alice Example owns no canoe.', fact_id: wrong, request_id: 'withdraw-own' }, { probe: noTty }); } finally { __correctFaults.after = undefined; }
    expect(first).toMatchObject({ state: 'partial', step: 'fact' });
    const resumed = await runCorrect(localRulesCtx(engine), { receipt_id: first.receipt_id, resume: true }) as any;
    expect(resumed).toMatchObject({ state: 'committed', effect: { fact: 'withdrawn' } });
  });
});

describe('approval shows and checks the entity', () => {
  test('a correction naming a rules/ page as its entity is refused before anything is written', async () => {
    const wrong = await seedFact('Alice Example uses a standing desk.');
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example uses a sitting desk.', fact_id: wrong, corrected_fact: 'Alice Example uses a sitting desk.', entity: 'rules/team/some-rule', scope: 'team' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('invalid_params');
    expect((await engine.executeRaw("SELECT slug FROM pages WHERE slug LIKE 'rules/team/alice-example-uses-a-sitting%'"))).toHaveLength(0);
  });

  test('a correction whose entity is not the fact\'s page is refused', async () => {
    const wrong = await seedFact('Alice Example lives on Elm Street.');
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example lives on Oak Street.', fact_id: wrong, corrected_fact: 'Alice Example lives on Oak Street.', entity: 'people/bob-example', scope: 'team' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('invalid_params');
    expect((await factRow(wrong))!.expired_at).toBeNull();
  });

  test('the approval prompt names the entity the rule corrects', async () => {
    const wrong = await seedFact('Alice Example takes the early train.');
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example takes the late train.', fact_id: wrong, corrected_fact: 'Alice Example takes the late train.', entity: 'people/alice-example', scope: 'team' });
    const { out, shown } = await approveShowing(`${r.json.rule_id}@${r.json.revision}`);
    expect(out).toMatchObject({ approved: true });
    expect(shown).toContain('Corrects: people/alice-example');
    expect(shown).toContain('(on people/alice-example)');
  });

  test('an approval of a stored receipt that names a rules/ entity is refused and changes nothing', async () => {
    const wrong = await seedFact('Alice Example drinks black coffee.');
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example drinks green tea.', fact_id: wrong, corrected_fact: 'Alice Example drinks green tea.', scope: 'team' });
    const key = `correct.receipt.${r.json.receipt_id}`;
    const stored = JSON.parse((await engine.getConfig(key))!);
    stored.fact.entity = `rules/${r.json.rule_id}`;
    await engine.setConfig(key, JSON.stringify(stored));
    const { out } = await approveShowing(`${r.json.rule_id}@${r.json.revision}`);
    expect(out.code).toBe('invalid_params');
    expect((await factRow(wrong))!.expired_at).toBeNull();
  });
});

describe('rules check and doctor', () => {
  test('rules check refuses an unknown id and names a rule it did not check', async () => {
    await expect(runRulesCheck(engine, { id: 'me/no-such-rule-000000' })).rejects.toMatchObject({ code: 'page_not_found' });
    const p = await runCorrect(localRulesCtx(engine), { rule: 'The heron review happens on Wednesdays.', scope: 'team' }, { probe: noTty }) as any;
    const unconfirmed = await runRulesCheck(engine, { id: p.rule_id });
    expect(unconfirmed).toMatchObject({ checked: 0, not_checked: { rule_id: p.rule_id } });
    const c = await runCorrect(localRulesCtx(engine), { rule: 'The egret launch happens in May.', scope: 'team', checks: [{ question: 'egret launch', expect: ['May'], reject: [] }] }, { probe: ownerTty() }) as any;
    expect(await runRulesCheck(engine, { id: `rules/${c.rule_id}` })).toMatchObject({ checked: 1, failed: 0 });
  });

  test('doctor checks the rules of every source', async () => {
    const c = await runCorrect(localRulesCtx(engine, 'source-a'), { rule: 'The osprey launch happens in June.', scope: 'team', source_id: 'source-a',
      checks: [{ question: 'osprey launch', expect: ['June'], reject: ['July'] }] }, { probe: ownerTty() }) as any;
    expect(c.confirmed).toBe(true);
    await local('put_page', { slug: 'notes/osprey', source_id: 'source-a', content: '---\ntitle: osprey launch\n---\n\nThe osprey launch moved to July.' });
    const [check] = await runRulesRegressionDoctor(doctorCtx());
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain(`source-a:${c.rule_id}`);
  });

  test('doctor notes pages remote writers can no longer change', async () => {
    await local('put_page', { slug: 'rules/legacy-checklist', content: '---\ntitle: Legacy checklist\n---\n\nAn old page kept under rules/.' });
    await local('put_page', { slug: 'policies/expense-example', content: '---\ntype: rule\ntitle: Expense rule\n---\n\nReceipts over a limit need a note.' });
    const checks = await runRulesRegressionDoctor(doctorCtx());
    const note = checks.find(c => c.name === 'rules_regression')!;
    const pages = (note.details as any).owner_only_pages as Array<{ source_id: string; slug: string }>;
    expect(pages.map(p => p.slug)).toEqual(expect.arrayContaining(['rules/legacy-checklist', 'policies/expense-example']));
    expect(note.message).toContain('remote writers');
  });
});

describe('second review round: races, forged approvals and entity spellings', () => {
  test('a page that appears between the absence check and the first write is refused at publication', async () => {
    const text = 'Retro notes for alice-example go in the shared folder.';
    const other = '---\ntype: rule\ntitle: other\nscope: team\nstatus: proposed\nrule: Retro notes for alice-example go in the shared folder.\nattribution: saved by a host writer\nreceipt: cr-00000000000000bb\n---\n\nAnother proposal.';
    let slug = '';
    const proto = Object.getPrototypeOf(engine);
    __correctFaults.before = async (s, receipt) => {
      if (s !== 'rule' || slug) return;
      slug = receipt.rule.slug;
      await local('put_page', { slug, content: other });
      let hidden = false;
      (engine as any).readPageSnapshot = async function (this: unknown, sl: string, o: unknown) { if (sl === slug && !hidden) { hidden = true; return null; } return proto.readPageSnapshot.call(this, sl, o); };
    };
    let out: any;
    try { out = await runCorrect(localRulesCtx(engine), { rule: text, scope: 'team' }, { probe: noTty }).catch(e => e); } finally { __correctFaults.before = undefined; delete (engine as any).readPageSnapshot; }
    expect(out.code).toBe('rule_exists');
    expect((await engine.getPage(slug))!.frontmatter).toMatchObject({ receipt: 'cr-00000000000000bb', attribution: 'saved by a host writer' });
  });

  test('an owner correction approved after a stop, then polled while its fact write was pending, ends confirmed', async () => {
    const wrong = await seedFact('Alice Example sits by the window.');
    const right = 'Alice Example sits by the door.';
    __correctFaults.before = s => { if (s === 'fact') throw new Error('killed'); };
    let first: any;
    try { first = await runCorrect(localRulesCtx(engine), { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team', request_id: 'owner-approve-poll' }, { probe: noTty }); } finally { __correctFaults.before = undefined; }
    expect(first).toMatchObject({ state: 'partial', step: 'fact' });
    let fired = false;
    __correctFaults.after = s => { if (s === 'fact' && !fired) { fired = true; throw new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt again.'); } };
    let ok: any;
    try { ok = await approveRule(engine, `${first.rule_id}@${first.revision}`, { probe: ownerTty() }); } finally { __correctFaults.after = undefined; }
    expect(ok).toMatchObject({ approved: false, receipt: { state: 'pending' } });
    const polled = await runCorrect(localRulesCtx(engine), { receipt_id: first.receipt_id }) as any;
    expect(polled).toMatchObject({ state: 'committed', confirmed: true });
  });

  test('a retry that finishes the correction before its creator holds the lease leaves the receipt intact', async () => {
    const params = { rule: 'Heron standups start at nine for alice-example.', scope: 'team', request_id: 'lease-race-1' };
    let retried: any = null;
    __correctFaults.claimed = async () => {
      if (retried) return;
      retried = await runCorrect(localRulesCtx(engine), params, { probe: noTty });
    };
    let out: any;
    try { out = await runCorrect(localRulesCtx(engine), params, { probe: noTty }).catch(e => e); } finally { __correctFaults.claimed = undefined; }
    expect(retried.state).toBe('committed');
    expect(out).toMatchObject({ state: 'committed', receipt_id: retried.receipt_id });
    expect(await engine.getConfig(`correct.receipt.${retried.receipt_id}`)).not.toBeNull();
  });

  test('a rule retired before its receipt was settled is settled by the next retire', async () => {
    const r = await remote(MEMBER, 'correct', { rule: 'Egret demos run on Fridays for alice-example.', scope: 'team' });
    expect(r.json.state).toBe('proposed');
    const slug = `rules/${r.json.rule_id}`;
    const rule = readRule({ ...(await engine.getPage(slug))!, source_id: 'default' } as never)!;
    await local('put_page', { slug, content: renderRulePage({ scope: rule.scope, status: 'retired', text: rule.text, corrects: rule.corrects, attribution: rule.attribution, receipt: rule.receipt ?? '', checks: rule.checks }), expected_revision: r.json.revision });
    expect((await engine.getPage(slug))!.frontmatter.status).toBe('retired');
    expect(await retireRule(engine, r.json.rule_id)).toMatchObject({ retired: true, unchanged: true });
    expect((await remote(MEMBER, 'correct', { receipt_id: r.json.receipt_id })).json.state).toBe('conflicted');
  });

  test('an approval written into a receipt by anything but the owner\'s approval confirms nothing', async () => {
    const wrong = await seedFact('Alice Example keeps a cactus.');
    const r = await remote(MEMBER, 'correct', { rule: 'Alice Example keeps a fern.', fact_id: wrong, corrected_fact: 'Alice Example keeps a fern.', scope: 'team' });
    const key = `correct.receipt.${r.json.receipt_id}`;
    const stored = JSON.parse((await engine.getConfig(key))!);
    const digest = ruleDigest(stored.rule);
    const bound = approvalDigest(digest, { action: 'replace', id: stored.fact.id, text: stored.fact.text });
    stored.approval = { revision: stored.steps.rule.revision, rule_digest: digest, proof: { method: 'terminal', digest: bound, at: new Date().toISOString() } };
    stored.state = 'pending'; stored.step = 'fact'; stored.steps.fact = { state: 'pending', request_id: `${stored.receipt_id}.fact` };
    await engine.setConfig(key, JSON.stringify(stored));
    const read = await runCorrect(localRulesCtx(engine), { receipt_id: r.json.receipt_id, resume: true }) as any;
    expect(read.confirmed).not.toBe(true);
    expect((await factRow(wrong))!.expired_at).toBeNull();
    expect(await engine.getConfig(`rules.confirmed.default:rules/${r.json.rule_id}`)).toBeNull();
  });

  test('an entity spelled with a leading slash that names a rules/ page is refused', async () => {
    const wrong = String((await local('remember', { fact: 'the spare cello lives in room four.', provenance: 'test seed', request_id: 'seed-unattributed-1' })).id);
    const r = await remote(MEMBER, 'correct', { rule: 'the spare cello lives in room five.', fact_id: wrong, corrected_fact: 'the spare cello lives in room five.', entity: '/rules/team/some-rule', scope: 'team' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('invalid_params');
  });

  test('a remote entity check never names the page of a fact the caller cannot read', async () => {
    await local('put_page', { slug: 'notes/bob-seating', content: '---\ntitle: Bob seating\nreadable_by: [bob-example]\n---\n\nSeating notes.' });
    const hidden = await seedFact('Bob Example prefers aisle seats.', 'notes/bob-seating');
    const r = await remote(OWNER, 'correct', { rule: 'Bob Example prefers window seats.', fact_id: hidden, corrected_fact: 'Bob Example prefers window seats.', entity: 'people/alice-example', scope: 'team' });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('notes/bob-seating');
  });

  test('a fact replaced under one connection and finished under the owner\'s approval is replaced once', async () => {
    const wrong = await seedFact('Alice Example drives a blue van.');
    const right = 'Alice Example drives a red van.';
    __correctFaults.after = s => { if (s === 'fact') throw new Error('killed'); };
    let first: any;
    try { const o = await remote(OWNER, 'correct', { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team', request_id: 'cross-principal-1' }); first = JSON.parse(o.text.slice(0, o.text.lastIndexOf('}') + 1)); } finally { __correctFaults.after = undefined; }
    expect(first).toMatchObject({ state: 'partial', step: 'fact' });
    const ok = await approveRule(engine, `${first.rule_id}@${first.revision}`, { probe: ownerTty() });
    expect(ok).toMatchObject({ approved: true });
    expect((await liveFacts()).filter(f => f === right)).toHaveLength(1);
  });

  test('approving an owner rule that is already active marks its receipt confirmed', async () => {
    const p = await runCorrect(localRulesCtx(engine), { rule: 'Kestrel reviews happen on Tuesdays.', scope: 'team' }, { probe: noTty }) as any;
    expect(p).toMatchObject({ state: 'committed', confirmed: false });
    expect(await approveRule(engine, `${p.rule_id}@${p.revision}`, { probe: ownerTty() })).toMatchObject({ approved: true });
    expect(JSON.parse((await engine.getConfig(`correct.receipt.${p.receipt_id}`))!).confirmed).toBe(true);
  });

  test('concurrent proposals never pass the per-caller cap', async () => {
    for (let i = 0; i < OPEN_RECEIPTS_PER_PRINCIPAL - 1; i++) {
      expect((await remote(THIRD, 'correct', { rule: `Concurrent cap rule ${i} for carol-example.`, scope: 'team' })).json.state).toBe('proposed');
    }
    const outs = await Promise.all([0, 1, 2].map(i => remote(THIRD, 'correct', { rule: `Concurrent last rule ${i} for carol-example.`, scope: 'team' })));
    expect(outs.filter(o => o.json.state === 'proposed')).toHaveLength(1);
    expect(outs.filter(o => o.text.includes('correct_proposals_capped'))).toHaveLength(2);
  });
});

describe('final review: approvals run only what the owner approved', () => {
  test('a remote owner names the entity of a fact on a page it reads', async () => {
    await local('put_page', { slug: 'notes/alice-only', content: '---\ntitle: Alice notes\nreadable_by: [alice-example]\n---\n\nNotes.' });
    const f = await seedFact('Alice Example prefers window seats.', 'notes/alice-only');
    const r = await remote(OWNER, 'correct', { rule: 'Alice Example prefers aisle seats.', fact_id: f, entity: 'notes/alice-only', scope: 'me' });
    expect(r.isError).toBe(false);
  });

  test('a fact change found committed on resume keeps its new fact id', async () => {
    const wrong = await seedFact('Alice Example parks on level two.');
    const right = 'Alice Example parks on level three.';
    __correctFaults.after = s => { if (s === 'fact') throw new Error('killed'); };
    let first: any;
    try { first = await runCorrect(localRulesCtx(engine), { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team', request_id: 'outcome-kept-1' }, { probe: noTty }); } finally { __correctFaults.after = undefined; }
    const key = `correct.receipt.${first.receipt_id}`;
    const stored = JSON.parse((await engine.getConfig(key))!);
    delete stored.steps.fact.fact_id;
    await engine.setConfig(key, JSON.stringify(stored));
    const resumed = await runCorrect(localRulesCtx(engine), { receipt_id: first.receipt_id, resume: true }) as any;
    expect(resumed.state).toBe('committed');
    expect(resumed.effect.new_fact_id).toBeDefined();
  });

  test('a receipt edited after the owner approved it runs what the owner approved', async () => {
    const wrong = await seedFact('Alice Example waters the plants on Monday.');
    const right = 'Alice Example waters the plants on Tuesday.';
    const r = await remote(MEMBER, 'correct', { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team' });
    let fired = false;
    __correctFaults.before = s => { if (s === 'fact' && !fired) { fired = true; throw new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt again.'); } };
    try { await approveRule(engine, `${r.json.rule_id}@${r.json.revision}`, { probe: ownerTty() }); } finally { __correctFaults.before = undefined; }
    const key = `correct.receipt.${r.json.receipt_id}`;
    const stored = JSON.parse((await engine.getConfig(key))!);
    stored.fact.entity = 'people/bob-example';
    await engine.setConfig(key, JSON.stringify(stored));
    const polled = (await remote(MEMBER, 'correct', { receipt_id: r.json.receipt_id })).json;
    expect(polled.state).toBe('committed');
    expect(await liveFacts('people/bob-example')).not.toContain(right);
  });

  test('a receipt edited while the owner reads the prompt is refused and changes nothing', async () => {
    const wrong = await seedFact('Alice Example eats lunch at noon.');
    const right = 'Alice Example eats lunch at one.';
    const r = await remote(MEMBER, 'correct', { rule: right, fact_id: wrong, corrected_fact: right, scope: 'team' });
    const key = `correct.receipt.${r.json.receipt_id}`;
    const probe: TerminalProbe = { ...ownerTty(), readAnswer: async prompt => {
      const stored = JSON.parse((await engine.getConfig(key))!);
      stored.fact.entity = 'people/bob-example';
      await engine.setConfig(key, JSON.stringify(stored));
      return /Type ([0-9a-f]+) /.exec(prompt)![1]!.slice(0, CONFIRM_CODE_LENGTH);
    } };
    const out = await approveRule(engine, `${r.json.rule_id}@${r.json.revision}`, { probe }).catch(e => e);
    expect(out.code).toBe('rule_transition');
    expect((await factRow(wrong))!.expired_at).toBeNull();
  });

  test('a receipt whose rule no longer matches the page is refused at approval', async () => {
    const r = await remote(MEMBER, 'correct', { rule: 'Bob Example takes notes in the standup.', scope: 'me' });
    const key = `correct.receipt.${r.json.receipt_id}`;
    const stored = JSON.parse((await engine.getConfig(key))!);
    delete stored.rule.readable_by;
    await engine.setConfig(key, JSON.stringify(stored));
    const out = await approveRule(engine, `${r.json.rule_id}@${r.json.revision}`, { probe: ownerTty() }).catch(e => e);
    expect(out.code).toBe('rule_transition');
  });

  test('an approved receipt finished from a stdio connection completes under the owner', async () => {
    const wrong = await seedFact('Alice Example cycles on Thursdays.');
    const right = 'Alice Example cycles on Fridays.';
    const r = await remote(MEMBER, 'correct', { rule: right, fact_id: wrong, corrected_fact: right, entity: 'people/alice-example', scope: 'team' });
    let fired = false;
    __correctFaults.before = s => { if (s === 'fact' && !fired) { fired = true; throw new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt again.'); } };
    try { await approveRule(engine, `${r.json.rule_id}@${r.json.revision}`, { probe: ownerTty() }); } finally { __correctFaults.before = undefined; }
    const polled = await withRegisteredLocalWriter(engine, 'stdio', () => withRemoteCaller(true, () => runCorrect(localRulesCtx(engine), { receipt_id: r.json.receipt_id }))) as any;
    expect(polled).toMatchObject({ state: 'committed', confirmed: true });
  });
});

describe('open proposals are capped per caller', () => {
  test('a member with the maximum open proposals is refused until one is settled', async () => {
    const ids: string[] = [];
    const open = async () => (await engine.listConfigKeys('correct.receipt.')).length;
    for (let i = 0; ids.length < OPEN_RECEIPTS_PER_PRINCIPAL; i++) {
      const r = await remote(MEMBER, 'correct', { rule: `Cap probe rule number ${i} for alice-example.`, scope: 'team' });
      if (r.json.state === 'proposed') ids.push(r.json.rule_id);
      else if (r.isError) break;
    }
    const before = await open();
    const capped = await remote(MEMBER, 'correct', { rule: 'One more cap probe rule for alice-example.', scope: 'team' });
    expect(capped.isError).toBe(true);
    expect(capped.text).toContain('correct_proposals_capped');
    expect(await open()).toBe(before);
    await retireRule(engine, ids[0]!);
    const after = await remote(MEMBER, 'correct', { rule: 'One more cap probe rule for alice-example.', scope: 'team' });
    expect(after.json.state).toBe('proposed');
    expect((await remote(OWNER, 'correct', { rule: 'The owner is never capped by a member\'s proposals.' })).json.state).toBe('committed');
  });
});
});
