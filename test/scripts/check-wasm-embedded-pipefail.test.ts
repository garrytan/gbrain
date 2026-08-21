/**
 * #3927 — check-wasm-embedded.sh could false-fail under pipefail.
 *
 * `if ! echo "$OUTPUT" | grep -q '<pattern>'; then FAIL` runs under
 * `set -euo pipefail`. grep -q exits as soon as it finds a match and
 * can close its end of the pipe before echo finishes writing $OUTPUT;
 * echo then gets SIGPIPE and the pipeline's exit status goes non-zero
 * even though grep matched. Reproduced 50/50 by the issue reporter with
 * a ~300KB payload.
 *
 * The fix is a plain bash substring test instead of a pipe, so this is
 * a source-shape guard rather than an execution test: exercising the
 * real script means a `bun build --compile` + binary run per check:wasm
 * invocation, which is already covered (slowly) by `bun run check:all`
 * and isn't worth duplicating here. This test just pins that the
 * vulnerable pipe shape doesn't come back.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'check-wasm-embedded.sh');

describe('check-wasm-embedded.sh (#3927)', () => {
  const source = readFileSync(SCRIPT, 'utf8');

  it('still runs under set -euo pipefail', () => {
    expect(source).toContain('set -euo pipefail');
  });

  it('does not pipe $OUTPUT through grep -q', () => {
    // Match the vulnerable pipeline shape in live code (ignore commented examples).
    expect(source).not.toMatch(/^[^\n#]*echo "\$OUTPUT"\s*\|\s*grep\s+-q\b/m);
  });

  it('uses a plain bash substring test for each of the three checks', () => {
    expect(source).toContain(`if [[ "$OUTPUT" != *'"has_symbol_names": true'* ]]; then`);
    expect(source).toContain(`if [[ "$OUTPUT" != *'"has_typescript_header": true'* ]]; then`);
    expect(source).toContain(`if [[ "$OUTPUT" != *'"calculateScore"'* ]]; then`);
  });
});
