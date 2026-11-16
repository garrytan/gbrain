/**
 * GST-2667: a passing database error in the holding-page access read prepares the fact again instead of refusing it.
 *
 * 1. Protects: on a strict git-canonical source, the attribute-fallback fact writer (writeSingleFact, the Google loops
 *    extraction's one call) holds a fact for a page-less entity on memory/unattributed. Preparation reads the access
 *    tables once (held-fact-move.ts holdingPageFor) to pick that page. An error of a class the persistence consumer
 *    prepares again (transient-retry.ts transientInterruption / transientDatabaseFailure: a statement cancel, a stale
 *    plan, contention, a dropped connection, a pooler's client cap) now reaches the consumer, which releases the request
 *    and prepares it again; the fact lands on memory/unattributed with its entity cell, committed in Git.
 * 2. Fails when: holdingPageFor maps that error to `access_unreadable`, so preparation throws the terminal
 *    `access_policy_pending` (master 503e7b65): no facts row, the request failed, and the loops job keeps its loop row
 *    with no fact. Also fails when a real refusal (a page rule, an unreadable access state, permission denied on the
 *    access tables) stops ending terminal, or when an error that never clears is prepared again without bound.
 * 3. Existing coverage: test/strict-fallback-refusal-gst2635.test.ts pins the refusals themselves;
 *    test/persistence-write-interrupted.test.ts pins the transient budget at publication.
 * 4. Real seams: the coordinated write and its consumer on PGLite and Postgres (DATABASE_URL), a managed Git checkout,
 *    the loops job as its minion handler runs it. Injection: the access read of holdingPageFor alone throws an error
 *    carrying the SQLSTATE or driver code (as persistence-write-interrupted.test.ts raises them), only between the
 *    consumer:preparing and consumer:prepared seams, a counted number of times.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const ENTITY = 'people/bob-example';
const EMAIL = 'emails/invoice-thread';
const ACCESS_READ = 'gbrain_access_state_unreadable() AS unreadable';
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
let chatReply = '{"commitments":[],"decisions_pending":[]}';
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: chatReply, blocks: [], stopReason: 'end', usage,
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
});
afterAll(() => { __setChatTransportForTests(null); resetGateway(); resetWriteSwitches(); });

const dbError = (code: string, message: string) => Object.assign(new Error(message), { code });
/** One error of each class the consumer prepares again (coordinator.ts finishUnpublishedFailure). */
const TRANSIENT: Array<[string, () => Error]> = [
  ['57014 statement cancel', () => dbError('57014', 'canceling statement due to user request')],
  ['0A000 stale plan', () => dbError('0A000', 'cached plan must not change result type')],
  ['40001 serialization failure', () => dbError('40001', 'could not serialize access due to concurrent update')],
  ['40P01 deadlock', () => dbError('40P01', 'deadlock detected')],
  ['55P03 lock not available', () => dbError('55P03', 'canceling statement due to lock timeout')],
  ['53300 too many connections', () => dbError('53300', 'sorry, too many clients already')],
  ['57P01 admin shutdown', () => dbError('57P01', 'terminating connection due to administrator command')],
  ['08006 connection failure', () => dbError('08006', 'connection failure during query')],
  ['ECONNRESET', () => dbError('ECONNRESET', 'read ECONNRESET')],
  ['CONNECTION_CLOSED', () => dbError('CONNECTION_CLOSED', 'write CONNECTION_CLOSED')],
  ['pooler client cap', () => dbError('XX000', '(EMAXCONNSESSION) max clients reached in session mode')],
];

/** Throws `error()` from holdingPageFor's access read only while an extract_facts request prepares, at most `times` times. */
function failAccessReadAtPreparation(engine: BrainEngine, error: () => Error, times: number) {
  let preparing = false;
  let thrown = 0;
  installFaultHook(async (point, detail) => {
    if (detail.operation !== 'extract_facts') return;
    if (point === 'consumer:preparing') preparing = true;
    if (point === 'consumer:prepared') preparing = false;
  });
  // A transaction's engine inherits from this one (PGLite Object.create), so the original runs on whichever engine called it.
  const original = engine.executeRaw as (this: BrainEngine, ...args: unknown[]) => Promise<unknown>;
  const spy = spyOn(engine, 'executeRaw').mockImplementation((async function (this: BrainEngine, sql: string, params?: unknown[], opts?: unknown) {
    if (preparing && thrown < times && sql.includes(ACCESS_READ)) { thrown++; throw error(); }
    return original.call(this, sql, params, opts);
  }) as typeof engine.executeRaw);
  return { thrown: () => thrown, restore() { spy.mockRestore(); installFaultHook(undefined); } };
}

const factRows = (engine: BrainEngine, claim: string) => engine.executeRaw<{ entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null }>(
  'SELECT entity_slug, source_markdown_slug, row_num FROM facts WHERE source_id=$1 AND fact=$2 ORDER BY id', ['default', claim]);
const lastFactRequest = async (engine: BrainEngine) => (await engine.executeRaw<{ state: string; error_code: string | null }>(
  `SELECT state, error_code FROM persistence_requests WHERE operation='extract_facts' AND source_id='default' AND intent->>'kind'='managed_facts_entity' ORDER BY sequence DESC LIMIT 1`))[0];
const committedHolding = (root: string, claim: string) => { try { return git(root, 'show', `HEAD:${HOLD}.md`).split('\n').filter(line => line.includes(claim)); } catch { return []; } };

type Refusal = { code?: string; message: string };
async function loopsWrite(engine: BrainEngine, claim: string): Promise<{ status: string | null; refusal: Refusal | null }> {
  try { return { status: (await writeSingleFact(engine, 'default', { fact: claim, entity: ENTITY, provenance: 'mail 2026-11-13', kind: 'commitment', visibility: 'private', remote: false })).status, refusal: null }; }
  catch (error) { return { status: null, refusal: error as Refusal }; }
  finally { await settleManagedGitEffects(engine); }
}

/** What one write left behind: its outcome, the facts row, the request row, and the committed holding-page line. */
async function outcome(b: ManagedBrain, claim: string, write: { status: string | null; refusal: Refusal | null }) {
  const rows = await factRows(b.engine, claim);
  const committed = committedHolding(b.root, claim);
  return { status: write.status, refusal: write.refusal?.code ?? null, request: (await lastFactRequest(b.engine))?.state ?? null,
    rows, committed_with_entity: committed.length === 1 && committed[0]!.includes(ENTITY) };
}
const HELD = { status: 'inserted', refusal: null, request: 'committed', rows: [{ entity_slug: ENTITY, source_markdown_slug: HOLD, row_num: expect.any(Number) }], committed_with_entity: true };

async function addPageRule(engine: BrainEngine) {
  const spy = spyOn(console, 'log').mockImplementation(() => {});
  try { await runAccessRules(engine, 'rule', ['add', '--source', 'default', '--slug', ENTITY, '--readers', 'alice-example', '--yes', '--json'], true); }
  finally { spy.mockRestore(); }
}
const unreadableAccess = (engine: BrainEngine) =>
  engine.executeRaw('CREATE OR REPLACE FUNCTION gbrain_access_state_unreadable() RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$');

/** The loops job as its minion handler runs it, on one email page whose commitment names ENTITY (as in the GST-2635 test). */
async function runLoopsJob({ engine, ctx }: ManagedBrain, claim: string) {
  await engine.setConfig('loops.extraction_enabled', 'true');
  await operationsByName.put_page!.handler(ctx, { slug: EMAIL, request_id: randomUUID(),
    content: `---\ntitle: Invoice thread\ntype: email\nthread_id: invoice-thread\nfrom: bob@example.invalid\n---\nI will send Bob the invoice summary by Friday.\n` });
  await settleManagedGitEffects(engine);
  chatReply = JSON.stringify({ commitments: [{ text: claim, direction: 'owed_by_me', counterparty_name: ENTITY, counterparty_email: '',
    due_iso: '2026-11-20', quote: 'I will send Bob the invoice summary by Friday.' }], decisions_pending: [] });
  const warned: string[] = [];
  const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
  try {
    const result = await runLoopsExtract(engine, { slug: EMAIL, sourceId: 'default' });
    await settleManagedGitEffects(engine);
    const loops = await engine.executeRaw<{ fact_id: number | null; summary: string }>('SELECT fact_id, summary FROM open_loops WHERE source_id=$1', ['default']);
    return { result, loops, log: warned.filter(line => line.startsWith('[loops_extract] fact projection failed')) };
  } finally { spy.mockRestore(); }
}

for (const backend of testBackends()) describe(`[${backend}] GST-2667: a transient error in the holding-page access read at preparation`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const strict = (run: (brain: ManagedBrain) => Promise<void>) => managedBrain(async b => {
    await b.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await run(b);
  }, { databaseUrl, setup: gitRepo });

  test('one error of each class the consumer retries prepares the write again and holds the fact on memory/unattributed', () => strict(async b => {
    const seen: Array<Record<string, unknown>> = [];
    for (const [name, error] of TRANSIENT) {
      const claim = `Send Bob example the invoice summary (${name}).`;
      const fault = failAccessReadAtPreparation(b.engine, error, 1);
      const write = await loopsWrite(b.engine, claim).finally(() => fault.restore());
      seen.push({ class: name, thrown: fault.thrown(), ...await outcome(b, claim, write) });
    }
    expect(seen).toEqual(TRANSIENT.map(([name]) => ({ class: name, thrown: 1, ...HELD })));
  }), 300_000);

  test('the loops job writes the fact after a transient access read and its loop row points at it', () => strict(async b => {
    const claim = 'Send Bob example the invoice summary by Friday.';
    const fault = failAccessReadAtPreparation(b.engine, () => dbError('40001', 'could not serialize access due to concurrent update'), 1);
    const { result, loops, log } = await runLoopsJob(b, claim).finally(() => fault.restore());
    expect(fault.thrown()).toBe(1);
    expect(result).toMatchObject({ status: 'extracted', commitments: 1 });
    expect(log).toEqual([]);
    const rows = await b.engine.executeRaw<{ id: number; entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null }>(
      'SELECT id, entity_slug, source_markdown_slug, row_num FROM facts WHERE source_id=$1 AND fact=$2', ['default', claim]);
    expect(rows).toMatchObject([{ entity_slug: ENTITY, source_markdown_slug: HOLD, row_num: expect.any(Number) }]);
    expect(loops.map(loop => ({ fact_id: Number(loop.fact_id), summary: loop.summary }))).toEqual([{ fact_id: Number(rows[0]!.id), summary: claim }]);
    expect(committedHolding(b.root, claim)).toHaveLength(1);
  }), 300_000);

  for (const arm of ['page_rule', 'access_unreadable', 'permission_denied'] as const) {
    test(`a real refusal still ends terminal and writes nothing (${arm})`, () => strict(async b => {
      const claim = `Send Bob example the invoice summary (${arm}).`;
      let armed = true;
      const fault = arm === 'permission_denied' ? failAccessReadAtPreparation(b.engine, () => dbError('42501', 'permission denied for table access_rules'), 1) : null;
      if (!fault) installFaultHook(async (point, detail) => {
        if (!armed || point !== 'consumer:preparing' || detail.operation !== 'extract_facts') return;
        armed = false;
        if (arm === 'page_rule') await addPageRule(b.engine); else await unreadableAccess(b.engine);
      });
      const write = await loopsWrite(b.engine, claim).finally(() => { fault?.restore(); installFaultHook(undefined); });
      if (fault) expect(fault.thrown()).toBe(1); else expect(armed).toBe(false);
      expect(await outcome(b, claim, write)).toEqual({ status: null, refusal: arm === 'page_rule' ? 'git_home_required' : 'access_policy_pending',
        request: 'failed', rows: [], committed_with_entity: false });
      expect(write.refusal!.message).toContain(ENTITY);
    }), 300_000);
  }

  test('a transient error that never clears ends at the charged-interruption limit and writes nothing', () => strict(async b => {
    await b.engine.setConfig('persistence.max_transient_retries', '1');
    resetWriteSwitches();
    try {
      const claim = 'Send Bob example the invoice summary (never clears).';
      const fault = failAccessReadAtPreparation(b.engine, () => dbError('57014', 'canceling statement due to user request'), Number.POSITIVE_INFINITY);
      const write = await loopsWrite(b.engine, claim).finally(() => fault.restore());
      const request = await lastFactRequest(b.engine);
      expect({ thrown: fault.thrown(), refusal: write.refusal?.code ?? null, request }).toEqual({ thrown: 2, refusal: 'write_interrupted',
        request: { state: 'failed', error_code: 'write_interrupted' } });
      expect(await factRows(b.engine, claim)).toEqual([]);
      expect(committedHolding(b.root, claim)).toEqual([]);
    } finally {
      await b.engine.executeRaw("DELETE FROM config WHERE key='persistence.max_transient_retries'");
      resetWriteSwitches();
    }
  }), 300_000);
});
