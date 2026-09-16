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

  test('non-Windows prefers NUL-delimited proc argv, falling back to ps', () => {
    const { deps, calls } = probe('sleep 60', 'darwin');
    expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(true);
    expect(calls).toEqual(['proc', 'ps']);
    calls.length = 0;
    deps.execFile = () => { calls.push('ps'); throw new Error('unavailable'); };
    deps.readCmdlineFile = () => { calls.push('proc'); return 'bun\0src/cli.ts\0serve\0'; };
    expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(false);
    expect(calls).toEqual(['proc']);
  });

  for (const platform of ['darwin', 'win32'] as const) {
    for (const command of [
      'bun src/cli.ts.bak serve',
      'bun src/not-cli.ts serve',
      'bun src/cli.ts/other.ts serve',
      'bun /tmp/gbrain/other.ts serve',
      'bun /tmp/not-gbrain.ts serve',
      'worker --label=gbrain --script=cli.ts',
      'worker --log=/tmp/gbrain --script=/project/src/cli.ts',
    ]) {
      test(`${platform}: substrings do not identify the holder: ${command}`, () => {
        const { deps } = probe(command, platform);
        expect(isPidReusedByOtherProgram(PID, ['/project/src/cli.ts', 'serve'], null, null, deps)).toBe(true);
      });
    }
    for (const command of ['gbrain serve', '/opt/bin/gbrain serve', 'bun run src/cli.ts serve']) {
      test(`${platform}: an exact executable or script basename still identifies the holder: ${command}`, () => {
        const { deps } = probe(command, platform);
        expect(isPidReusedByOtherProgram(PID, ['/Users/Full Name/project/src/cli.ts', 'serve'], null, null, deps)).toBe(false);
      });
    }
  }

  for (const script of ['/Users/Full Name/project/src/my cli.ts', 'C:\\Users\\Full Name\\project\\src\\my cli.ts']) {
    test(`proc preserves whitespace in a script basename: ${script}`, () => {
      const { deps, calls } = probe('should not use ps', 'darwin');
      deps.readCmdlineFile = () => 'bun\0run\0src/my cli.ts\0serve\0';
      expect(isPidReusedByOtherProgram(PID, [script, 'serve'], null, null, deps)).toBe(false);
      expect(calls).toEqual([]);
    });
  }

  test('proc never splits one argument into matching identity tokens', () => {
    const { deps } = probe('', 'darwin');
    for (const arg of ['echo gbrain', 'echo cli.ts', 'cli.ts backup', 'gbrain backup']) {
      deps.readCmdlineFile = () => `worker\0${arg}\0`;
      expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(true);
    }
  });

  test('Windows preserves quoted argv boundaries, including spaces in script names', () => {
    const { deps } = probe('"C:\\Program Files\\Bun\\bun.exe" run "src/my cli.ts" serve');
    expect(isPidReusedByOtherProgram(PID, ['C:\\Users\\Full Name\\src\\my cli.ts', 'serve'], null, null, deps)).toBe(false);
    const unrelated = probe('worker "echo gbrain" "cli.ts backup"');
    expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, unrelated.deps)).toBe(true);
  });

  test('Windows recognizes a compiled gbrain.exe by exact basename', () => {
    const { deps } = probe('"C:\\Program Files\\GBrain\\GBRAIN.EXE" serve');
    expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(false);
  });

  test('Windows Unicode spaces inside paths are not argv delimiters', () => {
    for (const space of ['\u00a0', '\u3000']) {
      const { deps } = probe(`bun src/my${space}cli.ts serve`);
      expect(isPidReusedByOtherProgram(PID, [`C:\\project\\my${space}cli.ts`, 'serve'], null, null, deps)).toBe(false);
    }
  });

  for (const [command, expected] of [
    [String.raw`bun "src/cli.ts.bak"`, true],
    [String.raw`worker "echo \"gbrain\""`, true],
    [String.raw`worker "echo ""gbrain"""`, true],
    [String.raw`bun "src/my cli.ts" "C:\data\\" ""`, false],
    [String.raw`bun src/"my cli".ts serve`, false],
    [String.raw`bun "src/cli.ts".bak serve`, true],
    [String.raw`bun "src/my cli.ts".bak serve`, true],
  ] as const) {
    test(`Windows quote and backslash boundaries: ${command}`, () => {
      const { deps } = probe(command);
      expect(isPidReusedByOtherProgram(PID, ['C:\\project\\my cli.ts', 'serve'], null, null, deps)).toBe(expected);
    });
  }

  test('missing or incomplete proc argv cannot prove reuse', () => {
    for (const raw of ['\0', 'worker\0unterminated']) {
      const { deps, calls } = probe('worker', 'darwin');
      deps.readCmdlineFile = () => raw;
      expect(isPidReusedByOtherProgram(PID, ['cli.ts', 'serve'], null, null, deps)).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test('an ambiguous ps rendering of a whitespace-bearing basename cannot prove reuse', () => {
    const { deps } = probe('bun run src/my  cli.ts serve', 'darwin');
    expect(isPidReusedByOtherProgram(PID, ['/Users/Full Name/my\tcli.ts', 'serve'], null, null, deps)).toBe(false);
  });

  test('an unterminated Windows quote cannot prove reuse', () => {
    const { deps } = probe('"C:\\Program Files\\Bun\\bun.exe run cli.ts');
    expect(isPidReusedByOtherProgram(PID, ['other.ts', 'serve'], null, null, deps)).toBe(false);
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
