/**
 * Refactor wave 1 (W0, EO11 / T-G10): doctor early-stop goldens through the
 * in-process `buildChecks` seam.
 *
 * The W4 registry runner must stop exactly where master returns early. Pins
 * the ordered (name, status, message, details) list for:
 *   - null engine, no database configured anywhere (dbSource undefined)
 *   - null engine, `--fast` with a config-file PgBouncer URL
 *   - null engine + captured connect error (the CLI's dead-DB fallback)
 *   - live engine whose getStats rejects (connection-failure early return)
 *
 * Serial: PATH / GBRAIN_HOME / GBRAIN_AUDIT_DIR / GBRAIN_SYNC_FAILURES_DIR point at a
 * fresh temp home per capture (the per-run audit dir is shared with other
 * test files, and doctor reads it). Each golden is captured twice from two
 * fresh homes (expectNormalizerStable) with normalizer `doctor-checks-v1`
 * (the doctor-json-v1 text scrubs applied to a bare Check[]).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { buildChecks, type Check } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable, mapStrings, scrubKeys } from './helpers/golden.ts';
import { makeDoctorHome, normalizeDoctorText, type DoctorHome } from './helpers/doctor-json-golden.ts';

const ENV_KEYS = ['PATH', 'GBRAIN_HOME', 'HOME', 'GBRAIN_AUDIT_DIR', 'GBRAIN_SYNC_FAILURES_DIR', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'CODEX_HOME', 'OPENCODE', 'OPENCODE_PID', 'XDG_CONFIG_HOME'] as const;
let saved: Record<string, string | undefined> = {};
const homes: DoctorHome[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const h of homes.splice(0)) h.cleanup();
});

interface Capture {
  checks: Check[];
  roots: Record<string, string>;
}

const CHECKS = defineNormalizer<Capture>('doctor-checks-v1', (c) =>
  mapStrings(scrubKeys(c.checks, /(^|_)(ms|pid|elapsed|duration|uptime)$|_ms$|^elapsed/i), (s) => normalizeDoctorText(s, c.roots)),
);

/** Fresh hermetic home as the process env; optional config.json. */
function enterHome(config?: Record<string, unknown>): DoctorHome {
  const h = makeDoctorHome('doctor-early-stop');
  homes.push(h);
  process.env.GBRAIN_HOME = h.home;
  process.env.HOME = h.home;
  process.env.GBRAIN_AUDIT_DIR = join(h.home, 'audit');
  process.env.GBRAIN_SYNC_FAILURES_DIR = join(h.home, 'sync-failures');
  // No globally linked gbrain on PATH (npm_squat would fire on dev boxes).
  process.env.PATH = [join(h.home, 'bin'), '/usr/bin', '/bin'].join(delimiter);
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
  // harness_wiring reads agent markers and harness config homes.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'CODEX_HOME', 'OPENCODE', 'OPENCODE_PID', 'XDG_CONFIG_HOME']) delete process.env[k];
  if (config) {
    mkdirSync(join(h.home, '.gbrain'), { recursive: true });
    writeFileSync(join(h.home, '.gbrain', 'config.json'), JSON.stringify(config) + '\n');
  }
  return h;
}

const DEAD_PG = { engine: 'postgres', database_url: 'postgresql://gbrain@127.0.0.1:1/gbrain' }; /* allow-pg-url-literal */
// PgBouncer transaction port: the URL-only pgbouncer_prepare check fires in both lanes.
const POOLER_PG = { engine: 'postgres', database_url: 'postgresql://gbrain@127.0.0.1:6543/gbrain' }; /* allow-pg-url-literal */

function connRefused(): Error {
  return new Error('connect ECONNREFUSED 127.0.0.1:1');
}

/** Every method resolves benign-empty except getStats, which rejects. */
function statsRejectingEngine(err: Error): BrainEngine {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'kind') return 'postgres';
      if (prop === 'then') return undefined;
      if (prop === 'getStats') return () => Promise.reject(err);
      if (prop === 'getConfig') return async () => null;
      return async () => [];
    },
  }) as unknown as BrainEngine;
}

async function capture(config: Record<string, unknown> | undefined, run: (h: DoctorHome) => Promise<Check[]>): Promise<Capture> {
  const h = enterHome(config);
  return { checks: await run(h), roots: { '<home>': h.home } };
}

const CASES: Array<{ golden: string; config?: Record<string, unknown>; run: (h: DoctorHome) => Promise<Check[]>; last: string }> = [
  {
    golden: 'doctor/early-stop-null-engine-no-config',
    run: (h) => buildChecks(null, ['--json', '--skills-dir', h.skillsDir]),
    last: 'connection',
  },
  {
    golden: 'doctor/early-stop-null-engine-fast',
    config: POOLER_PG,
    run: (h) => buildChecks(null, ['--json', '--fast', '--skills-dir', h.skillsDir], 'config-file'),
    last: 'pgbouncer_prepare',
  },
  {
    golden: 'doctor/early-stop-null-engine-connect-error',
    config: DEAD_PG,
    run: (h) => buildChecks(null, ['--json', '--skills-dir', h.skillsDir], 'config-file', connRefused()),
    last: 'connection',
  },
  {
    golden: 'doctor/early-stop-connection-failure',
    config: POOLER_PG,
    run: (h) => buildChecks(statsRejectingEngine(connRefused()), ['--json', '--skills-dir', h.skillsDir]),
    last: 'connection',
  },
];

describe('doctor early-stop goldens (buildChecks seam, T-G10)', () => {
  for (const c of CASES) {
    test(c.golden, async () => {
      const cap = await expectNormalizerStable(() => capture(c.config, c.run), CHECKS);
      expect(cap.checks.length).toBeGreaterThan(0);
      expect(cap.checks.at(-1)?.name).toBe(c.last);
      expectGolden(c.golden, cap, CHECKS);
    }, 120_000);
  }
});
