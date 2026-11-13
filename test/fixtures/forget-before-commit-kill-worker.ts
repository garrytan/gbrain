// Executed only in an owned subprocess by test/forget-door-landed-gst2517.test.ts (GST-2517, Postgres arm).
// Forgets one fact as the trusted local host and SIGKILLs itself at publication:before_commit, after the door commit
// landed in Git and before the publication transaction committed its row.
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';

const [url, id] = process.argv.slice(2) as [string, string];
installFaultHook(async (point, detail) => {
  if (point !== 'publication:before_commit' || detail.operation !== 'forget') return;
  process.stdout.write(`${JSON.stringify({ event: 'boundary' })}\n`);
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
});
const engine = new PostgresEngine();
await engine.connect({ database_url: url, poolSize: 4 });
const ctx = { engine, config: { engine: 'postgres', embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
await operationsByName.forget!.handler(ctx, { request_id: randomUUID(), id });
process.stdout.write(`${JSON.stringify({ event: 'completed' })}\n`);
process.exit(0);
