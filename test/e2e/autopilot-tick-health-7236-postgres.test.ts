import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../autopilot-tick-health-7236.test.ts'));
