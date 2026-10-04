/** D3 curated help for `gbrain onboard` (flags read by src/commands/onboard.ts runOnboard). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Onboarding plan for the brain: what to fix to reach the target score, and optionally run it.',
  usage: [
    'gbrain onboard [--check] [--target-score <n>] [--explain] [--json]',
    'gbrain onboard --auto --max-usd <n|off> [--yes] [--target-score <n>] [--json]',
    'gbrain onboard --history [--json]',
  ].join('\n'),
  flags: [
    { name: '--check', type: 'boolean', desc: 'Print the plan; submit nothing (the default mode).' },
    { name: '--auto', type: 'boolean', desc: 'Submit the auto_apply tier (refuses without --max-usd unless spend.posture=tokenmax).', consent: ['paid'] },
    { name: '--yes', type: 'boolean', desc: 'With --auto: also submit the prompt_required tier.', consent: ['paid'] },
    { name: '--max-usd', type: 'string', desc: 'USD cap for --auto, or off / unlimited / none to run uncapped (spend still ledgered).', consent: ['paid'] },
    { name: '--target-score', type: 'number', desc: 'Brain score the plan aims for (default 90).' },
    { name: '--explain', type: 'boolean', desc: 'With --check: per-cluster narrative for an available schema-pack upgrade.' },
    { name: '--history', type: 'boolean', desc: 'Show recent migration impact log entries.' },
    { name: '--json', type: 'boolean', desc: 'Print the stable JSON envelope.' },
  ],
  examples: [
    'gbrain onboard --json',
    'gbrain onboard --auto --max-usd 5',
    'gbrain onboard --history --json',
  ],
};
