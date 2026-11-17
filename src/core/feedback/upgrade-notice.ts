// One-shot post-upgrade notice for retrieval feedback. The feature ships off; the notice says what it does,
// how to turn it on, and what held-out results showed. Printed by `foresights post-upgrade` once, and not at all when
// the operator already set `feedback.enabled`.
import type { BrainEngine } from '../engine.ts';
import { agentBlock } from '../agent-markers.ts';

export const FEEDBACK_NOTICE_SHOWN_KEY = 'feedback.notice_shown';
export const FEEDBACK_ENABLE_ARGV = ['gbrain', 'config', 'set', 'feedback.enabled', 'true'] as const;

export async function retrievalFeedbackUpgradeNotice(engine: BrainEngine): Promise<string[] | null> {
  const shown = await engine.getConfig(FEEDBACK_NOTICE_SHOWN_KEY);
  if (shown != null && shown.trim() !== '') return null;
  if ((await engine.getConfig('feedback.enabled')) != null) return null;
  return [
    '',
    '═══════════════════════════════════════════════════════════════',
    '[foresights] Retrieval feedback is available and OFF. When on, an agent can rate',
    '[foresights] an answer (rate_answer / foresights rate) and the pages it used rank a',
    '[foresights] little higher or lower next time. No model call, local only.',
    '═══════════════════════════════════════════════════════════════',
    ...agentBlock({
      ask: 'Turn on retrieval feedback for this brain?',
      why: 'When on, every answer carries an answer_id; rating it 1-5 nudges the ranking of the pages and links that answer used (a capped ' +
        'multiplier, 0.9x to 1.1x by default; `search --explain` shows it). Held-out tests with consistent ratings showed a gain on entity-centric brains ' +
        '(people, companies, deals: +2.0 NDCG@10) and no gain on chat-history brains, so it ships off. Nothing leaves the machine.',
      consent: 'none',
      actor: 'user',
      next: 'ask_user',
      if_yes: `Run ${FEEDBACK_ENABLE_ARGV.join(' ')}. Guide: docs/guides/retrieval-feedback.md`,
      if_no: 'Nothing to run; it stays off.',
      verify: 'foresights feedback status --json',
    }, {
      showUser: 'Foresights can learn which pages actually helped when you or your agent rate answers. It is off by default: it helped on ' +
        'brains about people and companies but not on chat-history brains. Turn it on?',
    }).trimEnd().split('\n'),
    '',
  ];
}

/** Prints the notice once and stamps it. Best-effort: never blocks the upgrade. */
export async function printRetrievalFeedbackUpgradeNotice(engine: BrainEngine, log: (line: string) => void = console.log): Promise<boolean> {
  try {
    const lines = await retrievalFeedbackUpgradeNotice(engine);
    if (!lines) return false;
    for (const line of lines) log(line);
    await engine.setConfig(FEEDBACK_NOTICE_SHOWN_KEY, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}
