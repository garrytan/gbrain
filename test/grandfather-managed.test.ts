import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { phaseCGrandfather } from '../src/commands/migrations/v0_13_1.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { grandfatherCanonicalPage } from '../src/core/persistence/grandfather.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { localHostId } from '../src/core/persistence/identity.ts';

async function fixture(run: (f: { engine: BrainEngine; ctx: OperationContext; home: string; root: string; slug: string }) => Promise<void>, databaseUrl?: string) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-grandfather-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'content'); mkdirSync(root);
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default',
          remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        const slug = 'notes/example';
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: '---\ntype: note\ntitle: Example\n---\n\nAmberbadger searchable fixture.\n' } });
        await disposePersistenceConsumer(engine);
        await run({ engine, ctx, home, root, slug });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function preservesManagedPage(databaseUrl?: string) {
  await fixture(async ({ engine, home, root, slug }) => {
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const [column] = await engine.executeRaw<{ width: number }>("SELECT atttypmod::int AS width FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.executeRaw("UPDATE content_chunks SET embedding=('['||array_to_string(array_fill(0.1::real,ARRAY[$1::int]),',')||']')::vector WHERE page_id=$2", [column.width, before.page.id]);
      await tx.executeRaw('INSERT INTO extract_atoms_page_state(source_incarnation,page_id,content_hash,fail_count,tombstoned) VALUES($1::uuid,$2,$3,2,true)',
        [before.sourceIncarnation, before.page.id, before.page.content_hash]);
    }));
    const chunks = await engine.executeRaw('SELECT id,chunk_text,embedding::text FROM content_chunks WHERE page_id=$1 ORDER BY id', [before.page.id]);
    expect(chunks.length).toBeGreaterThan(0);
    const result = await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true });
    expect(result).toMatchObject({ result: { status: 'complete' }, detail: { touched: 1, failed: 0 } });
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(after.page.frontmatter.validate).toBe(false);
    expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
    expect(after.revision).not.toBe(before.revision);
    expect(after.page.text_projection_revision).toBe(after.revision);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('validate: false');
    expect(await engine.executeRaw('SELECT id,chunk_text,embedding::text FROM content_chunks WHERE page_id=$1 ORDER BY id', [before.page.id])).toEqual(chunks);
    expect(await engine.searchKeyword('Amberbadger', { sourceId: 'default' })).toHaveLength(1);
    expect(await engine.executeRaw('SELECT fail_count,tombstoned FROM extract_atoms_page_state WHERE source_incarnation=$1::uuid AND page_id=$2 AND content_hash=$3',
      [after.sourceIncarnation, after.page.id, after.page.content_hash])).toEqual([{ fail_count: 2, tombstoned: true }]);
    expect(await engine.executeRaw("SELECT e.kind FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.intent->>'kind'='managed_grandfather' AND e.kind IN ('embedding','facts-backstop')")).toEqual([]);
    const rollback = join(home, '.gbrain/migrations/v0_13_1-rollback.jsonl');
    const snapshot = JSON.parse(readFileSync(rollback, 'utf8').trim());
    expect(snapshot).toMatchObject({ id: before.page.id, source_id: 'default', source_incarnation: before.sourceIncarnation, knowledge_revision: before.revision });
    expect(snapshot.pre_frontmatter).not.toHaveProperty('validate');
    if (process.platform !== 'win32') expect(statSync(rollback).mode & 0o777).toBe(0o600);
    expect((await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true })).detail.touched).toBe(0);
  }, databaseUrl);
}

test('managed grandfathering publishes metadata without changing vectors or spending on derived effects', () => preservesManagedPage(), 120_000);
test.skipIf(!process.env.DATABASE_URL)('Postgres managed grandfathering preserves canonical bytes, projection and derived state',
  () => preservesManagedPage(process.env.DATABASE_URL), 120_000);

test('a concurrent explicit validation choice is not overwritten by grandfathering', () => fixture(async ({ engine, ctx, slug, root }) => {
  const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  await expect(grandfatherCanonicalPage(engine, { id: before.page.id, source_id: 'default', slug, source_incarnation: before.sourceIncarnation }, async () => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: before.revision,
      content: serializePageToMarkdown({ ...before.page, frontmatter: { ...before.page.frontmatter, validate: true } }, before.tags) } });
  })).rejects.toMatchObject({ code: 'revision_conflict' });
  expect((await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter.validate).toBe(true);
  expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('validate: true');
}), 120_000);

test('human file edits abort managed grandfathering without replacing either version', () => fixture(async ({ engine, slug, root }) => {
  const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const path = join(root, `${slug}.md`); const changed = readFileSync(path, 'utf8') + '\nUnpublished human edit.\n';
  await expect(grandfatherCanonicalPage(engine, { id: before.page.id, source_id: 'default', slug, source_incarnation: before.sourceIncarnation }, () => {
    writeFileSync(path, changed);
  })).rejects.toMatchObject({ code: 'source_changed' });
  expect(readFileSync(path, 'utf8')).toBe(changed);
  expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.revision).toBe(before.revision);
}), 120_000);

test('pending grandfathering reuses its admitted request and its original rollback snapshot', () => fixture(async ({ engine, slug }) => {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const selected = { id: snapshot.page.id, source_id: 'default', slug, source_incarnation: snapshot.sourceIncarnation };
  const host = localHostId(); let backups = 0;
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [randomUUID()]);
  });
  let requestId: string | undefined;
  try { await grandfatherCanonicalPage(engine, selected, () => { backups++; }); }
  catch (error: any) { expect(error.code).toBe('write_pending'); requestId = error.writeRequest.request_id; }
  expect(requestId).toBeDefined(); expect(backups).toBe(1);
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [host]);
  });
  expect(await grandfatherCanonicalPage(engine, selected, () => { backups++; })).toBe('touched');
  expect(backups).toBe(1);
  expect(await engine.executeRaw("SELECT request_id,state FROM persistence_requests WHERE intent->>'kind'='managed_grandfather'"))
    .toEqual([{ request_id: requestId, state: 'committed' }]);
}), 120_000);

test('archived sources and non-Markdown artifacts are not rewritten by managed grandfathering', () => fixture(async ({ engine, slug, root }) => {
  const path = join(root, `${slug}.md`), bytes = readFileSync(path, 'utf8');
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
  });
  expect((await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true })).detail).toMatchObject({ touched: 0, skipped: 1, failed: 0 });
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  mkdirSync(join(root, 'source'));
  writeFileSync(join(root, 'source/example.ts'), 'export const fixture = 1;\n');
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw("UPDATE sources SET archived=false WHERE id='default'");
    await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE pages SET source_path='source/example.ts' WHERE slug=$1", [slug]));
  });
  expect((await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true })).detail).toMatchObject({ touched: 0, skipped: 1, failed: 0 });
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(readFileSync(join(root, 'source/example.ts'), 'utf8')).toBe('export const fixture = 1;\n');
  expect((await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter).not.toHaveProperty('validate');
}), 120_000);
