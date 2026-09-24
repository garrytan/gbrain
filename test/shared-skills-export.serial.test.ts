import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { exportDatabaseContent } from '../src/core/shared-skills/migration-export.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { withEnv } from './helpers/with-env.ts';
import { runSharedSkillsMigration } from '../src/core/shared-skills/migration.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';

async function fixture(run: (ctx: OperationContext, home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-content-export-'));
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({}); await engine.initSchema();
      await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'A saved observation.', timeline: '', frontmatter: { visibility: 'private', custom: { retained: true } } }, { sourceId: 'default' });
      await engine.addTag('notes/example', 'fixture', { sourceId: 'default' });
      await run({ engine, config: { engine: 'pglite', mcp: { publish_skills: false } }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } }, home);
    } finally { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }
  });
}

test('DB export dry-run validates real pages and requires explicit quiescence/backup choices', () => fixture(async (ctx, home) => {
  const root = join(home, 'content');
  const result = await exportDatabaseContent(ctx, { sourceId: 'default', root, dryRun: true });
  expect(result.status).toBe('planned');
  expect(result.pages).toBe(1);
  expect(Object.keys(result.files)).toEqual(['notes/example.md']);
  expect(result.conflicts).toEqual([]);
  expect(result.pending_actions.join(' ')).toContain('--confirm-quiesced');
  expect(result.pending_actions.join(' ')).toContain('--backup-confirmed');
  expect(existsSync(root)).toBe(false);
  expect(await ctx.engine.getConfig('shared_skills.export.v1.default')).toBeNull();
}), 120_000);

test('DB export round-trips private knowledge, retains database state, and publishes a useful pack without broadening consent', () => fixture(async (ctx, home) => {
  const root = join(home, 'content');
  const before = await ctx.engine.getPage('notes/example', { sourceId: 'default' });
  const options = { sourceId: 'default', root, confirmQuiesced: true, backup: 'acknowledged_unprotected' as const };
  const result = await exportDatabaseContent(ctx, options);
  expect(result.status).toBe('complete');
  expect(result.database_retained).toBe(true);
  expect(result.backup).toBe('acknowledged_unprotected');
  const parsed = parseMarkdown(readFileSync(join(root, 'notes/example.md'), 'utf8'), 'notes/example.md', { validate: true });
  expect(parsed.errors).toEqual([]);
  expect(parsed.compiled_truth).toBe(before!.compiled_truth);
  expect(parsed.frontmatter.visibility).toBe('private');
  expect(parsed.frontmatter.custom).toEqual({ retained: true });
  expect(parsed.tags).toEqual(['fixture']);
  expect((await ctx.engine.getPage('notes/example', { sourceId: 'default' }))!.id).toBe(before!.id);
  expect(existsSync(join(root, 'skills/memory-recall/SKILL.md'))).toBe(true);
  expect(await ctx.engine.getConfig('mcp.publish_skills')).toBeNull();
  expect(ctx.config.mcp?.publish_skills).toBe(false);
  expect((await exportDatabaseContent(ctx, options)).status).toBe('complete');
  expect((await runSharedSkillsMigration(ctx)).status).toBe('action_required');
  expect((await runSharedSkillsMigration(ctx)).sources[0].stages.some(stage => stage.reason?.includes('idempotency_conflict'))).toBe(false);
}), 120_000);

test('DB export names unsupported canonical file formats instead of binding an incomplete root', () => fixture(async (ctx, home) => {
  await ctx.engine.executeRaw("UPDATE pages SET source_path='assets/example.png' WHERE source_id='default' AND slug='notes/example'");
  const result = await exportDatabaseContent(ctx, { sourceId: 'default', root: join(home, 'content'), confirmQuiesced: true, backup: 'operator_verified' });
  expect(result.status).toBe('conflict');
  expect(result.conflicts[0].slug).toBe('notes/example');
  expect(result.conflicts[0].reason).toContain('non-Markdown');
  expect(existsSync(result.root)).toBe(false);
  expect((await ctx.engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0].local_path).toBeNull();
}), 120_000);

test('interrupted export resumes only matching hashes and refuses human edits', () => fixture(async (ctx, home) => {
  const root = join(home, 'content'), options = { sourceId: 'default', root, confirmQuiesced: true, backup: 'operator_verified' as const };
  const setConfig = ctx.engine.setConfig.bind(ctx.engine);
  let interrupted = false;
  ctx.engine.setConfig = async (key, value) => {
    if (!interrupted && key.startsWith('shared_skills.export.') && JSON.parse(value).stage === 'exported') {
      interrupted = true; throw new Error('injected checkpoint interruption');
    }
    return setConfig(key, value);
  };
  await expect(exportDatabaseContent(ctx, options)).rejects.toThrow('injected checkpoint interruption');
  ctx.engine.setConfig = setConfig;
  expect(existsSync(join(root, 'notes/example.md'))).toBe(true);
  writeFileSync(join(root, 'notes/example.md'), 'Human edit after interruption');
  await expect(exportDatabaseContent(ctx, options)).rejects.toMatchObject({ code: 'local_conflict' });
  expect(readFileSync(join(root, 'notes/example.md'), 'utf8')).toBe('Human edit after interruption');
  expect((await ctx.engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0].local_path).toBeNull();
}), 120_000);

test('existing owned root gains packaged skills while preserving knowledge and opt-out', () => fixture(async (ctx, home) => {
  const root = join(home, 'existing'); mkdirSync(root);
  writeFileSync(join(root, 'README.md'), 'Local knowledge filing rules');
  await ctx.engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  await claimWorktree(ctx.engine, 'default', root);
  await activateSharedSkillPersistence(ctx.engine, { confirmQuiesced: true });
  const result = await runSharedSkillsMigration(ctx);
  expect(result.sources[0].stages.find(stage => stage.stage === 'projection')?.status).toBe('complete');
  expect(result.sources[0].publication).toBe('disabled');
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('Local knowledge filing rules');
  expect(existsSync(join(root, 'skills/brain-router/SKILL.md'))).toBe(true);
  expect((await runSharedSkillsMigration(ctx)).sources[0].stages.find(stage => stage.stage === 'projection')?.status).toBe('complete');
  expect((await ctx.engine.getPage('notes/example', { sourceId: 'default' }))!.compiled_truth).toBe('A saved observation.');
}), 120_000);

test('DB export uses the selected source schema and retains its custom types', () => fixture(async (ctx, home) => {
  await ctx.engine.setConfig('schema_pack', 'gbrain-base-v2');
  await ctx.engine.setConfig('schema_pack.source.default', 'company-brain');
  for (const [slug, type] of [['products/widget-example', 'product'], ['customers/account-example', 'customer']]) {
    await ctx.engine.putPage(slug, { type, title: 'Schema fixture', compiled_truth: 'Source-specific schema content.', timeline: '', frontmatter: { audience: 'internal' } }, { sourceId: 'default' });
  }
  const result = await exportDatabaseContent(ctx, { sourceId: 'default', root: join(home, 'content'), confirmQuiesced: true, backup: 'operator_verified' });
  expect(result.status).toBe('complete');
  expect(result.schema_policy?.schema.name).toBe('company-brain');
  expect(result.schema_policy?.schema.resolvedManifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.schema_policy?.source_config_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(parseMarkdown(readFileSync(join(result.root, 'products/widget-example.md'), 'utf8')).type).toBe('product');
  expect(parseMarkdown(readFileSync(join(result.root, 'customers/account-example.md'), 'utf8')).type).toBe('customer');
  expect(await ctx.engine.getConfig('schema_pack')).toBe('gbrain-base-v2');
  expect(await ctx.engine.getConfig('schema_pack.source.default')).toBe('company-brain');
}), 120_000);

test('a source schema change during export refuses binding and remains a checkpoint conflict', () => fixture(async (ctx, home) => {
  await ctx.engine.setConfig('schema_pack.source.default', 'company-brain');
  const original = ctx.engine.setConfig.bind(ctx.engine);
  let changed = false;
  ctx.engine.setConfig = async (key, value) => {
    await original(key, value);
    if (!changed && key.startsWith('shared_skills.export.')) {
      changed = true;
      await original('schema_pack.source.default', 'gbrain-base-v2');
    }
  };
  const options = { sourceId: 'default', root: join(home, 'content'), confirmQuiesced: true, backup: 'operator_verified' as const };
  await expect(exportDatabaseContent(ctx, options)).rejects.toMatchObject({ code: 'local_conflict' });
  ctx.engine.setConfig = original;
  expect(existsSync(options.root)).toBe(false);
  expect((await ctx.engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0].local_path).toBeNull();
  const resumed = await exportDatabaseContent(ctx, options);
  expect(resumed.status).toBe('conflict');
  expect(resumed.conflicts[0].reason).toContain('source schema or ingestion policy changed');
}), 120_000);
