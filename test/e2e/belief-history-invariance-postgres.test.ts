import { registerPostgresTests } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

await withEnv({ GBRAIN_HISTORY_GATE_SEED_FROM: '1', GBRAIN_HISTORY_GATE_SEEDS: '10' },
  () => registerPostgresTests(() => import('../belief-history-invariance.slow.test.ts')));
