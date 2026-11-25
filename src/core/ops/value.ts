/**
 * Roadmap PR 3: the value op (read scope), the agent's and the CLI's door to the value card (core/value/card.ts):
 * what this brain holds and has done for the caller, each row measured, off or unavailable. Counts follow the caller's
 * read policy; brain-wide activity reaches only the owner and the trusted local CLI. The CLI front door is
 * gbrain value [--json] (human text in core/value/format.ts). Never import from '../operations.ts' here (cycle).
 */
import type { Operation } from './contract.ts';

const value: Operation = {
  name: 'value',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'What this brain holds and has done for you, as counts: conversations archived and the days they cover, pages by kind, ' +
    'links, facts kept (active, superseded, withdrawn), nightly items, and for the owner only lookups served, pages brought up ' +
    'on their own and later retrieved, and the brain score. Each row is measured, off (with the command that turns it on) or ' +
    'unavailable (with a code and cause); a member connection counts only what it can read. Reads only; stamps nothing.',
  params: {},
  scope: 'read',
  annotations: { readOnlyHint: true },
  cliHints: { name: 'value' },
  handler: async (ctx) => {
    const { buildValueCard } = await import('../value/card.ts');
    return buildValueCard(ctx);
  },
};

export const valueOperations: Operation[] = [value];
