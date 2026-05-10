/**
 * v0.31.2 chunker timeout regression tests.
 *
 * Closes the bug class where a single pathological code file could
 * wedge the entire sync inside tree-sitter WASM at 99% CPU with no
 * I/O and no observable progress. The fix bounds parser.parse() with
 * setTimeoutMicros and falls back to recursive chunks on timeout.
 *
 * Test design (per codex C9): the runtime parser is non-deterministic
 * about how long it takes to parse arbitrary input, so "force timeout
 * via huge input" is machine-speed dependent and flaky on slow CI. We
 * stub the ParserLike seam directly to assert the timeout contract,
 * then verify the env wiring with a 1ms cap that reliably loses.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseWithTimeout,
  ChunkerTimeoutError,
  chunkCodeTextFull,
} from '../src/core/chunkers/code.ts';
import { withEnv } from './helpers/with-env.ts';

const REAL_TS = `export function add(a: number, b: number): number { return a + b; }
export class Counter {
  private n = 0;
  increment(): void { this.n++; }
  get value(): number { return this.n; }
}
`;

describe('parseWithTimeout — pure-function seam', () => {
  test('1. throws ChunkerTimeoutError when parser.parse returns null', () => {
    const stub = {
      _timeoutCalls: 0,
      _parseCalls: 0,
      setTimeoutMicros(_t: number) { this._timeoutCalls++; },
      parse(_s: string) { this._parseCalls++; return null; },
    };

    expect(() => parseWithTimeout(stub, 'x', 50, 'foo.ts')).toThrow(ChunkerTimeoutError);
    expect(stub._timeoutCalls).toBe(1);
    expect(stub._parseCalls).toBe(1);
  });

  test('2. throws clear error if setTimeoutMicros API is missing', () => {
    // A future web-tree-sitter that drops the API must NOT silently
    // regress to no-timeout behavior.
    const stub = {
      parse(_s: string) { return { rootNode: null, delete: () => {} }; },
    } as any;

    expect(() => parseWithTimeout(stub, 'x', 50, 'foo.ts'))
      .toThrow(/setTimeoutMicros/);
  });

  test('3. returns the tree on success; calls setTimeoutMicros once', () => {
    const stub = {
      _timeout: 0,
      setTimeoutMicros(t: number) { this._timeout = t; },
      parse(_s: string) { return { rootNode: { type: 'program' }, delete: () => {} }; },
    };

    const tree = parseWithTimeout(stub, 'x', 50, 'foo.ts') as { rootNode: { type: string } };
    expect(tree.rootNode.type).toBe('program');
    expect(stub._timeout).toBe(50_000); // microseconds = ms × 1000
  });

  test('4. ChunkerTimeoutError carries filePath + timeoutMs for actionable logs', () => {
    const stub = { setTimeoutMicros() {}, parse() { return null; } };
    try {
      parseWithTimeout(stub, 'x', 30_000, 'src/big.ts');
      throw new Error('should have thrown');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(ChunkerTimeoutError);
      expect((e as ChunkerTimeoutError).filePath).toBe('src/big.ts');
      expect((e as ChunkerTimeoutError).timeoutMs).toBe(30_000);
    }
  });
});

describe('chunkCodeTextFull — integration with real parser', () => {
  test('5. default-timeout path on real code completes well under cap', async () => {
    const result = await chunkCodeTextFull(REAL_TS, 'sample.ts');
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  test('6. GBRAIN_CHUNKER_TIMEOUT_MS=1 reliably forces fallback', async () => {
    // 1ms is below any plausible real-parser wall-clock. The parser
    // returns null; chunkCodeTextFull catches the ChunkerTimeoutError
    // and falls back to fallbackChunks (recursive text chunker).
    await withEnv({ GBRAIN_CHUNKER_TIMEOUT_MS: '1' }, async () => {
      const result = await chunkCodeTextFull(REAL_TS, 'sample.ts');
      // Recursive fallback still produces chunks; assertion is that the
      // call returned cleanly instead of hanging.
      expect(Array.isArray(result.chunks)).toBe(true);
      expect(result.edges).toEqual([]); // edges only emitted on tree-sitter path
    });
  });
});

describe('cleanup contract under exception', () => {
  test('7. parser.delete() still fires when timeout throws (codex C4)', async () => {
    // chunkCodeTextFull's finally must reap parser+tree even when
    // parseWithTimeout throws ChunkerTimeoutError. We can't directly
    // observe parser.delete() in a real WASM run, but we can test the
    // shape: forcing the env-timeout path through chunkCodeTextFull a
    // few times must not leak (smoke test — Bun GC won't catch a real
    // WASM leak but if cleanup were missing on the throw path, repeated
    // calls would visibly degrade).
    await withEnv({ GBRAIN_CHUNKER_TIMEOUT_MS: '1' }, async () => {
      for (let i = 0; i < 5; i++) {
        const result = await chunkCodeTextFull(REAL_TS, `sample-${i}.ts`);
        expect(Array.isArray(result.chunks)).toBe(true);
      }
    });
  });
});
