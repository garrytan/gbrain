import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { classifyAgentSessionFacts } from '../../../core/repair/agent-session-facts.ts';

/**
 * `agent_session_facts` (#8064): active capture-lane facts still attributed to
 * the owner although their session was launched by an agent (a speaker
 * sidecar, evidenced) or opens with a brief three or more other sessions share
 * (ambiguous). Counts them without operator flags and names the explicit-only
 * `gbrain repair agent-session-facts` preview; the apply needs the user's
 * agreement. Read-only; reads the brain host's session corpus.
 */
export async function agentSessionFactsCheck(engine: BrainEngine, sourceIds?: string[], opts: { corpusDir?: string | null } = {}): Promise<Check> {
  const name = 'agent_session_facts';
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const { candidates, unclassifiable } = await classifyAgentSessionFacts(engine, sources, opts);
    const count = (klass: string) => candidates.filter(c => c.class === klass).length;
    const details = { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded'), unclassifiable,
      repair: 'agent-session-facts', docs: 'docs/guides/repair.md#agent-session-facts' };
    if (!details.evidenced && !details.ambiguous) {
      return { name, status: 'ok', details, message: 'No active owner-attributed fact from an agent-launched session remains.' };
    }
    return { name, status: 'warn', details,
      message: `${details.evidenced + details.ambiguous} active fact(s) from agent-launched sessions are still attributed to the owner `
        + `(${details.evidenced} with a speaker sidecar, ${details.ambiguous} by a repeated session opening, heuristic); recall and consolidate treat them as the owner's own. `
        + 'Preview on the brain host: gbrain repair agent-session-facts (add --cwd <prefix> or --session <id> for sessions you know an orchestrator launched) '
        + '— the apply it prints re-attributes them and retires the takes built only from them, and needs the user\'s agreement '
        + '(repeated-opening candidates only with --include-ambiguous).' };
  } catch (error) {
    return { name, status: 'warn', message: `Agent-session facts could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
