/**
 * supersession_calibration (informational): whether this brain's embedding
 * model has a calibrated fact supersession threshold
 * (src/core/facts/supersession-threshold.ts). Without one, an explicit write
 * never replaces a similar fact by cosine: the new fact is inserted next to
 * the old one, and the conflict review sweep judges the pair where it is on.
 * The fix measures a threshold for the model on the synthetic C2 fixture
 * (about 23K tokens of test sentences, about a cent; no brain content leaves
 * the machine) and registers it in `facts.supersession_thresholds`. Always
 * status ok: the brain is safe either way, it just keeps more duplicates.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';
import { embeddingsDisabled } from '../../../core/embedding-disabled.ts';
import type { Action } from '../../../core/agent-output.ts';

const DOCS = 'docs/eval/decisions/supersession-threshold-dev/README.md';
const SCRIPT = resolve(import.meta.dir, '../../../../scripts/eval-c2-candidate-fusion.ts');

/** Calibrate (paid, ask first: embeds the fixture, then sweeps for free) → register the guarded pick. */
function calibrationFix(model: string, dims: number, key: string, overrides: Record<string, unknown>): Action {
  const out = join(tmpdir(), `gbrain-supersession-${key.replace(/[^a-z0-9]+/gi, '-')}.json.gz`);
  const register = JSON.stringify({ ...overrides, [key]: '<THRESHOLD>' }).replace('"<THRESHOLD>"', 'THRESHOLD');
  return {
    argv: ['bun', SCRIPT, 'calibrate', model, String(dims), out],
    consent: ['paid', 'egress'],
    actor: 'agent',
    why: `Supersession by similarity is off for ${key} until a threshold is measured for it. This embeds the synthetic C2 fixture (1,506 test sentences, about 23K tokens) with ${model}, then replays it at thresholds 0.80 to 0.97 on a throwaway in-memory brain (several minutes, no further provider calls) and prints threshold_pick.guarded. No brain content is sent.`,
    user_message: `Facts saved on this brain never replace a similar older fact automatically, because its embedding model (${key}) has no measured threshold. Measuring one sends about 23K tokens of synthetic test sentences to the embedding provider (about a cent). OK to run it?`,
    docs: DOCS,
    requires_exclusive: false,
    then: {
      argv: ['gbrain', 'config', 'set', 'facts.supersession_thresholds', register],
      consent: [],
      actor: 'agent',
      why: 'Registers the measured threshold for this model; the next fact write uses it. Remove it with gbrain config unset facts.supersession_thresholds.',
      inputs: [{ name: 'THRESHOLD', how: 'threshold_pick.guarded from the calibrate output. When it is null no threshold is safe for this model: skip this step and leave supersession off.' }],
      verify: doctorVerify('supersession_calibration'),
      requires_exclusive: false,
    },
  };
}

async function runSupersessionCalibration(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('supersession_calibration');
  try {
    if (await embeddingsDisabled(engine)) {
      checks.push({ name: 'supersession_calibration', status: 'ok', severity: 'info', readiness_state: 'not_applicable',
        message: 'Embeddings are off on this brain, so facts are only deduplicated by exact text; no supersession threshold applies.' });
      return checks;
    }
    const { getEmbeddingModel, getEmbeddingDimensions } = await import('../../../core/ai/gateway.ts');
    const { SUPERSESSION_THRESHOLDS_KEY, readSupersessionThreshold } = await import('../../../core/facts/supersession-threshold.ts');
    const model = getEmbeddingModel();
    const dims = getEmbeddingDimensions();
    const resolved = await readSupersessionThreshold(engine, model, dims);
    const details = { model, dims, key: resolved.key, threshold: resolved.threshold, source: resolved.source, config_key: SUPERSESSION_THRESHOLDS_KEY, docs: DOCS };
    if (resolved.threshold !== null) {
      checks.push({ name: 'supersession_calibration', status: 'ok', details,
        message: `Fact supersession replaces a similar fact at cosine ${resolved.threshold} for ${resolved.key} (${resolved.source === 'override' ? `operator value in ${SUPERSESSION_THRESHOLDS_KEY}` : 'calibrated'}).` });
      return checks;
    }
    if (resolved.source === 'override') {
      checks.push({ name: 'supersession_calibration', status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice', details,
        message: `Fact supersession by similarity is off for ${resolved.key} (set to "off" in ${SUPERSESSION_THRESHOLDS_KEY}); new facts are inserted and exact-text duplicates still collapse.` });
      return checks;
    }
    let raw: unknown = {};
    try { raw = JSON.parse((await engine.getConfig(SUPERSESSION_THRESHOLDS_KEY)) ?? '{}'); } catch { raw = {}; }
    const overrides = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    checks.push({
      name: 'supersession_calibration', status: 'ok', severity: 'info', readiness_state: 'degraded', details,
      message: `Embedding model ${resolved.key} has no calibrated fact supersession threshold, so a saved fact never replaces a similar older one `
        + 'by similarity: it is inserted beside it (exact-text duplicates still collapse), and the conflict review sweep judges the pair where it is on. '
        + `Measure one with the C2 fixture (about a cent), then register it in ${SUPERSESSION_THRESHOLDS_KEY}. See ${DOCS}.`,
      ...(existsSync(SCRIPT) ? { fix: calibrationFix(model, dims, resolved.key, overrides) } : {}),
    });
  } catch (error) {
    checks.push({ name: 'supersession_calibration', status: 'ok', severity: 'info', readiness_state: 'unknown',
      message: `Could not resolve the fact supersession threshold: ${error instanceof Error ? error.message : String(error)}.` });
  }
  return checks;
}

export const supersessionCalibrationEntry: DoctorEntry = {
  name: 'supersession_calibration',
  emits: ['supersession_calibration'],
  run: runSupersessionCalibration,
};
