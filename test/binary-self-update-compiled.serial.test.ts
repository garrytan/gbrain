/**
 * WS2 acceptance gate: the integrity-verify path must run in a REAL
 * `bun build --compile` binary, offline. Unit tests mock the seams; this proves
 * node:crypto + base64 + JSON (the dependency-free verify primitives) survive
 * compilation — the exact thing that would break had we used `sigstore-js`.
 *
 * Opt-in: compiling is slow (~seconds) and writes a large temp binary, so this
 * is skipped unless GBRAIN_SELFUPDATE_COMPILE_SMOKE=1 (run it locally / in a
 * heavy-test lane, not the hot unit path). Mirrors the repo's e2e gating.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN = process.env.GBRAIN_SELFUPDATE_COMPILE_SMOKE === '1';
const HARNESS = join(import.meta.dir, 'helpers', 'binary-self-update-smoke-harness.ts');

describe.skipIf(!RUN)('binary-self-update integrity verify — compiled binary (offline)', () => {
  test('real crypto + base64 + JSON verify path runs under bun build --compile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-smoke-build-'));
    const out = join(dir, 'smoke-harness');
    try {
      execFileSync('bun', ['build', '--compile', `--outfile=${out}`, HARNESS], {
        encoding: 'utf-8',
        timeout: 180_000,
      });
      // No network reachable is fine — the harness crafts the attestation in-process.
      const result = execFileSync(out, [], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env } });
      expect(result).toContain('SMOKE_OK');
      expect(result).not.toContain('SMOKE_FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
