import { beforeEach, expect, test } from 'bun:test';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../../../../../src/core/cli-force-exit.ts';

// Each test starts from its own verdict baseline.
beforeEach(() => { _resetCliExitVerdictForTests(); });
test('x', () => { expect(currentExitCode()).toBe(0); });
