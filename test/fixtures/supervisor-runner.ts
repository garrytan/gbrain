/**
 * Test fixture: spawns a MinionSupervisor with options parsed from env vars.
 *
 * Used by test/supervisor.test.ts integration tests. Separate file because
 * the supervisor calls `process.exit()` at the end of its lifecycle — tests
 * spawn this runner as a subprocess to observe exit codes and audit events
 * without killing the test runner itself.
 *
 * Env vars (all optional, sensible defaults for tests):
 *   SUP_CLI_PATH           — worker binary path (default: /bin/sh exit-1 script)
 *   SUP_PID_FILE           — PID file path (REQUIRED; each test uses a unique one)
 *   SUP_MAX_CRASHES        — max consecutive crashes (default: 3)
 *   SUP_BACKOFF_FLOOR_MS   — test-only short backoff (default: 1)
 *   SUP_HEALTH_INTERVAL_MS — how often healthCheck fires (default: 999_999 off)
 *   SUP_ALLOW_SHELL_JOBS   — "1" to set allowShellJobs:true, else false
 *   SUP_QUEUE              — queue name (default: 'default')
 *   SUP_AUDIT_DIR          — GBRAIN_AUDIT_DIR override (default: tmpdir/supervisor-test)
 */

import { MinionSupervisor } from '../../src/core/minions/supervisor.ts';
import { writeSupervisorEvent } from '../../src/core/minions/handlers/supervisor-audit.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

// Mock engine: healthCheck() calls engine.executeRaw; return empty rows so
// the query path exercises without needing Postgres.
//
// #1849: start() now acquires the queue-scoped DB singleton lock via
// tryAcquireDbLock, which uses the postgres `sql` tagged-template escape hatch.
// The stub returns a single row from every call so acquire succeeds (length 1
// → acquired) and refresh/release are no-ops. Each spawned runner is a fresh
// process, so there's no cross-test lock state to clean up.
const sqlStub = (..._args: unknown[]) => Promise.resolve([{ id: 'supervisor-lock' }]);
const mockEngine: Partial<BrainEngine> = {
  kind: 'postgres' as const,
  executeRaw: async () => [],
  sql: sqlStub,
} as unknown as BrainEngine;

const pidFile = process.env.SUP_PID_FILE;
if (!pidFile) {
  console.error('SUP_PID_FILE env var is required');
  process.exit(99);
}

const cliPath = process.env.SUP_CLI_PATH ?? '/bin/sh';
const maxCrashes = parseInt(process.env.SUP_MAX_CRASHES ?? '3', 10);
const backoffFloor = parseInt(process.env.SUP_BACKOFF_FLOOR_MS ?? '1', 10);
const healthInterval = parseInt(process.env.SUP_HEALTH_INTERVAL_MS ?? '999999', 10);
const allowShellJobs = process.env.SUP_ALLOW_SHELL_JOBS === '1';
const queueName = process.env.SUP_QUEUE ?? 'default';
// SUP_MAX_RSS: when set, pin an explicit watchdog cap (tests the passthrough
// path). When unset, MinionSupervisor auto-sizes cgroup-aware (issue #1678).
const maxRssExplicit = process.env.SUP_MAX_RSS !== undefined
  ? parseInt(process.env.SUP_MAX_RSS, 10)
  : undefined;

if (process.env.SUP_AUDIT_DIR) {
  process.env.GBRAIN_AUDIT_DIR = process.env.SUP_AUDIT_DIR;
}

const supervisorPid = process.pid;

const supervisor = new MinionSupervisor(mockEngine as BrainEngine, {
  concurrency: 1,
  queue: queueName,
  pidFile,
  maxCrashes,
  healthInterval,
  cliPath,
  allowShellJobs,
  json: true,
  _backoffFloorMs: backoffFloor,
  ...(maxRssExplicit !== undefined ? { maxRssMb: maxRssExplicit } : {}),
  onEvent: (emission) => writeSupervisorEvent(emission, supervisorPid),
});

await supervisor.start();
