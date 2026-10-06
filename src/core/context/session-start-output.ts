/**
 * Claude Code session-start stdout composition: always-loaded core memory
 * first, then the digest/pack parts, all under the harness hook-output cap
 * (overflow is diverted to a file by the harness, never injected).
 */
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../bootstrap/host-specs.ts';

/** Marker printed when lower-priority parts were trimmed to keep core whole under the cap. */
export const SESSION_START_TRIM_MARKER = '[gbrain: digest/pack trimmed to fit core memory]';

/**
 * Session-start stdout: core first, then the other parts, all under
 * CLAUDE_HOOK_OUTPUT_CAP_CHARS (overflow would be diverted, never injected).
 * Trailing parts are dropped whole, then the last kept part is cut, before
 * core is ever touched; core itself is bounded by memory.core.max_chars.
 */
export function composeSessionStartOutput(coreText: string, parts: string[]): string {
  const cap = CLAUDE_HOOK_OUTPUT_CAP_CHARS - 64;
  const head = coreText ? [coreText] : [];
  const kept: string[] = [];
  let trimmed = false;
  const size = (xs: string[]) => xs.join('\n\n').length;
  for (const part of parts) {
    if (size([...head, ...kept, part, SESSION_START_TRIM_MARKER]) <= cap) { kept.push(part); continue; }
    const room = cap - size([...head, ...kept, SESSION_START_TRIM_MARKER]) - 4;
    if (room > 200) kept.push(part.slice(0, room));
    trimmed = true;
    break;
  }
  const all = [...head, ...kept, ...(trimmed ? [SESSION_START_TRIM_MARKER] : [])];
  const text = all.join('\n\n');
  return text.length <= CLAUDE_HOOK_OUTPUT_CAP_CHARS ? text : text.slice(0, CLAUDE_HOOK_OUTPUT_CAP_CHARS);
}
