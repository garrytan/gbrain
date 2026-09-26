import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { prepareManagedSyncMutation, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer, writeResponse } from '../src/core/persistence/service.ts';
import { adoptSharedSkillpack } from '../src/core/shared-skills/publication.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { assertKnowledgePublicationAllowed } from '../src/core/shared-skills/knowledge-guard.ts';
import { atomicWrite } from '../src/core/skillopt/apply-edits.ts';
import { acceptCandidate, writeProposed } from '../src/core/skillopt/version-store.ts';
import { runSkillOpt } from '../src/core/skillopt/orchestrator.ts';
import { runFleet } from '../src/core/skillopt/batch.ts';
import type { SkillOptOpts } from '../src/core/skillopt/types.ts';
import { runBootstrapFromSkill } from '../src/core/skillopt/bootstrap-benchmark.ts';
import { copyArtifacts } from '../src/core/skillpack/copy.ts';
import { applyInstall, applyUninstall, planInstall } from '../src/core/skillpack/installer.ts';
import { applyWritePlan } from '../src/core/skillpack/init-scaffold.ts';
import { runInitBrainPack } from '../src/core/skillpack/init-brain-pack.ts';
import { runReferenceApply } from '../src/core/skillpack/reference.ts';
import { runHarvest } from '../src/core/skillpack/harvest.ts';
import { runDoctor } from '../src/core/skillpack/doctor.ts';
import { applyScaffold } from '../src/core/skillify/generator.ts';
import { autoFixDryViolations } from '../src/core/dry-fix.ts';
import { applyHarnessBridge, planHarnessBridge, removeHarnessBridge, runHarnessReference, runHarnessReferenceApply } from '../src/core/skillpack/harness-bridge.ts';
import { recordBridgeWrites, saveBridgeState, SKILLPACK_BRIDGE_SCHEMA_VERSION } from '../src/core/skillpack/bridge-state.ts';
import { saveState, SKILLPACK_STATE_SCHEMA_VERSION } from '../src/core/skillpack/state.ts';
import { packTarball, extractTarball } from '../src/core/skillpack/tarball.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const postgresUrl = testBackends().includes('postgres') ? process.env.DATABASE_URL : undefined;

interface Fixture { engine: BrainEngine; ctx: OperationContext; root: string; scratch: string; incarnation: string; }
const prose = '---\nname: alpha\ndescription: A synthetic shared skill\n---\n\nApproved instructions.\n';
const note = '---\ntitle: Imported skill text\ntype: note\n---\n\nSkill text is data.\n';
const protectedFiles = ['skillpack.json', 'skills/alpha/SKILL.md', 'skills/alpha/references/guide.md', 'skills/conventions/shared.md'];

async function fixture(run: (f: Fixture) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-skill-writers-'));
  try {
    await withEnv({ GBRAIN_HOME: join(scratch, 'home'), DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine(postgresUrl);
      const engine = isolated.engine;
      try {
        const root = join(scratch, 'brain'); mkdirSync(root);
        writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ api_version: 'gbrain-skillpack-v1', name: 'example-pack', version: '1.0.0',
          description: 'Synthetic fixture', author: 'Example Maintainer', license: 'MIT', homepage: 'https://example.com/skills',
          gbrain_min_version: '0.51.0', brain_resident: true, skills: ['skills/alpha'] }));
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
        const aliasRoot = join(scratch, 'alias-source'); mkdirSync(aliasRoot);
        await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('alias-source','Alias source',$1)", [aliasRoot]);
        for (const [slug, sourcePath, sourceUri] of [
          ['notes/path-alias', 'skills/alpha/SKILL.md', null],
          ['notes/manifest-alias', 'skillpack.json', null],
          ['notes/uri-alias', null, pathToFileURL(join(root, 'skills/alpha/references/guide.md')).href],
          ['notes/invalid-uri-alias', 'notes/invalid-uri-alias.md', 'file:///notes/%2F.md'],
        ]) {
          await engine.putPage(slug!, { title: 'Synthetic alias', type: 'note', compiled_truth: '', timeline: '', frontmatter: {} }, { sourceId: 'default' });
          await engine.executeRaw('UPDATE pages SET source_path=$1,source_uri=$2 WHERE source_id=$3 AND slug=$4', [sourcePath, sourceUri, 'default', slug]);
        }
        await claimWorktree(engine, 'default', root);
        await claimWorktree(engine, 'alias-source', aliasRoot);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, sourceId: 'default', dryRun: false,
          logger: { info() {}, warn() {}, error() {} } };
        await engine.setConfig('mcp.publish_skills', 'true');
        await setSharedSkillPolicy(ctx, 'default', { version: 1, enabled: true, classes: ['prose', 'reference'], audiences: ['readers'], requirements: [], allow_follow: true }, null);
        const result = await adoptSharedSkillpack(ctx, 'default', { request_id: randomUUID(), pack_id: 'example-pack', skills: [
          { pack_id: 'example-pack', name: 'alpha', expected_revision: null, files: [
            { path: protectedFiles[1], content: prose, file_class: 'prose', depends_on: protectedFiles.slice(2) },
            { path: protectedFiles[2], content: 'Approved reference.', file_class: 'reference' },
            { path: protectedFiles[3], content: 'Approved shared dependency.', file_class: 'reference' },
          ] },
        ] });
        expect(result.receipts[0].state).toBe('committed');
        const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
        await run({ engine, ctx, root, scratch, incarnation: source.incarnation });
      } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function canonicalState(f: Fixture) {
  return {
    bytes: protectedFiles.map(file => readFileSync(join(f.root, file), 'base64')),
    packs: await f.engine.executeRaw('SELECT * FROM shared_skill_packs ORDER BY source_id'),
    heads: await f.engine.executeRaw('SELECT * FROM shared_skill_heads ORDER BY source_id,name'),
    revisions: await f.engine.executeRaw('SELECT * FROM shared_skill_revisions ORDER BY source_id,name,revision'),
  };
}

test('registered source roots, aliases and symlinks deny page publication without changing canonical bytes or catalog', () => fixture(async f => {
  const before = await canonicalState(f);
  const row = { source_id: 'default', source_incarnation: f.incarnation, slug: 'notes/example' };
  for (const slug of ['skills/alpha/skill', 'skills/new/skill', 'skills/conventions/shared', 'skillpack.json', 'notes/path-alias', 'notes/manifest-alias', 'notes/uri-alias']) {
    await expect(assertKnowledgePublicationAllowed(f.engine, { ...row, slug })).rejects.toMatchObject({ code: 'skill_bundle_required' });
    expect(await canonicalState(f)).toEqual(before);
  }
  const alias = join(f.scratch, 'linked-root'); symlinkSync(f.root, alias);
  const [other] = await f.engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='alias-source'");
  for (const root of [f.root, alias]) for (const file of protectedFiles) {
    await expect(assertKnowledgePublicationAllowed(f.engine, { ...row, source_id: 'alias-source', source_incarnation: other.incarnation },
      { root, path: join(root, file) })).rejects.toMatchObject({ code: 'skill_bundle_required' });
  }
  await expect(assertKnowledgePublicationAllowed(f.engine, row, { root: f.root, path: join(f.root, 'notes/example.md') })).resolves.toBeUndefined();
  await expect(assertKnowledgePublicationAllowed(f.engine, { ...row, target_kind: 'skill_bundle' }, { root: f.root, path: join(f.root, protectedFiles[1]) })).resolves.toBeUndefined();
  expect(await canonicalState(f)).toEqual(before);
}), 120_000);

test('unresolvable stored file aliases fail closed with a metadata diagnostic instead of skill publication advice', () => fixture(async f => {
  const before = await canonicalState(f);
  const row = { source_id: 'default', source_incarnation: f.incarnation, slug: 'notes/invalid-uri-alias' };
  for (const preparedFile of [undefined, { root: f.root, path: join(f.root, 'notes/invalid-uri-alias.md') }]) {
    await expect(assertKnowledgePublicationAllowed(f.engine, row, preparedFile)).rejects.toMatchObject({
      code: 'invalid_source_uri',
      message: 'The page has a stored file source_uri that cannot be resolved to a local filesystem path. Have the source owner inspect and repair the stored source_uri before retrying.',
      suggestion: 'Have the source owner inspect and repair the stored source_uri before retrying the knowledge write. Shared skillpack protection remains enabled.',
    });
  }
  expect(await canonicalState(f)).toEqual(before);
  const [page] = await f.engine.executeRaw<{ source_uri: string }>(
    'SELECT source_uri FROM pages WHERE source_id=$1 AND slug=$2', ['default', row.slug]);
  expect(page.source_uri).toBe('file:///notes/%2F.md');
  const snapshot = await f.engine.readPageSnapshot(row.slug, { sourceId: 'default' });
  await expect(submitPageMutation(f.ctx, { operation: 'put_page', params: {
    slug: row.slug, content: note, request_id: randomUUID(), expected_revision: snapshot!.revision,
  } })).rejects.toMatchObject({ code: 'invalid_source_uri' });
  expect(await f.engine.readPageSnapshot(row.slug, { sourceId: 'default' })).toEqual(snapshot);
  expect(existsSync(join(f.root, 'notes/invalid-uri-alias.md'))).toBe(false);
  expect(await canonicalState(f)).toEqual(before);
  // The coordinator stores the message, but not OperationError.suggestion.
  // Verify that a queued failure retains both its classification and repair hint.
  await disposePersistenceConsumer(f.engine);
  const binding = (await getWorktreeBinding(f.engine, 'default'))!;
  const authority = await submissionAuthority(f.ctx, 'put_page', 'default', f.incarnation, row.slug);
  const accepted = await admitWrite(f.engine, { principal: authority.principal, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: f.incarnation, slug: row.slug, requestId: randomUUID(), callerIntent: { slug: row.slug },
    intent: { slug: row.slug }, authority, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const claimed = (await claimNextWrite(f.engine, localHostId()))!;
  expect(claimed.id).toBe(accepted.id);
  let applied = false;
  const result = await publishMutation(f.engine, claimed, { observedRevision: snapshot!.revision,
    file: { root: f.root, path: join(f.root, 'notes/invalid-uri-alias.md'), content: note },
    apply: async () => { applied = true; return {}; } }, localHostId());
  expect(result).toMatchObject({ state: 'failed', error_code: 'invalid_source_uri', recovery: null, publication_started: false });
  expect(result.error_message).toContain('inspect and repair the stored source_uri');
  expect(() => writeResponse(result)).toThrow(expect.objectContaining({ code: 'invalid_source_uri', writeError: 'invalid_source_uri' }));
  expect(applied).toBe(false);
  expect(existsSync(join(f.root, 'notes/invalid-uri-alias.md'))).toBe(false);
  expect(await f.engine.readPageSnapshot(row.slug, { sourceId: 'default' })).toEqual(snapshot);
  expect(await canonicalState(f)).toEqual(before);
}), 120_000);

test('legacy skill writers refuse before partial copies, history, optimizer evaluation and auxiliary output sinks', () => fixture(async f => {
  const before = await canonicalState(f);
  const skillsDir = join(f.root, 'skills');
  const upstream = join(f.scratch, 'upstream');
  mkdirSync(join(upstream, 'skills/alpha'), { recursive: true });
  writeFileSync(join(upstream, 'skills/alpha/SKILL.md'), prose.replace('Approved', 'Unreviewed'));
  writeFileSync(join(upstream, 'openclaw.plugin.json'), JSON.stringify({ name: 'fixture-pack', version: '1.0.0', skills: ['skills/alpha'], shared_deps: [] }));
  writeFileSync(join(upstream, 'skills/manifest.json'), JSON.stringify({ skills: [{ name: 'alpha', path: 'alpha/SKILL.md', description: 'Synthetic fixture' }] }));
  writeFileSync(join(upstream, 'skills/plugin-lanes.json'), JSON.stringify({ starter_policy: 'fixture', additions: {}, base_exclusions: {}, not_added: {}, starter_gaps: {} }));
  const install = { gbrainRoot: upstream, targetWorkspace: f.root, targetSkillsDir: skillsDir, skillSlug: 'alpha', overwriteLocal: true };
  const statePath = join(f.scratch, 'bridge-state.json');
  const bridgeOptions = { harness: 'claude-code', persona: null, gbrainVersion: '0.0.0-test', nowIso: '2026-09-22T00:00:00Z', statePath };
  saveBridgeState(recordBridgeWrites({ schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION, entries: [] },
    { ...bridgeOptions, dest: skillsDir, mode: 'full' }, [{ slug: 'alpha', mode: 'full', files: { 'alpha/SKILL.md': sha256(prose) } }]), { statePath });
  const bridgeStateBefore = readFileSync(statePath, 'utf8');
  const referenceOptions = { gbrainRoot: upstream, destDir: skillsDir, slugs: ['alpha'], harness: 'claude-code', statePath };
  expect(runHarnessReference(referenceOptions).files.find(file => file.relTarget === 'alpha/SKILL.md')?.differsKind).toBe('upstream_drift');
  const unguardedFirst = join(f.scratch, 'must-not-be-written.md');
  for (const work of [
    () => atomicWrite(join(f.root, protectedFiles[1]), 'Unreviewed'),
    () => atomicWrite(join(f.root, protectedFiles[2]), 'Unreviewed dependency'),
    () => acceptCandidate({ skillsDir, skillName: 'alpha', runId: 'fixture', epoch: 1, step: 1, edits: [], candidateText: 'Unreviewed', selScore: 1, delta: 1 }),
    () => writeProposed(skillsDir, 'alpha', 'Unreviewed'),
    () => copyArtifacts([{ source: '', target: unguardedFirst, content: 'Partial copy' }, { source: '', target: join(skillsDir, 'new/SKILL.md'), content: 'Unreviewed' }]),
    () => applyWritePlan([{ path: unguardedFirst, content: 'Partial scaffold' }, { path: join(skillsDir, 'new/SKILL.md'), content: 'Unreviewed' }]),
    () => runInitBrainPack({ targetDir: f.root, name: 'new-pack' }),
    () => applyScaffold({ files: [{ path: unguardedFirst, kind: 'new', content: 'Partial scaffold' },
      { path: join(skillsDir, 'alpha/SKILL.md'), kind: 'overwrite', content: 'Unreviewed' }], resolverFile: null, resolverAppend: null }),
    () => applyScaffold({ files: [{ path: unguardedFirst, kind: 'new', content: 'Partial scaffold' }],
      resolverFile: join(skillsDir, 'alpha/SKILL.md'), resolverAppend: 'Unreviewed router entry' }),
    () => autoFixDryViolations(skillsDir),
    () => applyHarnessBridge(planHarnessBridge({ gbrainRoot: upstream, destDir: skillsDir, slugs: ['alpha'], mode: 'full' }), bridgeOptions),
    () => runHarnessReferenceApply(referenceOptions),
    () => removeHarnessBridge({ ...bridgeOptions, destDir: skillsDir, slugs: ['alpha'] }),
    () => applyInstall(planInstall(install), install),
    () => applyUninstall({ ...install, skillSlug: 'alpha' }),
    () => runReferenceApply({ gbrainRoot: upstream, targetWorkspace: f.root, skillSlug: 'alpha' }),
    () => runHarvest({ hostRepoRoot: upstream, gbrainRoot: f.root, slug: 'alpha', overwriteLocal: true, noLint: true }),
    () => saveState({ schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [] }, { statePath: join(f.root, 'skillpack.json') }),
    () => packTarball({ sourceDir: upstream, outPath: join(f.root, protectedFiles[2]) }),
    () => extractTarball({ tgzPath: join(f.scratch, 'missing.tgz'), destDir: join(skillsDir, 'new') }),
  ]) {
    expect(work).toThrow('managed canonical worktree');
    expect(await canonicalState(f)).toEqual(before);
    expect(existsSync(unguardedFirst)).toBe(false);
    expect(existsSync(join(skillsDir, 'alpha/skillopt'))).toBe(false);
    expect(readFileSync(statePath, 'utf8')).toBe(bridgeStateBefore);
  }
  const optimizer: SkillOptOpts = { engine: f.engine, skillsDir, skillName: 'alpha', benchmarkPath: join(f.scratch, 'absent.jsonl'), epochs: 1, batchSize: 1,
    lr: 1, lrSchedule: 'constant', split: [4, 1, 5], optimizerModel: 'unconfigured', targetModel: 'unconfigured', judgeModel: 'unconfigured',
    mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: true, bootstrapReviewed: true, json: false, maxCostUsd: 1, maxRuntimeMin: 1, force: true };
  await expect(runSkillOpt(optimizer)).rejects.toMatchObject({ code: 'skill_bundle_required' });
  await expect(runFleet({ ...optimizer, targetModels: ['unconfigured'] })).rejects.toMatchObject({ code: 'skill_bundle_required' });
  await expect(runDoctor({ packRoot: f.root, mode: 'quick', fix: true, yes: true })).rejects.toMatchObject({ code: 'skill_bundle_required' });
  let calls = 0;
  await expect(runBootstrapFromSkill({ skillsDir, skillName: 'alpha', optimizerModel: 'unconfigured', chatFn: async () => { calls++; throw new Error('Must not evaluate'); } }))
    .rejects.toMatchObject({ code: 'skill_bundle_required' });
  expect(calls).toBe(0);
  const fakeTmp = join(f.scratch, 'unmanaged-output.tmp'); symlinkSync(join(f.root, protectedFiles[1]), fakeTmp);
  expect(() => atomicWrite(fakeTmp.slice(0, -4), 'Bypass')).toThrow('managed canonical worktree');
  const stagedSkills = join(f.scratch, 'staged-skills');
  mkdirSync(join(stagedSkills, 'alpha/skillopt'), { recursive: true });
  writeFileSync(join(stagedSkills, 'alpha/SKILL.md'), prose);
  symlinkSync(join(f.root, protectedFiles[2]), join(stagedSkills, 'alpha/skillopt/best.md.tmp'));
  expect(() => acceptCandidate({ skillsDir: stagedSkills, skillName: 'alpha', runId: 'fixture', epoch: 1, step: 1, edits: [],
    candidateText: 'Bypass', selScore: 1, delta: 1 })).toThrow('managed canonical worktree');
  expect(existsSync(join(stagedSkills, 'alpha/skillopt/history.json'))).toBe(false);
  const hardlinkTmp = join(f.scratch, 'hardlink-output.tmp'); linkSync(join(f.root, protectedFiles[1]), hardlinkTmp);
  expect(() => atomicWrite(hardlinkTmp.slice(0, -4), 'Hardlink bypass')).toThrow('multiply linked file');
  const hardlinkAlias = join(f.scratch, 'hardlink-alias.tmp'); symlinkSync(hardlinkTmp, hardlinkAlias);
  expect(() => atomicWrite(hardlinkAlias.slice(0, -4), 'Symlinked hardlink bypass')).toThrow('multiply linked file');
  rmSync(hardlinkAlias);
  rmSync(hardlinkTmp);
  const danglingTmp = join(f.scratch, 'dangling-output.tmp'); symlinkSync(join(f.root, 'skills/new/SKILL.md'), danglingTmp);
  expect(() => atomicWrite(danglingTmp.slice(0, -4), 'Dangling link bypass')).toThrow('managed canonical worktree');
  const child = Bun.spawnSync([process.execPath, '--eval', `import { atomicWrite } from ${JSON.stringify(join(import.meta.dir, '../src/core/skillopt/apply-edits.ts'))};
    try { atomicWrite(${JSON.stringify(join(f.root, protectedFiles[1]))}, 'Other installation'); process.exit(1); }
    catch (error) { console.log(error.code); process.exit(error.code === 'skill_bundle_required' ? 0 : 2); }`],
  { env: { ...process.env, GBRAIN_HOME: join(f.scratch, 'other-installation') }, stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain('skill_bundle_required');
  expect(readdirSync(join(skillsDir, 'alpha')).sort()).toEqual(['SKILL.md', 'references']);
  expect(await canonicalState(f)).toEqual(before);
}), 120_000);

test('ordinary page operations cannot replace canonical skill paths, but imported prose remains writable knowledge', () => fixture(async f => {
  const before = await canonicalState(f);
  for (const operation of ['put_page', 'restore_page', 'delete_page']) for (const slug of ['skills/alpha/skill', 'notes/path-alias', 'notes/uri-alias']) {
    const snapshot = await f.engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
    await expect(submitPageMutation(f.ctx, { operation, params: { slug, content: note, request_id: randomUUID(),
      ...(snapshot ? { expected_revision: snapshot.revision } : {}) } })).rejects.toMatchObject({ code: 'skill_bundle_required' });
    expect(await canonicalState(f)).toEqual(before);
  }
  const result = await submitPageMutation(f.ctx, { operation: 'put_page', params: { slug: 'notes/imported-skill', content: note + prose, request_id: randomUUID() } });
  expect(result.state).toBe('committed');
  expect(readFileSync(join(f.root, 'notes/imported-skill.md'), 'utf8')).toContain('Approved instructions.');
  expect(await canonicalState(f)).toEqual(before);
  const unmanaged = join(f.scratch, 'unmanaged'); mkdirSync(unmanaged);
  const scaffold = runInitBrainPack({ targetDir: unmanaged, name: 'example-skill', firstSkillSlug: 'alpha' });
  expect(scaffold.filesWritten.length).toBeGreaterThan(0);
  acceptCandidate({ skillsDir: join(unmanaged, 'skills'), skillName: 'alpha', runId: 'fixture', epoch: 1, step: 1, edits: [], candidateText: prose, selScore: 1, delta: 1 });
  expect(readFileSync(join(unmanaged, 'skills/alpha/SKILL.md'), 'utf8')).toBe(prose);
  copyArtifacts([{ source: '', target: join(unmanaged, 'skills/alpha/references/example.md'), content: 'Unmanaged reference' }]);
  expect(readFileSync(join(unmanaged, 'skills/alpha/references/example.md'), 'utf8')).toBe('Unmanaged reference');
  const doctor = await runDoctor({ packRoot: unmanaged, mode: 'quick', fix: true, yes: true });
  expect(doctor.fixes_applied.length).toBeGreaterThan(0);
}), 120_000);

test('the locked coordinator rejects a prepared physical alias before recovery bytes or database callbacks', () => fixture(async f => {
  await disposePersistenceConsumer(f.engine);
  const before = await canonicalState(f);
  const binding = (await getWorktreeBinding(f.engine, 'default'))!;
  for (const [index, file] of protectedFiles.entries()) {
    const slug = `notes/direct-${index}`;
    const authority = await submissionAuthority(f.ctx, 'put_page', 'default', f.incarnation, slug);
    const accepted = await admitWrite(f.engine, { principal: authority.principal, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: f.incarnation, slug, requestId: randomUUID(), callerIntent: { slug }, intent: { slug }, authority,
      worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const row = (await claimNextWrite(f.engine, localHostId()))!;
    expect(row.id).toBe(accepted.id);
    let applied = false;
    const boundaries: string[] = [];
    const result = await publishMutation(f.engine, row, { observedRevision: null, file: { root: f.root, path: join(f.root, file), content: 'Unreviewed' },
      apply: async () => { applied = true; return {}; } }, localHostId(), { boundary: async name => { boundaries.push(name); } });
    expect(result.state).toBe('failed');
    expect(result.error_code).toBe('skill_bundle_required');
    expect(result.recovery).toBeNull();
    expect(result.publication_started).toBe(false);
    expect(boundaries).toEqual([]);
    expect(applied).toBe(false);
    expect(await canonicalState(f)).toEqual(before);
  }
}), 120_000);

test('managed sync imports and deletions cannot disguise canonical files as knowledge and legacy import stays fenced', () => fixture(async f => {
  await disposePersistenceConsumer(f.engine);
  const before = await canonicalState(f);
  const binding = (await getWorktreeBinding(f.engine, 'default'))!;
  const syncAuthority = await managedSyncAuthority(f.engine, 'default', f.incarnation, f.root);
  for (const kind of ['managed_sync_import', 'managed_sync_delete'] as const) for (const [index, path] of protectedFiles.entries()) {
    const slug = `notes/disguised-${kind}-${index}`;
    const content = readFileSync(join(f.root, path), 'utf8');
    const intent: SyncIntent = { kind, expected_revision: null, sourcePath: path, path, rawHash: sha256(content), content,
      processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: true },
      ownerEpoch: String(binding.owner_epoch), syncAuthority, cursorKey: 'fixture', runId: randomUUID(), index: 0,
      from: null, target: 'fixture', total: 1, slugMode: 'source-root' };
    const row = await admitWrite(f.engine, { principal: syncAuthority.writer.principal, authority: syncAuthority.writer,
      operation: 'submit_job', sourceId: 'default', sourceIncarnation: f.incarnation, slug, requestId: randomUUID(),
      callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    await expect(prepareManagedSyncMutation(f.engine, row, f.ctx.config)).rejects.toMatchObject({ code: 'skill_bundle_required' });
    expect(await f.engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    expect(await canonicalState(f)).toEqual(before);
  }
  await expect(importFromContent(f.engine, 'skills/alpha/skill', note, { sourceId: 'default', noEmbed: true }))
    .rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(await canonicalState(f)).toEqual(before);
}), 120_000);
