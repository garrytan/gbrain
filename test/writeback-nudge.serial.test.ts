/**
 * Ambient-writeback consent nudge (WP8): the classifier (declaration beats
 * heuristics, conservative client-count evidence, fail directions), the
 * one-time init/post-upgrade ask (double gate + [AGENT] relay + stamp-after-
 * print + never-auto-enable + never-throws), and the advisor's reminder-role
 * collector (local-only, info, never --apply-able).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { classifyBrainAudience, SHARED_CLIENT_THRESHOLD, BRAIN_AUDIENCE_KEY } from '../src/core/facts/writeback-audience.ts';
import { runWritebackNudge } from '../src/core/onboard/writeback-nudge.ts';
import { collectWritebackConsent } from '../src/core/advisor/collect-writeback-consent.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';
import { AUTO_WRITEBACK_KEY, AUTO_WRITEBACK_NOTICE_KEY } from '../src/core/facts/writeback-config.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  tmp = mkdtempSync(join(tmpdir(), 'gb-wbnudge-'));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.unsetConfig(BRAIN_AUDIENCE_KEY);
  await engine.unsetConfig(AUTO_WRITEBACK_KEY);
  await engine.unsetConfig(AUTO_WRITEBACK_NOTICE_KEY);
  await engine.executeRaw('DELETE FROM mcp_request_log').catch(() => {});
});

async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try { await fn(); } finally { console.log = orig; }
  return out;
}

async function seedClient(token: string, op: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, operation, latency_ms, status) VALUES ($1, $2, 5, 'success')`,
      [token, op],
    );
  }
}

describe('classifyBrainAudience — declaration beats heuristics', () => {
  test('declared shared / personal win outright, with the reason named', async () => {
    await engine.setConfig(BRAIN_AUDIENCE_KEY, 'shared');
    expect((await classifyBrainAudience(engine)).audience).toBe('shared');
    await engine.setConfig(BRAIN_AUDIENCE_KEY, 'Personal');
    const r = await classifyBrainAudience(engine);
    expect(r.audience).toBe('personal');
    expect(r.reasons[0]).toContain('declared');
  });

  test('fresh brain, no declaration → personal (zero clients)', async () => {
    const r = await classifyBrainAudience(engine);
    expect(r.audience).toBe('personal');
    expect(r.reasons.join(' ')).toContain('0 non-automation client');
  });

  test('≥ threshold distinct non-automation clients in 30d → shared, evidence named; automation-only clients do not count', async () => {
    for (let i = 0; i < SHARED_CLIENT_THRESHOLD; i++) await seedClient(`human-${i}`, 'search', 5);
    // A pure heartbeat client (context_pack/delta = automation boundary ops) must not count.
    await seedClient('cron-bot', 'context_pack', 20);
    const r = await classifyBrainAudience(engine);
    expect(r.audience).toBe('shared');
    expect(r.reasons.join(' ')).toContain(`${SHARED_CLIENT_THRESHOLD} distinct non-automation`);

    // One below threshold → personal.
    await engine.executeRaw(`DELETE FROM mcp_request_log WHERE token_name = 'human-0'`);
    expect((await classifyBrainAudience(engine)).audience).toBe('personal');
  });

  test('unrecognized declaration falls through to the heuristic with a note', async () => {
    await engine.setConfig(BRAIN_AUDIENCE_KEY, 'team-ish');
    const r = await classifyBrainAudience(engine);
    expect(r.audience).toBe('personal');
    expect(r.reasons[0]).toContain('unrecognized');
  });

  test('the machine-global file declaration speaks for the HOST brain only — a mounted brain never inherits it (adversarial review)', async () => {
    // No DB declaration on the selected brain; the machine mirror declares
    // shared (the host operator's brain). Selecting a mounted brain via
    // GBRAIN_BRAIN_ID must fall through to the heuristic (personal here),
    // not silently classify as shared and suppress its own diagnostics.
    const fileCfg = { engine: 'pglite', brain: { audience: 'shared' } } as Parameters<typeof classifyBrainAudience>[1];
    await withEnv({ GBRAIN_BRAIN_ID: 'someteam' }, async () => {
      const mounted = await classifyBrainAudience(engine, fileCfg);
      expect(mounted.audience).toBe('personal'); // heuristic, not the host's declaration
    });
    await withEnv({ GBRAIN_BRAIN_ID: undefined }, async () => {
      const host = await classifyBrainAudience(engine, fileCfg);
      expect(host.audience).toBe('shared'); // host brain: the mirror is its voice
    });
  });

  test('fail directions: config read failure → unknown; usage read failure with reachable DB → personal', async () => {
    const dead = { getConfig: async () => { throw new Error('down'); } } as unknown as BrainEngine;
    expect((await classifyBrainAudience(dead)).audience).toBe('unknown');
    const half = {
      getConfig: async () => null,
      executeRaw: async () => { throw new Error('relation "mcp_request_log" does not exist'); },
    } as unknown as BrainEngine;
    const r = await classifyBrainAudience(half);
    expect(r.audience).toBe('personal');
    expect(r.reasons.join(' ')).toContain('heuristic unavailable');
  });
});

describe('runWritebackNudge — one-time ask, never auto-enables, never throws', () => {
  test('personal + unset → [AGENT] ask printed once, sentinel stamped, mode NOT set; second call silent', async () => {
    await withEnv({ GBRAIN_HOME: tmp, GBRAIN_NO_ONBOARD_NUDGE: undefined, GBRAIN_BRAIN_ID: undefined }, async () => {
      const out = await captureLog(() => runWritebackNudge(engine, { context: 'init' }));
      expect(out).toContain('[AGENT] One-time ask');
      expect(out).toContain('gbrain config set memory.auto_writeback salient');
      expect(out).toContain('Off switch');
      expect(await engine.getConfig(AUTO_WRITEBACK_NOTICE_KEY)).toBe('true');
      // NEVER auto-enabled — the ask is the only output.
      expect(await engine.getConfig(AUTO_WRITEBACK_KEY)).toBeNull();

      const out2 = await captureLog(() => runWritebackNudge(engine));
      expect(out2).toBe('');
    });
  });

  test('declared shared → total silence, and the sentinel is NOT burned (a later personal re-declare gets the ask)', async () => {
    await engine.setConfig(BRAIN_AUDIENCE_KEY, 'shared');
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const out = await captureLog(() => runWritebackNudge(engine));
      expect(out).toBe('');
      expect(await engine.getConfig(AUTO_WRITEBACK_NOTICE_KEY)).toBeNull();
    });
  });

  test('already decided (any set value, including off) → silent', async () => {
    await engine.setConfig(AUTO_WRITEBACK_KEY, 'off');
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      expect(await captureLog(() => runWritebackNudge(engine))).toBe('');
    });
  });

  test('suppressions: env bypass, thin client (config.json), mounted-brain routing — all silent; a crashing engine never throws', async () => {
    await withEnv({ GBRAIN_HOME: tmp, GBRAIN_NO_ONBOARD_NUDGE: '1' }, async () => {
      expect(await captureLog(() => runWritebackNudge(engine))).toBe('');
    });
    await withEnv({ GBRAIN_HOME: tmp, GBRAIN_BRAIN_ID: 'someteam' }, async () => {
      expect(await captureLog(() => runWritebackNudge(engine))).toBe('');
    });
    const dead = { getConfig: async () => { throw new Error('down'); }, setConfig: async () => { throw new Error('down'); } } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      expect(await captureLog(() => runWritebackNudge(dead))).toBe('');
    });
  });
});

describe('collectWritebackConsent — reminder role, never the first ask, never apply-able', () => {
  function ctx(overrides: Partial<AdvisorContext> = {}): AdvisorContext {
    return {
      engine, config: { engine: 'pglite' } as GBrainConfig, version: 'test',
      workspace: null, skillsDir: null, now: new Date(), remote: false,
      ...overrides,
    };
  }

  test('before the sentinel → nothing (the advisor never fires the first consent ask)', async () => {
    expect(await collectWritebackConsent.collect(ctx())).toEqual([]);
  });

  test('after the sentinel, personal + unset → one info finding, ask_user, NO dispatch_id, null argv', async () => {
    await engine.setConfig(AUTO_WRITEBACK_NOTICE_KEY, 'true');
    const found = await collectWritebackConsent.collect(ctx());
    expect(found.length).toBe(1);
    expect(found[0].severity).toBe('info');
    expect(found[0].ask_user).toBe(true);
    expect(found[0].fix.command_argv).toBeNull();
    expect(found[0].fix.dispatch_id).toBeUndefined();
  });

  test('suppressed for remote callers, decided brains, and shared brains', async () => {
    await engine.setConfig(AUTO_WRITEBACK_NOTICE_KEY, 'true');
    expect(await collectWritebackConsent.collect(ctx({ remote: true }))).toEqual([]);
    await engine.setConfig(AUTO_WRITEBACK_KEY, 'salient');
    expect(await collectWritebackConsent.collect(ctx())).toEqual([]);
    await engine.unsetConfig(AUTO_WRITEBACK_KEY);
    await engine.setConfig(BRAIN_AUDIENCE_KEY, 'shared');
    expect(await collectWritebackConsent.collect(ctx())).toEqual([]);
  });
});
