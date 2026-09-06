/**
 * E3 (amendment 29 + D12) — the mcp-client-fit advisor collector.
 *
 * Pins:
 *   - per-client starter fit: full-surface client whose observed successful
 *     30d distinct-op set ⊆ STARTER_OPS gets the usage review action
 *   - local vs REMOTE redaction: remote output aggregates counts, never
 *     names a client id (amendment 29)
 *   - exclusions: automation-shaped clients (D12), below-threshold volume,
 *     already-narrowed clients, legacy tokens without an oauth_clients row
 *   - no set-level starter drift advice from incomplete usage observations
 *   - nag snooze: unchanged findings go quiet after the ceiling; a changed
 *     usage fingerprint re-surfaces them
 *
 * Hermetic in-memory PGLite + a tmpdir nag-state path (test seam — never
 * touches ~/.gbrain).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  collectMcpClientFit,
  __setUsageNagStatePathForTests,
  MIN_CALLS_FOR_FIT,
} from '../src/core/advisor/collect-mcp-client-fit.ts';
import { COLLECTORS } from '../src/core/advisor/run.ts';
import { STARTER_OPS, ALWAYS_INCLUDED_STARTER_OPS } from '../src/mcp/surface.ts';
import { operations } from '../src/core/operations.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

let engine: PGLiteEngine;
let nagDir: string;
let nagSeq = 0;

// Programmatic op picks keep fixtures aligned with the exported surface.
const starterOp = 'recall'; // VERB_NAMES ⊆ STARTER_OPS by construction
const starterOp2 = 'whoami';
const nonStarterOp = operations.find((o) => !o.localOnly && !STARTER_OPS.has(o.name))!.name;
const localOnlyOp = operations.find((o) => o.localOnly)?.name ?? 'local_only_fixture';

function ctx(over: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    engine,
    config: {} as AdvisorContext['config'],
    version: '0.0.0.0',
    workspace: null,
    skillsDir: null,
    now: new Date(),
    remote: false,
    ...over,
  };
}

async function seedCalls(token: string, operation: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status)
       VALUES ($1, $1, $2, 5, 'success')`,
      [token, operation],
    );
  }
}

async function seedClient(clientId: string, surface: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients (client_id, client_name, surface)
     VALUES ($1, $1, $2)
     ON CONFLICT (client_id) DO UPDATE SET surface = $2`,
    [clientId, surface],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  nagDir = mkdtempSync(join(tmpdir(), 'gbrain-fit-nag-'));

  // fit-client: full surface (NULL row), 12 calls all inside STARTER_OPS.
  await seedClient('fit-client', null);
  await seedCalls('fit-client', starterOp, 8);
  await seedCalls('fit-client', starterOp2, 4);

  // narrowed-client: already on starter — never flagged.
  await seedClient('narrowed-client', 'starter');
  await seedCalls('narrowed-client', starterOp, MIN_CALLS_FOR_FIT + 5);

  // busy-client: full surface but uses a non-starter op — keep the nonstarter
  // observation out of per-client fit and membership recommendations.
  await seedClient('busy-client', null);
  await seedCalls('busy-client', nonStarterOp, MIN_CALLS_FOR_FIT + 2);

  // automation-client: >90% boundary calls — excluded everywhere (D12).
  await seedClient('automation-client', null);
  await seedCalls('automation-client', 'context_pack', 30);

  // low-volume-client: fits but below the alert threshold.
  await seedClient('low-volume-client', null);
  await seedCalls('low-volume-client', starterOp, MIN_CALLS_FOR_FIT - 1);

  // legacy-token: usage without an oauth_clients row — no rescope target.
  await seedCalls('legacy-token', starterOp, MIN_CALLS_FOR_FIT + 5);

  // unknown-client: an unrecognized historical operation must remain in the
  // observed distinct-op set and prevent an all-in-starter fit.
  await seedClient('unknown-client', null);
  await seedCalls('unknown-client', 'historical_unknown_op', MIN_CALLS_FOR_FIT + 1);

  // historical-local-only: old local-only rows must not create set-level
  // curator advice (the collector no longer has a global drift arm).
  await seedCalls('historical-local-only', localOnlyOp, MIN_CALLS_FOR_FIT + 1);
}, 120_000);

afterAll(async () => {
  __setUsageNagStatePathForTests(null);
  await engine.disconnect();
  rmSync(nagDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh nag file per test so snooze state never leaks between tests.
  nagSeq++;
  __setUsageNagStatePathForTests(join(nagDir, `nag-${nagSeq}.json`));
});

describe('registration', () => {
  test('collector is registered in the advisor COLLECTORS array', () => {
    expect(COLLECTORS.some((c) => c.id === 'mcp-client-fit')).toBe(true);
  });
});

describe('empty and missing usage history', () => {
  test('empty history produces no findings', async () => {
    const emptyEngine = { executeRaw: async () => [] } as unknown as AdvisorContext['engine'];
    const findings = await collectMcpClientFit.collect(ctx({ engine: emptyEngine }));
    expect(findings).toEqual([]);
  });

  test('missing usage table or reader failure produces no findings', async () => {
    const missingEngine = {
      executeRaw: async () => {
        throw new Error('mcp_request_log missing');
      },
    } as unknown as AdvisorContext['engine'];
    const findings = await collectMcpClientFit.collect(ctx({ engine: missingEngine }));
    expect(findings).toEqual([]);
  });
});

describe('per-client starter fit (local)', () => {
  test('full-surface client with starter-only usage gets the exact usage-review action', async () => {
    const findings = await collectMcpClientFit.collect(ctx());
    const fit = findings.find((f) => f.id === 'mcp_starter_fit:fit-client');
    expect(fit).toBeDefined();
    expect(fit!.severity).toBe('info');
    expect(fit!.ask_user).toBe(true);
    expect(fit!.fix.command_argv).toEqual([
      'gbrain', 'auth', 'clients', '--usage', '--days', '30', '--json',
    ]);
    expect(fit!.title).toContain('observed successful HTTP calls in the trailing 30d window');
    expect(fit!.title).toContain('within STARTER_OPS');
    expect(fit!.title).not.toContain('used only');
    expect(fit!.title).not.toContain('sees the full');
    expect(fit!.detail).toContain('incomplete logging');
    expect(fit!.detail).toContain('stdio');
    expect(fit!.detail).toContain('denied');
    expect(fit!.detail).toContain('effective surface');
    expect(fit!.detail).toContain('scope');
    expect(fit!.detail).toContain('future or infrequent');
    expect(fit!.detail).toContain('deliberate operator review');
    expect(fit!.detail).toContain('prevents self-widening');
  });

  test('excluded: narrowed, sparse, automation-shaped, legacy, non-fitting', async () => {
    const findings = await collectMcpClientFit.collect(ctx());
    const ids = findings.map((f) => f.id);
    expect(ids).not.toContain('mcp_starter_fit:narrowed-client');
    expect(ids).not.toContain('mcp_starter_fit:low-volume-client');
    expect(ids).not.toContain('mcp_starter_fit:automation-client');
    expect(ids).not.toContain('mcp_starter_fit:legacy-token');
    expect(ids).not.toContain('mcp_starter_fit:busy-client');
    expect(ids).not.toContain('mcp_starter_fit:unknown-client');
  });

  test('a configured starter default narrows a null row and suppresses the fit', async () => {
    const findings = await collectMcpClientFit.collect(ctx({
      config: { mcp: { default_surface_dcr: 'starter' } } as AdvisorContext['config'],
    }));
    expect(findings.map((f) => f.id)).not.toContain('mcp_starter_fit:fit-client');
  });
});

describe('remote redaction (amendment 29)', () => {
  test('remote output aggregates counts and never names a client id', async () => {
    const findings = await collectMcpClientFit.collect(ctx({ remote: true }));
    const agg = findings.find((f) => f.id === 'mcp_starter_fit_aggregate');
    expect(agg).toBeDefined();
    expect(agg!.title).toBe(
      '1 MCP client had observed successful HTTP calls in the trailing 30d window within STARTER_OPS — ' +
      'run `gbrain advisor` on the host for details.',
    );
    expect(agg!.title).toContain('observed successful HTTP calls in the trailing 30d window');
    expect(agg!.title).toContain('within STARTER_OPS');
    expect(agg!.title).toContain('run `gbrain advisor` on the host');
    expect(agg!.title).not.toContain('used only');
    expect(agg!.title).not.toContain('sees the full');
    expect(agg!.detail).toContain('incomplete logging');
    expect(agg!.detail).toContain('stdio');
    expect(agg!.detail).toContain('denied');
    expect(agg!.detail).toContain('effective surface');
    expect(agg!.detail).toContain('scope');
    expect(agg!.detail).toContain('future or infrequent');
    expect(agg!.detail).toContain('deliberate operator review');
    expect(agg!.detail).not.toContain('fit-client');
    expect(agg!.fix.command_argv).toBeNull();
    expect(agg!.ask_user).toBe(true);
    // No per-client finding, and no client identifier anywhere in the output.
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain('fit-client');
    expect(findings.some((f) => f.id.startsWith('mcp_starter_fit:'))).toBe(false);
  });

  test('remote runs never write nag state (read-only op)', async () => {
    const path = join(nagDir, `nag-${nagSeq}.json`);
    await collectMcpClientFit.collect(ctx({ remote: true }));
    expect(existsSync(path)).toBe(false);
  });
});

describe('set-level drift is deliberately absent', () => {
  test('known non-starter, unknown, and absent local-only ops produce no global advice', async () => {
    const findings = await collectMcpClientFit.collect(ctx());
    expect(findings.some((f) => f.id === 'mcp_starter_ops_drift')).toBe(false);
    expect(JSON.stringify(findings)).not.toContain(nonStarterOp);
    expect(JSON.stringify(findings)).not.toContain('historical_unknown_op');
    expect(JSON.stringify(findings)).not.toContain(localOnlyOp);
  });

  test('ALWAYS_INCLUDED_STARTER_OPS ⊆ STARTER_OPS (an always-member outside starter would be unfixable drift)', () => {
    for (const op of ALWAYS_INCLUDED_STARTER_OPS) {
      expect(STARTER_OPS.has(op)).toBe(true);
    }
  });
});

describe('nag snooze (escalate-then-suppress)', () => {
  test('unchanged fit finding goes quiet after the ceiling', async () => {
    let last: string[] = [];
    // Ceiling is 3 displays (DEFAULT_NAG_CEILING): first + 2 reminders.
    for (let run = 1; run <= 4; run++) {
      const findings = await collectMcpClientFit.collect(ctx());
      last = findings.map((f) => f.id);
      if (run <= 3) {
        expect(last).toContain('mcp_starter_fit:fit-client');
      }
    }
    expect(last).not.toContain('mcp_starter_fit:fit-client');
  });

  test('local nag state uses an isolated temporary GBRAIN_HOME', async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-fit-home-'));
    try {
      await withEnv({ GBRAIN_HOME: isolatedHome }, async () => {
        __setUsageNagStatePathForTests(null);
        try {
          await collectMcpClientFit.collect(ctx());
          expect(existsSync(join(isolatedHome, '.gbrain', 'advisor-usage-nag-state.json'))).toBe(true);
        } finally {
          __setUsageNagStatePathForTests(join(nagDir, `nag-${nagSeq}.json`));
        }
      });
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  test('a changed usage fingerprint re-surfaces a suppressed finding', async () => {
    // Suppress at the current fingerprint.
    for (let run = 1; run <= 3; run++) await collectMcpClientFit.collect(ctx());
    let findings = await collectMcpClientFit.collect(ctx());
    expect(findings.map((f) => f.id)).not.toContain('mcp_starter_fit:fit-client');
    try {
      // New starter-surface op joins fit-client's usage → new fingerprint.
      await seedCalls('fit-client', 'request_tools', 1);
      findings = await collectMcpClientFit.collect(ctx());
      expect(findings.map((f) => f.id)).toContain('mcp_starter_fit:fit-client');
    } finally {
      // The shared engine outlives this test — remove the extra usage row so
      // fit-client's fingerprint is unchanged for any later assertion.
      await engine.executeRaw(
        `DELETE FROM mcp_request_log WHERE token_name = 'fit-client' AND operation = 'request_tools'`,
      );
    }
  });
});
