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
import { readPolicyOpts } from './context.ts';
import {
  GET_RECENT_SALIENCE_DESCRIPTION,
  FIND_ANOMALIES_DESCRIPTION,
} from '../operations-descriptions.ts';

// --- v0.29: Salience + Anomaly Detection ---

const get_recent_salience: Operation = {
  name: 'get_recent_salience',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: GET_RECENT_SALIENCE_DESCRIPTION,
  scope: 'read',
  params: {
    days: { type: 'number', description: 'Window in days (default 14).' },
    limit: { type: 'number', description: 'Max results (default 20).' },
    slugPrefix: {
      type: 'string',
      description: 'Slug prefix.',
    },
    recency_bias: {
      type: 'string',
      enum: ['flat', 'on'],
      description: 'flat (default) or on (per-prefix decay).',
    },
  },
  handler: async (ctx, p) => {
    const recencyBias = p.recency_bias === 'on' ? 'on' : 'flat';
    // Scope by the caller's source (canonical sourceScopeOpts ladder: federated
    // array > scalar > nothing), matching find_orphans/find_experts. Pre-fix
    // this op returned brain-wide salience regardless of a source-bound OAuth
    // client's grant — a read leak in the v0.34.1 (#861) source-isolation class
    // that the v0.29 salience/anomaly batch missed. Trusted local callers
    // (ctx.remote === false) still get the empty scope = full brain.
    const rows = await ctx.engine.getRecentSalience({
      days: typeof p.days === 'number' ? p.days : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      slugPrefix: typeof p.slugPrefix === 'string' ? p.slugPrefix : undefined,
      recency_bias: recencyBias,
      ...await readPolicyOpts(ctx),
    });
    return rows;
  },
  // hidden: 'salience' is in CLI_ONLY (src/cli.ts) — runSalience owns the CLI
  // surface; the non-hidden hint was dead (CLI_ONLY wins at dispatch).
  cliHints: { name: 'salience', hidden: true },
};

const find_anomalies: Operation = {
  name: 'find_anomalies',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: FIND_ANOMALIES_DESCRIPTION,
  scope: 'read',
  params: {
    since: {
      type: 'string',
      description: 'YYYY-MM-DD (default today).',
    },
    lookback_days: {
      type: 'number',
      description: 'Baseline days (default 30).',
    },
    sigma: {
      type: 'number',
      description: 'Threshold (default 3).',
    },
  },
  handler: async (ctx, p) => {
    // Scope by the caller's source (same v0.34.1 #861 source-isolation class as
    // get_recent_salience above — the v0.29 batch missed both). Applied to the
    // baseline AND today windows inside the engine so the anomaly math stays
    // self-consistent. Trusted local callers (ctx.remote === false) get the
    // empty scope = full brain.
    const anomalies = await ctx.engine.findAnomalies({
      since: typeof p.since === 'string' ? p.since : undefined,
      lookback_days: typeof p.lookback_days === 'number' ? p.lookback_days : undefined,
      sigma: typeof p.sigma === 'number' ? p.sigma : undefined,
      ...await readPolicyOpts(ctx),
    });

    return anomalies;
  },
  // hidden: 'anomalies' is in CLI_ONLY (src/cli.ts) — runAnomalies owns the
  // CLI surface; the non-hidden hint was dead (CLI_ONLY wins at dispatch).
  cliHints: { name: 'anomalies', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const salienceOperations: Operation[] = [get_recent_salience, find_anomalies];
