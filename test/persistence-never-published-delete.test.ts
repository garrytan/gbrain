import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

// #5336: a subagent-sandbox page is published to the database only and never
// gets a canonical file. A trusted local delete of it must not fail closed as
// if the file had been removed outside gbrain, and its receipt must not claim
// a file or Git effect it did not perform; a trusted edit keeps refusing.
let engine: PGLiteEngine;
let home: string;
let root: string;
const sourceId = 'never-published';
const quiet = { info() {}, warn() {}, error() {} };
const cli = (): OperationContext => ({ engine, sourceId, remote: false, dryRun: false, config: { engine: 'pglite' }, logger: quiet });
const sandbox = (): OperationContext => ({ ...cli(), remote: true, viaSubagent: true, subagentId: 42 });
const submit = (ctx: OperationContext, operation: string, params: Record<string, unknown>) =>
  withEnv({ GBRAIN_HOME: home }, () => submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params }, waitMs: 30_000 }));

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-never-published-')));
  root = join(home, 'source'); mkdirSync(root);
  engine = new PGLiteEngine();
  await withEnv({ GBRAIN_HOME: home }, async () => { await engine.connect({}); await engine.initSchema(); });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

test('a trusted delete of a never-published sandbox page soft-deletes it; a trusted edit still refuses', async () => {
  const deleted = 'wiki/agents/42/notes/delete-me';
  const edited = 'wiki/agents/42/notes/edit-me';
  for (const slug of [deleted, edited]) {
    const put = await submit(sandbox(), 'put_page', { slug, content: '---\ntitle: Sandbox note\ntype: note\n---\nSandbox body.\n' });
    expect(put.state).toBe('committed');
    expect(put.persistence).toEqual({ mode: 'database' });
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
  }

  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('never-published-other','never-published-other') ON CONFLICT DO NOTHING");
  await engine.putPage(deleted, { type: 'note', title: 'Other source', compiled_truth: 'Other source body.' }, { sourceId: 'never-published-other' });
  const versionsBefore = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, deleted]);
  const disk = () => readdirSync(home, { recursive: true }).map(String).filter(entry => !entry.includes('.gbrain')).sort();
  const diskBefore = disk();

  const result = await submit(cli(), 'delete_page', { slug: deleted, force: true });
  expect(result.state).toBe('committed');
  expect(result.persistence).toEqual({ mode: 'database' });
  expect(result.write_through).toMatchObject({ written: false });
  const effects = await engine.executeRaw<{ kind: string }>(`SELECT e.kind FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE r.request_id=$1::uuid`, [result.request_id]);
  expect(effects.map(effect => effect.kind)).not.toContain('git');
  expect(await engine.readPageSnapshot(deleted, { sourceId })).toBeNull();
  expect((await engine.readPageSnapshot(deleted, { sourceId, includeDeleted: true }))?.page.deleted_at).not.toBeNull();
  const versionsAfter = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, deleted]);
  expect(versionsAfter[0]!.n).toBe(versionsBefore[0]!.n + 1);
  expect((await engine.readPageSnapshot(deleted, { sourceId: 'never-published-other' }))?.page.compiled_truth).toBe('Other source body.');
  expect(existsSync(join(root, `${deleted}.md`))).toBe(false);
  expect(disk()).toEqual(diskBefore);

  await expect(submit(cli(), 'put_page', { slug: edited, content: '---\ntitle: Sandbox note\ntype: note\n---\nTrusted edit.\n', force: true }))
    .rejects.toMatchObject({ code: 'source_changed' });
  expect(existsSync(join(root, `${edited}.md`))).toBe(false);
  expect((await engine.readPageSnapshot(edited, { sourceId }))?.page.compiled_truth).toContain('Sandbox body.');
}, 120_000);
