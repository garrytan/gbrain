import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL!;
assertSafeE2eDatabaseUrl(databaseUrl);
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
let providerCalls = 0;
__setChatTransportForTests(async () => { providerCalls++; throw new Error('Provider work must not run while replaying accepted fact output.'); });
__setEmbedTransportForTests(async () => { providerCalls++; throw new Error('Embedding work must not run while replaying accepted fact output.'); });
const input = JSON.parse(process.argv[2]) as { sourceId: string; auth: OperationContext['auth']; params: Record<string, unknown> };
const engine = new PostgresEngine();
await engine.connect({ database_url: databaseUrl });
try {
  const result = await operationsByName.extract_facts.handler({ engine, config: { engine: 'postgres', embedding_disabled: false }, remote: true,
    sourceId: input.sourceId, auth: input.auth, dryRun: false, logger: console }, input.params);
  console.log(JSON.stringify({ result, providerCalls }));
} finally { await engine.disconnect(); }
