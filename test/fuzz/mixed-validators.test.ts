/**
 * Mixed-purity validator fuzz tests.
 *
 * These targets are validator-shaped (string in, validation/transformation out)
 * but live in files that transitively import `node:fs` or engine modules.
 * They don't get the purity-guard contract that `pure-validators.test.ts`
 * does. The property tests are the same shape — fuzz inputs, assert no
 * unbounded behavior — but a future contributor moving these to a pure
 * `src/core/pure/` module would be the upgrade path.
 *
 * The bundle reality (smoke-tested 2026-05-19): `validatePageSlug` and
 * `validateFilename` are string-only logic, but they live in
 * `src/core/operations.ts` which transitively pulls in the engine. Same for
 * `splitBody` (markdown.ts), `slugifyPath` (sync.ts), `sanitizeQueryForPrompt`
 * (expansion.ts). The functions themselves don't touch fs at runtime — but
 * importing them imports the rest of their module's dependency graph.
 */

import { describe, test } from 'bun:test';
import fc from 'fast-check';

import { validatePageSlug, validateFilename } from '../../src/core/operations.ts';
import { splitBody } from '../../src/core/markdown.ts';
import { slugifyPath } from '../../src/core/sync.ts';
import { sanitizeQueryForPrompt } from '../../src/core/search/expansion.ts';

const NUM_RUNS = 1000;

function fuzzVoidValidator(name: string, fn: (s: string) => void) {
  test(`${name}: arbitrary string input, no unbounded behavior`, () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        try {
          fn(input);
        } catch {
          /* throwing is fine — contract is "no wedge", not "always succeeds" */
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
}

function fuzzStringSanitizer(name: string, fn: (s: string) => string) {
  test(`${name}: returns a string on any input, never throws`, () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const out = fn(input);
        if (typeof out !== 'string') {
          throw new Error(`${name} returned non-string: ${typeof out}`);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
}

describe('mixed-purity validator fuzz', () => {
  fuzzVoidValidator('validatePageSlug', validatePageSlug);
  fuzzVoidValidator('validateFilename', validateFilename);

  fuzzStringSanitizer('sanitizeQueryForPrompt', sanitizeQueryForPrompt);
  fuzzStringSanitizer('slugifyPath', slugifyPath);

  test('splitBody: returns shape { compiled_truth, timeline } on any input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const out = splitBody(input);
        if (typeof out !== 'object' || out === null) {
          throw new Error(`splitBody returned non-object: ${typeof out}`);
        }
        if (typeof out.compiled_truth !== 'string') {
          throw new Error(`splitBody.compiled_truth not a string: ${typeof out.compiled_truth}`);
        }
        if (typeof out.timeline !== 'string') {
          throw new Error(`splitBody.timeline not a string: ${typeof out.timeline}`);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Sentinel stress for splitBody — feed YAML-ish strings with `---`,
  // `## Timeline`, etc, to exercise the sentinel parser branches.
  test('splitBody: stress sentinels with shaped inputs', () => {
    const sentinels = ['---', '## Timeline', '## History', '<!-- timeline -->', '--- timeline ---'];
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom(...sentinels),
        fc.string(),
        (head, sentinel, tail) => {
          const input = `${head}\n${sentinel}\n${tail}`;
          const out = splitBody(input);
          if (typeof out.compiled_truth !== 'string') throw new Error('compiled_truth not string');
          if (typeof out.timeline !== 'string') throw new Error('timeline not string');
        },
      ),
      { numRuns: 500 },
    );
  });
});
