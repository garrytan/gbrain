/**
 * supersession_calibration doctor check: informational, names an uncalibrated
 * embedding model with the calibrate-and-register action, reports a calibrated
 * or operator threshold as ok, and is not applicable on a keyless brain.
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { supersessionCalibrationEntry } from '../src/commands/doctor/checks/supersession-calibration.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { Action } from '../src/core/agent-output.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const run = async () => (await supersessionCalibrationEntry.run({ engine, progress: { heartbeat() {} } } as never) as Check[])[0];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
}, 60_000);

describe('supersession_calibration', () => {
  test('a calibrated default model is ok', async () => {
    configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'k' } });
    const check = await run();
    expect(check).toMatchObject({ name: 'supersession_calibration', status: 'ok', details: { key: 'voyage:voyage-4@1024', threshold: 0.95, source: 'calibrated' } });
    expect(check.fix).toBeUndefined();
    expect(categorizeCheck('supersession_calibration')).toBe('brain');
  });

  test('an uncalibrated model is informational, names the model and carries the calibrate → register action', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'k' } });
    await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ 'other:model@8': 0.9 }));
    try {
      const check = await run();
      expect(check).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'degraded', details: { key: 'openai:text-embedding-3-large@1536', threshold: null, source: 'uncalibrated' } });
      expect(check.message).toContain('openai:text-embedding-3-large@1536 has no calibrated fact supersession threshold');
      const fix = check.fix as Action;
      expect(fix.consent).toEqual(['paid', 'egress']);
      expect(fix.user_message).toContain('about a cent');
      expect(fix.argv!.slice(2, 5)).toEqual(['calibrate', 'openai:text-embedding-3-large', '1536']);
      expect(fix.argv![1]).toMatch(/scripts\/eval-c2-candidate-fusion\.ts$/);
      expect(fix.argv!.some(a => a.startsWith('--'))).toBe(false);
      const register = fix.then!;
      expect(register.argv!.slice(0, 4)).toEqual(['gbrain', 'config', 'set', 'facts.supersession_thresholds']);
      expect(register.argv![4]).toBe('{"other:model@8":0.9,"openai:text-embedding-3-large@1536":THRESHOLD}');
      expect(register.inputs![0].name).toBe('THRESHOLD');
      expect(register.verify!.argv).toEqual(['gbrain', 'doctor', '--only', 'supersession_calibration', '--json']);
    } finally {
      await engine.unsetConfig('facts.supersession_thresholds');
    }
  });

  test('an operator threshold is ok; "off" is disabled by choice', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'k' } });
    await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ 'openai:text-embedding-3-large@1536': 0.97 }));
    try {
      expect(await run()).toMatchObject({ status: 'ok', details: { threshold: 0.97, source: 'override' } });
      await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ 'openai:text-embedding-3-large@1536': 'off' }));
      expect(await run()).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice' });
    } finally {
      await engine.unsetConfig('facts.supersession_thresholds');
    }
  });

  test('a brain with embeddings off is not applicable', async () => {
    await engine.setConfig('embedding_disabled', 'true');
    try {
      expect(await run()).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'not_applicable' });
    } finally {
      await engine.unsetConfig('embedding_disabled');
    }
  });
});
