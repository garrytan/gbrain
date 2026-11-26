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
import { runRulesCheck } from '../src/core/rules/check.ts';
import { runRulesRegressionDoctor } from '../src/commands/doctor/checks/rules-regression.ts';
import { CONFIRM_CODE_LENGTH, type TerminalProbe } from '../src/core/policy/authority.ts';
import { installTripwire, type Tripwire } from './helpers/ai-tripwire.ts';

const OWNER = 'alice-example';
const MEMBER = 'bob-example';
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
  for (const m of [OWNER, MEMBER]) await addMember(engine, m, { remote: false });
  await setOwner(engine, OWNER);
  await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('source-a', 'source-a', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
  for (const who of [OWNER, MEMBER]) {
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
