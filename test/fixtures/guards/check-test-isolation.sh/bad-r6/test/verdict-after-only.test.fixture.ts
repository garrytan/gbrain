import { afterEach, expect, test } from 'bun:test';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../../../../../src/core/cli-force-exit.ts';

// R6: the verdict is reset only after each test, so the first test reads the previous file's verdict.
afterEach(() => {
  _resetCliExitVerdictForTests();
});
test('x', () => { expect(currentExitCode()).toBe(0); });
