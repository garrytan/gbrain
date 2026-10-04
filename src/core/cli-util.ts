/**
 * Legacy home of the shared prompt helpers. They live in
 * `src/core/interaction.ts` now (agent operator wave A5); these re-exports
 * stay for one release with unchanged return contracts:
 *   - promptLine(prompt): string (trimmed line; '' on EOF/timeout, no longer hangs)
 *   - promptLineStderr(prompt, {timeoutMs}): string | null (null on EOF/timeout)
 * New code: use readLine() from interaction.ts.
 */
export { promptLine, promptLineStderr } from './interaction.ts';
