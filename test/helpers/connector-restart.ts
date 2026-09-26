import type { GBrainConfig } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../../src/core/github-source.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { writeSync } from 'node:fs';

const input = JSON.parse(process.env.GBRAIN_TEST_CONNECTOR_RESTART!);
const config: GBrainConfig = input.database;
if (config.database_url) assertSafeE2eDatabaseUrl(config.database_url);
const engine: BrainEngine = config.engine === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
await engine.connect(config);
if (input.crash) {
  const transaction = engine.transaction;
  engine.transaction = function <T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    return transaction.call(this, async tx => {
      const result = await run(tx);
      const row = result as Partial<WriteRequest> | undefined;
      if (row?.state === 'committed' && row.intent?.kind === 'managed_connector_import') {
        writeSync(1, 'CONNECTOR_AFTER_PUBLICATION_BEFORE_COMMIT\n');
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => {});
      }
      return result;
    }) as Promise<T>;
  };
}
const issue = { number: 1, title: 'Example issue', state: 'open', body: input.body,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', labels: [], assignees: [],
  user: { login: 'example-user' }, html_url: 'https://github.com/acme-example/app/issues/1' };
const fetcher = async (url: string) => {
  process.stdout.write('CONNECTOR_FIXTURE_FETCH\n');
  const path = new URL(url).pathname;
  let body: unknown;
  if (input.sourceConfig.kind === 'google') {
    body = path.endsWith('/settings/sendAs') ? { sendAs: [] } : { connections: [{ resourceName: 'people/first',
      names: [{ displayName: 'First Example' }], emailAddresses: [{ value: 'first@example.invalid' }],
      organizations: [{ name: input.body }] }], nextSyncToken: 'contacts-restart' };
  } else if (path.endsWith('/issues/1')) body = issue;
  else if (path.endsWith('/issues')) body = [issue];
  else if (path.endsWith('/pulls') || path.endsWith('/comments')) body = [];
  else if (path === '/repos/acme-example/app') body = { full_name: 'acme-example/app', private: true, default_branch: 'main' };
  else throw new Error('Unexpected connector fixture route');
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};
let failed = false;
try {
  const options = { noEmbed: true, noExtract: true, noSchemaPack: true, retryFailed: input.retryFailed === true };
  const result = input.sourceConfig.kind === 'google'
    ? await runGoogleSync(engine, input.sourceId, parseGoogleSourceConfig(input.sourceConfig, input.root), options, fetcher)
    : await runGitHubSync(engine, input.sourceId, parseGitHubSourceConfig(input.sourceConfig, input.root),
      { ...options, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } }, fetcher);
  process.stdout.write(`CONNECTOR_RESULT ${JSON.stringify(result)}\n`);
} catch (error) {
  const failure = error as { code?: string; writeRequest?: unknown };
  process.stdout.write(`CONNECTOR_ERROR ${JSON.stringify({ code: failure.code, receipt: failure.writeRequest })}\n`);
  failed = true;
} finally {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
}
if (failed) process.exitCode = 1;
