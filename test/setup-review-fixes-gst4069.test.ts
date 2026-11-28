/**
 * GST-4069 review fixes. 1. Protects: the history-choice refusal setup prints when a brain turns shared names the brain
 * the run was pointed at (--brain), so following either printed choice acts on that brain and not the host; a Claude
 * Code entry the gbrain plugin owns gets no brain pin in its receipt, because setup wrote no entry that carries one.
 * 2. Fails when: the printed re-run drops --brain, or the receipt records a brain_id the registered entry never carries.
 * 3. Existing coverage: setup-company-access.test.ts (the refusal's counts), setup-brain-pin-gst4069.test.ts (the pin).
 * 4. Real seams: historyRefusal and applyClaudeSetup against a temp HOME written by a real `gbrain setup` run.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { historyRefusal } from '../src/commands/setup-serves.ts';
import { _resetCliOptionsForTest, getCliOptions, setCliOptions } from '../src/core/cli-options.ts';
import { applyClaudeSetup, readSetupReceipt } from '../src/core/setup/claude-code.ts';
import { withEnv } from './helpers/with-env.ts';
import { type Box, CLEAN, createSetupFixture, receipt, setup } from './helpers/setup-fixture.ts';

const { box, cleanup } = createSetupFixture();
afterAll(cleanup);
afterEach(() => _resetCliOptionsForTest());

const ROSTER = ['owner-example', 'alice-example', 'bob-example'];
const status = { serves: 'one', from: 'derived', enabled_members: ['owner-example'], since: null, owner: 'owner-example', stdio_member: null } as never;
const preview = { members: [], open_pages: { total: 2, sensitive: 1, archive: 0 } } as never;

describe('GST-4069 review fixes', () => {
  test('the history choice names the brain this run was pointed at, in both printed re-runs and the verify step', () => {
    setCliOptions({ ...getCliOptions(), brain: 'example-mount' });
    const refusal = historyRefusal(status, preview, { serves: 'several', dryRun: false }, 'claude-code', ROSTER, { id: 'owner-example', from: 'flag' });
    expect(refusal).toMatchObject({ code: 'setup_history_choice_required' });
    const fix = (refusal as unknown as { fix: { argv: string[]; verify: { argv: string[] } } }).fix;
    expect(fix.argv.slice(0, 4)).toEqual(['gbrain', '--brain', 'example-mount', 'setup']);
    expect(fix.verify.argv.slice(0, 3)).toEqual(['gbrain', '--brain', 'example-mount']);
    expect(refusal!.suggestion).toContain('gbrain --brain example-mount setup claude-code --serves several');
    expect(refusal!.suggestion).toContain('--open-history');
    expect(refusal!.suggestion!.split('gbrain --brain example-mount setup').length).toBe(3);
  });

  test('without --brain the printed re-runs stay as they were', () => {
    const refusal = historyRefusal(status, preview, { serves: 'several', dryRun: false }, 'claude-code', ROSTER, undefined);
    expect((refusal as unknown as { fix: { argv: string[] } }).fix.argv.slice(0, 3)).toEqual(['gbrain', 'setup', 'claude-code']);
  });

  test('an entry the gbrain plugin owns records no brain pin, since setup wrote no entry that carries GBRAIN_BRAIN_ID', async () => {
    const b: Box = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    const r = readSetupReceipt(receipt(b)).setup!;
    await withEnv({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.gbrainHome, CODEX_HOME: join(b.home, '.codex'), XDG_CONFIG_HOME: undefined }, async () => {
      const plan = { name: r.name, scope: r.scope, launcher: r.launcher, brainHome: r.gbrain_home, sourceId: r.source_id, surface: r.surface, advertise: r.advertise ?? null, events: Object.keys(r.hooks.owned) as never, brainId: 'example-mount' };
      const done = await applyClaudeSetup(plan, r.consent, { pluginOwner: 'gbrain@example-marketplace', brainCreated: false });
      expect(done.receipt.mcp_plugin).toBe('gbrain@example-marketplace');
      expect(done.receipt.brain_id).toBeUndefined();
    });
    expect(readSetupReceipt(receipt(b)).setup!.brain_id).toBeUndefined();
  }, 120_000);
});
