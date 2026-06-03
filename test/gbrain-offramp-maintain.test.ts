import { describe, expect, test } from 'bun:test';

import { buildMaintenancePlan, main } from '../scripts/gbrain-offramp-maintain.ts';

function makeReceipt(chunksUnembedded: number) {
  return {
    activeSource: 'default',
    brainScore: 73,
    defaultSource: {
      sourceId: 'default',
      pages: 1889,
      chunksTotal: 7800,
      chunksUnembedded,
      embeddingCoveragePct: chunksUnembedded === 0 ? 100 : 98.4,
    },
    unacknowledgedFailures: 0,
    autopilot: {
      installed: false,
      running: false,
      waiting: 0,
    },
    maxReachableScore: 90,
    recommendedCommands: [],
  };
}

describe('gbrain-offramp-maintain', () => {
  test('buildMaintenancePlan blocks maintenance while default still has unembedded chunks', () => {
    const before = makeReceipt(125);

    expect(buildMaintenancePlan(before)).toEqual({
      blocked: true,
      reason: 'Default source still has 125 unembedded chunks. Run `gbrain embed --stale` before maintenance or pass --allow-default-backlog.',
      commands: [],
    });
  });

  test('buildMaintenancePlan allows the upkeep loop once default is clean', () => {
    const before = makeReceipt(0);

    expect(buildMaintenancePlan(before)).toEqual({
      blocked: false,
      reason: null,
      commands: [
        ['gbrain', 'sync', '--all', '--parallel', '4', '--workers', '4', '--skip-failed'],
        ['gbrain', 'embed', '--stale'],
        ['gbrain', 'extract', 'all'],
      ],
    });
  });

  test('blocked dry-run emits the reason to stderr, returns non-zero, and never runs commands', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const commands: string[][] = [];

    const code = await main(['--dry-run'], {
      collectReceipt: async () => makeReceipt(42),
      runCommand: async (command) => {
        commands.push(command);
      },
      writeStdout: (text) => {
        stdout.push(text);
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    });

    expect(code).toBe(1);
    expect(commands).toEqual([]);
    expect(stderr).toEqual([
      'Default source still has 42 unembedded chunks. Run `gbrain embed --stale` before maintenance or pass --allow-default-backlog.\n',
    ]);
    expect(JSON.parse(stdout.join(''))).toEqual({
      before: makeReceipt(42),
      plan: {
        blocked: true,
        reason: 'Default source still has 42 unembedded chunks. Run `gbrain embed --stale` before maintenance or pass --allow-default-backlog.',
        commands: [],
      },
    });
  });

  test('--allow-default-backlog unblocks dry-run and returns the exact command sequence without running it', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const commands: string[][] = [];

    const code = await main(['--dry-run', '--allow-default-backlog'], {
      collectReceipt: async () => makeReceipt(42),
      runCommand: async (command) => {
        commands.push(command);
      },
      writeStdout: (text) => {
        stdout.push(text);
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    });

    expect(code).toBe(0);
    expect(commands).toEqual([]);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toEqual({
      before: makeReceipt(42),
      plan: {
        blocked: false,
        reason: null,
        commands: [
          ['gbrain', 'sync', '--all', '--parallel', '4', '--workers', '4', '--skip-failed'],
          ['gbrain', 'embed', '--stale'],
          ['gbrain', 'extract', 'all'],
        ],
      },
    });
  });
});
