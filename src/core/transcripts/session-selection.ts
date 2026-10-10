import type { ParsedSession, TranscriptMessage } from './types.ts';
import { createHash } from 'node:crypto';

/** The newest valid SOURCE instant; invalid values must never poison a cursor. */
export function lastMessageTs(messages: Array<{ timestamp: string }>): string {
  let newest = '';
  for (const message of messages) {
    if (!message.timestamp) continue;
    const ms = Date.parse(message.timestamp);
    if (!Number.isFinite(ms)) continue;
    const iso = new Date(ms).toISOString();
    if (iso > newest) newest = iso;
  }
  return newest;
}

/** Opt-in cutover: retain only turns strictly AFTER the boundary, before redaction. */
export function trimSessionMessages(session: ParsedSession, sinceIso?: string): ParsedSession {
  if (!sinceIso) return session;
  const cutoff = Date.parse(sinceIso);
  if (!Number.isFinite(cutoff)) throw new Error('messagesSinceIso must be a valid timestamp');
  const messages = session.messages.filter((m: TranscriptMessage) => {
    const ms = Date.parse(m.timestamp);
    return Number.isFinite(ms) && ms > cutoff;
  });
  // A source without session metadata derives its slug date from its FIRST
  // message. Capture that original date before trimming, so the cutover and
  // later reruns retain the same identity (no pre-cutoff text is retained).
  const originalStart = session.meta.startedAt || session.messages.find(m => Number.isFinite(Date.parse(m.timestamp)))?.timestamp;
  const normalizedCutoff = new Date(cutoff).toISOString();
  // Cutovers are separate archive views. Reusing the native ID would let a
  // partial view replace a previously imported full archive and delete its
  // older part pages during reconciliation. Tuple hashing keeps a stable
  // scoped identity while the original ID remains in source provenance.
  const sessionId = 'gbrain-cutover:' + createHash('sha256')
    .update(JSON.stringify([session.meta.sessionId, normalizedCutoff, 'strictly-after-v1'])).digest('hex');
  return { meta: { ...session.meta, sessionId,
    ...(originalStart ? { startedAt: originalStart } : {}),
    raw: { ...session.meta.raw, source_session_id: session.meta.sessionId,
      import_messages_since: normalizedCutoff, import_semantics: 'strictly-after-v1' },
  }, messages };
}
