import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { SHARED_CONTENT_MIGRATION_VERSION } from '../src/commands/migrations/shared-content.ts';

async function cli(home: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID', 'GBRAIN_IN_AGENT_SETUP']) delete env[key];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, failure: code ? stdout + stderr : '' }).toEqual({ code: 0, failure: '' });
  return { stdout, stderr };
}

for (const publishing of [true, false]) {
  test(`released migration CLI exports real DB content and converges preserving publication=${publishing}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-migration-cli-')), root = join(home, 'canonical');
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const engine = new PGLiteEngine();
      const database = { engine: 'pglite' as const, database_path: join(home, '.gbrain', 'brain.pglite') };
      try {
        await cli(home, ['init', '--pglite', '--no-embedding', '--non-interactive', '--db-only']);
        await engine.connect(database);
        await engine.putPage('notes/fixture', { title: 'Fixture', type: 'note', compiled_truth: 'Saved before the migration.', timeline: '', frontmatter: { visibility: 'private' } }, { sourceId: 'default' });
        await engine.setConfig('mcp.publish_skills', String(publishing));
        await engine.disconnect();
        const args = ['apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--export-db-only', '--content-root', root, '--export-source', 'default'];
        const preview = await cli(home, [...args, '--dry-run', '--json']);
        const plan = JSON.parse(preview.stdout);
        expect(plan.previews).toHaveLength(1);
        expect(plan.previews[0].preview.content_export.pages).toBe(1);
        expect(plan.previews[0].preview.content_export.files['notes/fixture.md']).toMatch(/^[a-f0-9]{64}$/);
        expect(plan.previews[0].preview.content_export.pending_actions.join(' ')).toContain('--confirm-quiesced');
        expect(existsSync(root)).toBe(false);
        const applied = await cli(home, [...args, '--confirm-quiesced', '--acknowledge-no-backup', '--yes']);
        expect(applied.stdout).toContain('mechanical checks complete');
        expect(readFileSync(join(root, 'notes/fixture.md'), 'utf8')).toContain('Saved before the migration.');
        expect(existsSync(join(root, 'skills/memory-care/SKILL.md'))).toBe(true);
        await engine.connect(database);
        const [before] = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::integer AS count FROM persistence_requests WHERE target_kind='skill_bundle'");
        const source = (await engine.executeRaw<{ incarnation: string; local_path: string }>("SELECT incarnation,local_path FROM sources WHERE id='default'"))[0];
        const exported = JSON.parse((await engine.getConfig(`shared_skills.export.v1.default.${source.incarnation}`))!);
        expect(exported.status).toBe('complete');
        expect(exported.database_retained).toBe(true);
        expect(source.local_path).toBe(root);
        expect(await engine.getConfig('mcp.publish_skills')).toBe(String(publishing));
        expect(await engine.executeRaw('SELECT * FROM shared_skill_policies')).toHaveLength(0);
        await engine.disconnect();
        await cli(home, ['apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--yes']);
        await cli(home, [...args, '--confirm-quiesced', '--acknowledge-no-backup', '--yes']);
        await engine.connect(database);
        const [after] = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::integer AS count FROM persistence_requests WHERE target_kind='skill_bundle'");
        expect(after.count).toBe(before.count);
        expect(await engine.getConfig('mcp.publish_skills')).toBe(String(publishing));
        const report = JSON.parse((await engine.getConfig('shared_skills.migration.v1'))!);
        expect(report.sources[0].publication).toBe(publishing ? 'prose_only' : 'disabled');
        expect(report.sources[0].stages.find((stage: { stage: string }) => stage.stage === 'projection').status).toBe('complete');
        expect(report.permission_changes).toEqual([]);
        expect((await engine.getPage('notes/fixture', { sourceId: 'default' }))?.compiled_truth).toBe('Saved before the migration.');
      } finally { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }
    });
  }, 180_000);
}
