import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(
  () => import('../google-attachment-sync.test.ts'),
  () => import('../google-attachment-backfill.test.ts'),
  () => import('../google-attachment-recovery.test.ts'),
  () => import('../google-attachments-command.serial.test.ts'),
);
