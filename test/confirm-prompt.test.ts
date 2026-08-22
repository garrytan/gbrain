/**
 * #4318 — promptYesNo close-race regression.
 *
 * The old inline twins (sync-cost-gate.ts / reindex-code.ts) called
 * rl.close() before resolving, and their unguarded 'close' listener
 * resolved(false) synchronously during that close — a typed "y" was read as
 * a decline (verified reproducible under bun). Pins the shared helper:
 * answer resolves first; 'close' only declines on a true EOF.
 */

import { describe, test, expect } from 'bun:test';
import { PassThrough } from 'stream';
import { promptYesNo } from '../src/core/confirm-prompt.ts';

function mkStreams() {
  return { input: new PassThrough(), output: new PassThrough() };
}

describe('promptYesNo (#4318)', () => {
  test('"y" answer resolves TRUE (the close-race regression)', async () => {
    const { input, output } = mkStreams();
    const p = promptYesNo('Proceed? [y/N] ', { input, output });
    input.write('y\n');
    expect(await p).toBe(true);
  });

  test('"yes" (case/space-insensitive) resolves true', async () => {
    const { input, output } = mkStreams();
    const p = promptYesNo('Proceed? [y/N] ', { input, output });
    input.write('  YES \n');
    expect(await p).toBe(true);
  });

  test('"n" resolves false', async () => {
    const { input, output } = mkStreams();
    const p = promptYesNo('Proceed? [y/N] ', { input, output });
    input.write('n\n');
    expect(await p).toBe(false);
  });

  test('empty answer resolves false (the [y/N] default)', async () => {
    const { input, output } = mkStreams();
    const p = promptYesNo('Proceed? [y/N] ', { input, output });
    input.write('\n');
    expect(await p).toBe(false);
  });

  test('EOF without an answer (Ctrl-D) resolves false', async () => {
    const { input, output } = mkStreams();
    const p = promptYesNo('Proceed? [y/N] ', { input, output });
    input.end(); // no line ever arrives
    expect(await p).toBe(false);
  });

  test('answer followed by immediate EOF still resolves true', async () => {
    const { input, output } = mkStreams();
    const p = promptYesNo('Proceed? [y/N] ', { input, output });
    input.end('y\n');
    expect(await p).toBe(true);
  });
});
