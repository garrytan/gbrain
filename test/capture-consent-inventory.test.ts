/**
 * #6091 / W2.1: one capture gate with one truth table, and an inventory that
 * fails when an ambient provenance tag is added without registering it.
 *
 * 1. Protects: the lane-specific unset semantics (writeback retires; compact
 *    and SessionEnd extract), explicit off retiring every lane, and holds on a
 *    read error, plane drift, an invalid mode or an off that reached only the
 *    file mirror; the capture-lane lists in capture-dedup.ts and
 *    repair/captured-facts.ts equal the ambient subset of the backstop's
 *    provenance tags, and each ambient tag maps to a gate lane.
 * 2. Fails when: a lane extracts against an explicit off, an incoherent config
 *    extracts or retires, or a new `hook:*` / `sweep:*` tag is missing from a
 *    capture-lane list or from captureGateLaneForSource.
 */
import { describe, expect, test } from 'bun:test';
import { captureGateDecision, CAPTURE_GATE_LANES, resolveWritebackConfig, type WritebackConfig } from '../src/core/facts/writeback-config.ts';
import { AMBIENT_CAPTURE_SOURCES, captureGateLaneForSource, FACTS_BACKSTOP_SOURCES } from '../src/core/facts/capture-sources.ts';
import { CAPTURE_LANES as DEDUP_LANES } from '../src/core/facts/capture-dedup.ts';
import { CAPTURE_LANES as REPAIR_LANES } from '../src/core/repair/captured-facts.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { WRITEBACK_RESTART_AFTER_OFF, writebackOffMessage, writebackUnsetMessage } from '../src/core/facts/writeback-config.ts';
import { flagRejection, gbrainInvocations, liveCliVerbs } from './helpers/cli-command-surface.ts';
import type { GBrainConfig } from '../src/core/config.ts';

function engineWith(db: Record<string, string | null>, opts: { throws?: boolean } = {}): BrainEngine {
  return { getConfig: async (k: string) => { if (opts.throws) throw new Error('db down'); return db[k] ?? null; } } as unknown as BrainEngine;
}
const file = (mode?: string): GBrainConfig => ({ engine: 'pglite', ...(mode === undefined ? {} : { memory: { auto_writeback: mode } }) }) as GBrainConfig;
async function cfgFor(dbMode: string | null, fileMode?: string, throws = false): Promise<WritebackConfig> {
  return resolveWritebackConfig(engineWith({ 'memory.auto_writeback': dbMode }, { throws }), file(fileMode), { gate: true });
}
async function row(dbMode: string | null, fileMode?: string, throws = false): Promise<string[]> {
  const cfg = await cfgFor(dbMode, fileMode, throws);
  return CAPTURE_GATE_LANES.map((lane) => `${captureGateDecision(cfg, lane).action}:${captureGateDecision(cfg, lane).reason}`);
}

describe('captureGateDecision truth table (writeback, compact, session_end)', () => {
  test('unset: writeback retires, compact and SessionEnd extract', async () => {
    expect(await row(null)).toEqual(['retire:writeback_off', 'extract:writeback_unset', 'extract:writeback_unset']);
  });
  test('explicit off retires every lane', async () => {
    expect(await row('off', 'off')).toEqual(['retire:writeback_off', 'retire:writeback_off', 'retire:writeback_off']);
  });
  test('salient and all extract on every lane', async () => {
    for (const mode of ['salient', 'all']) {
      expect(await row(mode, mode)).toEqual(['extract:writeback_on', 'extract:writeback_on', 'extract:writeback_on']);
    }
  });
  test('an invalid mode holds every lane', async () => {
    expect(await row('sometimes')).toEqual(Array(3).fill('hold:writeback_mode_invalid'));
  });
  test('plane drift (DB row absent, file mirror on) holds every lane', async () => {
    expect(await row(null, 'salient')).toEqual(Array(3).fill('hold:writeback_plane_drift'));
  });
  test('a read error holds every lane, even with a cached enabled bundle', async () => {
    expect(await row(null, undefined, true)).toEqual(Array(3).fill('hold:writeback_gate_unreadable'));
  });
  test('an off that reached only the file mirror holds compact and SessionEnd; writeback retires as on unset', async () => {
    expect(await row(null, 'off')).toEqual(['retire:writeback_off', 'hold:writeback_off_unsynced', 'hold:writeback_off_unsynced']);
  });
  test('an explicit DB off beats a file mirror that still says on', async () => {
    expect(await row('off', 'all')).toEqual(Array(3).fill('retire:writeback_off'));
  });
});

describe('ambient capture inventory', () => {
  test('the ambient subset is derived from the backstop provenance tags', () => {
    expect([...AMBIENT_CAPTURE_SOURCES].sort()).toEqual(FACTS_BACKSTOP_SOURCES.filter((s) => /^(hook|sweep):/.test(s)).sort());
  });
  test('both capture-lane lists equal the ambient subset as sets', () => {
    expect(new Set<string>(DEDUP_LANES)).toEqual(new Set<string>(AMBIENT_CAPTURE_SOURCES));
    expect(new Set<string>(REPAIR_LANES)).toEqual(new Set<string>(AMBIENT_CAPTURE_SOURCES));
  });
  test('every ambient tag answers to a gate lane; explicit writers answer to none', () => {
    for (const s of FACTS_BACKSTOP_SOURCES) {
      expect(captureGateLaneForSource(s) !== null).toBe(AMBIENT_CAPTURE_SOURCES.includes(s));
    }
  });
});

describe('operator text names what stopped and only commands that exist', () => {
  const commandsIn = (lines: readonly string[]) => [...lines.join(' ').matchAll(/`(gbrain [^`]+)`/g)].flatMap((m) => gbrainInvocations(m[1]));
  test('config set off names the stopped lanes, what keeps working, the restart list, review and full-removal commands', () => {
    const text = writebackOffMessage().join('\n');
    for (const needle of ['Stop-hook turn capture', 'compaction harvest', 'SessionEnd transcript', 'Not stopped', 'remember / extract_facts',
      'gbrain serve', 'OpenClaw gateway', 'hook:compact', 'sweep:corpus', 'gbrain bootstrap harness --remove']) {
      expect(text).toContain(needle);
    }
  });
  test('every suggested command is a live verb whose flags the real CLI accepts', () => {
    const invocations = commandsIn([...writebackOffMessage(), ...writebackUnsetMessage(), ...WRITEBACK_RESTART_AFTER_OFF]);
    expect(invocations.length).toBeGreaterThanOrEqual(6);
    const live = liveCliVerbs();
    for (const inv of invocations) {
      expect(live.has(inv.verb)).toBe(true);
      expect(flagRejection(inv)).toBeNull();
    }
  });
  test('the ambient_capture_off refusal carries a runnable read-only fix', async () => {
    const { assertAmbientCaptureAdmissible } = await import('../src/core/facts/capture-sources.ts');
    const err = await assertAmbientCaptureAdmissible(engineWith({ 'memory.auto_writeback': 'off' }), 'sweep:corpus').then(() => null, (e) => e);
    expect(err?.code).toBe('ambient_capture_off');
    const argv = err.fix.argv as string[];
    expect(argv[0]).toBe('gbrain');
    expect(flagRejection({ verb: argv[1], argv: argv.slice(1) })).toBeNull();
    expect(await assertAmbientCaptureAdmissible(engineWith({ 'memory.auto_writeback': 'off' }), 'mcp:extract_facts')).toBeUndefined();
  });
});
