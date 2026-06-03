import { describe, expect, test } from 'bun:test';

import { buildMaintenancePlan } from '../scripts/gbrain-offramp-maintain.ts';

describe('gbrain-offramp-maintain', () => {
  test('buildMaintenancePlan blocks maintenance while default still has unembedded chunks', () => {
    const before = {
      activeSource: 'default',
      brainScore: 73,
      defaultSource: {
        sourceId: 'default',
        pages: 1889,
        chunksTotal: 7800,
        chunksUnembedded: 125,
        embeddingCoveragePct: 98.4,
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

    expect(buildMaintenancePlan(before)).toEqual({
      blocked: true,
      reason: 'Default source still has 125 unembedded chunks. Run `gbrain embed --stale` before maintenance or pass --allow-default-backlog.',
      commands: [],
    });
  });

  test('buildMaintenancePlan allows the upkeep loop once default is clean', () => {
    const before = {
      activeSource: 'default',
      brainScore: 90,
      defaultSource: {
        sourceId: 'default',
        pages: 1889,
        chunksTotal: 7800,
        chunksUnembedded: 0,
        embeddingCoveragePct: 100,
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
});
