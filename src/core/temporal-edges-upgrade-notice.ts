// Temporal typed edges: one-shot post-upgrade notice. Graph reads now return
// relationships that are true today (history on request), and the
// edge_contradictions dream phase proposes closures for live relationships
// that cannot both hold (paid chat calls; applied automatically for models
// certified in held-out runs, proposals for every other model). Printed by `foresights post-upgrade` once.
import type { BrainEngine } from './engine.ts';
import { agentBlock } from './agent-markers.ts';

export const TEMPORAL_EDGES_NOTICE_SHOWN_KEY = 'graph.temporal_notice_shown';

export async function temporalEdgesUpgradeNotice(engine: BrainEngine): Promise<string[] | null> {
  const shown = await engine.getConfig(TEMPORAL_EDGES_NOTICE_SHOWN_KEY);
  if (shown != null && shown.trim() !== '') return null;
  let model: string | null = null;
  let chatAvailable = false;
  try {
    const { configureGatewayIfUninitialized, isAvailable } = await import('./ai/gateway.ts');
    const { resolveModel } = await import('./model-config.ts');
    configureGatewayIfUninitialized();
    model = await resolveModel(engine, { configKey: 'models.dream.edge_contradictions', tier: 'utility', fallback: 'haiku' });
    chatAvailable = isAvailable('chat', model);
  } catch { /* notice still prints without the model line */ }
  const { loadEdgeContradictionsConfig } = await import('./cycle/edge-contradictions.ts');
  const config = await loadEdgeContradictionsConfig(engine, model ?? '');
  const mode = !chatAvailable ? 'off (no chat model)' : config.mode;
  return [
    '',
    '═══════════════════════════════════════════════════════════════',
    '[foresights] Relationships now have dates. Graph reads (get_links, get_backlinks,',
    '[foresights] traverse_graph, the relational search arm) return what is true today;',
    '[foresights] former relationships stay queryable with status "all", as_of or during.',
    '═══════════════════════════════════════════════════════════════',
    ...agentBlock({
      ask: 'Keep live-by-default graph reads and the nightly relationship check?',
      why: 'Pages are re-read without any model call to date relationships from timeline lines ("left Acme", "joined Widget"), ' +
        '"Ended works_at [[companies/x]]" lines and past-tense prose, so "who works at X" stops listing former employees. ' +
        `The dream cycle's relationship check (mode: ${mode}) sends a subject's competing relationships and their context lines to ` +
        `${model ?? 'the configured chat model'} once per changed subject (cap $${config.budgetUsd.toFixed(2)} per cycle). ` +
        (mode === 'apply'
          ? `${model} is certified for apply mode (0 wrong closures in held-out runs), so each closure is written as an "(inferred) Ended <relation> [[target]]" timeline line; foresights edge-proposals undo <id> (or --all-applied) removes them.`
          : 'In propose mode it writes nothing to pages until the user accepts a proposal (foresights edge-proposals list).'),
      consent: 'paid, egress',
      actor: 'user',
      next: 'ask_user',
      if_yes: 'Nothing to run; the defaults stay. Review what the check did with foresights edge-proposals list --status all.',
      if_no: 'Run foresights config set graph.edge_validity off (every edge, as before), foresights config set dream.edge_contradictions.mode propose (review before anything is written) or foresights config set dream.edge_contradictions.mode off.',
      verify: 'foresights doctor --only edge_validity --json',
    }, {
      showUser: 'Foresights now tracks when relationships started and ended, so it stops treating old jobs as current. A nightly check can also ' +
        'suggest which of two conflicting relationships ended, using your chat model (a small paid call per changed person or company). Keep both on?',
    }).trimEnd().split('\n'),
    '',
  ];
}

/** Prints the notice once and stamps it. Best-effort: never blocks the upgrade. */
export async function printTemporalEdgesUpgradeNotice(engine: BrainEngine, log: (line: string) => void = console.log): Promise<boolean> {
  try {
    const lines = await temporalEdgesUpgradeNotice(engine);
    if (!lines) return false;
    for (const line of lines) log(line);
    await engine.setConfig(TEMPORAL_EDGES_NOTICE_SHOWN_KEY, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}
