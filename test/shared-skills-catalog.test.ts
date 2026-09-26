import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitSharedSkillMutation, adoptSharedSkillpack, importSharedSkillProposal } from '../src/core/shared-skills/publication.ts';
import { admitWrite, compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { getSharedSkill, getSharedSkillAsset, listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { getSharedSkillPolicy, setSharedSkillPolicy as approvePolicy } from '../src/core/shared-skills/policy.ts';
import { normalizeSkillFiles } from '../src/core/shared-skills/manifest.ts';
import type { SharedSkillPolicy, SharedSkillFileInput } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { skillsCatalogOperations } from '../src/core/ops/skills-catalog.ts';
import { packagedSharedSkills } from '../src/core/shared-skills/setup-bundle.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { joinBrain } from '../src/core/shared-skills/membership.ts';
import { getSharedSkillRetention, pruneSharedSkillRevisions, retainSharedSkillRevision, SHARED_SKILL_RETENTION_LIMITS } from '../src/core/shared-skills/retention.ts';

const operations = ['list_skills', 'get_skill', 'get_skill_asset', 'put_skill', 'delete_skill', 'set_skill_policy', 'list_brain_skillpack'];
const fullPolicy: SharedSkillPolicy = { version: 1, enabled: true, classes: ['prose', 'reference', 'asset', 'script'],
  audiences: ['readers'], requirements: [], allow_follow: true };
const prose = (name: string, body = 'Original instructions', depends_on: string[] = []): SharedSkillFileInput => ({
  path: `skills/${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: A synthetic fixture\ntriggers: [example task]\n---\n\n${body}\n`, file_class: 'prose', depends_on,
});
async function setSharedSkillPolicy(ctx: OperationContext, sourceId: string, policy: SharedSkillPolicy) {
  const [row] = await ctx.engine.executeRaw<{ epoch: string }>(`SELECT p.epoch FROM shared_skill_policies p JOIN sources s
    ON s.id=p.source_id AND s.incarnation=p.source_incarnation WHERE s.id=$1`, [sourceId]);
  return approvePolicy(ctx, sourceId, policy, row?.epoch ?? null);
}
interface Fixture { engine: BrainEngine; root: string; hiddenRoot: string; local: OperationContext; reader: OperationContext; editor: OperationContext; incarnation: string; }
async function fixture(run: (fixture: Fixture) => Promise<void>, databaseUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shared-catalog-'));
  await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
    const isolated = await isolatedSharedSkillsEngine(databaseUrl);
    const engine = isolated.engine;
    try {
      const root = join(dir, 'default'); const hiddenRoot = join(dir, 'hidden'); mkdirSync(root); mkdirSync(hiddenRoot);
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$2,$3)', ['hidden', 'Hidden fixtures', hiddenRoot]);
      await claimWorktree(engine, 'default', root); await claimWorktree(engine, 'hidden', hiddenRoot);
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      await engine.setConfig('mcp.publish_skills', 'true');
      const local: OperationContext = { engine, config: { engine: databaseUrl ? 'postgres' : 'pglite' }, remote: false,
        sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations,bound_slug_prefixes)
        VALUES('reader','Synthetic reader','read','default',$1::text[],NULL),('editor','Synthetic editor','read write skill_editor','default',$1::text[],ARRAY['skills/alpha/'])`, [operations]);
      const remote = (id: string, scopes: string[]): OperationContext => ({ ...local, remote: true,
        auth: { token: 'synthetic', clientId: id, principal: { kind: 'oauth_client', id }, scopes, sourceId: 'default', allowedOperations: operations,
          ...(id === 'editor' ? { boundSlugPrefixes: ['skills/alpha/'] } : {}) } });
      const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
      await run({ engine, root, hiddenRoot, local, reader: remote('reader', ['read']), editor: remote('editor', ['read', 'write', 'skill_editor']), incarnation: source.incarnation });
    } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
  });
  rmSync(dir, { recursive: true, force: true });
}
async function put(ctx: OperationContext, name: string, files = [prose(name)], extra: Record<string, unknown> = {}) {
  const current = await ctx.engine.executeRaw<{ revision: string }>('SELECT revision FROM shared_skill_heads WHERE source_id=$1 AND name=$2', [ctx.sourceId, name]);
  const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [ctx.sourceId]);
  return submitSharedSkillMutation(ctx, 'put_skill', { request_id: randomUUID(), expected_revision: current[0]?.revision ?? null,
    source_id: ctx.sourceId, source_incarnation: source.incarnation, pack_id: 'example-pack', name, files, ...extra });
}
async function awaitAdmission(engine: BrainEngine, ids: string[]) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=ANY($1::uuid[])', [ids]);
    if (rows.length === ids.length) return;
    await Bun.sleep(20);
  }
  throw new Error('Expected durable admission was not observed');
}

test('sealed revision, exact assets, CAS replay and tombstone use the real canonical coordinator', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  const asset = 'skills/alpha/references/example.txt';
  const files: SharedSkillFileInput[] = [prose('alpha', 'Use the declared reference.', [asset]),
    { path: asset, content: 'Fixture reference', file_class: 'reference' }];
  const request_id = randomUUID();
  const params = { request_id, expected_revision: null, source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name: 'alpha', files };
  const result = await submitSharedSkillMutation(f.editor, 'put_skill', params);
  expect(result.state).toBe('committed');
  expect((await f.engine.executeRaw('SELECT id FROM pages WHERE slug=$1', ['skills/alpha'])).length).toBe(0);
  const initial = await getSharedSkill(f.reader, { name: 'alpha' });
  expect(initial.files.length).toBe(2);
  expect(readFileSync(join(f.root, asset), 'utf8')).toBe('Fixture reference');
  const downloaded = await getSharedSkillAsset(f.reader, { ...initial, path: asset });
  expect(Buffer.from(downloaded.content, 'base64').toString()).toBe('Fixture reference');
  await disposePersistenceConsumer(f.engine);
  expect((await submitSharedSkillMutation(f.editor, 'put_skill', params)).revision).toBe(result.revision);
  await expect(submitSharedSkillMutation(f.editor, 'put_skill', { ...params, files: [prose('alpha', 'Changed')] })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(submitSharedSkillMutation(f.editor, 'put_skill', { ...params, request_id: randomUUID() })).rejects.toMatchObject({ code: 'revision_conflict' });
  const next = await put(f.editor, 'alpha', [prose('alpha', 'Updated instructions')]);
  expect(next.revision).not.toBe(initial.revision);
  expect((await getSharedSkill(f.reader, { name: 'alpha', revision: initial.revision })).body).toBe(initial.body);
  expect(existsSync(join(f.root, asset))).toBe(false);
  await submitSharedSkillMutation(f.editor, 'delete_skill', { request_id: randomUUID(), expected_revision: next.revision,
    source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name: 'alpha' });
  expect((await listSharedSkills(f.reader)).skills).toEqual([]);
  await expect(getSharedSkill(f.reader, { name: 'alpha', revision: initial.revision })).rejects.toMatchObject({ code: 'skill_not_found' });
}), 120_000);

test('legacy true is prose only, policy narrowing hides asset metadata and editor cannot approve disclosure', () => fixture(async f => {
  const asset = 'skills/alpha/assets/example.dat';
  await expect(put(f.local, 'alpha', [prose('alpha', 'Text', [asset]), { path: asset, content: 'hidden bytes', file_class: 'asset' }])).rejects.toMatchObject({ code: 'approval_required' });
  await put(f.local, 'alpha');
  const legacy = await getSharedSkill(f.reader, { name: 'alpha' });
  expect(legacy.allow_follow).toBe(false);
  await expect(setSharedSkillPolicy(f.editor, 'default', fullPolicy)).rejects.toMatchObject({ code: 'permission_denied' });
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  await put(f.local, 'alpha', [prose('alpha', 'Text', [asset]), { path: asset, content: 'hidden bytes', file_class: 'asset' }]);
  await setSharedSkillPolicy(f.local, 'default', { ...fullPolicy, classes: ['prose'] });
  const narrowed = await getSharedSkill(f.reader, { name: 'alpha' });
  expect(narrowed.files.map(file => file.path)).toEqual(['skills/alpha/SKILL.md']);
  expect(narrowed.files[0].depends_on).toEqual([]);
  expect(JSON.stringify(narrowed)).not.toContain('example.dat');
  await expect(getSharedSkillAsset(f.reader, { ...narrowed, path: asset })).rejects.toMatchObject({ code: 'skill_asset_not_found' });
  await f.engine.setConfig('mcp.publish_skills', 'false');
  await expect(listSharedSkills(f.reader)).rejects.toMatchObject({ code: 'permission_denied' });
}), 120_000);

test('scoped views ignore hidden-source changes, bind cursors and disambiguate qualified identities', () => fixture(async f => {
  await put(f.local, 'alpha'); await put(f.local, 'beta');
  const first = await listSharedSkills(f.reader, { limit: 1 });
  expect(first.next_cursor).toBeDefined();
  const cursorBytes = Buffer.from(first.next_cursor!, 'base64url');
  for (const length of [0, 11, 12, 20, 27, 28, cursorBytes.length - 1]) {
    await expect(listSharedSkills(f.reader, { limit: 1, cursor: cursorBytes.subarray(0, length).toString('base64url') || 'invalid' }))
      .rejects.toMatchObject({ code: 'full_resync_required' });
  }
  const changedTag = Buffer.from(cursorBytes); changedTag[12] ^= 1;
  await expect(listSharedSkills(f.reader, { limit: 1, cursor: changedTag.toString('base64url') })).rejects.toMatchObject({ code: 'full_resync_required' });
  await put({ ...f.local, sourceId: 'hidden' }, 'alpha');
  expect((await listSharedSkills(f.reader, { limit: 1 })).view_token).toBe(first.view_token);
  expect((await listSharedSkills(f.reader, { limit: 1, cursor: first.next_cursor })).skills[0].name).toBe('beta');
  const all = { ...f.local, sourceId: '__all__' };
  await expect(getSharedSkill(all, { name: 'alpha' })).rejects.toMatchObject({ code: 'ambiguous_skill' });
  const hidden = (await listSharedSkills(all)).skills.find(s => s.source_id === 'hidden')!;
  await expect(getSharedSkill(f.reader, { qualified_id: hidden.qualified_id })).rejects.toMatchObject({ code: 'skill_not_found' });
  expect((await getSharedSkill(all, { qualified_id: hidden.qualified_id })).source_id).toBe('hidden');
  await expect(listSharedSkills(f.editor, { limit: 1, cursor: first.next_cursor })).rejects.toMatchObject({ code: 'full_resync_required' });
  await put(f.local, 'beta', [prose('beta', 'New metadata')]);
  await expect(listSharedSkills(f.reader, { limit: 1, cursor: first.next_cursor })).rejects.toMatchObject({ code: 'full_resync_required' });
  await f.engine.executeRaw("UPDATE oauth_clients SET deleted_at=now() WHERE client_id='reader'");
  await expect(getSharedSkill(f.reader, { name: 'alpha' })).rejects.toMatchObject({ code: 'permission_denied' });
}), 120_000);

test('one-slug editor cannot modify a shared dependency pinned by another skill', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  const path = 'skills/conventions/example.md';
  const files = (name: string, content: string): SharedSkillFileInput[] => [prose(name, 'Read convention', [path]), { path, content, file_class: 'reference' }];
  await put(f.local, 'alpha', files('alpha', 'original')); await put(f.local, 'beta', files('beta', 'original'));
  const before = await getSharedSkill(f.reader, { name: 'beta' });
  await expect(put(f.editor, 'alpha', files('alpha', 'protected change'))).rejects.toMatchObject({ code: 'permission_denied' });
  expect(readFileSync(join(f.root, path), 'utf8')).toBe('original');
  expect((await getSharedSkill(f.reader, { name: 'beta' })).revision).toBe(before.revision);
  await put(f.local, 'alpha', files('alpha', 'owner-approved update'));
  const after = await getSharedSkill(f.reader, { name: 'beta' });
  expect(after.revision).not.toBe(before.revision);
  expect(Buffer.from((await getSharedSkillAsset(f.reader, { ...after, path })).content, 'base64').toString()).toBe('owner-approved update');
}), 120_000);

test('shared convention edits rebuild complete dependent closures and reject cross-skill local pointers', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  const convention = 'skills/conventions/example.md';
  const helper = 'skills/conventions/helper.md';
  const base = (name: string): SharedSkillFileInput[] => [prose(name, 'Read convention', [convention]), { path: convention, content: 'original', file_class: 'reference' }];
  await put(f.local, 'alpha', base('alpha')); await put(f.local, 'beta', base('beta'));
  await put(f.local, 'alpha', [prose('alpha', 'Read convention', [convention]),
    { path: convention, content: 'Read new helper', file_class: 'reference', depends_on: [helper] },
    { path: helper, content: 'Shared helper content', file_class: 'reference' }]);
  const expanded = await getSharedSkill(f.reader, { name: 'beta' });
  expect(expanded.files.map(file => file.path)).toContain(helper);
  expect(Buffer.from((await getSharedSkillAsset(f.reader, { ...expanded, path: helper })).content, 'base64').toString()).toBe('Shared helper content');
  const local = 'skills/alpha/references/local.md';
  await expect(put(f.local, 'alpha', [prose('alpha', 'Read convention', [convention]),
    { path: convention, content: 'Invalid beta dependency', file_class: 'reference', depends_on: [local] },
    { path: local, content: 'Alpha-only helper', file_class: 'reference' }])).rejects.toMatchObject({ code: 'invalid_params' });
  expect((await getSharedSkill(f.reader, { name: 'beta' })).revision).toBe(expanded.revision);
  expect(existsSync(join(f.root, local))).toBe(false);
  await put(f.local, 'alpha', base('alpha'));
  const narrowed = await getSharedSkill(f.reader, { name: 'beta' });
  expect(narrowed.files).toHaveLength(2); expect(existsSync(join(f.root, helper))).toBe(false);
  expect((await getSharedSkillAsset(f.reader, { ...expanded, path: helper })).content).toBe(Buffer.from('Shared helper content').toString('base64'));
}), 120_000);

test('private and audience-restricted metadata never enters the remote catalog', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', { ...fullPolicy, audiences: ['readers', 'oauth_client:editor'] });
  await put(f.local, 'alpha', [prose('alpha')], { private: true });
  await expect(put(f.editor, 'alpha', [prose('alpha')], { private: false })).rejects.toMatchObject({ code: 'approval_required' });
  await put(f.local, 'beta', [{ ...prose('beta'), audience: ['oauth_client:editor'] }]);
  expect((await listSharedSkills(f.reader)).skills).toEqual([]);
  expect((await listSharedSkills(f.editor)).skills.map(s => s.name)).toEqual(['beta']);
  await expect(getSharedSkill(f.reader, { name: 'beta' })).rejects.toMatchObject({ code: 'skill_not_found' });
}), 120_000);

test('valid YAML privacy keys stay private and malformed or duplicate consent fails closed', () => fixture(async f => {
  for (const [name, marker] of [['privatequoted', '"private": true'], ['privatespaced', 'private : true'], ['publishquoted', '"publish": false'], ['publishspaced', 'mcp_publish : false']]) {
    await put(f.local, name, [{ ...prose(name), content: `---\nname: ${name}\n${marker}\n---\nPrivate fixture` }]);
    await expect(getSharedSkill(f.reader, { name })).rejects.toMatchObject({ code: 'skill_not_found' });
  }
  expect((await listSharedSkills(f.reader)).skills).toEqual([]);
  for (const marker of ['private: false\nprivate: true', '"private": false\nprivate : true', 'private: false\nPRIVATE: true', 'private: [true', '<<: {private: true}']) {
    await expect(put(f.local, 'invalid-consent', [{ ...prose('invalid-consent'), content: `---\nname: invalid-consent\n${marker}\n---\nRejected fixture` }])).rejects.toMatchObject({ code: 'approval_required' });
  }
  expect((await f.engine.executeRaw("SELECT name FROM shared_skill_heads WHERE name='invalid-consent'")).length).toBe(0);
}), 120_000);

test('ordinary editors cannot adopt or erase unsealed disk packs through one-skill publication', () => fixture(async f => {
  mkdirSync(join(f.root, 'skills/beta'), { recursive: true });
  const beta = prose('beta').content;
  const manifest = JSON.stringify({ name: 'example-pack', brain_resident: true, skills: ['skills/beta'] });
  writeFileSync(join(f.root, 'skills/beta/SKILL.md'), beta); writeFileSync(join(f.root, 'skillpack.json'), manifest);
  await expect(put(f.editor, 'alpha')).rejects.toMatchObject({ code: 'approval_required' });
  await expect(put(f.local, 'alpha')).rejects.toMatchObject({ code: 'approval_required' });
  await expect(adoptSharedSkillpack(f.local, 'default', { pack_id: 'example-pack', skills: [{ name: 'alpha', pack_id: 'example-pack', expected_revision: null, files: [prose('alpha')] }] })).rejects.toMatchObject({ code: 'approval_required' });
  expect(readFileSync(join(f.root, 'skillpack.json'), 'utf8')).toBe(manifest);
  expect(readFileSync(join(f.root, 'skills/beta/SKILL.md'), 'utf8')).toBe(beta);
  expect(existsSync(join(f.root, 'skills/alpha/SKILL.md'))).toBe(false);
  await adoptSharedSkillpack(f.local, 'default');
  await put(f.editor, 'alpha');
  expect((await listSharedSkills(f.reader)).skills.map(skill => skill.name)).toEqual(['alpha', 'beta']);
}), 120_000);

test('reviewed local proposals publish human edits and preserve edits made after review', () => fixture(async f => {
  await put(f.local, 'alpha');
  let before = await getSharedSkill(f.reader, { name: 'alpha' });
  const path = 'skills/alpha/SKILL.md';
  const edited = prose('alpha', 'Reviewed human edit');
  writeFileSync(join(f.root, path), edited.content);
  const params = { name: 'alpha', pack_id: 'example-pack', source_id: 'default', source_incarnation: f.incarnation,
    request_id: randomUUID(), expected_revision: before.revision, files: [edited],
    expected_hashes: { [path]: sha256(edited.content), 'skillpack.json': sha256(readFileSync(join(f.root, 'skillpack.json'))) } };
  await expect(importSharedSkillProposal(f.editor, params)).rejects.toMatchObject({ code: 'permission_denied' });
  const op = skillsCatalogOperations.find(operation => operation.name === 'import_skill_proposal')!;
  const accepted = await op.handler(f.local, params) as { revision: string };
  expect(accepted.revision).not.toBe(before.revision);
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).body).toBe(edited.content);
  before = await getSharedSkill(f.reader, { name: 'alpha' });
  const lock = (await acquireWorktree((await getWorktreeBinding(f.engine, 'default'))!))!;
  const request_id = randomUUID();
  const reviewed = prose('alpha', 'Second reviewed edit');
  writeFileSync(join(f.root, path), reviewed.content);
  const pending = op.handler(f.local, { ...params, request_id, expected_revision: before.revision, files: [reviewed],
    expected_hashes: { [path]: sha256(reviewed.content), 'skillpack.json': sha256(readFileSync(join(f.root, 'skillpack.json'))) } }).catch(error => error);
  const newer = `${reviewed.content}\nUnreviewed later edit`;
  try { await awaitAdmission(f.engine, [request_id]); writeFileSync(join(f.root, path), newer); } finally { await lock.release(); }
  expect(await pending).toMatchObject({ code: 'source_changed' });
  expect(readFileSync(join(f.root, path), 'utf8')).toBe(newer);
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).revision).toBe(before.revision);
}), 120_000);

test('adoption publishes existing bytes only through journal and memory-only writers remain denied', () => fixture(async f => {
  mkdirSync(join(f.root, 'skills', 'alpha'), { recursive: true });
  const body = prose('alpha').content;
  writeFileSync(join(f.root, 'skills', 'alpha', 'SKILL.md'), body);
  writeFileSync(join(f.root, 'skillpack.json'), JSON.stringify({ name: 'example-pack', brain_resident: true, skills: ['skills/alpha'] }));
  const adopted = await adoptSharedSkillpack(f.local, 'default');
  expect(adopted.receipts.length).toBe(1);
  expect(readFileSync(join(f.root, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe(body);
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).body).toBe(body);
  await expect(put({ ...f.reader, auth: { ...f.reader.auth!, scopes: ['admin'] } }, 'alpha')).rejects.toMatchObject({ code: 'permission_denied' });
  const file = join(f.root, 'skills', 'alpha', 'SKILL.md');
  writeFileSync(file, `${body}\nHuman edit`);
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).body).toBe(body);
  await expect(put(f.local, 'alpha', [prose('alpha', 'Overwrite')])).rejects.toMatchObject({ code: 'local_conflict' });
}), 120_000);

test('manifest rejects undeclared closure, traversal, case aliases, cycles and oversized prose', () => {
  for (const path of ['../secret', '/absolute', 'C:/drive', 'skills/alpha/../secret', 'skills/alpha/.env', 'skills/alpha/a\\b']) {
    expect(() => normalizeSkillFiles('alpha', [prose('alpha', 'Text', [path]), { path, content: '', file_class: 'asset' }])).toThrow();
  }
  expect(() => normalizeSkillFiles('alpha', [prose('alpha', 'Text', ['skills/alpha/missing'])])).toThrow();
  expect(() => normalizeSkillFiles('alpha', [prose('alpha', 'Text', ['skills/alpha/SKILL.md'])])).toThrow();
  expect(() => normalizeSkillFiles('alpha', [prose('alpha', 'x'.repeat(256 * 1024))])).toThrow();
  expect(() => normalizeSkillFiles('alpha', [prose('alpha'), { path: 'skills/alpha/unreachable.txt', content: '', file_class: 'reference' }])).toThrow();
});

test('CAS race commits one complete revision and queued editor revocation cannot publish', () => fixture(async f => {
  await put(f.local, 'alpha');
  const before = await getSharedSkill(f.reader, { name: 'alpha' });
  const binding = (await getWorktreeBinding(f.engine, 'default'))!;
  let lock = (await acquireWorktree(binding))!;
  const ids = [randomUUID(), randomUUID()];
  const parameters = (id: string, body: string) => ({ request_id: id, expected_revision: before.revision, source_id: 'default',
    source_incarnation: f.incarnation, name: 'alpha', pack_id: 'example-pack', files: [prose('alpha', body)] });
  const races = ids.map((id, i) => submitSharedSkillMutation(f.editor, 'put_skill', parameters(id, `winner-${i}`)).then(value => ({ value }), error => ({ error })));
  try { await awaitAdmission(f.engine, ids); } finally { await lock.release(); }
  const results = await Promise.all(races);
  expect(results.filter(r => 'value' in r).length).toBe(1);
  expect(results.filter(r => 'error' in r && r.error.code === 'revision_conflict').length).toBe(1);
  const winner = await getSharedSkill(f.reader, { name: 'alpha' });
  expect(readFileSync(join(f.root, 'skills/alpha/SKILL.md'), 'utf8')).toBe(winner.body);
  expect((await f.engine.executeRaw('SELECT revision FROM shared_skill_revisions WHERE name=$1', ['alpha'])).length).toBe(2);
  lock = (await acquireWorktree(binding))!;
  const revokedId = randomUUID();
  const revoked = submitSharedSkillMutation(f.editor, 'put_skill', { ...parameters(revokedId, 'must not publish'), expected_revision: winner.revision }).catch(error => error);
  try {
    await awaitAdmission(f.engine, [revokedId]);
    await f.engine.executeRaw("UPDATE oauth_clients SET scope='read write' WHERE client_id='editor'");
  } finally { await lock.release(); }
  expect((await revoked).code).toBe('permission_denied');
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).revision).toBe(winner.revision);
  expect(readFileSync(join(f.root, 'skills/alpha/SKILL.md'), 'utf8')).toBe(winner.body);
}), 120_000);

test('queued publication policy changes reject before file effects and enumeration errors are not empty', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  await put(f.local, 'alpha');
  const before = await getSharedSkill(f.reader, { name: 'alpha' });
  const lock = (await acquireWorktree((await getWorktreeBinding(f.engine, 'default'))!))!;
  const request_id = randomUUID();
  const queued = put(f.editor, 'alpha', [prose('alpha', 'must not publish')], { request_id }).catch(error => error);
  try {
    await awaitAdmission(f.engine, [request_id]);
    await setSharedSkillPolicy(f.local, 'default', { ...fullPolicy, allow_follow: false });
  } finally { await lock.release(); }
  expect((await queued).code).toBe('approval_required');
  expect(readFileSync(join(f.root, 'skills/alpha/SKILL.md'), 'utf8')).toBe(before.body);
  const failing = new Proxy(f.engine, { get(target, key) {
    if (key === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(new Proxy(target, { get(tx, prop) {
      if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM shared_skill_heads')) throw new Error('synthetic storage interruption');
        return tx.executeRaw(sql, params);
      };
      const value = Reflect.get(tx, prop); return typeof value === 'function' ? value.bind(tx) : value;
    } }));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(listSharedSkills({ ...f.reader, engine: failing })).rejects.toMatchObject({ code: 'catalog_unavailable' });
}), 120_000);

test('initial pack artifacts and all revisions commit together and replay after compaction', () => fixture(async f => {
  const initial_files = packagedSharedSkills();
  const paths: string[] = JSON.parse(initial_files['skillpack.json']).skills;
  const options = { request_id: 'synthetic-default-pack', pack_id: 'gbrain-memory', initial_files,
    skills: paths.map(path => ({ pack_id: 'gbrain-memory', name: path.slice(7), expected_revision: null,
      files: [{ path: `${path}/SKILL.md`, content: initial_files[`${path}/SKILL.md`], file_class: 'prose' as const }] })) };
  const result = await adoptSharedSkillpack(f.local, 'default', options);
  expect(result.receipts).toHaveLength(1);
  expect((await listSharedSkills(f.reader)).skills).toHaveLength(3);
  expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe(initial_files['README.md']);
  expect(readFileSync(join(f.root, 'LICENSE'), 'utf8')).toBe(initial_files.LICENSE);
  expect((await f.engine.executeRaw('SELECT DISTINCT request_id FROM shared_skill_revisions')).length).toBe(1);
  await compactWriteReceipts(f.engine, 0);
  const replay = await adoptSharedSkillpack(f.local, 'default', options);
  expect(replay.receipts[0].revision).toBe(result.receipts[0].revision);
  expect(replay.receipts[0].compacted).toBe(true);
  expect((await f.engine.executeRaw('SELECT * FROM shared_skill_revisions')).length).toBe(3);
  const list = await skillsCatalogOperations.find(op => op.name === 'list_skills')!.handler(f.reader, {}) as { schema_version: number; skills: Array<{ name: string }> };
  expect(list.schema_version).toBe(1);
  expect(list.skills).toHaveLength(3);
  const detail = await skillsCatalogOperations.find(op => op.name === 'get_skill')!.handler(f.reader, { name: 'memory-recall' }) as { schema_version: number; body: string };
  expect(detail.schema_version).toBe(1);
  expect(detail.body).toBe(initial_files['skills/memory-recall/SKILL.md']);
  writeFileSync(join(f.root, 'skills/memory-recall/SKILL.md'), 'unpublished human edit');
  const sealed = await skillsCatalogOperations.find(op => op.name === 'get_skill')!.handler(f.reader, { name: 'memory-recall' }) as { body: string };
  expect(sealed.body).toBe(detail.body);
}), 120_000);

test('compacted shared edits retain every affected slug authorization', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  const path = 'skills/conventions/example.md';
  const files = (name: string, content: string): SharedSkillFileInput[] => [prose(name, 'Read convention', [path]), { path, content, file_class: 'reference' }];
  await put(f.local, 'alpha', files('alpha', 'original')); await put(f.local, 'beta', files('beta', 'original'));
  await f.engine.executeRaw("UPDATE oauth_clients SET bound_slug_prefixes=ARRAY['skills/'] WHERE client_id='editor'");
  const editor = { ...f.editor, auth: { ...f.editor.auth!, boundSlugPrefixes: ['skills/'] } };
  const old = await getSharedSkill(f.reader, { name: 'alpha' });
  const params = { request_id: randomUUID(), expected_revision: old.revision, source_id: 'default', source_incarnation: f.incarnation,
    name: 'alpha', pack_id: 'example-pack', files: files('alpha', 'shared new') };
  const receipt = await submitSharedSkillMutation(editor, 'put_skill', params);
  await compactWriteReceipts(f.engine, 0);
  await f.engine.executeRaw("UPDATE oauth_clients SET bound_slug_prefixes=ARRAY['skills/alpha/'] WHERE client_id='editor'");
  await expect(submitSharedSkillMutation(f.editor, 'put_skill', params)).rejects.toMatchObject({ code: 'permission_denied' });
  const [row] = await f.engine.executeRaw<{ authority: { skillSlugsUsed: string[] }; intent: unknown }>('SELECT authority,intent FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id]);
  expect(row.intent).toBeNull(); expect(row.authority.skillSlugsUsed).toEqual(['skills/alpha/SKILL.md', 'skills/beta/SKILL.md']);
}), 120_000);

test('legacy reader operation snapshots intersect live grants without breaking absent snapshots', () => fixture(async f => {
  await put(f.local, 'alpha');
  const id = randomUUID();
  await f.engine.executeRaw(`INSERT INTO access_tokens(id,name,token_hash,scopes,permissions)
    VALUES($1::uuid,'Synthetic legacy reader',$2,ARRAY['read'],$3::text::jsonb)`, [id, sha256(id), JSON.stringify({ source_id: 'default' })]);
  const legacy: OperationContext = { ...f.reader, auth: { token: 'synthetic-legacy', clientId: id,
    principal: { kind: 'legacy_token', id }, scopes: ['read'], sourceId: 'default' } };
  expect((await listSharedSkills(legacy)).skills).toHaveLength(1);
  await f.engine.executeRaw('UPDATE access_tokens SET permissions=$2::text::jsonb WHERE id=$1::uuid',
    [id, JSON.stringify({ source_id: 'default', allowed_operations: ['list_skills'] })]);
  expect((await listSharedSkills(legacy)).skills).toHaveLength(1);
  await expect(getSharedSkill(legacy, { name: 'alpha' })).rejects.toMatchObject({ code: 'permission_denied' });
  await f.engine.executeRaw('UPDATE access_tokens SET permissions=$2::text::jsonb WHERE id=$1::uuid',
    [id, JSON.stringify({ source_id: 'default', allowed_operations: [] })]);
  await expect(listSharedSkills(legacy)).rejects.toMatchObject({ code: 'permission_denied' });
}), 120_000);

test('historical requirements narrowed by publisher are unusable even if tool grant remains', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', { ...fullPolicy, requirements: ['tool:get_skill'] });
  await put(f.local, 'alpha', [prose('alpha')], { requirements: ['tool:get_skill'] });
  const old = await getSharedSkill(f.reader, { name: 'alpha' });
  expect(old.usable).toBe(true);
  await put(f.local, 'alpha', [prose('alpha', 'No longer needs tools')]);
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  const historical = await getSharedSkill(f.reader, { name: 'alpha', revision: old.revision });
  expect(historical.usable).toBe(false);
  expect(historical.unavailable_requirements).toEqual(['tool:get_skill']);
}), 120_000);

test('publication policy requires reviewed CAS and only one concurrent approval wins', () => fixture(async f => {
  const initial = await approvePolicy(f.local, 'default', fullPolicy, null);
  await expect(approvePolicy(f.local, 'default', fullPolicy)).rejects.toMatchObject({ code: 'revision_required' });
  await expect(approvePolicy(f.local, 'default', fullPolicy, null)).rejects.toMatchObject({ code: 'revision_conflict' });
  const results = await Promise.allSettled([
    approvePolicy(f.local, 'default', { ...fullPolicy, allow_follow: false }, initial.policy_epoch),
    approvePolicy(f.local, 'default', { ...fullPolicy, classes: ['prose'] }, initial.policy_epoch),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected' && result.reason.code === 'revision_conflict')).toHaveLength(1);
  const audit = await f.engine.executeRaw<{ principal_kind: string }>("SELECT principal_kind FROM shared_skill_policy_audit WHERE source_id='default'");
  expect(audit).toHaveLength(2); expect(audit.every(row => row.principal_kind === 'local_cli')).toBe(true);
  await f.engine.setConfig('mcp.publish_skills', 'false');
  const review = await getSharedSkillPolicy(f.local, 'default');
  expect(review.publication_enabled).toBe(false);
  expect(review.policy_epoch).not.toBe(initial.policy_epoch);
  await expect(getSharedSkillPolicy(f.editor, 'default')).rejects.toMatchObject({ code: 'permission_denied' });
}), 120_000);

test('reviewed legacy adoption inventory replays generated manifest changes but rejects human drift', () => fixture(async f => {
  mkdirSync(join(f.root, 'skills/alpha'), { recursive: true });
  const skill = prose('alpha').content;
  const manifest = JSON.stringify({ name: 'example-pack', brain_resident: true, skills: ['skills/alpha'] });
  writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skill); writeFileSync(join(f.root, 'skillpack.json'), manifest);
  const inventory = () => Object.fromEntries(['skillpack.json', 'skills/alpha/SKILL.md'].map(path => [path, sha256(readFileSync(join(f.root, path)))]));
  const original = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: inventory() });
  await compactWriteReceipts(f.engine, 0);
  const replay = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: inventory() });
  expect(replay.receipts[0].revision).toBe(original.receipts[0].revision);
  const reviewed = inventory();
  writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), `${skill}\nHuman edit`);
  await expect(adoptSharedSkillpack(f.local, 'default', { expected_hashes: reviewed })).rejects.toMatchObject({ code: 'local_conflict' });
}), 120_000);

test('retention preserves active heads, tombstones, delivery, explicit pins and pending publications until expiry', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  const original = await put(f.local, 'alpha');
  await joinBrain(f.local, { adapter: 'generic', follow_policy: { approved: true } });
  await joinBrain(f.local, { adapter: 'codex', follow_policy: { approved: true } });
  const [delivery] = await f.engine.executeRaw<{ expires_at: Date }>("SELECT expires_at FROM shared_skill_revision_leases WHERE lease_kind='delivery' AND revision=$1::uuid", [original.revision]);
  expect(delivery).toBeDefined();
  expect((await f.engine.executeRaw("SELECT revision FROM shared_skill_revision_leases WHERE lease_kind='delivery' AND revision=$1::uuid", [original.revision])).length).toBe(1);
  const tombstone = await submitSharedSkillMutation(f.local, 'delete_skill', { source_id: 'default', source_incarnation: f.incarnation,
    name: 'alpha', pack_id: 'example-pack', request_id: randomUUID(), expected_revision: original.revision });
  const pinned = await put(f.local, 'alpha', [prose('alpha', 'explicit pin')]);
  await retainSharedSkillRevision(f.local, { source_id: 'default', source_incarnation: f.incarnation,
    pack_id: 'example-pack', name: 'alpha', revision: String(pinned.revision), hours: 1 });
  const pendingRevision = await put(f.local, 'alpha', [prose('alpha', 'pending reference')]);
  let latest = pendingRevision;
  for (let index = 0; index < SHARED_SKILL_RETENTION_LIMITS.recentPerSkill + 2; index++) latest = await put(f.local, 'alpha', [prose('alpha', `revision-${index}`)]);
  await disposePersistenceConsumer(f.engine);
  await f.engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE shared_skill_revisions SET created_at=created_at-interval '48 hours' WHERE source_id='default'"));
  });
  const authority = await submissionAuthority(f.local, 'put_skill', 'default', f.incarnation, 'skills/alpha/SKILL.md');
  const binding = (await getWorktreeBinding(f.engine, 'default'))!;
  const pending = await admitWrite(f.engine, { operation: 'put_skill', sourceId: 'default', sourceIncarnation: f.incarnation,
    principal: authority.principal, authority, requestId: randomUUID(), slug: 'skills/alpha/SKILL.md', worktreeId: binding.worktree_id,
    topologyGeneration: binding.topology_generation, targetKind: 'skill_bundle', protocolVersion: 2,
    callerIntent: { fixture: 'pending retention reference' }, intent: { expected_revision: pendingRevision.revision, affected: [{ name: 'alpha', revision: pendingRevision.revision }] } });
  const pruned = await pruneSharedSkillRevisions(f.local);
  expect(pruned.pruned_revisions).toBe(2);
  expect(pruned.protected_heads).toBe(1); expect(pruned.protected_tombstones).toBe(1);
  expect(pruned.protected_leases).toBe(2); expect(pruned.protected_publications).toBe(1);
  for (const revision of [original.revision, pinned.revision, pendingRevision.revision, latest.revision]) {
    expect((await getSharedSkill(f.reader, { name: 'alpha', revision: String(revision) })).revision).toBe(String(revision));
  }
  expect((await f.engine.executeRaw('SELECT revision FROM shared_skill_revisions WHERE revision=$1::uuid', [tombstone.revision])).length).toBe(1);
  await f.engine.executeRaw("UPDATE shared_skill_revision_leases SET expires_at=now()-interval '1 minute' WHERE source_id='default'");
  await cancelWriteRequest(f.engine, authority.principal, pending.request_id);
  const expired = await pruneSharedSkillRevisions(f.local);
  expect(expired.pruned_revisions).toBe(3);
  await expect(getSharedSkill(f.reader, { name: 'alpha', revision: String(original.revision) })).rejects.toMatchObject({ code: 'revision_unavailable' });
  expect((await pruneSharedSkillRevisions(f.local)).pruned_revisions).toBe(0);
  const [before] = await f.engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM persistence_requests');
  await compactWriteReceipts(f.engine, 0); await compactWriteReceipts(f.engine, 0);
  const [after] = await f.engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM persistence_requests');
  expect(after.count).toBe(before.count);
  const replay = await submitSharedSkillMutation(f.local, 'put_skill', { request_id: original.request_id, expected_revision: null,
    source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name: 'alpha', files: [prose('alpha')] });
  expect(replay.revision).toBe(original.revision); expect(replay.compacted).toBe(true);
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).revision).toBe(String(latest.revision));
}), 120_000);

test('retention operator authority and bounded pin quota never extend fetch permission', () => fixture(async f => {
  await put(f.local, 'alpha');
  const detail = await getSharedSkill(f.reader, { name: 'alpha' });
  await expect(getSharedSkillRetention(f.reader)).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(pruneSharedSkillRevisions(f.editor)).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(retainSharedSkillRevision(f.reader, detail)).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(retainSharedSkillRevision(f.local, { ...detail, hours: 25 })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(retainSharedSkillRevision(f.local, { ...detail, revision: randomUUID() })).rejects.toMatchObject({ code: 'revision_unavailable' });
  for (let index = 0; index < SHARED_SKILL_RETENTION_LIMITS.principalPins; index++) await retainSharedSkillRevision(f.local, detail);
  await expect(retainSharedSkillRevision(f.local, detail)).rejects.toMatchObject({ code: 'skill_retention_capacity' });
  await f.engine.executeRaw("UPDATE oauth_clients SET deleted_at=now() WHERE client_id='reader'");
  await expect(getSharedSkill(f.reader, detail)).rejects.toMatchObject({ code: 'permission_denied' });
}), 120_000);

test('retention budget provides real backpressure before canonical file effects', () => fixture(async f => {
  await put(f.local, 'alpha');
  const before = await getSharedSkill(f.reader, { name: 'alpha' });
  await f.engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`INSERT INTO shared_skill_revisions
      (source_id,source_incarnation,pack_id,name,revision,metadata,files,policy_epoch,request_id)
      SELECT r.source_id,r.source_incarnation,r.pack_id,r.name,gen_random_uuid(),r.metadata,r.files,r.policy_epoch,r.request_id
      FROM shared_skill_revisions r CROSS JOIN generate_series(1,$1) n WHERE r.revision=$2::uuid`,
    [SHARED_SKILL_RETENTION_LIMITS.sourceRevisions - 1, before.revision]));
  });
  const status = await getSharedSkillRetention(f.local);
  expect(status.retained_revisions).toBe(SHARED_SKILL_RETENTION_LIMITS.sourceRevisions);
  expect(status.capacity_blocked).toBe(true);
  await expect(put(f.local, 'alpha', [prose('alpha', 'over budget')])).rejects.toMatchObject({ code: 'skill_retention_capacity' });
  expect(readFileSync(join(f.root, 'skills/alpha/SKILL.md'), 'utf8')).toBe(before.body);
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).revision).toBe(before.revision);
}), 120_000);

const postgresUrl = process.env.DATABASE_URL;
test.skipIf(!postgresUrl)('Postgres retention serializes delivery issuance against pruning and exact fetch', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  await put(f.local, 'alpha');
  const old = await getSharedSkill(f.reader, { name: 'alpha' });
  for (let index = 0; index < SHARED_SKILL_RETENTION_LIMITS.recentPerSkill + 2; index++) await put(f.local, 'alpha', [prose('alpha', `race-${index}`)]);
  await disposePersistenceConsumer(f.engine);
  const member = await joinBrain(f.local, { adapter: 'generic', follow_policy: { approved: true } });
  await f.engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE shared_skill_revisions SET created_at=created_at-interval '48 hours' WHERE source_id='default'"));
  });
  const key = `${[old.brain_id, old.source_id, old.source_incarnation, old.pack_id, old.name].map(encodeURIComponent).join('/')}@${old.revision}`;
  const insertBatch = (tx: BrainEngine, sequence: number) => tx.executeRaw(`INSERT INTO shared_skill_delivery_batches
    (token,installation_id,epoch,sequence,view_token,authority_digest,revisions)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,'synthetic-race',$6::text::jsonb)`,
  [randomUUID(), member.installation_id, member.enrollment_epoch, sequence, member.view_token, JSON.stringify([key])]);
  let locked!: () => void; const hasLock = new Promise<void>(resolve => { locked = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  const issued = f.engine.transaction(async tx => {
    await tx.executeRaw('SELECT revision FROM shared_skill_revisions WHERE revision=$1::uuid FOR KEY SHARE', [old.revision]);
    locked(); await released;
    await insertBatch(tx, 100);
  });
  await hasLock;
  try {
    await pruneSharedSkillRevisions(f.local);
    expect((await getSharedSkill(f.reader, { name: 'alpha', revision: old.revision })).revision).toBe(old.revision);
  } finally { release(); await issued; }
  expect((await pruneSharedSkillRevisions(f.local)).pruned_revisions).toBe(0);
  expect((await getSharedSkillRetention(f.local)).protected_leases).toBe(2);
  await f.engine.executeRaw("UPDATE shared_skill_revision_leases SET expires_at=now()-interval '1 minute' WHERE revision=$1::uuid", [old.revision]);
  expect((await pruneSharedSkillRevisions(f.local)).pruned_revisions).toBe(1);
  await expect(getSharedSkill(f.reader, { name: 'alpha', revision: old.revision })).rejects.toMatchObject({ code: 'revision_unavailable' });
  await expect(f.engine.transaction(tx => insertBatch(tx, 101))).rejects.toMatchObject({ code: '23503' });
  expect((await f.engine.executeRaw('SELECT revision FROM shared_skill_revision_leases WHERE revision=$1::uuid', [old.revision])).length).toBe(0);
}, postgresUrl), 120_000);

test.skipIf(!postgresUrl)('Postgres parity: canonical bundle, exact immutable asset and replay', () => fixture(async f => {
  await setSharedSkillPolicy(f.local, 'default', fullPolicy);
  const path = 'skills/alpha/assets/example.bin';
  const request_id = randomUUID();
  const files: SharedSkillFileInput[] = [prose('alpha', 'Binary fixture', [path]), { path, content: 'AAECAw==', encoding: 'base64', file_class: 'asset' }];
  const params = { request_id, expected_revision: null, name: 'alpha', pack_id: 'example-pack', source_id: 'default', source_incarnation: f.incarnation, files };
  const first = await submitSharedSkillMutation(f.editor, 'put_skill', params);
  const replay = await submitSharedSkillMutation(f.editor, 'put_skill', params);
  expect(first.revision).toBe(replay.revision);
  const detail = await getSharedSkill(f.reader, { name: 'alpha' });
  expect((await getSharedSkillAsset(f.reader, { ...detail, path })).content).toBe('AAECAw==');
  expect((await f.engine.executeRaw('SELECT * FROM shared_skill_revisions')).length).toBe(1);
  const beforeView = (await listSharedSkills(f.reader)).view_token;
  await put({ ...f.local, sourceId: 'hidden' }, 'alpha');
  expect((await listSharedSkills(f.reader)).view_token).toBe(beforeView);
  const lock = (await acquireWorktree((await getWorktreeBinding(f.engine, 'default'))!))!;
  const queuedId = randomUUID();
  const queued = put(f.editor, 'alpha', [prose('alpha', 'revoked')], { request_id: queuedId }).catch(error => error);
  try {
    await awaitAdmission(f.engine, [queuedId]);
    await f.engine.executeRaw("UPDATE oauth_clients SET scope='read write' WHERE client_id='editor'");
  } finally { await lock.release(); }
  expect((await queued).code).toBe('permission_denied');
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).revision).toBe(detail.revision);
  await setSharedSkillPolicy(f.local, 'default', { ...fullPolicy, classes: ['prose'] });
  expect((await getSharedSkill(f.reader, { name: 'alpha' })).files).toHaveLength(1);
  await expect(getSharedSkillAsset(f.reader, { ...detail, path })).rejects.toMatchObject({ code: 'skill_asset_not_found' });
}, postgresUrl), 120_000);
