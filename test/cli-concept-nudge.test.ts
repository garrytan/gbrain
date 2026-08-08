// #2416: CLI wiring for the concept-shaped search nudge. Same in-process
// pattern as cli-query-image.test.ts (import the helper from src/cli.ts —
// safe, the import.meta.main seam guards top-level execution). The helper is
// called from BOTH result paths (local engine + thin-client routed), so
// pinning its behavior here covers the shared wiring; the per-path call
// sites are two-liners.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { maybePrintConceptNudge } from '../src/cli.ts';
import {
  DEFAULT_CLI_OPTIONS,
  setCliOptions,
  _resetCliOptionsForTest,
} from '../src/core/cli-options.ts';

let stderrChunks: string[];
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  stderrChunks = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
  _resetCliOptionsForTest();
});

const CONCEPT_QUERY = 'all the companies that do offshore wind';

describe('#2416 — maybePrintConceptNudge wiring', () => {
  test('concept-shaped search emits the one-line query nudge to stderr', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS });
    maybePrintConceptNudge('search', { query: CONCEPT_QUERY });
    expect(stderrChunks.length).toBe(1);
    expect(stderrChunks[0]).toContain('gbrain query');
    expect(stderrChunks[0]).toContain('not proof of completeness');
    expect(stderrChunks[0].endsWith('\n')).toBe(true);
  });

  test('exact-token search stays silent', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS });
    maybePrintConceptNudge('search', { query: 'stripe' });
    expect(stderrChunks.length).toBe(0);
  });

  test('--quiet silences the nudge even for concept-shaped queries', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, quiet: true });
    maybePrintConceptNudge('search', { query: CONCEPT_QUERY });
    expect(stderrChunks.length).toBe(0);
  });

  test('the query op never nudges (only search does)', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS });
    maybePrintConceptNudge('query', { query: CONCEPT_QUERY });
    expect(stderrChunks.length).toBe(0);
  });

  test('missing query param is a silent no-op, not a crash', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS });
    maybePrintConceptNudge('search', {});
    expect(stderrChunks.length).toBe(0);
  });
});
