import { registerPostgresTests } from '../helpers/test-backends.ts';

// #9676: the PostgreSQL arm of the connector import rendering its trust_tier marker.
await registerPostgresTests(() => import('../connector-trust-marker-9676.test.ts'));
