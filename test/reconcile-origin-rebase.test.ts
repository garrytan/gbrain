import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-origin-rebase-'));
let engine: BrainEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  if (engine) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  rmSync(home, { recursive: true, force: true });
});

async function fixture() {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `origin-rebase-${randomUUID().slice(0, 12)}`;
  const gitRoot = join(home, id);
  const root = join(gitRoot, 'vault');
  mkdirSync(join(gitRoot, '.git'), { recursive: true });
  mkdirSync(join(root, 'notes'), { recursive: true });
  const slug = 'notes/example';
  const oldPath = 'vault/notes/example.md';
  const newPath = 'notes/example.md';
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb)',
    [id, root, JSON.stringify({ slug_root_mode: 'source-root' })]);
  const content = '---\ntype: note\ntitle: Example\n---\nAn exact canonical page for a guarded path rebase.\n';
  await importFromContent(engine, slug, content, { sourceId: id, sourcePath: oldPath, noEmbed: true });
  const before = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
  const file = join(root, newPath);
  writeFileSync(file, serializePageToMarkdown(before.page, before.tags));
  const binding = await claimWorktree(engine, id, root);
  const registration = await registerLocalWriter(engine, 'cli');
  return { id, root, slug, oldPath, newPath, file, before, binding, registration };
}

test('explicit reconcile rebase moves one exact Git-root origin to the pinned source-root path', async () => withEnv({
  GBRAIN_HOME: home, DATABASE_URL: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
}, async () => {
  const f = await fixture();
  const originalBytes = readFileSync(f.file);
  await withVerifiedLocalRegistration(engine, f.registration as LocalRegistration, async () => {
    const preview = await runReconcilePreview(engine, { source_id: f.id, slug: f.slug, rebase_origin: true });
    expect(preview.status).toBe('ready');
    expect(preview.origin_rebase).toEqual({ from: f.oldPath, to: f.newPath });
    expect(preview.preview.preconditions.page_id).toBe(f.before.page.id);
    expect(preview.preview.preconditions.revision).toBe(f.before.revision);
    expect(typeof preview.preview.preconditions.raw_file_hash).toBe('string');
    expect(readFileSync(f.file)).toEqual(originalBytes);
    const artifact = JSON.parse(JSON.stringify(preview.preview));
    const receipt = await runReconcileApply(engine, { source_id: f.id, slug: f.slug, preview: artifact, request_id: randomUUID() });
    expect(receipt.state).toBe('committed');
    const after = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
    expect(after.page.id).toBe(f.before.page.id);
    expect(after.page.slug).toBe(f.slug);
    expect(after.page.source_path).toBe(f.newPath);
    expect(after.page.compiled_truth).toBe(f.before.page.compiled_truth);
    expect(readFileSync(f.file)).toEqual(originalBytes);
    expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL', [f.id, f.newPath]))
      .toEqual([{ id: f.before.page.id }]);
  });
}));
