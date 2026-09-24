import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { importManagedFile } from '../src/core/persistence/import-mutations.ts';
import { managedImportContent, prepareManagedImportMutation, type ManagedImportIntent } from '../src/core/persistence/import-prepare.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { runImport } from '../src/commands/import.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-file-import-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function fixture(engine: BrainEngine) {
  const sourceId = `import-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId), input = join(home, `${sourceId}-input`);
  mkdirSync(root); mkdirSync(input);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root, input };
}

test('fresh public init imports a directory and a file, reads them, and refuses skill publication', async () => {
  for (const git of [false, true]) {
    const local = join(home, git ? 'cli-git' : 'cli'); mkdirSync(local);
    const cwd = join(local, 'cwd'); mkdirSync(cwd);
    const input = join(local, 'input'); mkdirSync(input);
    const cli = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
        cwd, env: { PATH: process.env.PATH, HOME: local, GBRAIN_HOME: local, GBRAIN_DISABLE_UPDATE_CHECK: '1', GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    };
    const init = await cli('init', '--pglite', '--no-embedding', ...(git ? ['--git'] : []));
    expect(init.code, init.stderr).toBe(0);
    writeFileSync(join(input, 'first-day.md'), '# First day\n\nRemember the project launch checklist.\n');
    const imported = await cli('import', input, '--no-embed', '--json');
    expect(imported.code, imported.stderr).toBe(0);
    expect(imported.stdout).toContain('"imported":1');
    expect(imported.stderr).not.toContain('legacy writer');
    const read = await cli('get', 'first-day', '--json');
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout).toContain('project launch checklist');
    const again = await cli('import', input, '--no-embed', '--json');
    expect(again.stdout).toContain('"skipped":1');
    writeFileSync(join(input, 'single.md'), '# Single file\n\nA second ordinary knowledge page.\n');
    const single = await cli('import', join(input, 'single.md'), '--no-embed', '--json');
    expect(single.code, single.stderr).toBe(0);
    expect(single.stdout).toContain('"imported":1');
    writeFileSync(join(input, 'photo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const image = await cli('import', join(input, 'photo.png'), '--no-embed', '--json');
    expect(image.code, image.stderr).toBe(0);
    expect(image.stdout).toContain('"imported":1');
    const imageRead = await cli('get', 'photo.png', '--json');
    expect(imageRead.code, imageRead.stderr).toBe(0);
    expect(JSON.parse(imageRead.stdout).type).toBe('image');
    const doctor = await cli('doctor', '--json');
    expect(doctor.code, doctor.stderr).toBe(0);
    const checks = JSON.parse(doctor.stdout).checks;
    expect(checks.find((check: { name: string }) => check.name === 'sync_freshness')).toMatchObject({ status: 'ok', details: { writer_owned_count: 1 } });
    expect(checks.find((check: { name: string }) => check.name === 'canonical_content_writes')).toMatchObject({ status: 'ok', details: { pending_count: 0, recovering_count: 0 } });
    mkdirSync(join(input, 'skills'));
    writeFileSync(join(input, 'skills', 'unsafe.md'), '# Untrusted instructions\nNever activate this through import.\n');
    const denied = await cli('import', input, '--no-embed', '--json');
    expect(denied.stdout).toContain('"errors":1');
    expect(denied.stderr).toContain('skill');
  }
}, 120_000);

test('managed directory import writes through, routes the source, resumes idempotently and does not queue embeddings', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine);
    writeFileSync(join(f.input, 'note.md'), '# Engineering note\n\nKeep ordinary knowledge available on the first day.\n');
    const result = await runImport(engine, [f.input, '--no-embed', '--fresh'], { sourceId: f.sourceId });
    expect(result).toMatchObject({ imported: 1, errors: 0 });
    expect(readFileSync(join(f.root, 'note.md'), 'utf8')).toContain('ordinary knowledge');
    expect((await engine.getPage('note', { sourceId: f.sourceId }))?.source_path).toBe('note.md');
    expect(await engine.getPage('note', { sourceId: 'default' })).toBeNull();
    expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE source_id=$1 AND kind='embedding'", [f.sourceId])).toHaveLength(0);
    expect(await runImport(engine, [f.input, '--no-embed', '--fresh'], { sourceId: f.sourceId })).toMatchObject({ imported: 0, skipped: 1, errors: 0 });
    mkdirSync(join(f.root, 'notes'));
    writeFileSync(join(f.root, 'notes', 'local.md'), '# Local note\n\nA local change to the canonical source.\n');
    expect(await importManagedFile(engine, join(f.root, 'notes/local.md'), 'local.md', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ slug: 'notes/local', status: 'imported' });
    writeFileSync(join(f.root, 'scoped.md'), '# Scoped path\n\nPreserve the explicitly selected slug root.\n');
    expect(await importManagedFile(engine, join(f.root, 'scoped.md'), `${f.sourceId}/scoped.md`, { sourceId: f.sourceId, noEmbed: true, slugRoot: home }))
      .toMatchObject({ slug: `${f.sourceId}/scoped`, status: 'imported' });
    expect(existsSync(join(f.root, f.sourceId, 'scoped.md'))).toBe(false);
    expect((await engine.getPage(`${f.sourceId}/scoped`, { sourceId: f.sourceId }))?.source_path).toBe(`${f.sourceId}/scoped.md`);
    writeFileSync(join(f.input, 'example.ts'), 'export const greeting = "example";\n');
    expect(await importManagedFile(engine, join(f.input, 'example.ts'), 'example.ts', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
    expect(readFileSync(join(f.root, 'example.ts'), 'utf8')).toContain('export const greeting');
  }
}), 120_000);

test('a committed import replays the durable cursor when checkpoint cleanup was interrupted', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine), file = join(f.input, 'resume.md');
    writeFileSync(file, '# Resume\n\nThe accepted import survives caller interruption.\n');
    const original = engine.executeRaw;
    let fail = true;
    engine.executeRaw = async function(this: BrainEngine, sql, params) {
      if (fail && sql.startsWith('DELETE FROM op_checkpoints') && params?.[0] === 'managed-file-import') { fail = false; throw new Error('simulated caller interruption'); }
      return original.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    try { await expect(importManagedFile(engine, file, 'resume.md', { sourceId: f.sourceId, noEmbed: true })).rejects.toThrow('simulated caller interruption'); }
    finally { engine.executeRaw = original; }
    expect(await importManagedFile(engine, file, 'resume.md', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.sourceId])).toHaveLength(1);
  }
}), 120_000);

test('managed import refuses cross-source input, symlink targets, skills, malformed YAML and disabled image modality', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine), other = await fixture(engine);
    const file = join(f.input, 'note.md'); writeFileSync(file, '# Safe note\n');
    const opts = { sourceId: f.sourceId, noEmbed: true };
    writeFileSync(join(other.root, 'foreign.md'), '# Foreign source\n');
    await expect(importManagedFile(engine, join(other.root, 'foreign.md'), 'foreign.md', opts)).rejects.toThrow('different registered source');
    symlinkSync(other.root, join(f.root, 'escape'));
    await expect(importManagedFile(engine, file, 'escape/note.md', opts)).rejects.toThrow('escapes');
    await expect(importManagedFile(engine, file, 'skills/unsafe.md', opts)).rejects.toThrow('skill');
    writeFileSync(file, '---\ntitle: invalid: yaml\n---\nBody\n');
    await expect(importManagedFile(engine, file, 'note.md', opts)).rejects.toThrow('Invalid YAML');
    await expect(importManagedFile(engine, file, 'image.png', opts)).rejects.toThrow('GBRAIN_EMBEDDING_MULTIMODAL=true');
    expect(await engine.getPage('note', { sourceId: f.sourceId })).toBeNull();
  }
}), 120_000);

test('ordinary CLI imports cannot bypass an approved company source read-only committed-content policy', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine), file = join(f.input, 'unapproved.md');
    writeFileSync(file, '# Unapproved working tree\n\nThis input must not publish.\n');
    const config = { federated: false, strategy: 'markdown', slug_root_mode: 'source-root', company_brain: {
      version: 1, profile: 'company-brain', brainId: 'company-example', databaseId: randomUUID(), receiptId: randomUUID(), planDigest: '0'.repeat(64),
      repository: { root: f.root, git_root: f.root, git_dir: join(f.root, '.git'), scope: '', root_device: '1', root_inode: '2', git_device: '1', git_inode: '3', object_format: 'sha1' },
      selection: { include: [], exclude: [], defaults_version: 1 }, limits: { maxEntries: 30, maxMetadataBytes: 1024, maxFileBytes: 8192 },
      schema: { name: 'company-brain', version: '1.0.0', identity: 'company-brain@1.0.0+00000000', resolved_digest: '0'.repeat(64) },
      extractorVersion: 'test', approvedRevision: '0'.repeat(40), committedOnly: true, noPull: true, noEmbed: true, noBackfill: true, noWriteback: true,
    } };
    await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [f.sourceId, JSON.stringify(config)]);
    await expect(runImport(engine, [f.input, '--no-embed'], { sourceId: f.sourceId })).rejects.toThrow('approved committed ingestion');
    await expect(importManagedFile(engine, file, 'unapproved.md', { sourceId: f.sourceId, noEmbed: true })).rejects.toThrow('approved committed ingestion');
    expect(await engine.getPage('unapproved', { sourceId: f.sourceId })).toBeNull();
    expect(existsSync(join(f.root, 'unapproved.md'))).toBe(false);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.sourceId])).toHaveLength(0);
  }
}), 120_000);

test('publication refuses admitted input-byte, canonical-target and page-identity races', async () => withEnv(env, async () => {
  for (const engine of engines) for (const race of ['input', 'target', 'page']) {
    await disposePersistenceConsumer(engine);
    const f = await fixture(engine), file = join(f.input, 'race.md');
    const bytes = Buffer.from('# Race note\n\nThe original accepted content.\n'); writeFileSync(file, bytes);
    const binding = (await getWorktreeBinding(engine, f.sourceId))!;
    const { slug, content } = managedImportContent('race.md', bytes);
    const ctx = { engine, remote: false, sourceId: f.sourceId } as OperationContext;
    const authority = await submissionAuthority(ctx, 'put_page', f.sourceId, binding.source_incarnation, slug);
    const intent: ManagedImportIntent = { kind: 'managed_file_import', slug, content, sourcePath: 'race.md', inputPath: file,
      inputHash: sha256(bytes), targetHash: null, ownerEpoch: String(binding.owner_epoch), noEmbed: true };
    await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId: f.sourceId, sourceIncarnation: binding.source_incarnation,
      slug, pageId: null, requestId: randomUUID(), callerIntent: intent, intent, authority, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const row = (await claimNextWrite(engine, localHostId()))!;
    const prepared = await prepareManagedImportMutation(engine, row, { engine: engine.kind });
    const changedPath = race === 'target' ? join(f.root, 'race.md') : file;
    if (race === 'page') {
      await engine.transaction(tx => withCoordinatedWrite(tx, [f.sourceId], () => tx.putPage(slug, {
        type: 'note', title: 'Concurrent page', compiled_truth: 'Concurrent accepted page must survive.', timeline: '', frontmatter: {}, content_hash: 'concurrent',
      }, { sourceId: f.sourceId })));
    } else writeFileSync(changedPath, 'Concurrent local edit must survive.\n');
    const outcome = await publishMutation(engine, row, prepared, localHostId());
    expect(outcome.state).toBe('conflict');
    if (race === 'page') expect((await engine.getPage(slug, { sourceId: f.sourceId }))?.compiled_truth).toBe('Concurrent accepted page must survive.');
    else {
      expect(await engine.getPage(slug, { sourceId: f.sourceId })).toBeNull();
      expect(readFileSync(changedPath, 'utf8')).toBe('Concurrent local edit must survive.\n');
    }
    if (race !== 'target') expect(existsSync(join(f.root, 'race.md'))).toBe(false);
    await expect(prepareManagedImportMutation(engine, { ...row, authority: { ...row.authority, remote: true } }, { engine: engine.kind })).rejects.toThrow('trusted local CLI');
  }
}), 120_000);
