/**
 * Named policy presets. ask-all is the default. One preset per gskills level, derived from
 * gskills' levels.json (pinned below by commit) so gbrain and gskills answer "may the agent
 * send" the same way: every level asks before it sends, spends, deletes or publishes (the
 * levels.json rule), and level 2 drafts and never sends, pays or calls.
 */
import { AGENT_VERBS, type AgentVerb } from '../agent-verbs.ts';
import type { PolicyDecision, PolicyRule } from './fence.ts';

/** The levels.json fields presets read, from garrytan/gskills at this commit. */
export const GSKILLS_LEVELS = {
  source: 'garrytan/gskills levels.json @ ae3e1ce5fa42b6bd07c53a2b8941b9156ee0c13c',
  default: 2,
  rule: 'Ask the user before you send, spend, delete or publish anything.',
  levels: {
    0: { name: 'quiet', summary: 'Skills run only when you ask for them.' },
    1: { name: 'assist', summary: 'The agent reads the clock and your calendar before it says anything about time, stops retrying a tool call that failed twice the same way, and checks the live source before it tells you to act on a digest.' },
    2: { name: 'proactive', summary: 'Adds a brief at the start of each session: who is waiting on you, today\'s calendar, promises coming due and what changed, with draft replies offered. It drafts and never sends.' },
    3: { name: 'chief of staff', summary: 'Adds a check of your task list, a triage of who is waiting in your inbox and, with the comms set, a Slack digest, at the start of each session. It still asks before it sends, deletes or changes anything.' },
  },
} as const;

/** The verbs the levels.json rule names. */
export const GSKILLS_ASK_VERBS: readonly AgentVerb[] = ['send', 'spend', 'delete', 'publish'];
/** "It drafts and never sends": level 2 refuses the verbs that leave a draft. */
export const GSKILLS_LEVEL2_DENY: readonly AgentVerb[] = ['send', 'spend', 'call'];

export interface PolicyPreset { name: string; summary: string; rules: PolicyRule[] }

const rule = (verb: AgentVerb, decision: PolicyDecision, note: string): PolicyRule => ({ id: `${verb}-${decision}`, verb, decision, note });

function levelPreset(level: 0 | 1 | 2 | 3): PolicyPreset {
  const info = GSKILLS_LEVELS.levels[level];
  const rules = level === 2
    ? [...GSKILLS_LEVEL2_DENY.map(v => rule(v, 'deny', 'gskills level 2 drafts and never sends, pays or calls')),
      ...GSKILLS_ASK_VERBS.filter(v => !GSKILLS_LEVEL2_DENY.includes(v)).map(v => rule(v, 'ask', GSKILLS_LEVELS.rule))]
    : GSKILLS_ASK_VERBS.map(v => rule(v, 'ask', GSKILLS_LEVELS.rule));
  return { name: `gskills-level-${level}`, summary: `gskills level ${level} (${info.name}): ${info.summary}`, rules };
}

export const POLICY_PRESETS: readonly PolicyPreset[] = [
  { name: 'ask-all', summary: 'Ask the user before every outside action (the default).', rules: AGENT_VERBS.map(v => rule(v, 'ask', 'ask before every outside action')) },
  levelPreset(0), levelPreset(1), levelPreset(2), levelPreset(3),
];

export const DEFAULT_PRESET = 'ask-all';

export function findPreset(name: string): PolicyPreset | undefined {
  return POLICY_PRESETS.find(p => p.name === name);
}
