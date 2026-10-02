import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runGoogleAttachments } from '../../src/commands/google-attachments.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { currentExitCode } from '../../src/core/cli-force-exit.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

const input = JSON.parse(process.env.GBRAIN_TEST_GMAIL_COMMAND!);
if (input.database.database_url) assertSafeE2eDatabaseUrl(input.database.database_url);
const engine = input.database.engine === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
await engine.connect(input.database);
let calls = 0;
try {
  await runGoogleAttachments(input.args, engine, async url => {
    calls++;
    if (url.includes('/profile')) return Response.json({ emailAddress: 'reader@example.com', historyId: '100' });
    const n = Number(url.match(/threads\/thread(\d+)/)?.[1]);
    if (!n) throw new Error('Unexpected synthetic route');
    if (input.unavailable && n === 1) return Response.json({}, { status: 404 });
    return Response.json({ id: `thread${n}`, messages: [{ id: `message000000000${n}`, payload: { mimeType: 'application/pdf', filename: 'sensitive-name-not-for-logs.pdf', body: { size: 2 } } }] });
  });
} finally {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  process.stderr.write(`FIXTURE_CALLS:${calls}\n`);
}
process.exit(currentExitCode());
