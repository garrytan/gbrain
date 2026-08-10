/**
 * fork-patch #9 — the sync baseline-commit guard must distinguish a CLEAN
 * unborn-HEAD signal from any ambiguous probe failure (timeout / lock / other)
 * and fail CLOSED on ambiguity. `classifyHeadProbeError` isolates that decision
 * as a pure predicate so the born/unborn/ambiguous distinction is unit-testable
 * without fault injection.
 *
 * Empirical basis (verified on the installed git): `git rev-parse --verify
 * --quiet HEAD` exits EXACTLY 1 with empty stderr on an unborn HEAD, exit 0 on
 * a born HEAD. A 30s execFileSync timeout throws with `signal:'SIGTERM'` and
 * `status:null`; an index/ref lock exits non-zero (e.g. 128) with a `fatal:`
 * line on stderr. Only the clean exit-1 signal may be treated as unborn.
 */
import { describe, test, expect } from 'bun:test';
import { classifyHeadProbeError } from '../src/commands/sync.ts';

describe('classifyHeadProbeError: clean-unborn vs ambiguous (fork-patch #9)', () => {
  test("exit 1 + no signal + empty stderr => 'unborn'", () => {
    expect(classifyHeadProbeError({ status: 1, signal: null, stderr: '' })).toBe('unborn');
    expect(classifyHeadProbeError({ status: 1, signal: null, stderr: Buffer.from('') })).toBe('unborn');
    // stderr that trims to empty is still the clean signal.
    expect(classifyHeadProbeError({ status: 1, signal: null, stderr: '   \n' })).toBe('unborn');
    // a missing stderr field (undefined) with the clean exit is still unborn.
    expect(classifyHeadProbeError({ status: 1, signal: null })).toBe('unborn');
  });

  test("timeout kill (SIGTERM / status null) => 'ambiguous' (the incident class)", () => {
    expect(classifyHeadProbeError({ status: null, signal: 'SIGTERM', stderr: '' })).toBe('ambiguous');
    expect(classifyHeadProbeError({ status: null, signal: 'SIGKILL', stderr: '' })).toBe('ambiguous');
  });

  test("index/ref lock or any non-empty stderr => 'ambiguous'", () => {
    expect(
      classifyHeadProbeError({ status: 128, signal: null, stderr: "fatal: Unable to create '/x/.git/index.lock': File exists" }),
    ).toBe('ambiguous');
    // even exit 1: if stderr is non-empty it is NOT the clean unborn signal.
    expect(classifyHeadProbeError({ status: 1, signal: null, stderr: 'fatal: something' })).toBe('ambiguous');
  });

  test("any nonzero-but-not-1 exit => 'ambiguous'", () => {
    expect(classifyHeadProbeError({ status: 128, signal: null, stderr: '' })).toBe('ambiguous');
    expect(classifyHeadProbeError({ status: 129, signal: null, stderr: '' })).toBe('ambiguous');
  });

  test('malformed / missing input never crashes and never claims unborn', () => {
    expect(classifyHeadProbeError(undefined)).toBe('ambiguous');
    expect(classifyHeadProbeError(null)).toBe('ambiguous');
    expect(classifyHeadProbeError({})).toBe('ambiguous');
    expect(classifyHeadProbeError(new Error('boom'))).toBe('ambiguous');
    expect(classifyHeadProbeError('nope')).toBe('ambiguous');
  });
});
