/**
 * Chunk-path flag parity for `gbrain embed` (the non-`--facts` path): `--source`
 * and `--batch-size` resolve through the same fail-closed helpers as the facts
 * branch, on the inline drain AND the `--background` job payload.
 *
 *   - `--stale --source=other --dry-run` scopes every count to `other` (the
 *     inline `=` form used to resolve to undefined and drain EVERY source).
 *   - `--stale --source` / `--source --stale` exit 1 (used to bind '--stale').
 *   - `--stale --batch-size abc` / `0` exit 1 (used to become 1).
 *   - the `--background` paramBuilder carries `sourceId: 'other'` for `--source=other`.
 *
 * Hermetic: Proxy mock engine (no DB), dry-run only, maybeBackground mocked to
 * capture the job payload instead of submitting it.
 */
import { describe, test, expect, mock } from 'bun:test';
import * as realCliOptions from '../src/core/cli-options.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let capturedParams: Record<string, unknown> | undefined;
mock.module('../src/core/cli-options.ts', () => ({
  ...realCliOptions,
  maybeBackground: async (opts: { args: string[]; paramBuilder: (a: string[]) => Record<string, unknown> }) => {
    capturedParams = opts.paramBuilder(opts.args.filter((a) => a !== '--background' && a !== '--follow'));
    return true;
  },
}));

// Import AFTER mocking (embed.ts statically imports cli-options).
const { runEmbed } = await import('../src/commands/embed.ts');

type Call = { method: string; args: unknown[] };

/** Proxy engine: records every call; overrides win; everything else resolves null. */
function mockEngine(overrides: Record<string, (...a: unknown[]) => unknown> = {}): BrainEngine & { _calls: Call[] } {
  const calls: Call[] = [];
  return new Proxy({} as BrainEngine & { _calls: Call[] }, {
    get(_, prop: string | symbol) {
      if (prop === '_calls') return calls;
      if (typeof prop !== 'string') return undefined;
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return prop in overrides ? overrides[prop](...args) : Promise.resolve(null);
      };
    },
  });
}

/** Run fn with process.exit throwing `__exit__<code>` and console.error captured. */
async function withCliCapture<T>(fn: () => Promise<T>): Promise<{ result?: T; thrown?: unknown; stderr: string[] }> {
  const origExit = process.exit;
  const origError = console.error;
  const stderr: string[] = [];
  process.exit = ((code?: number) => { throw new Error(`__exit__${code}`); }) as typeof process.exit;
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), stderr };
  } catch (thrown) {
    return { thrown, stderr };
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
}

const exitCode = (run: { thrown?: unknown }): string => String((run.thrown as Error)?.message);

describe('embed chunk path: --source / --batch-size fail closed', () => {
  test('--stale --source=other --dry-run scopes every stale count to "other"', async () => {
    const engine = mockEngine({
      countChunklessPagesWithContent: async () => 0,
      countStaleChunks: async () => 0,
    });
    const run = await withCliCapture(() => runEmbed(engine, ['--stale', '--source=other', '--dry-run']));
    expect(run.thrown).toBeUndefined();
    expect(run.result).toMatchObject({ dryRun: true, embedded: 0 });
    const scoped = engine._calls.filter((c) => c.method === 'countChunklessPagesWithContent' || c.method === 'countStaleChunks');
    expect(scoped.length).toBeGreaterThan(0);
    for (const c of scoped) expect(c.args[0], c.method).toMatchObject({ sourceId: 'other' });
  });

  test('--source without a usable value exits 1 before any engine call', async () => {
    for (const args of [['--stale', '--source'], ['--source', '--stale'], ['--stale', '--source=']]) {
      const engine = mockEngine();
      const run = await withCliCapture(() => runEmbed(engine, args));
      expect(exitCode(run), args.join(' ')).toBe('__exit__1');
      expect(run.stderr.join('\n'), args.join(' ')).toContain('--source requires a value');
      expect(engine._calls).toEqual([]);
    }
  });

  test('a malformed --source id exits 1', async () => {
    const engine = mockEngine();
    const run = await withCliCapture(() => runEmbed(engine, ['--stale', '--source', 'Not_Valid']));
    expect(exitCode(run)).toBe('__exit__1');
    expect(run.stderr.join('\n')).toContain('Invalid source_id');
    expect(engine._calls).toEqual([]);
  });

  test('--batch-size rejects non-numeric and zero with exit 1', async () => {
    for (const [args, raw] of [[['--stale', '--batch-size', 'abc'], 'abc'], [['--stale', '--batch-size=0'], '0']] as Array<[string[], string]>) {
      const engine = mockEngine();
      const run = await withCliCapture(() => runEmbed(engine, args));
      expect(exitCode(run), args.join(' ')).toBe('__exit__1');
      expect(run.stderr.join('\n')).toContain(`Invalid --batch-size "${raw}". Expected a positive integer.`);
      expect(engine._calls).toEqual([]);
    }
  });

  test('--background payload carries the resolved --source=other and --batch-size', async () => {
    capturedParams = undefined;
    const engine = mockEngine();
    const run = await withCliCapture(() => runEmbed(engine, ['--stale', '--source=other', '--batch-size=7', '--background']));
    expect(run.thrown).toBeUndefined();
    expect(run.result).toBeUndefined(); // backgrounded
    expect(capturedParams).toMatchObject({ stale: true, sourceId: 'other', batchSize: 7 });
  });
});
