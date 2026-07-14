/**
 * Tests for MinionSupervisor's tini detection wiring.
 *
 * Per the eng-review + codex review: the seam is the supervisor's
 * `isTiniDetected` accessor (added for testability) and the existing
 * `worker_spawned` event payload at supervisor.ts:483-487 which already
 * includes `{tini: true}` when tini is in use. Spawning the full lifecycle
 * for a tini-presence assertion is overkill; the constructor reads tiniPath
 * once via `detectTini()`, and tests control the answer via PATH.
 *
 * Two cases:
 *   1. tini absent (PATH stripped of any directory containing tini) → false
 *   2. tini present (PATH points at a tmpdir with a fake `tini` script) → true
 *
 * Uses withEnv from test/helpers/with-env.ts so PATH mutations restore
 * cleanly even if the test throws.
 */

import { describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MinionSupervisor } from '../src/core/minions/supervisor.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const mockEngine: Partial<BrainEngine> = {
  kind: 'postgres' as const,
  executeRaw: async () => [],
} as unknown as BrainEngine;

describe('MinionSupervisor tini detection', () => {
  test('isTiniDetected = false when tini is not on PATH', async () => {
    // Empty PATH so `which tini` cannot find anything.
    await withEnv({ PATH: '' }, async () => {
      const supervisor = new MinionSupervisor(mockEngine as BrainEngine, {
        cliPath: '/bin/echo',
      });
      expect(supervisor.isTiniDetected).toBe(false);
    });
  });

  test('isTiniDetected = true when a runnable tini binary exists on PATH', async () => {
    const dir = join(
      tmpdir(),
      `gbrain-supervisor-tini-test-${process.pid}-${Date.now()}`,
    );
    mkdirSync(dir, { recursive: true });
    const fakeTini = join(dir, 'tini');
    writeFileSync(
      fakeTini,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tini version 0.19.0"; exit 0; fi\nexec "$@"\n',
      'utf8',
    );
    chmodSync(fakeTini, 0o755);
    try {
      // Prepend our fake-tini directory so `which tini` resolves to it.
      // Keep `/usr/bin:/bin` so `which` itself is locatable on macOS/Linux.
      await withEnv({ PATH: `${dir}:/usr/bin:/bin` }, async () => {
        const supervisor = new MinionSupervisor(mockEngine as BrainEngine, {
          cliPath: '/bin/echo',
        });
        expect(supervisor.isTiniDetected).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isTiniDetected = false when a PATH entry named tini cannot run as a child', async () => {
    const dir = join(
      tmpdir(),
      `gbrain-supervisor-invalid-tini-test-${process.pid}-${Date.now()}`,
    );
    mkdirSync(dir, { recursive: true });
    const invalidTini = join(dir, 'tini');
    // Mirrors an s6-overlay /init alias: discoverable on PATH but unusable
    // outside PID 1. The supervisor must directly spawn its worker instead.
    writeFileSync(invalidTini, '#!/bin/sh\necho "fatal: can only run as pid 1" >&2\nexit 100\n', 'utf8');
    chmodSync(invalidTini, 0o755);
    try {
      await withEnv({ PATH: `${dir}:/usr/bin:/bin` }, async () => {
        const supervisor = new MinionSupervisor(mockEngine as BrainEngine, {
          cliPath: '/bin/echo',
        });
        expect(supervisor.isTiniDetected).toBe(false);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
