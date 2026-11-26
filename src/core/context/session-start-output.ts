/**
 * Claude Code session-start stdout composition: always-loaded core memory
 * first, then the digest/pack parts, all under the harness hook-output cap
 * (overflow is diverted to a file by the harness, never injected).
 */
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../bootstrap/host-specs.ts';
import type { SessionStartSection } from './session-start-sections.ts';

/**
 * Onboarding PR 2: core, then the named sections in priority order, then the other parts. When the first-session
 * section is present, the coaching parts (`coaching`) are left out only if the final payload then still holds the
 * section whole (`quiet`); `emitted` says whether the text carries it.
 */
export function composeSessionStartWithSections(coreText: string, sections: SessionStartSection[], parts: string[], coaching: ReadonlySet<string>):
  { text: string; quiet: boolean; emitted: boolean; first?: SessionStartSection } {
  const first = sections.find((s) => s.name === 'first_session');
  const head = sections.map((s) => s.text);
  const text = composeSessionStartOutput(coreText, [...head, ...parts]);
  if (!first) return { text, quiet: false, emitted: false };
  const without = composeSessionStartOutput(coreText, [...head, ...parts.filter((p) => !coaching.has(p))]);
  if (without.includes(first.text)) return { text: without, quiet: true, emitted: true, first };
  return { text, quiet: false, emitted: text.includes(first.text), first };
}

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
