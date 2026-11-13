/**
 * #9286: new slug-based pages must reuse an unambiguous imported parent's
 * spelling rather than silently creating a parallel lowercase directory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const put = operations.find(operation => operation.name === 'put_page')!;
const note = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

for (const backend of testBackends()) describe(`[${backend}] #9286 new-page parent spelling`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-parent-case-${backend}-`));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };

  beforeAll(async () => {
    if (backend === 'pglite') {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    } else {
      const postgres = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = postgres.engine;
      closePostgres = postgres.close;
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (engine) {
        await withEnv(env, async () => {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        });
        await engine.disconnect();
      }
      await closePostgres?.();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  for (const parent of ['02_Projects', '03_Areas/Health', '04_Resources', '02_projects']) {
    test(`remote put_page reuses the imported parent ${parent}`, async () => {
      await withEnv(env, async () => {
        const sourceId = `case-${randomUUID()}`;
        const root = join(home, sourceId);
        const originalPath = `${parent}/Original.md`;
        const original = note('Original', 'Synthetic original content retained byte for byte.');
        const content = note('New page', 'Synthetic new sibling content.');
        mkdirSync(dirname(join(root, originalPath)), { recursive: true });
        git(root, 'init', '-q');
        writeFileSync(join(root, originalPath), original);
        git(root, 'add', '--', originalPath);
        git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'Synthetic imported note');
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        expect((await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
        const originalSlug = `${parent.toLowerCase()}/original`;
        const before = await engine.readPageSnapshot(originalSlug, { sourceId });
        expect(before!.page.source_path).toBe(originalPath);
        const ctx: OperationContext = { engine, sourceId, remote: true, dryRun: false,
          config: { engine: backend, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } };
        const slug = `${parent.toLowerCase()}/new-page`;
        const receipt = await put.handler(ctx, { slug, content, request_id: randomUUID() }) as { state: string };
        expect(receipt.state).toBe('committed');
        const created = await engine.readPageSnapshot(slug, { sourceId });
        expect(created!.page.compiled_truth).toContain('Synthetic new sibling content.');
        const after = await engine.readPageSnapshot(originalSlug, { sourceId });
        expect(after!.page.id).toBe(before!.page.id);
        expect(after!.revision).toBe(before!.revision);
        expect(after!.page.source_path).toBe(originalPath);
        expect(readFileSync(join(root, originalPath), 'utf8')).toBe(original);
        expect(created!.page.source_path).toBe(`${parent}/new-page.md`);
        expect(existsSync(join(root, parent, 'new-page.md'))).toBe(true);
        expect(readdirSync(root).filter(name => name.toLowerCase() === parent.split('/')[0]!.toLowerCase()))
          .toEqual([parent.split('/')[0]!]);
      });
    }, 120_000);
  }
});
