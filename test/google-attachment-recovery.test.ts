import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { parseGoogleSourceConfig } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import { createConnectorFixture, options } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { home, engines, env, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);
const config = { kind: 'google', g_account: 'reader@example.com', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const slug = 'emails/2026/09/thread-1';
const content = '---\ntype: email\ntitle: Synthetic recovery\nthread_id: thread1\naccount: reader@example.com\nmessage_ids: [message0000000001]\nvisibility: private\ncustom: retained\n---\nExact preserved historical body.\n';

async function child(engine: BrainEngine, f: { id: string; dir: string }, crash?: string, unavailable = false) {
  let database: Record<string, unknown> = { engine: 'pglite', database_path: join(home, 'database') };
  if (engine.kind === 'postgres') {
    const [row] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${row.name}`;
    database = { engine: 'postgres', database_url: url.toString(), poolSize: 4 };
  }
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  let pid: number | undefined;
  try {
    const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'helpers/google-attachment-restart.ts')], {
      env: { ...process.env, ...env, GBRAIN_TEST_GMAIL_RESTART: JSON.stringify({ database, sourceId: f.id, root: f.dir, sourceConfig: config, crash, unavailable }) }, stdout: 'pipe', stderr: 'pipe',
    });
    pid = proc.pid;
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, exit };
    } finally { clearTimeout(timer); if (proc.exitCode === null) proc.kill('SIGKILL'); await proc.exited; }
  } finally {
    await engine.connect(database);
    if (crash && pid) await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquired_at=now()-interval '2 minutes',last_refreshed_at=now()-interval '1 hour',ttl_expires_at=now()-interval '1 hour' WHERE id=$1 AND holder_pid=$2`, [syncLockId(f.id), pid]);
  }
}

for (const crash of ['after_metadata_commit', 'after_checkpoint_commit']) {
  test(`unavailable receipt diagnostics and counts survive actual SIGKILL ${crash}`, async () => withEnv(env, async () => {
    for (const engine of engines) {
      const f = await boundSource(engine, config);
      await withConnectorSync(engine, f.id, 'google', parseGoogleSourceConfig(config, f.dir), options, async managed => {
        await managed!.importMarkdown(`${slug}.md`, content);
      });
      const before = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
      const killed = await child(engine, f, crash, true);
      expect(killed.stdout, killed.stderr).toContain(`GMAIL_CRASH ${crash}`);
      expect(killed.exit).not.toBe(0);
      const restarted = await child(engine, f, undefined, true);
      expect(restarted.exit, restarted.stderr).toBe(0);
      const result = JSON.parse(restarted.stdout.split('GMAIL_RESULT ')[1].trim());
      expect(result).toMatchObject({ status: 'complete', inspected: 0, unavailable: 1, unavailableMessages: 1, inspection_complete: false });
      const after = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
      expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
      expect(after.page.frontmatter.visibility).toBe('private');
      expect(after.page.frontmatter.message_ids).toEqual(before.page.frontmatter.message_ids);
      expect(after.page.frontmatter.gmail_attachment_receipts).toMatchObject({ unavailable: 'thread_not_found',
        messages: [{ unavailable: 'thread_not_found', inspection: { state: 'not_inspected', attachments: [] } }] });
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.id])).toHaveLength(0);
    }
  }), 120_000);
}

for (const crash of ['before_publication', 'after_publication', 'after_metadata_commit', 'after_checkpoint_commit']) {
  test(`historical receipt journal survives actual SIGKILL ${crash}`, async () => withEnv(env, async () => {
    for (const engine of engines) {
      const f = await boundSource(engine, config);
      await withConnectorSync(engine, f.id, 'google', parseGoogleSourceConfig(config, f.dir), options, async managed => {
        await managed!.importMarkdown(`${slug}.md`, content);
      });
      const before = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
      const killed = await child(engine, f, crash);
      expect(killed.stdout, killed.stderr).toContain(`GMAIL_CRASH ${crash}`);
      expect(killed.exit).not.toBe(0);
      const restarted = await child(engine, f);
      expect(restarted.exit, restarted.stderr).toBe(0);
      expect(restarted.stdout).toContain('"status":"complete"');
      const after = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
      expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
      expect(after.page.frontmatter.custom).toBe('retained');
      expect(after.page.frontmatter.visibility).toBe('private');
      expect(after.page.frontmatter.gmail_attachment_receipts).toMatchObject({ messages: [{ inspection: { state: 'present', attachments: [{ filename: 'fixture.pdf' }] } }] });
      expect(readFileSync(join(f.dir, `${slug}.md`), 'utf8')).toContain('Exact preserved historical body.');
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.id])).toHaveLength(0);
      const [count] = await engine.executeRaw<{ count: string }>("SELECT count(*)::text AS count FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_google_receipts' AND state='committed' AND NOT COALESCE((outcome->>'noop')::boolean,false)", [f.id]);
      expect(Number(count.count)).toBe(1);
    }
  }), 120_000);
}
