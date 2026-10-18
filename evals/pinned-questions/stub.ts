/**
 * Offline stand-in for the pinned-question answer model: one sentence per
 * evidence line, citing it, with the evidence text copied in. Deterministic;
 * used by the benefit gate's --offline plumbing check only.
 */
export type { QuestionChatFn } from '../../src/core/questions/refresh.ts';

export function stubAnswerFor(user: string): string {
  const lines = user.split('\n').filter(l => /^E\d+: /.test(l)).slice(0, 6);
  return JSON.stringify({
    sentences: lines.map(l => ({ text: l.slice(l.indexOf(':') + 2).replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, 200), cite: [l.slice(0, l.indexOf(':'))] })),
    gaps: [],
  });
}
