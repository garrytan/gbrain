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

/**
 * pglite-repair.ts had its own inline promptYesNo (not this shared helper)
 * with the same close-before-resolve race: `rl.close()` inside the
 * rl.question callback fired the unguarded `rl.on('close', ...)` listener
 * synchronously, so `resolve(false)` won before the typed "y" resolve ran —
 * `gbrain pglite-repair` always treated an affirmative interactive answer as
 * decline. Pins the exact call now wired at that call site (question text +
 * `{ output: process.stderr }`, matching `src/commands/pglite-repair.ts`) so
 * a regression to the old inline shape — or a stdout-leaking `output`
 * default — is caught here rather than only in the generic cases above.
 */
describe('promptYesNo — pglite-repair call-site wiring (#4318 residual)', () => {
  test('"Repair now?" [y/N] question resolves true on "y", written to stderr not stdout', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk) => written.push(chunk.toString()));

    const p = promptYesNo('Repair now? [y/N] ', { output, input });
    input.write('y\n');

    expect(await p).toBe(true);
    // The prompt text itself must have gone to the injected `output` stream
    // (which stands in for process.stderr at the real call site), not been
    // silently dropped or duplicated with a second "[y/N]" suffix.
    expect(written.join('')).toBe('Repair now? [y/N] ');
  });

  test('"Repair now?" [y/N] question resolves false on decline', async () => {
    const { input, output } = mkStreams();
    const p = promptYesNo('Repair now? [y/N] ', { output, input });
    input.write('n\n');
    expect(await p).toBe(false);
  });
});
