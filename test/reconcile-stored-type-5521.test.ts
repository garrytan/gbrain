/**
 * #5521 (preview half): a canonical file with frontmatter but no `type:` line keeps the stored type on import
 * (#1035), and with it the stored subtype. Reconcile read such a file with the type its path infers, so an
 * untouched file previewed a `/type` conflict, taking the file would have retyped the page, and an apply that
 * kept the file's bytes failed its readback.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { loadActivePackForEngine } from '../src/core/schema-pack/engine-resolution.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-stored-type-'));
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const packDir = join(home, '.gbrain', 'schema-packs', 'path-typed');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'pack.yaml'), `api_version: gbrain-schema-pack-v1
name: path-typed
version: 1.0.0
extends: gbrain-base-v2
page_types:
  - name: standup
    primitive: temporal
    path_prefixes: [standups/]
    aliases: []
    extractable: false
    expert_routing: false
    subtypes:
      - name: daily
        when:
          path_pattern: '^standups/'
`);
}, 60_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});


/** Imports `rel` from `content`, rewrites the file to `onDisk` and runs `check` as the source's canonical owner. */
async function imported<T>(rel: string, content: string, onDisk: string, pack: string | undefined,
  check: (page: { id: string; root: string; slug: string; stored: Page }) => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: pack, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    const id = `stored-type-${randomUUID().slice(0, 8)}`, root = join(home, id), slug = rel.replace(/\.md$/, '');
    mkdirSync(join(root, 'standups'), { recursive: true });
    writeFileSync(join(root, rel), content);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
    const activePack = pack ? (await loadActivePackForEngine(engine, { remote: false, sourceId: id })).manifest : undefined;
    expect((await importFromFile(engine, join(root, rel), rel, { sourceId: id, noEmbed: true, ...(activePack ? { activePack } : {}) })).status).toBe('imported');
    writeFileSync(join(root, rel), onDisk);
    const stored = (await engine.readPageSnapshot(slug, { sourceId: id }))!.page;
    await claimWorktree(engine, id, root);
    const registration = await registerLocalWriter(engine, 'cli');
    return withVerifiedLocalRegistration(engine, registration, () => check({ id, root, slug, stored }));
  });
}

const NOTE = '---\ntitle: Item\ntype: note\n---\nA synthetic note.\n';
const TYPELESS_NOTE = '---\ntitle: Item\n---\nA synthetic note.\n';

test('a file without a type line previews no type conflict against the stored type', () => imported('notes-item.md', NOTE, TYPELESS_NOTE, undefined,
  async ({ id, root, slug, stored }) => {
    expect(stored.type).toBe('note');
    expect((await runReconcilePreview(engine, { source_id: id, slug })).conflict_paths).toEqual([]);
    writeFileSync(join(root, 'notes-item.md'), TYPELESS_NOTE.replace('---\n', '---\ntype: concept\n'));
    expect((await runReconcilePreview(engine, { source_id: id, slug })).conflict_paths).toEqual(['/type']);
  }), 120_000);

test('a body edit to a file without a type line applies with its bytes kept, as repair --prefer file does', () => imported('notes-item.md', NOTE, TYPELESS_NOTE, undefined,
  async ({ id, root, slug }) => {
    const edited = TYPELESS_NOTE.replace('note.', 'note, edited.');
    writeFileSync(join(root, 'notes-item.md'), edited);
    const preview = await runReconcilePreview(engine, { source_id: id, slug });
    expect(preview.conflict_paths).toEqual(['/compiled_truth']);
    const resolved = await runReconcilePreview(engine, { source_id: id, slug, from: preview.preview, decisions: [{ path: '/compiled_truth', action: 'take_file' }] });
    const receipt = await runReconcileApply(engine, { source_id: id, slug, preview: resolved.preview, request_id: randomUUID(), keep_file_bytes: true });
    expect(receipt.state).toBe('committed');
    expect((await engine.readPageSnapshot(slug, { sourceId: id }))!.page).toMatchObject({ type: 'note', compiled_truth: 'A synthetic note, edited.' });
    expect(readFileSync(join(root, 'notes-item.md'), 'utf8')).toBe(edited);
  }), 120_000);

test('a pack-typed page whose file has no type line previews neither a type nor a subtype conflict', () => {
  const content = '---\ntitle: Monday\n---\nA synthetic standup.\n';
  return imported('standups/monday.md', content, content, 'path-typed', async ({ id, root, slug, stored }) => {
    expect(stored).toMatchObject({ type: 'standup', frontmatter: { subtype: 'daily' } });
    expect((await runReconcilePreview(engine, { source_id: id, slug })).conflict_paths).toEqual([]);
    expect((await runReconcilePreview(engine, { source_id: id, slug, auto_additive: true })).classification).toBe('no_drift');
    writeFileSync(join(root, 'standups/monday.md'), content.replace('---\n', '---\ntype: concept\n'));
    expect((await runReconcilePreview(engine, { source_id: id, slug })).conflict_paths).toContain('/type');
  });
}, 120_000);
