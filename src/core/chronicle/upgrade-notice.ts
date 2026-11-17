// #5876: one-shot post-upgrade notice for the auto_chronicle default flip. Printed by
// `foresights post-upgrade` while the operator has not answered the change (key unset, or an explicit
// `true` written before this release, when it had no effect). The doctor/advisor
// `auto_chronicle_default_on` notice stays visible after this prints, until the key is set.
import type { BrainEngine } from '../engine.ts';
import {
  AUTO_CHRONICLE_KEEP_ARGV, AUTO_CHRONICLE_OPT_OUT_ARGV, CHRONICLE_NOTICE_SHOWN_KEY, autoChronicleNeedsAcknowledgement,
  chronicleSettings,
} from './config.ts';
import { CHRONICLE_RUN_NOW_ARGV, chronicleBackfillArgv } from './reasons.ts';
import { agentBlock } from '../agent-markers.ts';

export interface ChronicleProviderView {
  /** Configured chat model id, or null when it cannot be resolved. */
  model: string | null;
  priced: boolean;
  chatAvailable: boolean;
}

async function providerView(engine: BrainEngine): Promise<ChronicleProviderView> {
  try {
    const { configureGatewayIfUninitialized, getChatModel, isAvailable } = await import('../ai/gateway.ts');
    const { isModelPriceable, loadPricingOverrides } = await import('../budget/budget-tracker.ts');
    // post-upgrade opens its engine without cli.ts's connect path, so the gateway may be unconfigured.
    configureGatewayIfUninitialized();
    const model = getChatModel();
    return { model, priced: isModelPriceable(model, 'chat', await loadPricingOverrides(engine)), chatAvailable: isAvailable('chat') };
  } catch {
    return { model: null, priced: false, chatAvailable: false };
  }
}

/** The notice lines, or null when it must not print (already shown, opted out, or acknowledged). */
export async function autoChronicleUpgradeNotice(engine: BrainEngine, view?: ChronicleProviderView): Promise<string[] | null> {
  const shown = await engine.getConfig(CHRONICLE_NOTICE_SHOWN_KEY);
  if (shown != null && shown.trim() !== '') return null;
  if (!(await autoChronicleNeedsAcknowledgement(engine))) return null;
  const settings = await chronicleSettings(engine);
  const provider = view ?? await providerView(engine);
  const ceiling = settings.dailyLimit * settings.jobBudgetUsd;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const runs = `On this ${engine.kind === 'pglite' ? 'PGLite' : 'Postgres'} brain, pending pages run in the autopilot cycle; ` +
    `\`${CHRONICLE_RUN_NOW_ARGV.join(' ')}\` runs them now.`;
  const cost = provider.priced
    ? `Worst case: ${settings.dailyLimit} calls/day x $${settings.jobBudgetUsd.toFixed(2)} per-page cap = $${ceiling.toFixed(2)}/day with ${provider.model}. ` +
      'The cap is per page, not a daily budget; typical pages cost far less.'
    : `foresights has no price for ${provider.model ?? 'the configured chat model'}, so the per-page cap ($${settings.jobBudgetUsd.toFixed(2)}) cannot apply: ` +
      `calls are unbounded in dollars (still at most ${settings.dailyLimit} per day).`;
  return [
    '',
    '═══════════════════════════════════════════════════════════════',
    '[foresights] Automatic event extraction (auto_chronicle) is now ON by default.',
    '[foresights] Each new or changed meeting, conversation or calendar page gets one',
    '[foresights] paid chat call that turns it into timeline events (life/events/).',
    '═══════════════════════════════════════════════════════════════',
    ...agentBlock({
      ask: 'Keep automatic event extraction on, or turn it off?',
      why: `It spends money and sends page text to the configured chat provider${provider.model ? ` (${provider.model})` : ''}: one paid chat call per eligible page. ` +
        `Only pages written after this upgrade, dated within ${settings.recentDays} days, run automatically; history is not swept. ${runs}` +
        (provider.chatAvailable ? '' : ' No chat provider is configured, so nothing runs until the user sets one up.'),
      risk: cost,
      consent: 'paid, egress',
      actor: 'user',
      next: 'ask_user',
      if_yes: `Run ${AUTO_CHRONICLE_KEEP_ARGV.join(' ')} (records the user's answer). History is paid too; ask before running it. ` +
        `Preview: ${chronicleBackfillArgv({ since, dryRun: true }).join(' ')}. Guide: docs/guides/life-chronicle.md`,
      if_no: `Run ${AUTO_CHRONICLE_OPT_OUT_ARGV.join(' ')}.`,
      verify: 'foresights doctor --only auto_chronicle_default_on --json',
    }, {
      showUser: 'Automatic event extraction is now on: each new or changed meeting, conversation or calendar page gets one paid chat call ' +
        'and its text goes to your chat provider. Keep it on, or turn it off?',
      decisions: [{ id: 'auto_chronicle', question: 'Keep automatic event extraction on?', default: 'keep',
        default_reason: 'It is the new default; the user has not answered yet.',
        options: [{ id: 'keep', label: 'Keep automatic extraction on', argv: [...AUTO_CHRONICLE_KEEP_ARGV] },
          { id: 'opt_out', label: 'Turn automatic extraction off', argv: [...AUTO_CHRONICLE_OPT_OUT_ARGV] }] }],
    }).trimEnd().split('\n'),
    '',
  ];
}

/** Prints the notice once and stamps it. Best-effort: never blocks the upgrade. */
export async function printAutoChronicleUpgradeNotice(engine: BrainEngine, log: (line: string) => void = console.log): Promise<boolean> {
  try {
    const lines = await autoChronicleUpgradeNotice(engine);
    if (!lines) return false;
    for (const line of lines) log(line);
    await engine.setConfig(CHRONICLE_NOTICE_SHOWN_KEY, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}
