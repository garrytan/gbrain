/**
 * #6425: the notice a `budget`-stopped atom drain carries (`gbrain dream --drain --json`):
 * what the attempt spent, its per-run cap, the pages left, and the paid fix that raises the cap.
 */
import { cliRenderContext, renderNotice, type RenderedNotice } from '../agent-output.ts';

export const usd = (n: number | undefined): string => n === undefined ? '$?' : `$${Number(n.toFixed(4))}`;

export function drainBudgetNotice(result: { spent_usd?: number; budget_usd?: number; remaining: number | null }): RenderedNotice {
  return renderNotice({
    code: 'atom_drain_budget', kind: 'info',
    why: `The atom drain stopped at its per-run spending cap: it spent ${usd(result.spent_usd)} of ${usd(result.budget_usd)} (cycle.extract_atoms.budget_usd) and ${result.remaining ?? 'an unknown number of'} page(s) still need atoms. Rerun the drain to continue under the same cap, or raise the cap.`,
    fix: { argv: ['gbrain', 'config', 'set', 'cycle.extract_atoms.budget_usd', '<USD>'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
      inputs: [{ name: 'USD', how: `Ask the user the most one atom drain or cycle may spend on extraction (the cap is ${usd(result.budget_usd)} now).` }],
      why: 'Raises the per-run atom extraction cap; every later drain and cycle may spend up to it on model calls.',
      verify: { argv: ['gbrain', 'config', 'get', 'cycle.extract_atoms.budget_usd'] } },
  }, cliRenderContext());
}
