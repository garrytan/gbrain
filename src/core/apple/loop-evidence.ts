/** Durable per-message detection evidence carried alongside every rendered Mail block.
 * The cursor's bounded recent-thread cache is never authoritative for detection or recovery.
 */
import { trimQuotedReply } from '../google/google-render.ts';
import { asksQuestion } from '../google/loop-detect.ts';
import type { GmailMessageMeta, GmailThreadData } from '../google/types.ts';
const bareAddress = (raw: string): string => (/<([^<>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
import type { AppleLoopMessage, AppleMailMessage } from './types.ts';
export const APPLE_LOOPS_BODY_CAP = 120;

// ── Adapter: Mail message → the detector's message ───────────────────────────

/** A Mail message as the loop state keeps it. Null when it has no usable timestamp. */
export function compactMailMessage(m: AppleMailMessage): AppleLoopMessage | null {
  const ms = Date.parse(m.date);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const full = trimQuotedReply(m.body.replace(/\r\n?/g, '\n'));
  let body = full.replace(/\s+/g, ' ').trim().slice(0, APPLE_LOOPS_BODY_CAP);
  // A question mark beyond the cap still makes the message an ask.
  if (asksQuestion(full) && !asksQuestion(body)) body = `${body.slice(0, APPLE_LOOPS_BODY_CAP - 2)} ?`;
  return {
    id: m.id, from: bareAddress(m.from), to: m.to.map(bareAddress).filter(Boolean), cc: m.cc.map(bareAddress).filter(Boolean),
    subject: m.subject.replace(/\s+/g, ' ').trim().slice(0, 200), ms, body,
    ...(typeof m.automated === 'boolean' ? { auto: m.automated } : {}), ...(typeof m.bulk === 'boolean' ? { bulk: m.bulk } : {}),
  };
}

/**
 * Adapts a thread to the Google detector's input. No Gmail label is invented: `labelIds` is always empty, so
 * direction is the owner-address test alone. Returns null (refuse the thread) when any message lacks the
 * reader's header classification.
 */
export function toLoopThread(threadId: string, messages: readonly AppleLoopMessage[], account: string): GmailThreadData | null {
  if (messages.length === 0 || messages.some((m) => typeof m.auto !== 'boolean' || typeof m.bulk !== 'boolean')) return null;
  const metas: GmailMessageMeta[] = [...messages].sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : 1)).map((m) => ({
    id: m.id, threadId, from: m.from, fromAddress: m.from, to: m.to, cc: m.cc, subject: m.subject,
    dateIso: new Date(m.ms).toISOString(), internalDateMs: m.ms, labelIds: [],
    listUnsubscribe: m.bulk === true, autoSubmitted: m.auto === true, bodyText: m.body,
  }));
  return { threadId, account, messages: metas };
}


/** Validate durable evidence against ALL message ids on the page, not a recent tail. */
export function pageLoopMessages(fm: Record<string, unknown>): AppleLoopMessage[] | null {
  if (!Array.isArray(fm.apple_message_ids) || !Array.isArray(fm.apple_loop_messages)) return null;
  const messages = fm.apple_loop_messages as AppleLoopMessage[];
  if (messages.length !== fm.apple_message_ids.length) return null;
  const byId = new Map(messages.map(m => [m?.id, m]));
  if (byId.size !== messages.length) return null;
  for (const id of fm.apple_message_ids) {
    const m = byId.get(id);
    if (!m || typeof m.id !== 'string' || typeof m.from !== 'string' || !Number.isFinite(m.ms) || m.ms <= 0
      || typeof m.body !== 'string' || !Array.isArray(m.to) || !m.to.every(a => typeof a === 'string')
      || !Array.isArray(m.cc) || !m.cc.every(a => typeof a === 'string') || typeof m.subject !== 'string') return null;
  }
  return messages;
}
