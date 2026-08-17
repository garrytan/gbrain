/**
 * Salience + Anomaly operation cluster — pure move from operations.ts
 * (v0.46.x tranche 2). Op consts stay module-private; `salienceOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts (find_anomalies was defined after
 * the push-context divider in the original file but has always occupied the
 * slot right after get_recent_salience in the array — the array order is
 * the contract). Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import {
  GET_RECENT_SALIENCE_DESCRIPTION,
  FIND_ANOMALIES_DESCRIPTION,
} from '../operations-descriptions.ts';

// --- v0.29: Salience + Anomaly Detection ---

const get_recent_salience: Operation = {
  name: 'get_recent_salience',
  description: GET_RECENT_SALIENCE_DESCRIPTION,
  scope: 'read',
  params: {
    days: { type: 'number', description: 'Window in days. Default 14.' },
    limit: { type: 'number', description: 'Max results (default 20, capped at 100).' },
    slugPrefix: {
      type: 'string',
      description: "Optional slug-prefix filter, e.g. 'personal' or 'wiki/people'.",
    },
    recency_bias: {
      type: 'string',
      enum: ['flat', 'on'],
      description:
        "v0.29.1: how to weight recency in the salience score.\n" +
        "  'flat' (DEFAULT) — v0.29.0 behavior. Every page gets 1/(1+days_old).\n" +
        "                     Stable, predictable; what most callers want.\n" +
        "  'on'             — Per-prefix decay map. concepts/originals/writing/\n" +
        "                     become evergreen (recency component = 0); daily/,\n" +
        "                     media/x/, chat/ decay aggressively. Use when the\n" +
        "                     user explicitly biases for recency-aware salience\n" +
        "                     ('what's been salient lately' vs 'what matters\n" +
        "                     in this brain regardless of when').",
    },
  },
  handler: async (ctx, p) => {
    const recencyBias = p.recency_bias === 'on' ? 'on' : 'flat';
    return ctx.engine.getRecentSalience({
      days: typeof p.days === 'number' ? p.days : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      slugPrefix: typeof p.slugPrefix === 'string' ? p.slugPrefix : undefined,
      recency_bias: recencyBias,
    });
  },
  // hidden: 'salience' is in CLI_ONLY (src/cli.ts) — runSalience owns the CLI
  // surface; the non-hidden hint was dead (CLI_ONLY wins at dispatch).
  cliHints: { name: 'salience', hidden: true },
};

const find_anomalies: Operation = {
  name: 'find_anomalies',
  description: FIND_ANOMALIES_DESCRIPTION,
  scope: 'read',
  params: {
    since: {
      type: 'string',
      description: 'ISO date YYYY-MM-DD. Default = today (UTC).',
    },
    lookback_days: {
      type: 'number',
      description: 'Days of history for the baseline. Default 30.',
    },
    sigma: {
      type: 'number',
      description: 'Sigma threshold. Default 3.0.',
    },
  },
  handler: async (ctx, p) => {
    return ctx.engine.findAnomalies({
      since: typeof p.since === 'string' ? p.since : undefined,
      lookback_days: typeof p.lookback_days === 'number' ? p.lookback_days : undefined,
      sigma: typeof p.sigma === 'number' ? p.sigma : undefined,
    });
  },
  // hidden: 'anomalies' is in CLI_ONLY (src/cli.ts) — runAnomalies owns the
  // CLI surface; the non-hidden hint was dead (CLI_ONLY wins at dispatch).
  cliHints: { name: 'anomalies', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const salienceOperations: Operation[] = [get_recent_salience, find_anomalies];
