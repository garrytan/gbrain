/**
 * The nightly probes' committed fixtures, embedded with Bun's
 * `import ... with { type: 'file' }` (#5187, C-N6) — the mechanism
 * bootstrap/assets.ts uses. In a source checkout each import resolves to the
 * file under test/fixtures; in a `bun build --compile` binary it resolves to a
 * bundler path that `readFileSync` reads, so a binary install runs the probes
 * instead of looking for the fixtures in the user's brain repo.
 */

import longMemEvalNightly from '../../../test/fixtures/longmemeval-nightly.jsonl' with { type: 'file' };
import parserFormats from '../../../test/fixtures/conversation-formats/all.jsonl' with { type: 'file' };
import parserAdversarial from '../../../test/fixtures/conversation-formats/adversarial.jsonl' with { type: 'file' };

export const NIGHTLY_PROBE_FIXTURES = Object.freeze({
  longMemEval: longMemEvalNightly,
  parserFormats,
  parserAdversarial,
});
