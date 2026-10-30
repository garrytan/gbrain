/** Keyword OR fallback rarity on PostgreSQL: the dual-backend cases in test/search/keyword-or-rarity.test.ts. */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/keyword-or-rarity.test.ts'));
