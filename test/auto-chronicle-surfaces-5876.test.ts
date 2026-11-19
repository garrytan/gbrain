/**
 * #5876 (T11): doctor `auto_chronicle` and the chronicle advisor report automatic extraction.
 *
 * Protects: the wave-8 "has no effect" text is gone; off-by-choice is ok/info (disabled_by_choice);
 * an invalid setting or chronicle.* value warns with a fix; pending pages with no chat provider warn;
 * failures warn with the reason's fix; otherwise the check reports 24 h use of the daily limit, the
 * largest writer's share and 7-day spend (priced dollars and unpriced calls apart); the default-on
 * notice stays visible (doctor info + advisor ask_user) until `config set auto_chronicle` answers it,
 * even after the post-upgrade banner was stamped (swap-only upgrade).
 * Fails when: a surface reverts to the no-op text, mislabels a by-choice state as a problem, loses
 * the spend/share numbers, or the default-on notice clears without an explicit answer.
 * Seams: gateway chat transport/unconfigure test seams; ledger rows seeded on the real migration.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { collectChronicle } from '../src/core/advisor/collect-chronicle.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';
import { autoChronicleEntry } from '../src/commands/doctor/checks/auto-chronicle.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { Check } from '../src/commands/doctor.ts';
import { CHRONICLE_ACK_KEY, CHRONICLE_NOTICE_SHOWN_KEY } from '../src/core/chronicle/config.ts';
import { __setChatTransportForTests, __unconfigureGatewayForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { insertChronicleLedgerRow } from './helpers/chronicle-ledger-rows.ts';

let engine: PGLiteEngine;
const advisorCtx = () => ({ engine, remote: false, now: new Date('2026-10-04T12:00:00Z') } as unknown as AdvisorContext);
const doctorCtx = () => ({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext);
const doctor = async () => (await autoChronicleEntry.run(doctorCtx())) as Check[];
const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name)!;
const withChat = () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } } as never);
  __setChatTransportForTests(async () => { throw new Error('doctor and advisor must not call the provider'); });
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  for (const k of ['auto_chronicle', CHRONICLE_ACK_KEY, CHRONICLE_NOTICE_SHOWN_KEY, 'chronicle.auto_daily_limit']) await engine.unsetConfig(k);
  await engine.executeRaw('DELETE FROM chronicle_page_state');
  await engine.executeRaw('DELETE FROM chronicle_judge_reservations');
  __unconfigureGatewayForTests();
});
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

describe('doctor auto_chronicle', () => {
  test('default on, fresh brain, no provider: ok/info, no stale no-op text, default-on notice with both answers', async () => {
    const checks = await doctor();
    const main = byName(checks, 'auto_chronicle');
    expect(main.status).toBe('ok');
    expect(main.message).toContain('auto_chronicle is on (default)');
    expect(main.message).toContain('No chat provider is configured');
    expect(main.message).not.toContain('no effect');
    expect(main.details).toMatchObject({ severity: 'info', readiness: 'missing', daily_limit: 200, ledger_available: true });
    const notice = byName(checks, 'auto_chronicle_default_on');
    expect(notice).toMatchObject({ status: 'ok', details: { code: 'auto_chronicle_default_on', severity: 'info', ask_user: true } });
    expect(notice.message).toContain('foresights config set auto_chronicle false');
    expect(notice.message).toContain('$50.00 per day');
    for (const c of checks) expect(categorizeCheck(c.name)).toBe('brain');
  });

  test('off by choice is ok + info + disabled_by_choice, with no default-on notice', async () => {
    await engine.setConfig('auto_chronicle', 'false');
    const checks = await doctor();
    expect(byName(checks, 'auto_chronicle')).toMatchObject({ status: 'ok',
      details: { enabled: false, severity: 'info', readiness: 'disabled_by_choice' } });
    expect(byName(checks, 'auto_chronicle_default_on').details).toBeUndefined();
  });

  test('an invalid word reads as off and warns with a fix', async () => {
    await engine.setConfig('auto_chronicle', 'flase');
    const main = byName(await doctor(), 'auto_chronicle');
    expect(main).toMatchObject({ status: 'warn', details: { code: 'auto_chronicle_invalid', enabled: false,
      fix: { argv: ['gbrain', 'config', 'set', 'auto_chronicle', 'true'], consent: ['paid'] } } });
  });

  test('a malformed chronicle.* row falls back and warns with the set command', async () => {
    await engine.setConfig('chronicle.auto_daily_limit', '-3');
    const check = byName(await doctor(), 'chronicle_config_invalid');
    expect(check).toMatchObject({ status: 'warn', details: { code: 'chronicle_config_invalid',
      fix: { argv: ['gbrain', 'config', 'set', 'chronicle.auto_daily_limit', '200'] } } });
  });

  test('pending pages and no chat provider warn with the credentials fix', async () => {
    await insertChronicleLedgerRow(engine, { slug: 'meetings/a', state: 'pending' });
    const main = byName(await doctor(), 'auto_chronicle');
    expect(main).toMatchObject({ status: 'warn', details: { code: 'judge_llm_unavailable', pending: 1,
      fix: { actor: 'user', consent: ['credentials'] } } });
  });

  test('activity: 24 h use (retries count), largest writer share, 7-day spend with unpriced calls apart, run-now command', async () => {
    withChat();
    await engine.setConfig('chronicle.auto_daily_limit', '10');
    await insertChronicleLedgerRow(engine, { slug: 'meetings/a', state: 'extracted', principal: ['oauth_client', 'client-a'], cost: 0.01, retries: 1 });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/b', state: 'extracted', principal: ['oauth_client', 'client-a'], cost: 0.02 });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/c', state: 'extracted', principal: ['local_cli', 'w1'], unpriced: true });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/old', state: 'extracted', cost: 5, hoursAgo: 24 * 9 });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/d', state: 'skipped', reason: 'history' });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/e', state: 'pending' });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/f', state: 'extracted', trigger: 'backfill', cost: 1 });
    const main = byName(await doctor(), 'auto_chronicle');
    expect(main.status).toBe('ok');
    expect(main.message).toContain('Last 24 h: 4 of 10 automatic extraction calls; largest writer oauth_client:client-a used 30% of the daily limit');
    expect(main.message).toContain('3 extracted, 0 failed, 1 skipped (history 1); $0.03 known spend + 1 unpriced call(s)');
    expect(main.message).toContain('foresights dream --phase chronicle');
    expect(main.details).toMatchObject({ readiness: 'ok', auto_calls_24h: 4,
      spend_7d: { knownUsd: 0.03, unpricedCalls: 1, incompleteRecords: 0 } });
  });

  test('failures warn with the failed row\'s reason fix, not a more frequent skip (no_pricing names the pricing command)', async () => {
    withChat();
    await insertChronicleLedgerRow(engine, { slug: 'meetings/s1', state: 'skipped', reason: 'superseded' });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/s2', state: 'skipped', reason: 'superseded' });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/a', state: 'failed', reason: 'no_pricing' });
    const main = byName(await doctor(), 'auto_chronicle');
    expect(main).toMatchObject({ status: 'warn', details: { code: 'no_pricing', fix: { actor: 'agent' } } });
    expect((main.details!.fix as { argv: string[] }).argv.slice(0, 3)).toEqual(['gbrain', 'pricing', 'set']);
  });

  test('the default-on notice survives a stamped banner and clears on an explicit answer', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    await engine.setConfig(CHRONICLE_NOTICE_SHOWN_KEY, '2026-10-04T00:00:00Z');
    expect(byName(await doctor(), 'auto_chronicle_default_on').details).toMatchObject({ code: 'auto_chronicle_default_on' });
    await engine.setConfig(CHRONICLE_ACK_KEY, '2026-10-04T00:00:00Z');
    expect(byName(await doctor(), 'auto_chronicle_default_on').details).toBeUndefined();
  });
});

describe('advisor', () => {
  test('default on: ask_user default-on finding with the keep command and no stale no-op finding', async () => {
    const findings = await collectChronicle.collect(advisorCtx());
    expect(findings.some((f) => f.id === 'auto_chronicle_no_effect')).toBe(false);
    const f = findings.find((x) => x.id === 'auto_chronicle_default_on')!;
    expect(f).toMatchObject({ severity: 'info', ask_user: true, fix: { command_argv: ['gbrain', 'config', 'set', 'auto_chronicle', 'true'] } });
    expect(f.detail).toContain('foresights config set auto_chronicle false');
  });

  test('swap-only upgrade: the stamped banner does not clear the finding; an explicit set does', async () => {
    await engine.setConfig(CHRONICLE_NOTICE_SHOWN_KEY, '2026-10-04T00:00:00Z');
    expect((await collectChronicle.collect(advisorCtx())).some((f) => f.id === 'auto_chronicle_default_on')).toBe(true);
    await engine.setConfig('auto_chronicle', 'true');
    await engine.setConfig(CHRONICLE_ACK_KEY, '2026-10-04T00:00:00Z');
    expect((await collectChronicle.collect(advisorCtx())).some((f) => f.id === 'auto_chronicle_default_on')).toBe(false);
  });

  test('off by choice: no automatic-extraction findings', async () => {
    await engine.setConfig('auto_chronicle', 'false');
    const ids = (await collectChronicle.collect(advisorCtx())).map((f) => f.id);
    expect(ids.filter((id) => id.startsWith('auto_chronicle') || id.startsWith('chronicle_') && id !== 'chronicle_coverage_gap')).toEqual([]);
  });

  test('a used-up daily limit with pages waiting asks before raising it; the coverage gap points at a scoped preview', async () => {
    withChat();
    await engine.setConfig(CHRONICLE_ACK_KEY, 'x');
    await engine.setConfig('chronicle.auto_daily_limit', '2');
    await engine.putPage('meetings/2026-10-01', { type: 'meeting', title: 'Weekly sync', compiled_truth: 'x'.repeat(120) });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/a', state: 'extracted', cost: 0.01 });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/b', state: 'extracted', cost: 0.01 });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/c', state: 'pending' });
    const findings = await collectChronicle.collect(advisorCtx());
    expect(findings.find((f) => f.id === 'chronicle_daily_limit')).toMatchObject({ ask_user: true,
      fix: { command_argv: ['gbrain', 'config', 'set', 'chronicle.auto_daily_limit', '4'] } });
    expect(findings.find((f) => f.id === 'chronicle_coverage_gap')?.fix.command_argv).toEqual(
      ['gbrain', 'chronicle-backfill', '--since', '2026-09-04', '--limit', '50', '--dry-run']);
    const main = byName(await doctor(), 'auto_chronicle');
    expect(main.message).toContain('The daily limit is used up, so pending pages wait');
    expect(main.message).not.toContain('to run them now');
  });

  test('a skipped execution reason alone is not reported as a failure', async () => {
    withChat();
    await insertChronicleLedgerRow(engine, { slug: 'meetings/a', state: 'skipped', reason: 'superseded' });
    expect((await collectChronicle.collect(advisorCtx())).some((f) => f.id === 'chronicle_extraction_failing')).toBe(false);
    expect(byName(await doctor(), 'auto_chronicle').status).toBe('ok');
  });

  test('remote advisor callers see the largest writer\'s share but not who it is', async () => {
    await insertChronicleLedgerRow(engine, { slug: 'meetings/a', state: 'extracted', principal: ['oauth_client', 'client-a'], cost: 0.01 });
    const remote = { engine, remote: true, now: new Date('2026-10-04T12:00:00Z') } as unknown as AdvisorContext;
    const remoteDetail = (await collectChronicle.collect(remote)).find((f) => f.id === 'auto_chronicle_default_on')!.detail!;
    expect(remoteDetail).toContain('largest writer used 1% of the daily limit');
    expect(remoteDetail).not.toContain('client-a');
    expect((await collectChronicle.collect(advisorCtx())).find((f) => f.id === 'auto_chronicle_default_on')!.detail)
      .toContain('largest writer oauth_client:client-a used 1%');
  });

  test('pending pages with no chat provider warn', async () => {
    await insertChronicleLedgerRow(engine, { slug: 'meetings/a', state: 'pending' });
    expect((await collectChronicle.collect(advisorCtx())).find((f) => f.id === 'chronicle_chat_unavailable'))
      .toMatchObject({ severity: 'warn', ask_user: true });
  });
});
