import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importManagedFile } from '../src/core/persistence/import-mutations.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { resumeCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { admitCompanyBrain } from '../src/core/company-brain/admission.ts';
import { performSync } from '../src/commands/sync.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

// #5470: unchanged items take no admission in the managed import, working-tree
// sync and company-profile paths (the connector path is covered in
// connector-checkpoint-identity.test.ts). Each path screens through its own
// publication preparer; changed items and pending projection work still admit.

const home = mkdtempSync(join(tmpdir(), 'gbrain-noop-kernel-'));
const engines: BrainEngine[] = [];
// Company admission needs an empty brain, so that case gets its own stores.
const companyStores: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  const company = new PGLiteEngine(); await company.connect({}); await company.initSchema(); companyStores.push({ engine: company, close: () => company.disconnect() });
  if (process.env.DATABASE_URL) companyStores.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    for (const store of companyStores) { await disposePersistenceConsumer(store.engine); await store.close(); }
  });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => { for (const engine of engines) await fn(engine); });
const admissions = async (engine: BrainEngine, sourceId: string, slug: string) =>
  (await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, slug])).length;
async function unmanaged<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

async function importFixture(engine: BrainEngine) {
  const sourceId = `import-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId), input = join(home, `${sourceId}-input`);
  mkdirSync(root); mkdirSync(input);
  await unmanaged(engine, async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await registerLocalWriter(engine, 'cli');
    await claimWorktree(engine, sourceId, root);
  });
  return { sourceId, root, input };
}

test('#5470 managed import: an identical re-import takes no admission; a change, a safe-chunk reseal and projection lag still admit', async () => each(async engine => {
  const f = await importFixture(engine);
  const file = join(f.input, 'note.md');
  const run = () => importManagedFile(engine, file, 'note.md', { sourceId: f.sourceId, noEmbed: true });
  writeFileSync(file, '---\ntitle: Note\n---\nThe first durable observation.\n');
  expect((await run()).status).toBe('imported');
  expect(await run()).toMatchObject({ status: 'skipped' });
  expect(await admissions(engine, f.sourceId, 'note')).toBe(1);
  writeFileSync(file, '---\ntitle: Note\n---\nA changed durable observation.\n');
  expect((await run()).status).toBe('imported');
  expect(await admissions(engine, f.sourceId, 'note')).toBe(2);
  // Below the safe-chunk fence: admitted, so publication re-seals instead of the skip hiding it.
  await engine.executeRaw("UPDATE pages SET chunker_version=1 WHERE source_id=$1 AND slug='note'", [f.sourceId]);
  await run();
  expect(await admissions(engine, f.sourceId, 'note')).toBe(3);
  await engine.executeRaw('UPDATE pages SET text_projection_revision=gen_random_uuid() WHERE source_id=$1 AND slug=$2', [f.sourceId, 'note']);
  await run();
  expect(await admissions(engine, f.sourceId, 'note')).toBe(4);
}), 180_000);

async function syncFixture(engine: BrainEngine) {
  const id = `wt-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'a.md'), '---\ntitle: a\n---\nA committed observation.\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await unmanaged(engine, async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
    await claimWorktree(engine, id, root);
  });
  return { id, root };
}

test('#5470 working-tree sync: a dirty file re-queued on the next run takes no second admission', async () => each(async engine => {
  const f = await syncFixture(engine);
  const opts = { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, workingTree: true, explicitProcessing: [] };
  expect((await performManagedSync(engine, opts)).status).not.toBe('partial');
  writeFileSync(join(f.root, 'a.md'), '---\ntitle: a\n---\nAn uncommitted working-tree edit.\n');
  expect((await performManagedSync(engine, opts)).status).not.toBe('partial');
  expect((await engine.getPage('a', { sourceId: f.id }))?.compiled_truth).toContain('uncommitted working-tree edit');
  const once = await admissions(engine, f.id, 'a');
  await disposePersistenceConsumer(engine);
  expect((await performManagedSync(engine, opts)).status).not.toBe('partial');
  expect(await admissions(engine, f.id, 'a')).toBe(once);
}), 180_000);

test('#5470 company profile: rediscovering an interrupted approved revision re-imports no committed entry', async () => withEnv(env, async () => {
  {
    for (const { engine } of companyStores) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const root = mkdtempSync(join(home, 'company-')), repo = await makeGitFixture(root);
      for (const [path, content] of Object.entries({
        'people/operator.md': '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the account.\n',
        'customers/account.md': '---\ntype: customer\ntitle: Example Account\nowner: "[[people/operator]]"\naudience: internal\n---\n# Example Account\nA synthetic account.\n',
      })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
      repo.commitAll('Add approved synthetic source');
      const sourceId = `company-${randomUUID().slice(0, 12)}`;
      const input = { brainId: 'company-example', sourceId, path: root, remote: false, requestId: randomUUID(),
        plan: await inspectCompanyBrain({ path: root, profile: 'company-brain' }) };
      await admitCompanyBrain(engine, input);
      // Interrupt the content phase once the first entry's page has committed.
      const abort = new AbortController(), transaction = engine.transaction;
      engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
        const value = await transaction.call(this, run) as T & { index?: number; sourceId?: string; runId?: string };
        if (value && typeof value === 'object' && value.runId && value.sourceId === sourceId && Number(value.index) >= 1) abort.abort();
        return value;
      };
      try { expect(await resumeCompanyBrain(engine, input, { signal: abort.signal })).toMatchObject({ ok: false }); }
      finally { engine.transaction = transaction; }
      const pages = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [sourceId]))[0].n;
      const before = await pages();
      expect(before).toBe(1);
      // A lost cursor makes the resume rediscover every included entry of the approved revision.
      await disposePersistenceConsumer(engine);
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [sourceId]);
      expect((await performSync(engine, { sourceId })).status).toBe('synced');
      expect(await pages()).toBe(before + 1);
      expect((await engine.getPage('customers/account', { sourceId }))?.compiled_truth).toContain('synthetic account');
      expect((await engine.getPage('people/operator', { sourceId }))?.compiled_truth).toContain('Owns the account');
    }
  }
}), 180_000);
