/**
 * #2084 class pin — every exit-code write in src/ routes through
 * setCliExitVerdict.
 *
 * A RAW `process.exitCode = N` is silently ZEROED by the deliberate
 * flush-exit: currentExitCode() reads only gbrain's owned verdict (the
 * PGLite-Emscripten-pollution defense), so a command that bypasses the
 * setter reports success on failure. Caught live twice in one day: doctor's
 * FAIL path exited 0 after a merge introduced a raw write. Runtime variants
 * are pinned in test/cli-finish-teardown.test.ts; this is the structural
 * guard that catches the NEXT raw write at review time.
 */

import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';

describe('exit-verdict ownership — no raw process.exitCode assignments', () => {
  test('every exit-code write in src/ routes through setCliExitVerdict', () => {
    // Two legitimate writers are exempt:
    //  - cli-force-exit.ts: setCliExitVerdict's own mirror-write.
    //  - pglite-engine.ts preservingProcessExitCode: #2141's containment
    //    RESTORE around PGlite.create() — it keeps the GLOBAL tidy for
    //    external readers and is explicitly not a verdict write (the owned
    //    channel never reads process.exitCode).
    // Whitespace/operator-tolerant: catches `process.exitCode=1`,
    // `process.exitCode ??= 1`, `process.exitCode ||= 1`, and the bracket
    // form — every shape is equally zeroed by the owned-verdict read.
    const hits = execSync(
      String.raw`grep -rnE "process(\.|\[')exitCode('\])?[[:space:]]*([?|&]{2})?=[^=]" src --include='*.ts' | grep -v "core/cli-force-exit.ts" | grep -v "core/pglite-engine.ts" || true`,
      { encoding: 'utf-8', cwd: new URL('..', import.meta.url).pathname },
    ).trim();
    expect(hits).toBe('');
  });
});
