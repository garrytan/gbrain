import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleAttachmentsArgs } from '../src/commands/google-attachments.ts';
import { parseGoogleSourceConfig } from '../src/core/google/google-source.ts';
import { withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { createConnectorFixture, options, settleConnectorWrites } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { join } from 'node:path';

const { home, engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);
const config = { kind: 'google', g_account: 'reader@example.com', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };

test('historical command accepts only explicit bounded source-scoped controls', () => {
  expect(parseGoogleAttachmentsArgs(['backfill', '--source=gmail-example', '--limit', '2', '--yes', '--json'])).toMatchObject({ sourceId: 'gmail-example', limit: 2, yes: true, json: true });
  for (const args of [[], ['backfill'], ['backfill', '--source', '../escape'], ['backfill', '--source', '__all__'],
    ['backfill', '--source', '界'], ['backfill', '--source', 'a'.repeat(33)], ['backfill', '--source', 'ok', '--limit', '26'],
    ['backfill', '--source', 'ok', '--limit', '0'], ['backfill', '--source', 'ok', '--source', 'other'],
    ['backfill', '--source', 'ok', '--retry-failed'], ['backfill', '--source', 'ok', '--download']]) {
    expect(() => parseGoogleAttachmentsArgs(args)).toThrow();
  }
});

test('command JSON preview and apply expose truthful scope and progress without logging filenames', async () => withEnv(env, async () => {
  for (const engine of engines) for (const unavailable of [false, true]) {
    const f = await source(engine, config);
    await withConnectorSync(engine, f.id, 'google', parseGoogleSourceConfig(config, f.dir), options, async managed => {
      for (let n = 1; n <= 2; n++) await managed!.importMarkdown(`emails/2026/09/thread-${n}.md`, `---\ntype: email\ntitle: Synthetic command\naccount: reader@example.com\nthread_id: thread${n}\nmessage_ids: [message000000000${n}]\n---\nRetained body.\n`);
    });
    await settleConnectorWrites(engine, f.id);
    let database: Record<string, unknown> = { engine: 'pglite', database_path: join(home, 'database') };
    if (engine.kind === 'postgres') {
      const [row] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${row.name}`;
      database = { engine: 'postgres', database_url: url.toString(), poolSize: 4 };
    }
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    const run = async (extra: string[]) => {
      const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'helpers/google-attachments-command.ts')], {
        env: { ...process.env, ...env, GBRAIN_TEST_GMAIL_COMMAND: JSON.stringify({ database, unavailable, args: ['backfill', '--source', f.id, '--json', ...extra] }) }, stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(stdout + stderr).not.toContain('sensitive-name-not-for-logs');
      return { value: JSON.parse(stdout), stderr, exit };
    };
    try {
      const preview = await run([]);
      expect(preview.stderr).toContain('FIXTURE_CALLS:0');
      expect(preview.exit).toBe(0);
      expect(preview.value).toMatchObject({ ok: true, status: 'preview', writes: 'none', imported_thread_pages: 2, historical_inspection: { status: 'not_inspected' } });
      const first = await run(['--yes', '--limit', '1']);
      expect(first.value).toMatchObject({ ok: false, status: 'paused', processed: 1, complete: false, brain: 'host', source: f.id });
      expect(first.value).toMatchObject({ inspected: unavailable ? 0 : 1, unavailable: unavailable ? 1 : 0, inspection_complete: false });
      expect(first.exit).toBe(1);
      const second = await run(['--yes', '--limit', '1']);
      expect(second.value).toMatchObject({ ok: true, status: 'complete', processed: 1, inspected: unavailable ? 1 : 2,
        unavailable: unavailable ? 1 : 0, unavailableMessages: unavailable ? 1 : 0, inspection_complete: !unavailable });
      if (unavailable) expect(second.value.next_action.user_message).toContain('not inspected this run');
      expect(second.exit).toBe(0);
      expect((await run([])).value).toMatchObject({ status: 'preview', historical_inspection: { complete: true, inspected: unavailable ? 1 : 2 } });
    } finally { await engine.connect(database); }
  }
}), 120_000);

test('real CLI help and invalid-input errors document the managed-only repair path', async () => {
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, 'run', 'src/cli.ts', 'google', 'attachments', ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  const help = await run(['--help']);
  expect(help.exit).toBe(0);
  expect(help.stdout).toContain('Managed persistence');
  expect(help.stdout).toContain('--limit 1-25');
  const invalid = await run(['backfill', '--source', '../escape', '--yes', '--json']);
  expect(invalid.exit).toBe(2);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, status: 'failed', error: { code: 'invalid_params' } });
  expect(invalid.stdout).not.toContain('../escape');
}, 120_000);
