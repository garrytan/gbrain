/**
 * Tests for the v0.40.3.0 per-source console-prefix helper.
 *
 * Why these exist:
 *   AsyncLocalStorage propagation through await boundaries is what makes
 *   `withSourcePrefix(src.id, () => performSync(...))` correct without
 *   manual threading. If the propagation breaks (e.g. via setImmediate or
 *   a Promise resolver that bypasses ALS), every `slog` inside performSync
 *   loses its prefix and operators see interleaved unreadable output under
 *   `--parallel > 1`. These cases pin the contract.
 *
 *   The line-splitting math (embedded newlines each get their own prefix)
 *   is the difference between greppable output and a wall of text where
 *   only the first line of every multi-line emitter has a prefix.
 */

import { describe, expect, test } from 'bun:test';
import {
  getSourcePrefix,
  slog,
  serr,
  withSourcePrefix,
} from '../src/core/console-prefix.ts';

// Capture stdout/stderr writes for the duration of a callback. Restores
// the original write fns even on throw. Returns the captured chunks.
function captureStdio<T>(fn: () => T | Promise<T>): Promise<{ stdout: string; stderr: string; result: T }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  return Promise.resolve(fn())
    .then((result) => ({ stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), result }))
    .finally(() => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    });
}

describe('withSourcePrefix / getSourcePrefix', () => {
  test('prefix is applied inside the wrap', async () => {
    let observed: string | null = 'unset';
    await withSourcePrefix('media-corpus', async () => {
      observed = getSourcePrefix();
    });
    expect(observed).toBe('media-corpus');
  });

  test('no prefix outside the wrap', async () => {
    // Sanity: getSourcePrefix returns null when called outside any wrap.
    // This is what guarantees slog/serr fall through to bare console.log
    // for single-source / non-parallel callers (back-compat invariant).
    expect(getSourcePrefix()).toBeNull();
  });

  test('nested wrap uses innermost prefix; outer restored on exit', async () => {
    const observed: { outerBefore: string | null; inner: string | null; outerAfter: string | null } = {
      outerBefore: null,
      inner: null,
      outerAfter: null,
    };
    await withSourcePrefix('outer', async () => {
      observed.outerBefore = getSourcePrefix();
      await withSourcePrefix('inner', async () => {
        observed.inner = getSourcePrefix();
      });
      observed.outerAfter = getSourcePrefix();
    });
    expect(observed.outerBefore).toBe('outer');
    expect(observed.inner).toBe('inner');
    expect(observed.outerAfter).toBe('outer');
  });

  test('prefix propagates through await boundaries (the load-bearing ALS contract)', async () => {
    // This is the case that justifies AsyncLocalStorage over a global
    // variable. If propagation breaks, every async function called from
    // inside performSync loses its prefix and the whole feature is
    // theatrical. We assert by awaiting through Promise.resolve and a
    // setImmediate microtask — both common patterns inside the sync path.
    const observed: Array<string | null> = [];
    await withSourcePrefix('foo', async () => {
      observed.push(getSourcePrefix());
      await Promise.resolve();
      observed.push(getSourcePrefix());
      await new Promise<void>((resolve) => setImmediate(resolve));
      observed.push(getSourcePrefix());
    });
    expect(observed).toEqual(['foo', 'foo', 'foo']);
  });
});

describe('slog / serr line prefixing', () => {
  test('slog under a wrap prefixes a single-line string and writes to stdout', async () => {
    const { stdout, stderr } = await captureStdio(async () => {
      await withSourcePrefix('media-corpus', async () => {
        slog('phase started');
      });
    });
    expect(stdout).toBe('[media-corpus] phase started\n');
    expect(stderr).toBe('');
  });

  test('serr under a wrap prefixes and writes to stderr', async () => {
    const { stdout, stderr } = await captureStdio(async () => {
      await withSourcePrefix('zion-brain', async () => {
        serr('warn: skipping');
      });
    });
    expect(stdout).toBe('');
    expect(stderr).toBe('[zion-brain] warn: skipping\n');
  });

  test('embedded newlines each get their own prefix (greppable multi-line output)', async () => {
    // Without per-line prefixing, only the first line of a multi-line
    // emit would carry the source tag; the rest would be ambiguous under
    // interleaved parallel output. This case pins the kubectl-style
    // semantics that make `grep '[media-corpus]'` actually work.
    const { stdout } = await captureStdio(async () => {
      await withSourcePrefix('media-corpus', async () => {
        slog('phase started\n  details: x\n  details: y');
      });
    });
    expect(stdout).toBe(
      '[media-corpus] phase started\n[media-corpus]   details: x\n[media-corpus]   details: y\n',
    );
  });

  test('slog outside a wrap is identical to console.log (back-compat invariant)', async () => {
    // Single-source / non-parallel callers (single-source gbrain sync,
    // doctor, every existing caller that doesn't opt into withSourcePrefix)
    // must see bit-for-bit identical output. The fast path through
    // console.log preserves that — no prefix, no extra formatting.
    const origLog = console.log;
    const captured: unknown[][] = [];
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => { captured.push(args); };
    try {
      slog('plain message', { foo: 1 });
      expect(captured).toEqual([['plain message', { foo: 1 }]]);
    } finally {
      // eslint-disable-next-line no-console
      console.log = origLog;
    }
  });
});
