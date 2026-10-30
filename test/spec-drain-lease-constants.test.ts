/**
 * spec/tla/drain-lease models the drain lease with the code's timing. This test keeps the model's configs and the code in
 * step: a changed lease constant fails here, naming the constant and the config to revisit, before the model silently
 * checks a protocol the code no longer runs. Read spec/tla/README.md ("Timing") before changing either side.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRAIN_LEASE_REFRESH_MS, DRAIN_LEASE_TTL_MINUTES, FENCED_SLICE_MS } from '../src/core/persistence/sync-lease.ts';
import { HOLDER_TAKEOVER_GRACE_MS, resolveStealGraceSeconds } from '../src/core/db-lock.ts';
import { withEnv } from './helpers/with-env.ts';

const ROOT = join(import.meta.dir, '..');
const SPEC = join(ROOT, 'spec/tla/drain-lease');
const CONFIGS = readdirSync(SPEC).filter(f => f.endsWith('.cfg')).sort();

function constants(cfg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(SPEC, cfg), 'utf8').split('\n')) {
    const m = line.match(/^\s+(\w+)\s*=\s*(\S+)\s*$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** withRefreshingLock's renewal deadline: min(heartbeatTimeoutMs ?? default, ttl / 3). The default is read from the source. */
function renewalTimeoutMs(ttlMs: number): number {
  // test-reads-source-ok[structural]: the renewal timeout is a local expression inside withRefreshingLock with no export; the model's RenewTimeoutMs must track it
  const source = readFileSync(join(ROOT, 'src/core/db-lock.ts'), 'utf8');
  const m = source.match(/const heartbeatTimeoutMs = Math\.min\(opts\.heartbeatTimeoutMs \?\? ([\d_]+), ttlMs \/ 3\);/);
  expect(m, 'withRefreshingLock no longer computes its renewal timeout as min(opts.heartbeatTimeoutMs ?? <default>, ttlMs / 3); update this test and RenewTimeoutMs in spec/tla/drain-lease/*.cfg to the new rule').not.toBeNull();
  return Math.min(Number(m![1]!.replace(/_/g, '')), ttlMs / 3);
}

const TTL_MS = DRAIN_LEASE_TTL_MINUTES * 60_000;
const code = () => withEnv({ GBRAIN_LOCK_STEAL_GRACE_SECONDS: undefined }, () => ({
  TtlMs: TTL_MS,
  RefreshMs: DRAIN_LEASE_REFRESH_MS,
  RenewTimeoutMs: renewalTimeoutMs(TTL_MS),
  StealGraceMs: resolveStealGraceSeconds(DRAIN_LEASE_TTL_MINUTES) * 1000,
  TakeoverGraceMs: HOLDER_TAKEOVER_GRACE_MS,
}));
const SOURCES: Record<string, string> = {
  TtlMs: 'DRAIN_LEASE_TTL_MINUTES (src/core/persistence/sync-lease.ts)',
  RefreshMs: 'DRAIN_LEASE_REFRESH_MS (src/core/persistence/sync-lease.ts)',
  RenewTimeoutMs: 'withRefreshingLock heartbeatTimeoutMs (src/core/db-lock.ts)',
  StealGraceMs: 'resolveStealGraceSeconds(DRAIN_LEASE_TTL_MINUTES) (src/core/db-lock.ts)',
  TakeoverGraceMs: 'HOLDER_TAKEOVER_GRACE_MS (src/core/db-lock.ts)',
};

describe('spec/tla/drain-lease configs match the code', () => {
  for (const cfg of CONFIGS) {
    test(`${cfg}: the lease timing is the code's`, async () => {
      const want = await code();
      const have = constants(cfg);
      for (const [name, value] of Object.entries(want)) {
        expect(Number(have[name]), `${name} in spec/tla/drain-lease/${cfg} is ${have[name]}, but ${SOURCES[name]} gives ${value} ms. Set it to ${value}, run bun run test:tla, and read any new counterexample before accepting it.`).toBe(value);
      }
    });
  }

  test('DrainLease.cfg checks liveness with fenced transactions that outlive the renewal timeout and the pass stamp on (#7442)', async () => {
    const { RenewTimeoutMs, RefreshMs, TtlMs } = await code();
    const c = constants('DrainLease.cfg');
    expect({ Stamps: c.Stamps, RenewalWinsGap: c.RenewalWinsGap, UnsafeSteals: c.UnsafeSteals }).toEqual({ Stamps: 'TRUE', RenewalWinsGap: 'FALSE', UnsafeSteals: 'FALSE' });
    expect(Number(c.MaxTxMs)).toBeGreaterThan(RenewTimeoutMs);
    expect(FENCED_SLICE_MS).toBeLessThan(Number(c.MaxTxMs));
    expect(RefreshMs + RenewTimeoutMs, 'a renewal and its timeout must fit inside the TTL').toBeLessThan(TtlMs);
  });

  test('DrainLeaseSafety.cfg keeps every adverse assumption on', () => {
    const c = constants('DrainLeaseSafety.cfg');
    expect({ UnsafeSteals: c.UnsafeSteals, RenewalWinsGap: c.RenewalWinsGap }).toEqual({ UnsafeSteals: 'TRUE', RenewalWinsGap: 'FALSE' });
    expect(Number(c.MaxTxMs)).toBeGreaterThanOrEqual(Number(c.RenewTimeoutMs));
  });
});

describe('the TLA+ workflow runs when anything a mutant names changes', () => {
  test('every code file and test in mutants.json is in tla-spec.yml\'s path filter', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/tla-spec.yml'), 'utf8');
    const paths = new Set([...workflow.matchAll(/^\s+- '([^']+)'$/gm)].map(m => m[1]!));
    const { mutants } = JSON.parse(readFileSync(join(SPEC, 'mutants.json'), 'utf8')) as { mutants: Array<{ code?: { edits: Array<{ file: string }>; tests: Array<{ test: string }> } }> };
    const named = new Set(mutants.flatMap(m => m.code ? [...m.code.edits.map(e => e.file), ...m.code.tests.map(t => t.test)] : []));
    expect([...named].filter(file => !paths.has(file)), 'add these to on.pull_request.paths in .github/workflows/tla-spec.yml').toEqual([]);
    const list = (from: string, to: string) => [...workflow.slice(workflow.indexOf(from), workflow.indexOf(to)).matchAll(/^\s+- '([^']+)'$/gm)].map(m => m[1]);
    expect(list('  push:', '  schedule:'), 'on.push.paths must repeat on.pull_request.paths exactly').toEqual(list('  pull_request:', '  push:'));
  });
});
