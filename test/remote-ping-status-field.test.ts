/**
 * Regression guard: `gbrain remote ping` must poll the MinionJob `status`
 * field, never `state`.
 *
 * submit_job and get_job (src/core/operations.ts) return the MinionJob row
 * verbatim, whose lifecycle field is `status`
 * (src/core/minions/types.ts). remote.ts once typed and read `state`
 * instead: every poll then saw `undefined`, the terminal check
 * (`['completed','failed','dead','cancelled'].includes(job.state)`) never
 * matched, and ping exhausted its full --timeout and exited 1 even when
 * the autopilot-cycle had completed — printing
 * "Job #N is still undefined." on the way out.
 *
 * Source-audit style (same idiom as thin-client-routing-audit.test.ts):
 * pins the reads without needing a live MCP transport.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REMOTE_TS_PATH = join(import.meta.dir, '..', 'src', 'commands', 'remote.ts');
const REMOTE_SOURCE = readFileSync(REMOTE_TS_PATH, 'utf8');

describe('remote ping polls MinionJob.status, not .state', () => {
  test('no `.state` property reads on job objects remain', () => {
    // Catches `submitted.state`, `job.state` — any resurrection of the
    // wrong field. The ping's JSON *output* keys (`state:`, `last_state:`)
    // are object-literal keys, not property reads, and don't match this.
    expect(REMOTE_SOURCE).not.toMatch(/\b(?:job|submitted)\.state\b/);
  });

  test('poll loop reads job.status', () => {
    expect(REMOTE_SOURCE).toMatch(/\bjob\.status\b/);
    expect(REMOTE_SOURCE).toMatch(/\bsubmitted\.status\b/);
  });

  test('terminal-state check tests job.status', () => {
    expect(REMOTE_SOURCE).toMatch(/terminal\.includes\(job\.status\)/);
  });

  test('unpack generics type the lifecycle field as status', () => {
    // Both the submit and poll unpack sites must carry `status: string` in
    // their type argument, and none may reintroduce `state: string`.
    const unpackShapes = REMOTE_SOURCE.match(/unpackToolResult<\{[^}]*\}>/g) ?? [];
    const jobShapes = unpackShapes.filter((s) => s.includes('id: number'));
    expect(jobShapes.length).toBeGreaterThanOrEqual(2);
    for (const shape of jobShapes) {
      expect(shape).toContain('status: string');
      expect(shape).not.toContain('state: string');
    }
  });
});
