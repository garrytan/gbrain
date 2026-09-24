import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { startPersistenceConsumer, disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { getWriteRequestById } from '../../src/core/persistence/journal.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

const config: GBrainConfig = JSON.parse(process.env.GBRAIN_MAINTENANCE_TEST_CONFIG!);
if (config.database_url) assertSafeE2eDatabaseUrl(config.database_url);
const engine = config.engine === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
await engine.connect(config);
try {
  startPersistenceConsumer(engine, config);
  let row;
  const deadline = Date.now() + 15_000;
  do {
    await Bun.sleep(50);
    row = await getWriteRequestById(engine, process.env.GBRAIN_MAINTENANCE_TEST_REQUEST!);
  } while (Date.now() < deadline && row && ['queued', 'running', 'recovering'].includes(row.state));
  if (row?.state !== 'committed') throw new Error(`Resident replay did not commit: ${row?.state}`);
} finally {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
}
