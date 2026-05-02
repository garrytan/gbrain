/**
 * Tests for test/helpers/cli-pty-runner.ts (D14/C-prime PTY harness).
 *
 * Pure-function tests. The launchPty subprocess path is exercised by
 * the E2E suite (test/e2e/skill-smoke-openclaw.test.ts), not here.
 */

import { describe, expect, it } from 'bun:test';
import {
  stripAnsi,
  isNumberedOptionListVisible,
  parseNumberedOptions,
  optionsSignature,
  isTrustDialogVisible,
  resolveBinary,
} from './helpers/cli-pty-runner.ts';

describe('stripAnsi', () => {
  it('strips standard CSI sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;33;42mfoo\x1b[m')).toBe('foo');
  });

  it('strips OSC sequences (terminator BEL)', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest');
  });

  it('strips OSC sequences (terminator ST)', () => {
    expect(stripAnsi('\x1b]1;icon\x1b\\rest')).toBe('rest');
  });

  it('strips charset designators', () => {
    expect(stripAnsi('\x1b(Bplain')).toBe('plain');
  });

  it('strips DEC special functions (\\x1b7 / \\x1b8 / \\x1b=)', () => {
    expect(stripAnsi('\x1b7save\x1b8restore\x1b=app')).toBe('saverestoreapp');
  });

  it('passes through plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('1. Option\n2. Option')).toBe('1. Option\n2. Option');
  });
});

describe('isNumberedOptionListVisible', () => {
  it('matches a cursor + numbered list', () => {
    expect(isNumberedOptionListVisible('❯ 1. Yes\n  2. No')).toBe(true);
  });

  it('rejects when no cursor', () => {
    expect(isNumberedOptionListVisible('1. Yes\n2. No')).toBe(false);
  });

  it('rejects when only one option', () => {
    expect(isNumberedOptionListVisible('❯ 1. Only')).toBe(false);
  });

  it('handles cursor + collapsed-whitespace cases (TTY artifacts)', () => {
    // After stripAnsi, cursor-positioning escapes that visually rendered
    // as spaces are gone — `text 2.` becomes `text2.`.
    expect(isNumberedOptionListVisible('❯ 1.Yestext2.No')).toBe(true);
  });
});

describe('parseNumberedOptions', () => {
  it('extracts a clean 3-option list', () => {
    const visible = `Question text
❯ 1. First option
  2. Second option
  3. Third option
`;
    const opts = parseNumberedOptions(visible);
    expect(opts).toEqual([
      { index: 1, label: 'First option' },
      { index: 2, label: 'Second option' },
      { index: 3, label: 'Third option' },
    ]);
  });

  it('returns [] when no list rendered', () => {
    expect(parseNumberedOptions('just prose, no list')).toEqual([]);
  });

  it('returns [] when only one option (not a real list)', () => {
    expect(parseNumberedOptions('❯ 1. Only')).toEqual([]);
  });

  it('caller pattern: gate on isNumberedOptionListVisible to skip prose', () => {
    // parseNumberedOptions itself has a fallback for cursor-on-non-1
    // (user pressed Down) which means it WILL match prose numbering
    // when no cursor is present. The contract is that consumers gate
    // on `isNumberedOptionListVisible` first — it requires `❯`.
    const prose = `Steps to take:
1. Read the file
2. Edit the line
3. Run the test`;
    expect(isNumberedOptionListVisible(prose)).toBe(false);
    // Defense-in-depth: even if parseNumberedOptions returns options
    // here, the caller would not act on them because the gate is false.
  });

  it('truncates at the first gap (sequential block only)', () => {
    const visible = `❯ 1. A
  2. B
  4. D`;
    expect(parseNumberedOptions(visible)).toEqual([
      { index: 1, label: 'A' },
      { index: 2, label: 'B' },
    ]);
  });

  it('handles cursor on a non-1 option (user pressed Down)', () => {
    const visible = `Question
  1. First
❯ 2. Second
  3. Third`;
    const opts = parseNumberedOptions(visible);
    expect(opts.length).toBe(3);
    expect(opts[0]).toEqual({ index: 1, label: 'First' });
  });

  it('reads only the last 4KB to avoid stale option lists', () => {
    const noise = 'old ❯ 1. STALE\n  2. STALE\n'.padEnd(5000, ' ');
    const fresh = '❯ 1. Fresh\n  2. New\n';
    const opts = parseNumberedOptions(noise + fresh);
    expect(opts).toEqual([
      { index: 1, label: 'Fresh' },
      { index: 2, label: 'New' },
    ]);
  });
});

describe('optionsSignature', () => {
  it('produces a stable signature regardless of input order', () => {
    const a = optionsSignature([
      { index: 2, label: 'B' },
      { index: 1, label: 'A' },
    ]);
    const b = optionsSignature([
      { index: 1, label: 'A' },
      { index: 2, label: 'B' },
    ]);
    expect(a).toBe(b);
    expect(a).toBe('1:A|2:B');
  });

  it('includes label in the signature so same indices with different labels differ', () => {
    expect(optionsSignature([{ index: 1, label: 'Yes' }])).not.toBe(
      optionsSignature([{ index: 1, label: 'No' }]),
    );
  });
});

describe('isTrustDialogVisible', () => {
  it('matches the canonical phrasing', () => {
    expect(
      isTrustDialogVisible('Do you want to trust this folder?'),
    ).toBe(true);
  });

  it('does not match other prompts', () => {
    expect(isTrustDialogVisible('Do you want to proceed?')).toBe(false);
    expect(isTrustDialogVisible('')).toBe(false);
  });
});

describe('resolveBinary', () => {
  it('honors override when the file exists', () => {
    // /bin/sh exists everywhere unix-y this test runs.
    expect(resolveBinary('any-name', '/bin/sh')).toBe('/bin/sh');
  });

  it('returns null for a definitely-missing binary', () => {
    expect(resolveBinary('definitely-not-a-real-binary-xyzzy123')).toBeNull();
  });

  it('finds common binaries by name (sh)', () => {
    const sh = resolveBinary('sh');
    // bun.which finds /bin/sh on macOS/linux. Either /bin/sh or /usr/bin/sh
    // is acceptable — just confirm SOMETHING was found.
    expect(sh).toBeTruthy();
  });
});
