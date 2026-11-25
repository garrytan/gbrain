/**
 * rust/crates/gbrain-store/src/takes/zone_transitions.rs is generated from the tzdata of the PGLite this
 * repository depends on (rust/scripts/gen-zone-transitions.ts). The Rust store reads a resolved date
 * written with a date-dependent zone abbreviation (`MSK`, `SGT`, ...) from it, so a PGLite upgrade
 * that changes those zones must regenerate it, or Rust would answer a different instant than PGLite.
 */
import { describe, expect, test } from 'bun:test';

describe('zone_transitions.rs', () => {
  test("matches the tzdata of the repository's PGLite", () => {
    const run = Bun.spawnSync(['bun', 'rust/scripts/gen-zone-transitions.ts'], { stdout: 'pipe', stderr: 'pipe' });
    expect(run.stderr.toString()).toBe('');
    expect(run.stdout.toString()).toContain('zone_transitions.rs is current');
    expect(run.exitCode).toBe(0);
  }, 60_000);
});
