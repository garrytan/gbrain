/** D3 curated help for `gbrain profile` (flags read by src/commands/profile.ts runProfile). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Your own profile: the facts remember saved with a facet (diet, allergy, size.<item>, brand, style, constraint, schedule, household, other), relationships from your page\'s links, and unfaceted preferences. The brain owner reads the owner\'s profile; a member credential reads its own. Read-only, zero model calls. Guide: docs/guides/profile.md.',
  usage: 'gbrain profile [--json] [--budget-tokens <n>]',
  flags: [
    { name: '--json', type: 'boolean', desc: 'Print the profile block as one JSON document.' },
    { name: '--budget-tokens', type: 'number', desc: 'Pack the profile into this many tokens; the rest is counted as withheld.' },
  ],
  examples: [
    'gbrain profile',
    'gbrain profile --json --budget-tokens 400',
  ],
};
