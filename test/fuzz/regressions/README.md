# test/fuzz/regressions/

Pinned fuzz failures. Anything `pure-validators.test.ts` or
`filesystem-validators.test.ts` ever finds gets the minimal repro from
fast-check's shrinker copied here as a normal `*.test.ts` file so the bug is
locked in place even if the fuzz target list changes.

## Format

```ts
// test/fuzz/regressions/validatePageSlug-<short-hash>.test.ts
import { test, expect } from 'bun:test';
import { validatePageSlug } from '../../../src/core/operations.ts';

test('regression: validatePageSlug rejected this in <date>', () => {
  expect(() => validatePageSlug('<the failing input>')).toThrow(/expected error/);
});
```

Use a short hash of the input as the filename so multiple regressions for
the same validator don't collide.

## How to capture a new regression

When fast-check reports a property failure, the reporter prints the minimal
shrunken input. Copy it into a new file matching the format above. Keep the
date in the test name for future archaeology.
