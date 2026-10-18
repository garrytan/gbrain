/**
 * #6605 (revision 2): reconcile read a canonical file's raw bytes, so a frontmatter-less file under a
 * directory-inference rule showed every key the importer inferred from its path as a difference from the
 * stored row. The file side is now read the way the importer read it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-inferred-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

const REL = 'Apple Notes/Ideas/2021-06-20 Packing list.md';

test('an untouched inferred-path file reconciles as unchanged; a body edit shows only the body', async () => {
  await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    const id = `inferred-${randomUUID().slice(0, 8)}`, root = join(home, id);
    mkdirSync(join(root, 'Apple Notes/Ideas'), { recursive: true });
    writeFileSync(join(root, REL), 'Passport, charger, notebook.\n');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{"slug_root_mode":"source-root"}\')', [id, root]);
    const imported = await importFromFile(engine, join(root, REL), REL, { sourceId: id, noEmbed: true });
    expect(imported.status).toBe('imported');
    const slug = slugifyPath(REL);
    const stored = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
    expect(Object.keys(stored.page.frontmatter ?? {}).sort()).toEqual(['date', 'source']);
    await claimWorktree(engine, id, root);
    const registration = await registerLocalWriter(engine, 'cli');
    await withVerifiedLocalRegistration(engine, registration, async () => {
      const untouched = await runReconcilePreview(engine, { source_id: id, slug });
      expect(untouched.conflict_paths ?? []).toEqual([]);
      expect(untouched.status).toBe('ready');
      writeFileSync(join(root, REL), 'Passport, charger, notebook, adapter.\n');
      const edited = await runReconcilePreview(engine, { source_id: id, slug });
      expect(edited.conflict_paths).toEqual(['/compiled_truth']);
      const resolved = await runReconcilePreview(engine, { source_id: id, slug, from: edited.preview, decisions: [{ path: '/compiled_truth', action: 'take_file' }] });
      expect(resolved.status).toBe('ready');
      const receipt = await runReconcileApply(engine, { source_id: id, slug, preview: resolved.preview, request_id: randomUUID() });
      expect(receipt.state).toBe('committed');
      const after = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
      expect(after.page.compiled_truth).toContain('adapter');
      expect(Object.keys(after.page.frontmatter ?? {}).sort()).toEqual(['date', 'source']);
    });
  });
}, 120_000);
