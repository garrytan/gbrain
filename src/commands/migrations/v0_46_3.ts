import type { Migration } from './types.ts';

export const v0_46_3: Migration = {
  version: '0.46.3',
  featurePitch: {
    headline: 'Embedding provider migration is available with an explicit cost preview.',
    description: 'Use gbrain migrate embeddings --status to inspect the stored identity and --dry-run to preview an explicit migration. No provider or vectors change automatically.',
  },
  orchestrator: async () => ({
    version: '0.46.3',
    status: 'complete',
    phases: [{ name: 'notice', status: 'skipped', detail: 'Historical notification retired; no data or configuration changes.' }],
  }),
};
