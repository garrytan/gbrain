import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { setupSharedBrainContent, contentSetupKey } from '../src/core/shared-skills/setup.ts';
import { packagedSharedSkills } from '../src/core/shared-skills/setup-bundle.ts';
import { inventorySkillpack, setupHash } from '../src/core/shared-skills/setup-files.ts';
import { legacyPublication, migrationCheckpointKey, runSharedSkillsMigration } from '../src/core/shared-skills/migration.ts';
import { withEnv } from './helpers/with-env.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'gbrain-shared-setup-')); directories.push(root); return root; }
function fixture(root: string | null = null) {
  const config = new Map<string, string>();
  const brainId = randomUUID(), incarnation = randomUUID();
  const source = { id: 'default', incarnation, local_path: root };
  let hasPages = false;
  const calls: string[] = [];
  const engine = {
    getConfig: async (key: string) => config.get(key) ?? null,
    setConfig: async (key: string, value: string) => { config.set(key, value); },
    executeRaw: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM persistence_brain')) return [{ brain_id: brainId, enabled: false, skill_bundles_enabled: false }];
      if (sql.includes('FROM sources')) return [source];
      if (sql.includes('EXISTS(SELECT 1 FROM pages')) return [{ present: hasPages }];
      if (sql.includes('FROM shared_skill_packs')) return [];
      if (sql.includes('FROM source_ingestion_receipts')) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as BrainEngine;
  const ctx: OperationContext = { engine, sourceId: 'default', config: { engine: 'pglite' }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  return { ctx, config, source, brainId, incarnation, calls, pages: () => { hasPages = true; } };
}
function writePack(root: string) {
  for (const [path, body] of Object.entries(packagedSharedSkills())) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
}

describe('combined content root setup', () => {
  test('dry-run uses the persistent brain ID and makes no directory or checkpoint', async () => {
    const home = temp(), f = fixture();
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined }, async () => {
      const result = await setupSharedBrainContent(f.ctx, { fresh: true, dryRun: true });
      expect(result.root).toBe(join(home, '.gbrain', 'content', f.brainId, 'default'));
      expect(result.status).toBe('planned');
      expect(result.repository_kind).toBe('content_directory');
      expect(existsSync(result.root!)).toBe(false);
      expect(f.config.size).toBe(0);
    });
  });
  test('preserves selected existing root and refuses a competing root', async () => {
    const root = temp(), f = fixture(root);
    writeFileSync(join(root, 'notes.md'), 'keep me');
    const result = await setupSharedBrainContent(f.ctx, { fresh: true });
    expect(result.root).toBe(root);
    expect(result.owned_root).toBe(false);
    expect(result.status).toBe('action_required');
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('keep me');
    await expect(setupSharedBrainContent(f.ctx, { root: join(root, 'other') })).rejects.toMatchObject({ code: 'local_conflict' });
  });
  test('keeps DB-only explicit, including an existing database without a root', async () => {
    const f = fixture();
    const explicit = await setupSharedBrainContent(f.ctx, { dbOnly: true, fresh: true });
    expect(explicit.repository_kind).toBe('db_only');
    expect(explicit.status).toBe('action_required');
    expect(explicit.root).toBeNull();
    f.pages();
    const result = await setupSharedBrainContent(f.ctx, { fresh: true, root: join(temp(), 'export') });
    expect(result.repository_kind).toBe('db_only');
    expect(result.pending_actions.join()).toContain('round trip');
    expect(result.stage).not.toBe('complete');
  });
  test('thin clients never query a local database or create a host repository', async () => {
    const f = fixture();
    f.ctx.config = { remote_mcp: { mcp_url: 'https://brain.example/mcp' } } as OperationContext['config'];
    const result = await setupSharedBrainContent(f.ctx, { fresh: true });
    expect(result.repository_kind).toBe('remote');
    expect(f.calls).toEqual([]);
    expect(f.config.size).toBe(0);
  });
  test('refuses a nonempty unowned root, missing existing root and symlink', async () => {
    const root = temp(), f = fixture();
    writeFileSync(join(root, 'private.md'), 'private');
    await expect(setupSharedBrainContent(f.ctx, { root, fresh: true })).rejects.toMatchObject({ code: 'local_conflict' });
    expect(f.config.size).toBe(0);
    const missing = fixture(join(root, 'missing'));
    await expect(setupSharedBrainContent(missing.ctx)).rejects.toMatchObject({ code: 'local_conflict' });
    symlinkSync(root, join(root, 'alias'));
    await expect(setupSharedBrainContent(f.ctx, { root: join(root, 'alias'), fresh: true })).rejects.toMatchObject({ code: 'local_conflict' });
  });
  test('preserves the isolated installation memory path', async () => {
    const installation = temp(), f = fixture(join(installation, 'memory'));
    mkdirSync(f.source.local_path!);
    const result = await setupSharedBrainContent(f.ctx, { root: f.source.local_path!, dryRun: true });
    expect(result.root).toBe(join(installation, 'memory'));
  });
  test('malformed checkpoint cannot become owned authority', async () => {
    const f = fixture();
    f.config.set(contentSetupKey('default', f.incarnation), '{broken');
    await expect(setupSharedBrainContent(f.ctx, { root: temp(), fresh: true })).rejects.toMatchObject({ code: 'local_conflict' });
  });
});

describe('staged skill migration', () => {
  test('maps true to prose-only, preserves false and leaves unset consent-required', async () => {
    const f = fixture();
    expect(await legacyPublication(f.ctx)).toBe('consent_required');
    f.ctx.config.mcp = { publish_skills: true };
    expect(await legacyPublication(f.ctx)).toBe('prose_only');
    f.config.set('mcp.publish_skills', 'false');
    expect(await legacyPublication(f.ctx)).toBe('disabled');
    f.config.set('mcp.publish_skills', 'true');
    expect(await legacyPublication(f.ctx)).toBe('prose_only');
  });
  test('dry-run inventories exact source files without writes or permission changes', async () => {
    const root = temp(), f = fixture(root); writePack(root);
    f.ctx.config.mcp = { publish_skills: false };
    const result = await runSharedSkillsMigration(f.ctx, { dryRun: true });
    expect(result.sources[0].inventory?.names).toEqual(['brain-router', 'memory-recall', 'memory-care']);
    expect(result.sources[0].publication).toBe('disabled');
    expect(result.permission_changes).toEqual([]);
    expect(f.config.size).toBe(0);
    expect(result.sources[0].stages.at(-1)?.reason).toContain('writer_not_quiesced');
  });
  test('retries interrupted inventory without modifying bytes, then detects edits', async () => {
    const root = temp(), f = fixture(root); writePack(root);
    const before = inventorySkillpack(root)!;
    const first = await runSharedSkillsMigration(f.ctx);
    expect(first.status).toBe('action_required');
    expect(f.config.has(migrationCheckpointKey('default', f.incarnation))).toBe(true);
    const again = await runSharedSkillsMigration(f.ctx);
    expect(again.sources[0].inventory).toEqual(before);
    writeFileSync(join(root, 'skills/memory-care/SKILL.md'), 'private: true\nLocal instructions');
    const edited = await runSharedSkillsMigration(f.ctx);
    expect(edited.status).toBe('conflict');
    expect(readFileSync(join(root, 'skills/memory-care/SKILL.md'), 'utf8')).toBe('private: true\nLocal instructions');
    expect((await runSharedSkillsMigration(f.ctx)).status).toBe('conflict');
  });
  test('preserves exclusions and private content without adopting new publication authority', async () => {
    const root = temp(), f = fixture(root); writePack(root);
    const manifest = JSON.parse(readFileSync(join(root, 'skillpack.json'), 'utf8'));
    manifest.excluded_from_install = ['memory-care'];
    writeFileSync(join(root, 'skillpack.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'skills/memory-care/SKILL.md'), '---\nprivate: true\n---\nPrivate local edits');
    f.ctx.config.mcp = { publish_skills: true };
    const result = await runSharedSkillsMigration(f.ctx);
    expect(result.sources[0].inventory?.excluded_from_install).toEqual(['memory-care']);
    expect(result.sources[0].publication).toBe('prose_only');
    expect(result.permission_changes).toEqual([]);
    expect(readFileSync(join(root, 'skills/memory-care/SKILL.md'), 'utf8')).toContain('private: true');
  });
  test('rejects malformed manifests and unsafe dependency closure', async () => {
    const root = temp(), f = fixture(root); writePack(root);
    symlinkSync(join(root, 'README.md'), join(root, 'skills/memory-care/secret.md'));
    expect((await runSharedSkillsMigration(f.ctx)).status).toBe('conflict');
    rmSync(join(root, 'skills/memory-care/secret.md'));
    writeFileSync(join(root, 'skillpack.json'), '[]');
    expect((await runSharedSkillsMigration(f.ctx)).status).toBe('conflict');
  });
  test('DB-only migration remains action-required and creates no replacement pages', async () => {
    const f = fixture(); f.pages();
    const result = await runSharedSkillsMigration(f.ctx);
    expect(result.status).toBe('action_required');
    expect(result.sources[0].stages[0].reason).toContain('db_only_export_required');
    expect(f.calls.some(sql => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
  });
  test('host-global assignment recognizes a registered complete manifest, but not undeclared skills', async () => {
    const root = temp(), f = fixture(root); writePack(root);
    f.ctx.config.mcp = { skills_dir: join(root, 'skills'), publish_skills: true };
    expect((await runSharedSkillsMigration(f.ctx, { dryRun: true })).pending_actions).toEqual([]);
    mkdirSync(join(root, 'skills/unreviewed'));
    writeFileSync(join(root, 'skills/unreviewed/SKILL.md'), 'Unreviewed local instructions');
    const report = await runSharedSkillsMigration(f.ctx, { dryRun: true });
    expect(report.pending_actions[0]).toContain('sources add shared-skills');
    expect(report.pending_actions[0]).toContain('--no-federated');
    expect(report.permission_changes).toEqual([]);
    expect(readFileSync(join(root, 'skills/unreviewed/SKILL.md'), 'utf8')).toBe('Unreviewed local instructions');
  });
});

describe('packaged default skills', () => {
  test('useful self-contained prose has release pinning, hashes and licensing', () => {
    const files = packagedSharedSkills(), manifest = JSON.parse(files['skillpack.json']);
    expect(manifest.brain_resident).toBe(true);
    expect(manifest.shared_deps).toEqual([]);
    expect(manifest.provenance.release).toBe(manifest.version);
    expect(files.LICENSE).toContain('MIT License');
    for (const path of manifest.skills) {
      expect(files[`${path}/SKILL.md`].length).toBeGreaterThan(1000);
      expect(files[`${path}/SKILL.md`]).not.toContain('(edit me)');
      expect(manifest.provenance.sha256[`${path}/SKILL.md`]).toBe(setupHash(files[`${path}/SKILL.md`]));
    }
  });
  test('compiled bundle works without the source checkout or ambient working directory', async () => {
    const root = temp(), entry = join(root, 'entry.ts'), binary = join(root, 'bundle');
    writeFileSync(entry, `import { packagedSharedSkills } from ${JSON.stringify(join(import.meta.dir, '../src/core/shared-skills/setup-bundle.ts'))}; console.log(JSON.stringify(packagedSharedSkills()));`);
    const child = Bun.spawn([process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--outfile', binary, entry], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr: code ? stderr : '', stdout: code ? stdout : '' }).toEqual({ code: 0, stderr: '', stdout: '' });
    rmSync(entry);
    const run = Bun.spawn([binary], { cwd: root, env: { GBRAIN_HOME: root, PATH: '' }, stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    expect(JSON.parse(output)).toEqual(packagedSharedSkills());
  }, 60_000);
});
