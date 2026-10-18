/**
 * #5876 (T13): the post-upgrade notice for the auto_chronicle default flip, and the opt-out wording.
 *
 * Protects: the notice prints once while the operator has not answered (unset, or an explicit `true`
 * written before this release), never after `config set auto_chronicle` or on an opted-out brain; it
 * names the per-page cap, the daily ceiling (or that an unpriced model has no cap), provider egress,
 * the missing-provider case, the set-false opt-out and a previewed backfill; no surface in src/, docs/
 * or skills/ tells anyone to clear auto_chronicle with `config unset` (unset now means on).
 * Fails when: the notice repeats, is skipped for legacy-true brains, drops the cost or opt-out, or
 * stale unset advice comes back.
 * Seams: the provider view is passed in (pricing/provider state is config, not under test here).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CHRONICLE_ACK_KEY, CHRONICLE_NOTICE_SHOWN_KEY } from '../src/core/chronicle/config.ts';
import { autoChronicleUpgradeNotice, printAutoChronicleUpgradeNotice } from '../src/core/chronicle/upgrade-notice.ts';
import { __unconfigureGatewayForTests, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
const priced = { model: 'anthropic:claude-sonnet-4-6', priced: true, chatAvailable: true };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
// The unconfigured-gateway case restores inline; the hook covers a throw before that restore (isolation lint R7).
afterEach(() => { resetGateway(); });
beforeEach(async () => { for (const k of ['auto_chronicle', CHRONICLE_ACK_KEY, CHRONICLE_NOTICE_SHOWN_KEY]) await engine.unsetConfig(k); });

describe('auto_chronicle upgrade notice', () => {
  test('unset: names cost, ceiling, egress, opt-out and a previewed backfill', async () => {
    const text = (await autoChronicleUpgradeNotice(engine, priced))!.join('\n');
    expect(text).toContain('now ON by default');
    expect(text).toContain('200 calls/day x $0.25 per-page cap = $50.00/day with anthropic:claude-sonnet-4-6');
    expect(text).toContain('sends page text to the configured chat provider');
    expect(text).toContain('opt_out: Turn automatic extraction off (run: gbrain config set auto_chronicle false)');
    expect(text).toContain('[/AGENT]');
    expect(text).toMatch(/gbrain chronicle-backfill --since \d{4}-\d{2}-\d{2} --limit 50 --dry-run/);
    expect(text).toContain('gbrain dream --phase chronicle');
    expect(text).not.toContain('No chat provider is configured');
  });

  test('unpriced model and no provider are stated plainly', async () => {
    const text = (await autoChronicleUpgradeNotice(engine, { model: 'openai:gpt-new', priced: false, chatAvailable: false }))!.join('\n');
    expect(text).toContain('no price for openai:gpt-new');
    expect(text).toContain('No chat provider is configured, so nothing runs');
  });

  test('post-upgrade opens its engine without configuring the gateway: the notice still reads the configured model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chronicle-notice-'));
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', chat_model: 'anthropic:claude-sonnet-4-6' }));
    try {
      await withEnv({ GBRAIN_HOME: home, ANTHROPIC_API_KEY: 'sk-test' }, async () => {
        __unconfigureGatewayForTests();
        const text = (await autoChronicleUpgradeNotice(engine))!.join('\n');
        expect(text).toContain('$50.00/day with anthropic:claude-sonnet-4-6');
        expect(text).not.toContain('No chat provider is configured');
      });
    } finally {
      resetGateway();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('prints once, then never again', async () => {
    const lines: string[] = [];
    expect(await printAutoChronicleUpgradeNotice(engine, (l) => lines.push(l))).toBe(true);
    expect(lines.join('\n')).toContain('auto_chronicle');
    expect(await engine.getConfig(CHRONICLE_NOTICE_SHOWN_KEY)).not.toBeNull();
    expect(await printAutoChronicleUpgradeNotice(engine, (l) => lines.push(l))).toBe(false);
  });

  test('a pre-release explicit true is notified; an answered or opted-out brain is not', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    expect(await autoChronicleUpgradeNotice(engine, priced)).not.toBeNull();
    await engine.setConfig(CHRONICLE_ACK_KEY, '2026-10-04T00:00:00Z');
    expect(await autoChronicleUpgradeNotice(engine, priced)).toBeNull();
    await engine.unsetConfig(CHRONICLE_ACK_KEY);
    await engine.setConfig('auto_chronicle', 'false');
    expect(await autoChronicleUpgradeNotice(engine, priced)).toBeNull();
  });
});

describe('opt-out wording guard', () => {
  test('no surface tells anyone to clear auto_chronicle with config unset', () => {
    // Unset restores the default, which is now on; the only opt-out is `gbrain config set auto_chronicle false`.
    const result = Bun.spawnSync(['git', 'grep', '-n', '-I', '-E', 'config unset (--pattern )?auto_chronicle', '--', 'src', 'docs', 'skills'],
      { cwd: `${import.meta.dir}/..` });
    const hits = result.stdout.toString().split('\n').filter(Boolean)
      .filter((line) => !line.startsWith('docs/fix-wave-notes/') && !line.startsWith('docs/test-audit/'));
    expect(hits).toEqual([]);
  });
});
