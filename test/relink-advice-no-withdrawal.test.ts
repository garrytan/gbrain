/**
 * GBRA-215 DX review: the by-hand relink advice for a fact saved without an
 * entity said "forget it and remember it again with --entity". forget records
 * a withdrawal of the claim for every entity, so following the advice refused
 * the claim for good. The advice now names remember with --entity and
 * --replaces <fact-id>, which links the saved fact (supersession) and writes no
 * withdrawal.
 *
 * Protects: the advised path links without a withdrawal, the old path is the
 * refusal it was, and no relink fix or doctor line tells the user to forget
 * before remembering. PGLite, database-only source. Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { RELINK_REASONS } from '../src/core/facts/relink-reasons.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const CLAIM = 'Alice Example renewed the office lease relinkadvice';
const ENTITY = 'people/alice-example';
let engine: PGLiteEngine;
const ctx = () => ({ engine, config: { engine: 'pglite', embedding_disabled: true }, remote: false, sourceId: 'default', dryRun: false, logger: console }) as never;
const call = (name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx(), { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const ledger = async () => (await engine.executeRaw<{ subject: string }>(
  `SELECT subject FROM fact_withdrawals WHERE source_id='default' AND fact_hash=gbrain_fact_fingerprint($1)`, [CLAIM])).map(r => r.subject);

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage(ENTITY, { type: 'person' as never, title: 'Alice Example', compiled_truth: '# Alice Example', timeline: '', frontmatter: {} });
});

async function savedWithoutEntity(): Promise<string> {
  const saved = await call('remember', { fact: CLAIM, provenance: 'test', infer_entity: false });
  expect(saved).toMatchObject({ state: 'committed' });
  expect(saved.entity_slug ?? null).toBeNull();
  return String(saved.id);
}

test('the advised relink (remember --entity --replaces <fact-id>) links the fact and writes no withdrawal', async () => {
  const id = await savedWithoutEntity();
  const linked = await call('remember', { fact: CLAIM, provenance: 'test', entity: ENTITY, replaces: id });
  expect(linked).toMatchObject({ state: 'committed', status: 'superseded', entity_slug: ENTITY });
  expect(await ledger()).toEqual([]);
  const active = await engine.executeRaw<{ entity_slug: string | null }>(
    'SELECT entity_slug FROM facts WHERE fact=$1 AND expired_at IS NULL', [CLAIM]);
  expect(active.map(r => r.entity_slug)).toEqual([ENTITY]);
});

test('the old advice (forget, then remember with --entity) withdraws the claim for every entity', async () => {
  const id = await savedWithoutEntity();
  await call('forget', { id });
  expect(await ledger()).toEqual(['*']);
  await expect(call('remember', { fact: CLAIM, provenance: 'test', entity: ENTITY })).rejects.toThrow(/fact_withdrawn/);
});

test('no relink fix or doctor line advises forgetting a fact before remembering it with an entity', () => {
  const forgetThenRemember = /forget (it|the fact)[^.]*remember/i;
  for (const [reason, { fix }] of Object.entries(RELINK_REASONS)) expect([reason, forgetThenRemember.test(fix)]).toEqual([reason, false]);
  expect(RELINK_REASONS.ambiguous.fix).toContain('--replaces <fact-id>');
  // test-reads-source-ok[structural]: the doctor line is a prose literal inside a template; this pins its advice.
  const doctor = readFileSync(join(import.meta.dir, '../src/commands/doctor/checks/unlinked-facts.ts'), 'utf8');
  expect(forgetThenRemember.test(doctor)).toBe(false);
});
