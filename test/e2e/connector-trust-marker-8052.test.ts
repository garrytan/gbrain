import { registerPostgresTests } from '../helpers/test-backends.ts';

// #8052: the PostgreSQL arm of the connector re-render keeping the repaired trust_tier marker.
await registerPostgresTests(() => import('../connector-trust-marker-8052.test.ts'));
