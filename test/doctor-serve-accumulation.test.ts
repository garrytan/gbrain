/**
 * Leaf coverage for the serve_process_accumulation doctor check (#1163
 * visibility). Pure parser + threshold logic tested directly; the check
 * wrapper is exercised through the PsRunner test seam so no test ever
 * shells out to a real `ps`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  parseServeProcesses,
  parseEtimeSeconds,
  computeServeAccumulationCheck,
  checkServeProcessAccumulation,
  _setServePsRunnerForTests,
  type ServeProcessRow,
} from '../src/commands/doctor.ts';

// Shape observed live on a macOS host (5 leaked serves, oldest 1d9h):
// login wrapper + bun argv carrying the gbrain symlink path.
// Columns: pid uid etime command (ps -axww -o pid=,uid=,etime=,command=).
const PS_FIXTURE = `
 3661  501 01:05:42 bun /Users/op/.bun/bin/gbrain serve
11137  501 01-09:28:54 bun /Users/op/.bun/bin/gbrain serve
75582  501 09:51:44 bun /Users/op/.bun/bin/gbrain serve
 4242  501 02:00:01 bun /Users/op/.bun/bin/gbrain serve --http --port 8787
 5555  501 00:00:10 bun /Users/op/.bun/bin/gbrain doctor
 6666  501 03:14:15 vim /Users/op/src/commands/serve.ts
 7777  501 00:01:00 /usr/bin/login -f op /bin/zsh -c gbrain-mcp-serve.sh
 8888  502 04:00:00 bun /home/teammate/.bun/bin/gbrain serve
 9999  501 00:05:00 bun /Users/op/My Drive/.bun/bin/gbrain --quiet serve
 9100  501 00:06:00 bun /Users/op/.bun/bin/gbrain serve-http
`;

afterEach(() => _setServePsRunnerForTests(null));

describe('parseServeProcesses', () => {
  test('matches stdio serves incl. global flags + spaced paths; excludes --http, serve-http, doctor, editors, wrappers', () => {
    const rows = parseServeProcesses(PS_FIXTURE);
    expect(rows.map(r => r.pid)).toEqual([3661, 11137, 75582, 8888, 9999]);
    expect(rows[1]!.etime).toBe('01-09:28:54');
  });

  test('ownUid filter drops other users (shared-host false positive)', () => {
    const rows = parseServeProcesses(PS_FIXTURE, 501);
    expect(rows.map(r => r.pid)).toEqual([3661, 11137, 75582, 9999]);
  });

  test('empty and garbage input parse to no rows', () => {
    expect(parseServeProcesses('')).toEqual([]);
    expect(parseServeProcesses('not a ps line\n\n')).toEqual([]);
  });
});

describe('parseEtimeSeconds', () => {
  test('all ps ELAPSED shapes', () => {
    expect(parseEtimeSeconds('00:10')).toBe(10);
    expect(parseEtimeSeconds('09:51:44')).toBe(9 * 3600 + 51 * 60 + 44);
    expect(parseEtimeSeconds('01-09:28:54')).toBe(86400 + 9 * 3600 + 28 * 60 + 54);
    expect(parseEtimeSeconds('junk')).toBe(-1);
  });
});

describe('computeServeAccumulationCheck', () => {
  const row = (pid: number, etime: string): ServeProcessRow => ({
    pid,
    uid: 501,
    etime,
    command: 'bun gbrain serve',
  });

  test('below threshold → ok', () => {
    const c = computeServeAccumulationCheck([row(1, '00:10'), row(2, '01:00')]);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('2 gbrain serve');
  });

  test('at threshold → warn listing every PID, oldest first, with the idle-timeout hint', () => {
    const c = computeServeAccumulationCheck([
      row(10, '00:10'),
      row(20, '01-09:28:54'),
      row(30, '09:51:44'),
    ]);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('3 concurrent');
    expect(c.message).toContain('20 (up 01-09:28:54), 30 (up 09:51:44), 10 (up 00:10)');
    expect(c.message).toContain('oldest: 20');
    expect(c.message).toContain('--stdio-idle-timeout');
  });
});

describe('checkServeProcessAccumulation (PsRunner seam)', () => {
  test('live-shaped fixture → warn through the full wrapper (no uid filter on injected runners)', async () => {
    const c = await checkServeProcessAccumulation(async () => PS_FIXTURE);
    expect(c.name).toBe('serve_process_accumulation');
    expect(c.status).toBe('warn');
  });

  test('ps failure fails open to ok', async () => {
    const c = await checkServeProcessAccumulation(async () => {
      throw new Error('ps exploded');
    });
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Skipped');
  });

  test('module-level test seam reaches the wrapper (orchestrator hermeticity)', async () => {
    let calls = 0;
    _setServePsRunnerForTests(async () => {
      calls++;
      return '';
    });
    const c = await checkServeProcessAccumulation();
    expect(calls).toBe(1);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('0 gbrain serve');
  });
});
