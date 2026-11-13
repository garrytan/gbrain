import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extract-receipt-sealed-7620.test.ts'));
