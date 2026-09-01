/**
 * Ambient-writeback WP1: the pure ttl-parse leaf, the dual-plane config
 * resolver (fail-closed off, mode_valid/ttl_valid flags, F5 visibility
 * semantics, last-known-good bundle), and `gbrain config set memory.*`'s
 * dual-plane write/unset routing (OV2-5).
 */
import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseTtlShorthand,
  parseDurationShorthandMs,
  validateTtlConfig,
  TRANSIENT_TTL_MAX_MS,
} from '../src/core/facts/ttl-parse.ts';
import {
  resolveWritebackConfig,
  resolveWritebackConfigFromFile,
  ambientOptsFrom,
  WRITEBACK_MODES,
  DEFAULT_TRANSIENT_TTL,
  AUTO_WRITEBACK_KEY,
  AUTO_WRITEBACK_TTL_KEY,
  type WritebackConfig,
} from '../src/core/facts/writeback-config.ts';
import { parseTtlParam } from '../src/core/ops/facts.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { runConfig } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

// ── ttl-parse leaf ──────────────────────────────────────────────────────────

describe('parseTtlShorthand (pure leaf)', () => {
  test('null/undefined/empty → ok with null (never expires)', () => {
    expect(parseTtlShorthand(null)).toEqual({ ok: true, validUntil: null });
    expect(parseTtlShorthand(undefined)).toEqual({ ok: true, validUntil: null });
    expect(parseTtlShorthand('   ')).toEqual({ ok: true, validUntil: null });
  });

  test('duration shorthand → now + duration (3d within tolerance)', () => {
    const res = parseTtlShorthand('3d');
    if (!res.ok || !res.validUntil) throw new Error('expected ok date');
    const expected = Date.now() + 3 * 24 * 60 * 60 * 1000;
    expect(Math.abs(res.validUntil.getTime() - expected)).toBeLessThan(5_000);
  });

  test('absolute ISO 8601 accepted', () => {
    const res = parseTtlShorthand('2030-01-02T00:00:00Z');
    if (!res.ok || !res.validUntil) throw new Error('expected ok date');
    expect(res.validUntil.toISOString()).toBe('2030-01-02T00:00:00.000Z');
  });

  test('typed failures: not_string / iso_duration / unparseable', () => {
    expect(parseTtlShorthand(30)).toMatchObject({ ok: false, code: 'not_string' });
    expect(parseTtlShorthand('P30D')).toMatchObject({ ok: false, code: 'iso_duration' });
    expect(parseTtlShorthand('PT12H')).toMatchObject({ ok: false, code: 'iso_duration' });
    expect(parseTtlShorthand('soonish')).toMatchObject({ ok: false, code: 'unparseable' });
  });

  test('parseDurationShorthandMs unit table', () => {
    expect(parseDurationShorthandMs('90s')).toBe(90_000);
    expect(parseDurationShorthandMs('45m')).toBe(45 * 60_000);
    expect(parseDurationShorthandMs('12h')).toBe(12 * 3_600_000);
    expect(parseDurationShorthandMs('30 days')).toBe(30 * 86_400_000);
    expect(parseDurationShorthandMs('2030-01-01')).toBeNull();
  });
});

describe('validateTtlConfig (OV2-16 bounds)', () => {
  test('valid shorthand passes through trimmed', () => {
    expect(validateTtlConfig(' 12h ', DEFAULT_TRANSIENT_TTL)).toEqual({ valid: true, ttl: '12h' });
  });
  test('unset → valid fallback; garbage/zero/over-cap/absolute → invalid fallback', () => {
    expect(validateTtlConfig(null, '3d')).toEqual({ valid: true, ttl: '3d' });
    expect(validateTtlConfig('P3D', '3d')).toEqual({ valid: false, ttl: '3d' });
    expect(validateTtlConfig('0d', '3d')).toEqual({ valid: false, ttl: '3d' });
    expect(validateTtlConfig('400d', '3d')).toEqual({ valid: false, ttl: '3d' });
    expect(validateTtlConfig('2030-01-01', '3d')).toEqual({ valid: false, ttl: '3d' });
    expect(TRANSIENT_TTL_MAX_MS).toBe(365 * 86_400_000);
  });
});

describe('parseTtlParam wrapper keeps the frozen wire contract', () => {
  test('happy paths unchanged', () => {
    expect(parseTtlParam(null)).toBeNull();
    expect(parseTtlParam('')).toBeNull();
    const d = parseTtlParam('30d');
    expect(d).toBeInstanceOf(Date);
  });
  test('verbError messages are byte-identical to the pre-extraction copy', () => {
    expect(() => parseTtlParam(30)).toThrow('ttl must be a string, got number.');
    expect(() => parseTtlParam('P30D')).toThrow('ttl "P30D" looks like an ISO-8601 duration, which is not accepted.');
    expect(() => parseTtlParam('soonish')).toThrow('Cannot parse ttl "soonish".');
  });
});

// ── resolver ────────────────────────────────────────────────────────────────

function fakeEngine(rows: Record<string, string | null>): BrainEngine {
  return {
    getConfig: async (k: string) => rows[k] ?? null,
  } as unknown as BrainEngine;
}

describe('resolveWritebackConfigFromFile (engine-free)', () => {
  test('absent slot → off, valid, default ttl', () => {
    const r = resolveWritebackConfigFromFile({ engine: 'pglite' } as GBrainConfig);
    expect(r).toMatchObject({ mode: 'off', enabled: false, mode_valid: true, transient_ttl: '3d', ttl_valid: true });
  });
  test('salient + custom ttl honored; garbage mode fail-closed with mode_valid=false', () => {
    const on = resolveWritebackConfigFromFile({ engine: 'pglite', memory: { auto_writeback: 'Salient', auto_writeback_transient_ttl: '12h' } } as GBrainConfig);
    expect(on).toMatchObject({ mode: 'salient', enabled: true, mode_valid: true, transient_ttl: '12h' });
    const bad = resolveWritebackConfigFromFile({ engine: 'pglite', memory: { auto_writeback: 'always', auto_writeback_transient_ttl: 'P3D' } } as GBrainConfig);
    expect(bad).toMatchObject({ mode: 'off', enabled: false, mode_valid: false, raw_mode: 'always', transient_ttl: '3d', ttl_valid: false });
  });
});

describe('resolveWritebackConfig (dual-plane + F5 visibility + LKG)', () => {
  test('DB plane wins over file plane', async () => {
    const r = await resolveWritebackConfig(
      fakeEngine({ [AUTO_WRITEBACK_KEY]: 'all', [AUTO_WRITEBACK_TTL_KEY]: '7d' }),
      { engine: 'pglite', memory: { auto_writeback: 'off', auto_writeback_transient_ttl: '1d' } } as GBrainConfig,
    );
    expect(r).toMatchObject({ mode: 'all', enabled: true, transient_ttl: '7d' });
  });

  test('file plane NEVER enables a DB gap — that is plane drift, not enablement (adversarial review)', async () => {
    // The file mirror is machine-global while DB rows are per-brain: a file
    // fallback would leak brain A's opt-in into a selected brain B whose
    // operator never enabled anything. DB row absent + file enabled resolves
    // OFF with `plane_drift` so gate callers hold banked turns (no terminal
    // sidecar) instead of destroying them.
    const r = await resolveWritebackConfig(
      fakeEngine({}),
      { engine: 'pglite', memory: { auto_writeback: 'salient' } } as GBrainConfig,
    );
    expect(r).toMatchObject({ mode: 'off', enabled: false, mode_valid: true, plane_drift: true });
  });

  test('explicit DB off + file enabled is operator intent, NOT drift', async () => {
    const r = await resolveWritebackConfig(
      fakeEngine({ [AUTO_WRITEBACK_KEY]: 'off' }),
      { engine: 'pglite', memory: { auto_writeback: 'salient' } } as GBrainConfig,
    );
    expect(r).toMatchObject({ mode: 'off', enabled: false, mode_valid: true });
    expect(r.plane_drift).toBeUndefined();
  });

  test('both planes silent → off with no drift flag', async () => {
    const r = await resolveWritebackConfig(fakeEngine({}), { engine: 'pglite' } as GBrainConfig);
    expect(r).toMatchObject({ mode: 'off', enabled: false });
    expect(r.plane_drift).toBeUndefined();
  });

  test('read failure + file mirror explicitly off → OFF even when an LKG-enabled bundle exists', async () => {
    let healthy = true;
    const flappy = {
      getConfig: async (k: string) => {
        if (!healthy) throw new Error('db blip');
        return ({ [AUTO_WRITEBACK_KEY]: 'salient' } as Record<string, string>)[k] ?? null;
      },
    } as unknown as BrainEngine;
    await resolveWritebackConfig(flappy); // primes the LKG (enabled)
    healthy = false;
    const fileOff = { engine: 'pglite', memory: { auto_writeback: 'off' } } as GBrainConfig;
    const r = await resolveWritebackConfig(flappy, fileOff);
    expect(r).toMatchObject({ mode: 'off', enabled: false, read_error: true });
  });

  test('F5: facts.default_visibility UNSET → world posture, not explicit private', async () => {
    const r = await resolveWritebackConfig(fakeEngine({ [AUTO_WRITEBACK_KEY]: 'salient' }));
    expect(r.visibility).toBe('world');
    expect(r.visibility_explicit_private).toBe(false);
  });

  test('F5: explicit private (and any non-world garbage) → private posture', async () => {
    const priv = await resolveWritebackConfig(fakeEngine({ [AUTO_WRITEBACK_KEY]: 'salient', 'facts.default_visibility': 'private' }));
    expect(priv).toMatchObject({ visibility: 'private', visibility_explicit_private: true });
    const garbage = await resolveWritebackConfig(fakeEngine({ [AUTO_WRITEBACK_KEY]: 'salient', 'facts.default_visibility': 'Weird' }));
    expect(garbage).toMatchObject({ visibility: 'private', visibility_explicit_private: true });
    const world = await resolveWritebackConfig(fakeEngine({ [AUTO_WRITEBACK_KEY]: 'salient', 'facts.default_visibility': 'world' }));
    expect(world).toMatchObject({ visibility: 'world', visibility_explicit_private: false });
  });

  test('read failure with no LKG → OFF bundle marked read_error; after a success the LKG bundle is served atomically', async () => {
    const failing = {
      getConfig: async () => { throw new Error('db down'); },
    } as unknown as BrainEngine;
    const cold = await resolveWritebackConfig(failing);
    expect(cold).toMatchObject({ mode: 'off', enabled: false, read_error: true });

    // One engine instance: succeed once, then fail — the FULL bundle
    // (mode + ttl + visibility) must come back, never a mixed default.
    let healthy = true;
    const flappy = {
      getConfig: async (k: string) => {
        if (!healthy) throw new Error('db blip');
        const rows: Record<string, string> = {
          [AUTO_WRITEBACK_KEY]: 'salient',
          [AUTO_WRITEBACK_TTL_KEY]: '12h',
          'facts.default_visibility': 'private',
        };
        return rows[k] ?? null;
      },
    } as unknown as BrainEngine;
    const warm = await resolveWritebackConfig(flappy);
    expect(warm).toMatchObject({ mode: 'salient', transient_ttl: '12h', visibility: 'private' });
    healthy = false;
    const cachedBundle = await resolveWritebackConfig(flappy);
    expect(cachedBundle).toMatchObject({ mode: 'salient', transient_ttl: '12h', visibility: 'private', visibility_explicit_private: true });
    expect(cachedBundle.read_error).toBeUndefined();
  });
});

describe('ambientOptsFrom (transport availability gating)', () => {
  const ENABLED: WritebackConfig = {
    mode: 'salient', enabled: true, mode_valid: true, raw_mode: 'salient',
    transient_ttl: '3d', ttl_valid: true,
    visibility: 'world', visibility_explicit_private: false, visibility_posture: 'world',
  };

  test('no remember in the caller\'s callable set → NO section at all (instructions never order calls dispatch denies)', () => {
    expect(ambientOptsFrom(ENABLED, { remember: false, extractFacts: true })).toBeNull();
    expect(ambientOptsFrom(ENABLED, { remember: false, extractFacts: false })).toBeNull();
  });

  test('remember callable → section renders; extract_facts availability only shapes the multi-fact line', () => {
    expect(ambientOptsFrom(ENABLED, { remember: true, extractFacts: true }))
      .toMatchObject({ mode: 'salient', extractFactsAvailable: true });
    expect(ambientOptsFrom(ENABLED, { remember: true, extractFacts: false }))
      .toMatchObject({ mode: 'salient', extractFactsAvailable: false });
  });

  test('disabled bundle → null regardless of availability', () => {
    expect(ambientOptsFrom({ ...ENABLED, mode: 'off', enabled: false }, { remember: true, extractFacts: true })).toBeNull();
  });
});

// ── registry + dual-plane CLI routing ───────────────────────────────────────

describe('KNOWN_CONFIG_KEYS registration', () => {
  test('the four ambient-writeback keys are registered (exact keys, no new prefixes)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('memory.auto_writeback');
    expect(KNOWN_CONFIG_KEYS).toContain('memory.auto_writeback_transient_ttl');
    expect(KNOWN_CONFIG_KEYS).toContain('memory.auto_writeback_notice_shown');
    expect(KNOWN_CONFIG_KEYS).toContain('brain.audience');
  });
});

async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const origErr = console.error;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try {
    await fn();
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  return out;
}

describe('config set/unset memory.* — dual-plane routing (OV2-5)', () => {
  afterEach(() => {
    // spies restored per-test below; nothing global to undo
  });

  test('set writes file mirror AND db plane; unset deletes both', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg-'));
    const db = new Map<string, string>();
    const engine = {
      getConfig: async (k: string) => db.get(k) ?? null,
      setConfig: async (k: string, v: string) => { db.set(k, v); },
      unsetConfig: async (k: string) => (db.delete(k) ? 1 : 0),
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(engine, ['set', 'memory.auto_writeback', 'salient']));
      expect(out).toContain('Set memory.auto_writeback = salient (file + db planes)');
      expect(out).toContain('bootstrap harness --yes');
      const cfgPath = join(parent, '.gbrain', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { memory?: { auto_writeback?: string } };
      expect(cfg.memory?.auto_writeback).toBe('salient');
      expect(db.get('memory.auto_writeback')).toBe('salient');

      const out2 = await captureLog(() => runConfig(engine, ['unset', 'memory.auto_writeback']));
      expect(out2).toContain('Unset memory.auto_writeback (file plane + db plane)');
      const cfg2 = JSON.parse(readFileSync(cfgPath, 'utf8')) as { memory?: { auto_writeback?: string } };
      expect(cfg2.memory?.auto_writeback).toBeUndefined();
      expect(db.has('memory.auto_writeback')).toBe(false);
    });
  });

  test('ttl key validates bounds at set time (loud rejection, nothing written)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg2-'));
    const db = new Map<string, string>();
    const engine = {
      setConfig: async (k: string, v: string) => { db.set(k, v); },
      unsetConfig: async () => 0,
      getConfig: async () => null,
    } as unknown as BrainEngine;
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await withEnv({ GBRAIN_HOME: parent }, async () => {
        const out = await captureLog(async () => {
          await expect(runConfig(engine, ['set', 'memory.auto_writeback_transient_ttl', 'P3D'])).rejects.toThrow('exit:1');
        });
        expect(out).toContain('positive duration shorthand');
        expect(db.size).toBe(0);

        const out2 = await captureLog(() => runConfig(engine, ['set', 'memory.auto_writeback_transient_ttl', '12h']));
        expect(out2).toContain('Set memory.auto_writeback_transient_ttl = 12h (file + db planes)');
        expect(db.get('memory.auto_writeback_transient_ttl')).toBe('12h');
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('mode value validated against the enum (loud rejection)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg3-'));
    const engine = { setConfig: async () => {}, getConfig: async () => null, unsetConfig: async () => 0 } as unknown as BrainEngine;
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await withEnv({ GBRAIN_HOME: parent }, async () => {
        const out = await captureLog(async () => {
          await expect(runConfig(engine, ['set', 'memory.auto_writeback', 'always'])).rejects.toThrow('exit:1');
        });
        expect(out).toContain(`must be one of: ${WRITEBACK_MODES.join(' | ')}`);
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('enabling on a shared-classified brain prints the privacy caution and PROCEEDS (WP8 — operator sovereignty)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg5-'));
    const db = new Map<string, string>([['brain.audience', 'shared']]);
    const engine = {
      getConfig: async (k: string) => db.get(k) ?? null,
      setConfig: async (k: string, v: string) => { db.set(k, v); },
      unsetConfig: async () => 0,
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(engine, ['set', 'memory.auto_writeback', 'salient']));
      expect(out).toContain('CAUTION');
      expect(out).toContain('company/team brain');
      expect(out).toContain('Proceeding as requested');
      expect(db.get('memory.auto_writeback')).toBe('salient'); // never a refusal
    });
  });

  test('db-plane write failure is a LOUD non-zero exit naming the unchanged runtime value (adversarial review)', async () => {
    // The DB plane is authoritative at runtime: exiting 0 here would report
    // an off switch as flipped while every serve keeps the previous value —
    // and `config get` (file mirror) would corroborate the lie.
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg4-'));
    const engine = {
      getConfig: async () => null,
      setConfig: async () => { throw new Error('locked'); },
      unsetConfig: async () => 0,
    } as unknown as BrainEngine;
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await withEnv({ GBRAIN_HOME: parent }, async () => {
        const out = await captureLog(async () => {
          await expect(runConfig(engine, ['set', 'memory.auto_writeback', 'salient'])).rejects.toThrow('exit:1');
        });
        expect(out).toContain('DB-plane write failed');
        expect(out).toContain('UNCHANGED');
        const cfg = JSON.parse(readFileSync(join(parent, '.gbrain', 'config.json'), 'utf8')) as { memory?: { auto_writeback?: string } };
        expect(cfg.memory?.auto_writeback).toBe('salient'); // file write stays — doctor names the re-sync
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('db-plane DELETE failure on unset is equally loud (revocation must not report success)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg6-'));
    const engine = {
      getConfig: async () => null,
      setConfig: async () => {},
      unsetConfig: async () => { throw new Error('locked'); },
    } as unknown as BrainEngine;
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await withEnv({ GBRAIN_HOME: parent }, async () => {
        const out = await captureLog(async () => {
          await expect(runConfig(engine, ['unset', 'memory.auto_writeback'])).rejects.toThrow('exit:1');
        });
        expect(out).toContain('DB-plane delete failed');
        expect(out).toContain('UNCHANGED');
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('unset --pattern memory. clears the file mirror too — the engine-free hook must not keep banking (codex re-review)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg8-'));
    const db = new Map<string, string>([['memory.auto_writeback', 'salient']]);
    const engine = {
      getConfig: async (k: string) => db.get(k) ?? null,
      setConfig: async (k: string, v: string) => { db.set(k, v); },
      unsetConfig: async (k: string) => (db.delete(k) ? 1 : 0),
      listConfigKeys: async (prefix: string) => [...db.keys()].filter((k) => k.startsWith(prefix)),
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      // Seed the realistic dual-written state.
      await captureLog(() => runConfig(engine, ['set', 'memory.auto_writeback', 'salient']));
      const cfgPath = join(parent, '.gbrain', 'config.json');
      expect((JSON.parse(readFileSync(cfgPath, 'utf8')) as { memory?: { auto_writeback?: string } }).memory?.auto_writeback).toBe('salient');

      const out = await captureLog(() => runConfig(engine, ['unset', '--pattern', 'memory.']));
      expect(out).toContain('File mirror cleared for: memory.auto_writeback');
      expect(db.has('memory.auto_writeback')).toBe(false);
      const after = JSON.parse(readFileSync(cfgPath, 'utf8')) as { memory?: { auto_writeback?: string } };
      expect(after.memory?.auto_writeback).toBeUndefined();
    });
  });

  test('mount selection never writes the host mirror: set on a mounted brain is DB-only (codex re-review)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg9-'));
    const db = new Map<string, string>();
    const engine = {
      getConfig: async (k: string) => db.get(k) ?? null,
      setConfig: async (k: string, v: string) => { db.set(k, v); },
      unsetConfig: async (k: string) => (db.delete(k) ? 1 : 0),
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: parent, GBRAIN_BRAIN_ID: 'someteam' }, async () => {
      const out = await captureLog(() => runConfig(engine, ['set', 'memory.auto_writeback', 'salient']));
      // The mount's DB row lands; the HOST's engine-free Stop hook must not
      // be opted in by a team-mount enable.
      expect(db.get('memory.auto_writeback')).toBe('salient');
      expect(out).toContain('db plane only — mounted brain');
      expect(existsSync(join(parent, '.gbrain', 'config.json'))).toBe(false);
    });
  });

  test('set-to-off prints the block-converge hint (the off switch names its second step)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wbcfg7-'));
    const db = new Map<string, string>();
    const engine = {
      getConfig: async (k: string) => db.get(k) ?? null,
      setConfig: async (k: string, v: string) => { db.set(k, v); },
      unsetConfig: async (k: string) => (db.delete(k) ? 1 : 0),
    } as unknown as BrainEngine;
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(engine, ['set', 'memory.auto_writeback', 'off']));
      expect(out).toContain('bootstrap harness --yes (converges on off)');
    });
  });
});
