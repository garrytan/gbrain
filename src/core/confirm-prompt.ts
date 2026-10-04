/**
 * #4318 — shared interactive [y/N] confirm. Lives in
 * `src/core/interaction.ts` now (agent operator wave A5); this re-export stays
 * for one release with the same contract: true on y/yes, false on anything
 * else or EOF. The close-race rules are pinned by test/confirm-prompt.test.ts.
 */
export { promptYesNo, type ConfirmStreams } from './interaction.ts';
