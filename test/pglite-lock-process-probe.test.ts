import { describe, expect, test } from 'bun:test';
import { isPidReusedByOtherProgram } from '../src/core/pglite-lock.ts';
import type { ProcessCommandProbeDeps } from '../src/core/autopilot-lock.ts';

const PID = process.pid + 1000;

function probe(command: string, platform: NodeJS.Platform = 'win32') {
  const calls: string[] = [];
  const deps: ProcessCommandProbeDeps = {
    platform,
    readCmdlineFile: () => { calls.push('proc'); throw new Error('unavailable'); },
    execFile: (file, args, options) => {
      calls.push(file);
      if (platform === 'win32') {
        if (file !== 'powershell.exe') throw new Error('unavailable');
        expect(args).toContain('-NonInteractive');
        expect(args.join(' ')).toContain(`ProcessId=${PID}`);
        expect(options.windowsHide).toBe(true);
      }
      return command;
    },
  };
  return { deps, calls };
}

describe('PGLite process command probes', () => {
  test('Windows reclaims an unrelated PID using CIM, not POSIX probes (#5065)', () => {
    const { deps, calls } = probe('C:\\Windows\\System32\\notepad.exe');
    expect(isPidReusedByOtherProgram(PID, ['C:\\bin\\cli.ts', 'serve'], null, null, deps)).toBe(true);
    expect(calls).toEqual(['powershell.exe']);
  });

  for (const argv of [undefined, ['C:\\Users\\Example User\\project\\src\\CLI.TS', 'serve']]) {
    test(`Windows case and separator drift does not steal a live holder (structured=${!!argv})`, () => {
      const { deps } = probe('"C:\\Program Files\\Bun\\bun.exe" run src/cli.ts serve');
      expect(isPidReusedByOtherProgram(PID, argv, null, null, deps)).toBe(false);
    });
  }

  test('structured argv still proves a genuinely unrelated process', () => {
    const { deps } = probe('C:\\Windows\\System32\\notepad.exe');
    const argv = ['C:\\Users\\Example User\\project\\src\\cli.ts', 'serve'];
    expect(isPidReusedByOtherProgram(PID, argv, null, null, deps)).toBe(true);
  });

  test('Windows paths match a relative command by backslash-delimited basename', () => {
    const { deps } = probe('bun cli.ts serve');
    expect(isPidReusedByOtherProgram(PID, ['C:\\project\\src\\cli.ts', 'serve'], null, null, deps)).toBe(false);
  });

  for (const argv of [undefined, null, [], [42], [''], ['cli.ts', 42], 'cli.ts']) {
    test(`malformed structured argv cannot prove reuse: ${JSON.stringify(argv)}`, () => {
      const { deps } = probe('bun other.ts', 'darwin');
      expect(isPidReusedByOtherProgram(PID, argv, null, null, deps)).toBe(false);
    });
  }

  test('unreadable or empty Windows command lines cannot prove reuse', () => {
    for (const output of [null, '', '   ']) {
      const { deps } = probe('');
      deps.execFile = () => { if (output === null) throw new Error('denied'); return output; };
      expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(false);
    }
  });

  test('non-Windows retains ps first and proc fallback', () => {
    const { deps, calls } = probe('sleep 60', 'darwin');
    expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(true);
    expect(calls).toEqual(['ps']);
    calls.length = 0;
    deps.execFile = () => { calls.push('ps'); throw new Error('unavailable'); };
    deps.readCmdlineFile = () => { calls.push('proc'); return 'bun\0src/cli.ts\0serve\0'; };
    expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(false);
    expect(calls).toEqual(['ps', 'proc']);
  });

  test('the current PID and unverified Linux namespace never trigger a command probe', () => {
    const { deps, calls } = probe('other', 'linux');
    expect(isPidReusedByOtherProgram(process.pid, ['cli.ts', 'serve'], null, null, deps)).toBe(false);
    expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  test('non-Windows path comparisons remain case sensitive', () => {
    const { deps } = probe('bun OTHER.ts', 'darwin');
    expect(isPidReusedByOtherProgram(PID, ['other.ts', 'serve'], null, null, deps)).toBe(true);
  });
});
