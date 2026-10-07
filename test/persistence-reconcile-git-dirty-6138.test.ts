/**
 * #6138: a managed canonical file whose content agrees with the database but whose bytes differ from its last
 * commit (only YAML quoting changed) was previewed as `no_drift` with "Retry the original write with a new
 * request ID", which tells the agent nothing about the modified file Git shows. The preview now reports
 * `git_dirty` and a truthful next step; the managed commit path itself is deferred (D5).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-git-dirty-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes'); };

test('a git-dirty file that agrees with the database reports git_dirty and a truthful next step', () => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const id = `dirty-${randomUUID().slice(0, 12)}`, root = join(home, id), slug = 'people/alice-example', file = join(root, `${slug}.md`);
    mkdirSync(join(root, 'people'), { recursive: true });
    git(root, 'init', '-q');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
    await importFromContent(engine, slug, '---\ntype: person\ntitle: Alice Example\n---\nWorks at [[companies/acme-example]].\n', { sourceId: id, sourcePath: `${slug}.md`, noEmbed: true });
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
    writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
    commit(root);
    // Same content, different bytes: only the YAML quoting of the title changes.
    const committed = readFileSync(file, 'utf8');
    expect(committed).toContain('title: Alice Example');
    writeFileSync(file, committed.replace('title: Alice Example', "title: 'Alice Example'"));
    expect(git(root, 'status', '--porcelain')).toContain(`${slug}.md`);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const registration = await registerLocalWriter(engine, 'cli');
    await withVerifiedLocalRegistration(engine, registration, async () => {
      const dirty = await runReconcilePreview(engine, { source_id: id, slug, auto_additive: true });
      expect(dirty).toMatchObject({ classification: 'no_drift', git_dirty: true });
      expect(String(dirty.next_action)).toContain(`git -C ${root} diff -- ${slug}.md`);
      expect(String(dirty.next_action)).not.toStartWith('No drift: the file and database agree. Retry');
      git(root, 'checkout', '--', `${slug}.md`);
      const clean = await runReconcilePreview(engine, { source_id: id, slug, auto_additive: true });
      expect(clean).toMatchObject({ classification: 'no_drift', git_dirty: false });
      expect(String(clean.next_action)).toContain('Git shows the file unchanged');
    });
  }
}), 120_000);
