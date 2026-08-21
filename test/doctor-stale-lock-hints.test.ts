/**
 * checkStaleLocks (src/commands/doctor/checks/routing-federation.ts) —
 * per-lock break hints. First coverage of this check's hint dispatch:
 *
 *   - cycle locks (`gbrain-cycle`, `gbrain-cycle:<source>`) point at
 *     `gbrain doctor --fix`. The removed hint `gbrain dream --break-lock`
 *     must NEVER come back: dream never implemented the flag, so a pasting
 *     operator ran a full (paid) dream cycle instead of breaking a lock.
 *   - sync locks (`gbrain-sync:<source>`) get the paste-ready
 *     `gbrain sync --break-lock --source <source>` command.
 *   - any other lock id falls back to the swept-at-next-acquire text.
 *
 * Runs without opts.fix so no reaping happens — the hints render for rows
 * `listStaleLocks` returns (ttl_expires_at < NOW()), seeded via direct SQL
 * like test/db-lock-inspect.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkStaleLocks } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedStaleLock(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
     VALUES ($1, 43210, 'dead-host', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
    [id],
  );
}

describe('checkStaleLocks — per-lock break hints', () => {
  it('ok with no stale rows', async () => {
    // A live (unexpired) lock is not stale.
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ('gbrain-cycle', 1234, 'live-host', NOW(), NOW() + INTERVAL '30 minutes')`,
    );
    const check = await checkStaleLocks(engine as unknown as BrainEngine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('No stale locks');
  });

  it('stale cycle locks hint at doctor --fix, never the removed dream --break-lock', async () => {
    await seedStaleLock('gbrain-cycle');
    await seedStaleLock('gbrain-cycle:src');
    const check = await checkStaleLocks(engine as unknown as BrainEngine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain-cycle');
    expect(check.message).toContain('gbrain-cycle:src');
    expect(check.message).toContain('gbrain doctor --fix');
    // The circular hint that ran a full paid dream cycle when pasted.
    expect(check.message).not.toContain('dream --break-lock');
  });

  it('a stale sync lock gets the paste-ready break command with its source id', async () => {
    await seedStaleLock('gbrain-sync:foo');
    const check = await checkStaleLocks(engine as unknown as BrainEngine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain sync --break-lock --source foo');
  });

  it('any other stale lock id falls back to the swept-at-next-acquire text', async () => {
    await seedStaleLock('custom-maintenance-lock');
    const check = await checkStaleLocks(engine as unknown as BrainEngine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('swept at the next acquire');
    // The fallback must not misroute to either named break command.
    expect(check.message).not.toContain('--break-lock');
    expect(check.message).not.toContain('doctor --fix');
  });
});
