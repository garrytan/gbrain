/**
 * Tests for src/commands/advisor.ts — the `gbrain advisor` CLI surface (plan E1).
 *
 * Covers the seams the command actually exposes:
 *   - runAdvisorCli(engine, args): the only public entry. The exit-verdict
 *     mapping (exitFor: critical → 2, warn → 1, info-only → 0) is driven
 *     end-to-end through a stub engine, because the severity levers are all
 *     engine-shaped: collect-migration (the ONLY collector that can emit
 *     `critical`) keys on engine.getConfig('version') vs LATEST_VERSION,
 *     collect-chronicle emits `warn` from engine.findOntologyConflicts, and
 *     collect-stalled-jobs emits `info` (stale_sync) from engine.executeRaw.
 *   - --apply's TTY gate (confirmTty checks process.stdin.isTTY BEFORE any
 *     read) and its spawn seam (child_process.spawnSync, spied via the module
 *     namespace — Bun named imports are live bindings, so no mock.module).
 *
 * Hermeticity (non-serial rules): no bare process.env mutation — withEnv +
 * emptyHome() point GBRAIN_HOME at a fresh temp dir per call, which isolates
 * loadConfig, the self-upgrade update cache (collect-version's warn source),
 * and the advisor-history append side effect. The default-embedding provider
 * key is set via withEnv so collect-setup-smells' `embedding_key_missing`
 * warn can't leak in from a key-less environment. process.stdin.isTTY is a
 * property, NOT process.env — monkeypatching it with a finally-restore is the
 * sanctioned pattern (see test/init-nudge.test.ts).
 */

import { describe, test, expect, spyOn } from 'bun:test';
import * as childProcess from 'child_process';

import { runAdvisorCli } from '../src/commands/advisor.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { DEFAULT_EMBEDDING_MODEL } from '../src/core/ai/defaults.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AdvisorReport } from '../src/core/advisor/types.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

/** The env key the EFFECTIVE default embedding model requires (dynamic so a
 * default-provider change doesn't silently reopen the embedding_key_missing
 * warn leak). */
const EMBED_KEY_NAME = getRecipe(DEFAULT_EMBEDDING_MODEL.split(':')[0]!)?.auth_env?.required?.[0];

/** Fresh hermetic env per call: empty GBRAIN_HOME + the embed key present. */
function hermeticEnv(): Record<string, string | undefined> {
  return {
    GBRAIN_HOME: emptyHome(),
    GBRAIN_EMBEDDING_MODEL: undefined, // effective model = DEFAULT_EMBEDDING_MODEL
    ...(EMBED_KEY_NAME ? { [EMBED_KEY_NAME]: 'test-key-advisor-cli' } : {}),
  };
}

interface FakeEngineOpts {
  /** engine.getConfig('version') → controls collect-migration's `critical`.
   * Default: String(LATEST_VERSION) (no pending migration). */
  schemaVersion?: string;
  /** engine.findOntologyConflicts → non-empty controls collect-chronicle's `warn`. */
  ontologyConflicts?: Array<{ entity_slug: string; dimension: string }>;
  /** Stale-source ids → collect-stalled-jobs' `info` finding (stale_sync:<id>). */
  staleSyncIds?: string[];
}

/** Minimal stub engine. Collectors are individually try/caught in runAdvisor,
 * so anything not stubbed (a missing method throws) contributes nothing. */
function fakeEngine(opts: FakeEngineOpts = {}): BrainEngine {
  const engine = {
    getConfig: async (key: string): Promise<string | null> => {
      if (key === 'version') return opts.schemaVersion ?? String(LATEST_VERSION);
      return null; // schema_pack → default resolution; everything else unset
    },
    executeRaw: async (sql: string): Promise<unknown[]> => {
      // collect-stalled-jobs' stale-sync arm (the deterministic `info` lever).
      if (sql.includes("interval '7 days'")) {
        return (opts.staleSyncIds ?? []).map((id) => ({ id }));
      }
      return []; // minion_jobs, sources, chronicle gap, mcp-client-fit → quiet
    },
    getStats: async () => ({
      page_count: 0,
      chunk_count: 0,
      embedded_count: 0,
      link_count: 0,
      tag_count: 0,
      timeline_entry_count: 0,
      pages_by_type: {},
    }),
    findOntologyConflicts: async () => opts.ontologyConflicts ?? [],
  };
  return engine as unknown as BrainEngine;
}

interface CapturedRun {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderrLines: string[];
}

/** Run the CLI with stdout captured, console.error collected, and stdin
 * forced non-TTY (confirmTty would BLOCK on fs.readSync under an interactive
 * terminal otherwise). Everything restored in finally. */
async function runCaptured(engine: BrainEngine, args: string[]): Promise<CapturedRun> {
  const stdin = process.stdin as unknown as { isTTY: boolean | undefined };
  const origIsTTY = stdin.isTTY;
  const origStdoutWrite = process.stdout.write;
  let stdout = '';
  const stderrLines: string[] = [];
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderrLines.push(a.map(String).join(' '));
  });
  try {
    stdin.isTTY = false;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const { exitCode } = await runAdvisorCli(engine, args);
    return { exitCode, stdout, stderrLines };
  } finally {
    process.stdout.write = origStdoutWrite;
    stdin.isTTY = origIsTTY;
    errSpy.mockRestore();
  }
}

function parseReport(stdout: string): AdvisorReport {
  return JSON.parse(stdout) as AdvisorReport;
}

describe('runAdvisorCli exit-verdict mapping (E2 contract: 0 clean / 1 warn / 2 critical)', () => {
  test('a critical finding (pending migration) → exit 2', async () => {
    await withEnv(hermeticEnv(), async () => {
      // schema version 1 < LATEST_VERSION → collect-migration emits critical.
      const run = await runCaptured(fakeEngine({ schemaVersion: '1' }), ['--json']);
      const report = parseReport(run.stdout);
      expect(report.findings.map((f) => f.id)).toContain('pending_migration');
      expect(report.worst).toBe('critical');
      expect(run.exitCode).toBe(2);
    });
  });

  test('worst = warn (ontology conflicts, no critical) → exit 1', async () => {
    await withEnv(hermeticEnv(), async () => {
      const run = await runCaptured(
        fakeEngine({ ontologyConflicts: [{ entity_slug: 'alice-example', dimension: 'role' }] }),
        ['--json'],
      );
      const report = parseReport(run.stdout);
      // Diagnosable on flake: name any critical that leaked in.
      expect(report.findings.filter((f) => f.severity === 'critical').map((f) => f.id)).toEqual([]);
      expect(report.findings.map((f) => f.id)).toContain('ontology_conflicts');
      expect(report.worst).toBe('warn');
      expect(run.exitCode).toBe(1);
    });
  });

  test('info-only findings → exit 0', async () => {
    await withEnv(hermeticEnv(), async () => {
      const run = await runCaptured(fakeEngine({ staleSyncIds: ['wiki'] }), ['--json']);
      const report = parseReport(run.stdout);
      // Diagnosable on flake: name any warn/critical that leaked in.
      expect(report.findings.filter((f) => f.severity !== 'info').map((f) => f.id)).toEqual([]);
      expect(report.findings.map((f) => f.id)).toContain('stale_sync:wiki');
      expect(report.worst).toBe('info');
      expect(run.exitCode).toBe(0);
    });
  });
});

describe('runAdvisorCli --apply', () => {
  test('non-TTY stdin → confirm refused: exit 1, "Aborted. Nothing was run.", spawnSync never invoked', async () => {
    const spawnSpy = spyOn(childProcess, 'spawnSync').mockImplementation(
      (() => ({ status: 0 })) as never,
    );
    try {
      await withEnv(hermeticEnv(), async () => {
        // pending_migration is the runnable finding (dispatch_id apply_migrations).
        const run = await runCaptured(fakeEngine({ schemaVersion: '1' }), [
          '--apply',
          'apply_migrations',
        ]);
        expect(run.stderrLines).toContain('About to run: gbrain apply-migrations --yes');
        expect(run.stderrLines).toContain('Aborted. Nothing was run.');
        expect(run.exitCode).toBe(1);
        // The spy intercepts advisor.ts's own `spawnSync` binding (live-binding
        // interop, verified by the mocked return above: had the spawn path run,
        // status 0 would have produced exit 0, not 1).
        expect(spawnSpy.mock.calls.length).toBe(0);
      });
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test('unknown --apply id → exit 2, error names the id and lists runnable ids, no spawn', async () => {
    const spawnSpy = spyOn(childProcess, 'spawnSync').mockImplementation(
      (() => ({ status: 0 })) as never,
    );
    try {
      await withEnv(hermeticEnv(), async () => {
        const run = await runCaptured(fakeEngine({ schemaVersion: '1' }), [
          '--apply',
          'not-a-real-id',
        ]);
        expect(run.stderrLines).toContain(
          'No runnable finding with apply id "not-a-real-id". Runnable now: apply_migrations.',
        );
        expect(run.exitCode).toBe(2);
        expect(spawnSpy.mock.calls.length).toBe(0);
      });
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test('unknown id with NOTHING runnable → "Nothing is runnable right now." suffix', async () => {
    const spawnSpy = spyOn(childProcess, 'spawnSync').mockImplementation(
      (() => ({ status: 0 })) as never,
    );
    try {
      await withEnv(hermeticEnv(), async () => {
        // Clean engine → no finding carries a dispatch_id.
        const run = await runCaptured(fakeEngine(), ['--apply', 'apply_migrations']);
        expect(run.stderrLines).toContain(
          'No runnable finding with apply id "apply_migrations". Nothing is runnable right now.',
        );
        expect(run.exitCode).toBe(2);
        expect(spawnSpy.mock.calls.length).toBe(0);
      });
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
