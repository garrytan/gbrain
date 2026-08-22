/**
 * #4318 — shared interactive [y/N] confirm.
 *
 * The old inline twins (sync-cost-gate.ts, reindex-code.ts) called
 * `rl.close()` BEFORE resolving the answer, and their unguarded
 * `rl.on('close', () => resolve(false))` listener fired synchronously during
 * that close — so the promise settled `false` before the real answer's
 * resolve ran and a typed "y" was read as a decline (the cost gate refused
 * every interactive approval).
 *
 * Rules pinned here (test/confirm-prompt.test.ts):
 *   - resolve the ANSWER first, then close the interface;
 *   - the 'close' listener resolves(false) ONLY when no answer arrived
 *     (true EOF / Ctrl-D — decline, matching the [y/N] default).
 */

import { createInterface } from 'node:readline';

export interface ConfirmStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Interactive [y/N] prompt. Resolves true on y/yes; false on anything else or EOF. */
export async function promptYesNo(question: string, streams: ConfirmStreams = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: streams.input ?? process.stdin,
      output: streams.output ?? process.stdout,
    });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
      rl.close();
    });
    rl.on('close', () => {
      if (!answered) resolve(false);
    });
  });
}
