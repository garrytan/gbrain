/**
 * Leaf coverage for the serve_process_accumulation doctor check (#1163
 * visibility). Pure parser + threshold logic tested directly; the check
 * wrapper is exercised through the PsRunner test seam so no test ever
 * shells out to a real `ps`.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseServeProcesses,
  parseEtimeSeconds,
  computeServeAccumulationCheck,
  checkServeProcessAccumulation,
  type ServeProcessRow,
} from '../src/commands/doctor.ts';

// Shape observed live on a macOS host (5 leaked serves, oldest 1d9h):
// login wrapper + bun argv carrying the gbrain symlink path.
const PS_FIXTURE = `
 3661 01:05:42 bun /Users/op/.bun/bin/gbrain serve
11137 01-09:28:54 bun /Users/op/.bun/bin/gbrain serve
75582 09:51:44 bun /Users/op/.bun/bin/gbrain serve
 4242 02:00:01 bun /Users/op/.bun/bin/gbrain serve --http --port 8787
 5555 00:00:10 bun /Users/op/.bun/bin/gbrain doctor
 6666 03:14:15 vim /Users/op/src/commands/serve.ts
 7777 00:01:00 /usr/bin/login -f op /bin/zsh -c gbrain-mcp-serve.sh
`;

describe('parseServeProcesses', () => {
  test('matches stdio serves; excludes --http, doctor, editors, wrappers', () => {
    const rows = parseServeProcesses(PS_FIXTURE);
    expect(rows.map(r => r.pid)).toEqual([3661, 11137, 75582]);
    expect(rows[1]!.etime).toBe('01-09:28:54');
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
    etime,
    command: 'bun gbrain serve',
  });

  test('below threshold → ok', () => {
    const c = computeServeAccumulationCheck([row(1, '00:10'), row(2, '01:00')]);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('2 gbrain serve');
  });

  test('at threshold → warn with oldest etime and the idle-timeout hint', () => {
    const c = computeServeAccumulationCheck([
      row(1, '00:10'),
      row(2, '01-09:28:54'),
      row(3, '09:51:44'),
    ]);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('3 concurrent');
    expect(c.message).toContain('01-09:28:54');
    expect(c.message).toContain('--stdio-idle-timeout');
  });
});

describe('checkServeProcessAccumulation (PsRunner seam)', () => {
  test('live-shaped fixture → warn through the full wrapper', async () => {
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
});
