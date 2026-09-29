import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { isSourceInCooldown } from '../src/commands/autopilot-fanout.ts';

const failedAt = new Date(Date.now() - 60_000);

function engineWithState(state: {
  sourceExists?: boolean;
  legacySourceAt?: string | null;
  legacyFullAt?: string | null;
  stateSourceAt?: Date | null;
  stateFullAt?: Date | null;
  stateExists?: boolean;
}): BrainEngine {
  return {
    getConfig: async () => null,
    executeRaw: async (sql: string) => {
      if (sql.includes('FROM minion_jobs')) {
        return [{ source_id: 'source-a', fail_count: 1, last_failed_at: failedAt }];
      }
      if (sql.includes('FROM sources s')) {
        if (state.sourceExists === false) return [];
        return [{
          config: {
            last_source_cycle_at: state.legacySourceAt ?? undefined,
            last_full_cycle_at: state.legacyFullAt ?? undefined,
          },
          cycle_state_exists: state.stateExists ?? false,
          last_source_cycle_at: state.stateSourceAt ?? null,
          last_full_cycle_at: state.stateFullAt ?? null,
        }];
      }
      throw new Error(`Unexpected SQL in cooldown test: ${sql}`);
    },
  } as unknown as BrainEngine;
}

describe('claim-time cooldown reads current-incarnation cycle state', () => {
  test('a newer state-table success clears failed-job cooldown', async () => {
    const engine = engineWithState({
      stateExists: true,
      stateSourceAt: new Date(Date.now() - 30_000),
      legacySourceAt: '2020-01-01T00:00:00.000Z',
    });
    expect(await isSourceInCooldown(engine, 'source-a')).toBe(false);
  });

  test('current state row is authoritative over a newer legacy config timestamp', async () => {
    const engine = engineWithState({
      stateExists: true,
      stateSourceAt: new Date(failedAt.getTime() - 30_000),
      legacySourceAt: new Date(Date.now()).toISOString(),
    });
    expect(await isSourceInCooldown(engine, 'source-a')).toBe(true);
  });

  test('legacy config is used when no current-incarnation state row exists', async () => {
    const engine = engineWithState({
      stateExists: false,
      legacySourceAt: new Date(Date.now() - 30_000).toISOString(),
    });
    expect(await isSourceInCooldown(engine, 'source-a')).toBe(false);
  });
});