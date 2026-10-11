import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerPgliteEngine } from '../../src/product/database/worker-engine';
import { withDatabasePriority } from '../../src/product/database/priority';
import { loadConfig, toEngineConfig } from '../../src/core/config';
import { configureGateway } from '../../src/core/ai/gateway';
import { buildGatewayConfig } from '../../src/core/ai/gateway-config';
import { runServeHttp } from '../../src/commands/serve-http';
import type { BrainEngine } from '../../src/core/engine';

const config = loadConfig()!;
configureGateway(buildGatewayConfig(config));
const engine = new WorkerPgliteEngine() as unknown as BrainEngine;
await engine.connect(toEngineConfig(config));
await engine.initSchema();
createInterface({ input: process.stdin }).on('line', line => {
  if (line !== 'load') return;
  void withDatabasePriority(3, async () => {
    const query = engine.executeRaw('SELECT sum(sqrt(i)) FROM generate_series(1, 6000000) i');
    await Bun.sleep(60);
    writeFileSync(join(process.env.PMBRAIN_HOME!, 'load-started'), 'started');
    await query;
    writeFileSync(join(process.env.PMBRAIN_HOME!, 'load-finished'), 'finished');
  });
});
await runServeHttp(engine, { port: Number(process.argv[process.argv.indexOf('--port') + 1]), tokenTtl: 3600, enableDcr: false, diagnosticMode: true, suppressBootstrapToken: true });
