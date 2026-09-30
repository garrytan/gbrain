import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(
  () => import('../managed-connector-routing.serial.test.ts'),
  () => import('../persistence-connectors.test.ts'),
);
