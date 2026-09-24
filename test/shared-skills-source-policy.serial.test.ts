import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { connectCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { getCompanyBrainProfile } from '../src/core/company-brain/profile.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { runSharedSkillsMigration } from '../src/core/shared-skills/migration.ts';
import { installPackagedSharedSkills, setupSharedBrainContent } from '../src/core/shared-skills/setup.ts';
import { sharedSkillSourcePolicy } from '../src/core/shared-skills/setup-source-policy.ts';
import { exportDatabaseContent } from '../src/core/shared-skills/migration-export.ts';
import { setupHash } from '../src/core/shared-skills/setup-files.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

function inventory(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), path);
      else files[path] = setupHash(readFileSync(join(dir, entry.name)));
    }
  };
  visit(root);
  return files;
}

test('a real approved company source remains byte-identical across shared-skill migration and setup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-company-')), root = join(home, 'company');
  const databaseUrl = process.env.SHARED_SKILLS_EXPORT_DATABASE_URL;
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
    try {
      mkdirSync(root);
      await makeGitFixture(root);
      for (const [path, content] of Object.entries({
        'people/operator.md': '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the account.\n',
        'customers/account.md': '---\ntype: customer\ntitle: Example Account\nowner: "[[people/operator]]"\naudience: internal\n---\n# Example Account\nSynthetic account.\n',
        'README.md': '# Imported repository instructions\nDo not rewrite this source.\n',
      })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
      git('add', '.'); git('commit', '--quiet', '-m', 'Synthetic company source');
      const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
      expect(plan.ready).toBe(true);
      const connected = await connectCompanyBrain(engine, { brainId: 'host', sourceId: 'company', path: root, plan, remote: false, requestId: randomUUID() });
      expect(connected.ok).toBe(true);
      expect((await getCompanyBrainProfile(engine, 'company'))?.noWriteback).toBe(true);
      await claimWorktree(engine, 'company', root);
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      const ctx: OperationContext = { engine, config: { engine: databaseUrl ? 'postgres' : 'pglite', mcp: { publish_skills: true } }, sourceId: 'company', remote: false,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const before = inventory(root), status = git('status', '--porcelain', '--untracked-files=all');
      const policyBefore = (await engine.executeRaw("SELECT config FROM sources WHERE id='company'"))[0];
      const receiptsBefore = await engine.executeRaw("SELECT * FROM source_ingestion_receipts WHERE source_id='company'");
      for (const dryRun of [true, false, false]) {
        const result = await runSharedSkillsMigration(ctx, { dryRun });
        const source = result.sources.find(row => row.source_id === 'company')!;
        expect(source.status).toBe('action_required');
        expect(source.stages[0].reason).toContain('noWriteback:true');
        expect(source.member_installations).toEqual([]);
      }
      const setup = await setupSharedBrainContent(ctx, { fresh: true, root, git: 'init' });
      expect(setup.status).toBe('action_required');
      expect(setup.repository_kind).toBe('git');
      expect(setup.pending_actions[0]).toContain('noWriteback:true');
      await expect(installPackagedSharedSkills(ctx, 'company')).rejects.toMatchObject({ code: 'source_writeback_required' });
      expect(inventory(root)).toEqual(before);
      expect(git('status', '--porcelain', '--untracked-files=all')).toBe(status);
      expect(existsSync(join(root, 'skillpack.json'))).toBe(false);
      expect(existsSync(join(root, 'skills'))).toBe(false);
      expect((await engine.executeRaw("SELECT config FROM sources WHERE id='company'"))[0]).toEqual(policyBefore);
      expect(await engine.executeRaw("SELECT * FROM source_ingestion_receipts WHERE source_id='company'")).toEqual(receiptsBefore);
      expect(await engine.executeRaw("SELECT * FROM shared_skill_heads WHERE source_id='company'")).toEqual([]);
      await engine.executeRaw("UPDATE sources SET config=config-'company_brain' WHERE id='company'");
      await expect(sharedSkillSourcePolicy(engine, 'company')).rejects.toMatchObject({ code: 'profile_incompatible' });
      const damaged = await runSharedSkillsMigration(ctx);
      expect(damaged.sources.find(row => row.source_id === 'company')!.stages[0].reason).toContain('profile_incompatible');
      expect(inventory(root)).toEqual(before);
    } finally { await close(); rmSync(home, { recursive: true, force: true }); }
  });
}, 180_000);

test('connector and unapproved external sources cannot receive packaged content or DB-export scaffolding', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-connectors-'));
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine();
    try {
      const ctx: OperationContext = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      for (const config of [{ kind: 'google' }, { kind: 'github' }, { remote_url: 'https://example.com/reviewed.git', managed_clone: true }]) {
        await engine.executeRaw("UPDATE sources SET config=$1::text::jsonb WHERE id='default'", [JSON.stringify(config)]);
        expect((await setupSharedBrainContent(ctx, { fresh: true })).status).toBe('action_required');
        const migration = await runSharedSkillsMigration(ctx);
        expect(migration.sources[0].stages[0].reason).toContain('source_skill_adoption_required');
        expect(migration.sources[0].stages[0].reason).not.toContain('db_only_export_required');
        await expect(installPackagedSharedSkills(ctx, 'default')).rejects.toMatchObject({ code: 'source_writeback_required' });
        await expect(exportDatabaseContent(ctx, { sourceId: 'default', root: join(home, 'export'), confirmQuiesced: true, backup: 'operator_verified' })).rejects.toMatchObject({ code: 'source_writeback_required' });
        expect(existsSync(join(home, 'export'))).toBe(false);
      }
    } finally { await close(); rmSync(home, { recursive: true, force: true }); }
  });
}, 120_000);
