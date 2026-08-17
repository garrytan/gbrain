/**
 * Calibration-profile operation cluster — pure move from operations.ts
 * (v0.46.x tranche 2). Op consts stay module-private;
 * `calibrationOperations` below lists them in EXACTLY the order they appear
 * in the canonical `operations` array in ../operations.ts. Never import
 * from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';

// --- v0.36.1.0 (T7): calibration profile read op ---

const get_calibration_profile: Operation = {
  name: 'get_calibration_profile',
  description:
    'Read the active calibration profile for a holder. Returns the latest row from calibration_profiles ' +
    '(per-source, per-holder) including Brier score, accuracy, pattern statements, and active bias tags. ' +
    'Source-scoped via sourceScopeOpts — federated_read scopes see the union of allowed sources, ' +
    'scalar source-bound clients see only their source. Returns null when no profile exists yet ' +
    '(cold-brain branch: builds after 5+ resolved takes + a calibration_profile phase run).',
  scope: 'read',
  params: {
    holder: {
      type: 'string',
      description:
        "Holder slug, e.g. 'self' or 'people/charlie-example'. Defaults to config emotional_weight.user_holder, else 'self', when omitted.",
    },
  },
  handler: async (ctx, p) => {
    const { getCalibrationProfileOp } = await import('../../commands/calibration.ts');
    return getCalibrationProfileOp(ctx, {
      ...(typeof p.holder === 'string' ? { holder: p.holder } : {}),
    });
  },
};


// Ops in EXACTLY the canonical `operations` array order.
export const calibrationOperations: Operation[] = [get_calibration_profile];
