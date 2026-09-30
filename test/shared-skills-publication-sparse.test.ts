import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { SharedSkillFileInput } from '../src/core/shared-skills/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { adoptSharedSkillpack, submitSharedSkillMutation } from '../src/core/shared-skills/publication.ts';
import { getSharedSkill, getSharedSkillAsset } from '../src/core/shared-skills/catalog.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const prose = (name: string, body = 'Synthetic prose', depends_on: string[] = []): SharedSkillFileInput => ({
  path: `skills/${name}/SKILL.md`, content: `---\nname: ${name}\n---\n${body}\n`, file_class: 'prose', depends_on,
});
interface ReadObservation { requested: unknown; names: string[]; bytes: number; }
interface Fixture {
  engine: BrainEngine; root: string; local: OperationContext; editor: OperationContext; incarnation: string;
  observed: ReadObservation[]; queries: string[]; observe(): void;
  put(ctx: OperationContext, name: string, files: SharedSkillFileInput[]): Promise<Record<string, unknown>>;
}
async function fixture(run: (fixture: Fixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'gbrain-sparse-skill-publication-'));
  try {
    await withEnv({ GBRAIN_HOME: join(directory, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine();
      let recording = false;
      const observed: ReadObservation[] = []; const queries: string[] = [];
      const wrap = (target: BrainEngine): BrainEngine => new Proxy(target, { get(object, property, receiver) {
        const original = Reflect.get(object, property, receiver);
        if (property === 'transaction') return function<T>(this: BrainEngine, callback: (tx: BrainEngine) => Promise<T>): Promise<T> {
          return original.call(this, (tx: BrainEngine) => callback(wrap(tx)));
        };
        if (property === 'executeRaw') return async function(this: BrainEngine, sql: string, params?: unknown[]) {
          const rows = await original.call(this, sql, params);
          if (recording) {
            queries.push(sql);
            if (sql.startsWith('SELECT r.* FROM shared_skill_heads h JOIN shared_skill_revisions r')) {
              observed.push({ requested: params?.[3], names: rows.map((row: { name: string }) => row.name), bytes: Buffer.byteLength(JSON.stringify(rows)) });
            }
          }
          return rows;
        };
        return original;
      } });
      const engine = wrap(isolated.engine);
      try {
        const root = join(directory, 'content'); mkdirSync(root);
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        await engine.setConfig('mcp.publish_skills', 'true');
        const local: OperationContext = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false,
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await setSharedSkillPolicy(local, 'default', { version: 1, enabled: true, classes: ['prose', 'reference', 'asset'], audiences: ['readers'], requirements: [], allow_follow: true }, null);
        const operations = ['list_skills', 'get_skill', 'get_skill_asset', 'put_skill', 'delete_skill'];
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations,bound_slug_prefixes)
          VALUES('sparse-editor','Synthetic scoped editor','read write skill_editor','default',$1::text[],ARRAY['skills/alpha/'])`, [operations]);
        const editor: OperationContext = { ...local, remote: true, auth: { token: 'synthetic', clientId: 'sparse-editor', principal: { kind: 'oauth_client', id: 'sparse-editor' },
          sourceId: 'default', scopes: ['read', 'write', 'skill_editor'], allowedOperations: operations, boundSlugPrefixes: ['skills/alpha/'] } };
        const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
        await run({ engine, root, local, editor, incarnation: source.incarnation, observed, queries,
          observe() { observed.length = 0; queries.length = 0; recording = true; },
          async put(ctx, name, files) {
            const [head] = await engine.executeRaw<{ revision: string }>("SELECT revision FROM shared_skill_heads WHERE source_id='default' AND name=$1", [name]);
            return submitSharedSkillMutation(ctx, 'put_skill', { name, pack_id: 'sparse-pack', source_id: 'default', source_incarnation: source.incarnation,
              expected_revision: head?.revision ?? null, request_id: randomUUID(), files });
          },
        });
      } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function manifest(root: string) {
  return JSON.parse(readFileSync(join(root, 'skillpack.json'), 'utf8')) as { skills: string[]; shared_skills: { skills: Array<{ name: string; revision: string; files: Array<{ path: string }> }> } };
}

test('publication stores one proposal copy and preserves custom manifest fields with compact per-skill inventory', () => fixture(async f => {
  const custom = { license: 'Synthetic license', notes: { text: 'Quoted "fixture"\nwith a second line' } };
  await adoptSharedSkillpack(f.local, 'default', { pack_id: 'sparse-pack',
    skills: [{ name: 'alpha', pack_id: 'sparse-pack', expected_revision: null, files: [prose('alpha')] }],
    initial_files: { 'skillpack.json': JSON.stringify({ name: 'sparse-pack', brain_resident: true, skills: ['skills/alpha'], ...custom }) } });
  await f.put(f.local, 'beta', [prose('beta')]);
  const published = await f.put(f.editor, 'alpha', [prose('alpha', 'Changed synthetic instructions')]);
  const [row] = await f.engine.executeRaw<{ intent: Record<string, any> }>('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [published.request_id]);
  expect(row.intent).not.toHaveProperty('files');
  expect(row.intent).not.toHaveProperty('metadata');
  expect(row.intent.original_manifest).not.toHaveProperty('skills');
  expect(row.intent.original_manifest).not.toHaveProperty('shared_skills');
  expect(row.intent.proposals).toHaveLength(1);
  expect(row.intent.proposals[0].files).toHaveLength(1);
  const text = readFileSync(join(f.root, 'skillpack.json'), 'utf8');
  expect(JSON.parse(text)).toMatchObject(custom);
  expect(JSON.parse(text).skills).toEqual(['skills/alpha', 'skills/beta']);
  expect(JSON.parse(text).shared_skills.skills).toHaveLength(2);
  expect(text.split('\n').filter(line => line.startsWith('    {"name":'))).toHaveLength(2);
}), 120_000);
function expectOnlyReads(f: Fixture, expected: string[]) {
  expect(f.observed.length).toBeGreaterThan(0);
  for (const read of f.observed) {
    expect(Array.isArray(read.requested)).toBe(true);
    expect(read.names.every(name => expected.includes(name))).toBe(true);
    expect((read.requested as string[]).every(name => expected.includes(name))).toBe(true);
  }
}

test('skill-local edits, shared-file removal and recreation read only the target revision bytes', () => fixture(async f => {
  const convention = 'skills/conventions/shared.md';
  const files = (name: string, body: string) => [prose(name, body, [convention]), { path: convention, content: 'Unchanged shared convention', file_class: 'reference' as const }];
  await f.put(f.local, 'alpha', files('alpha', 'Original alpha'));
  await f.put(f.local, 'beta', files('beta', 'Unchanged beta'));
  for (let index = 0; index < 6; index++) {
    const name = `untouched-${index}`;
    await f.put(f.local, name, [prose(name, 'Unrelated fixture content. '.repeat(4000))]);
  }
  const before = manifest(f.root).shared_skills.skills.filter(skill => skill.name !== 'alpha');
  const originalFiles = new Map(before.flatMap(skill => skill.files.map(file => [file.path, sha256(readFileSync(join(f.root, file.path)))] as const)));
  f.observe();
  const changed = await f.put(f.editor, 'alpha', files('alpha', 'Updated alpha'));
  expectOnlyReads(f, ['alpha']);
  expect(f.observed.flatMap(read => read.names)).toEqual(['alpha', 'alpha']);
  expect(f.observed.reduce((bytes, read) => bytes + read.bytes, 0)).toBeLessThan(16 * 1024);
  expect(f.queries.some(sql => sql.includes('AS protected_heads'))).toBe(false);
  expect(changed.retention).toBeUndefined();
  expect(manifest(f.root).shared_skills.skills.filter(skill => skill.name !== 'alpha')).toEqual(before);
  for (const [path, hash] of originalFiles) expect(sha256(readFileSync(join(f.root, path)))).toBe(hash);
  f.observe();
  const detached = await f.put(f.editor, 'alpha', [prose('alpha', 'No shared dependency')]);
  expectOnlyReads(f, ['alpha']);
  expect(readFileSync(join(f.root, convention), 'utf8')).toBe('Unchanged shared convention');
  expect(manifest(f.root).shared_skills.skills.filter(skill => skill.name !== 'alpha')).toEqual(before);
  f.observe();
  const deleted = await submitSharedSkillMutation(f.editor, 'delete_skill', { name: 'alpha', pack_id: 'sparse-pack', source_id: 'default', source_incarnation: f.incarnation,
    expected_revision: detached.revision, request_id: randomUUID() });
  expectOnlyReads(f, ['alpha']);
  expect(manifest(f.root).shared_skills.skills).toEqual(before);
  f.observe();
  const recreated = await f.put(f.editor, 'alpha', [prose('alpha', 'Recreated alpha')]);
  expectOnlyReads(f, ['alpha']); expect(recreated.revision).not.toBe(deleted.revision);
  expect(manifest(f.root).shared_skills.skills.filter(skill => skill.name !== 'alpha')).toEqual(before);
  for (const [path, hash] of originalFiles) expect(sha256(readFileSync(join(f.root, path)))).toBe(hash);
}), 120_000);

test('shared changes load every authorized transitive dependent and no unrelated body', () => fixture(async f => {
  const outer = 'skills/conventions/outer.md'; const inner = 'skills/conventions/inner.md'; const added = 'skills/conventions/added.md';
  const shared = (name: string, next: boolean): SharedSkillFileInput[] => [prose(name, 'Uses shared closure', [outer]),
    { path: outer, content: 'Outer convention', file_class: 'reference', depends_on: [inner] },
    { path: inner, content: next ? 'Changed inner convention' : 'Original inner convention', file_class: 'reference', depends_on: next ? [added] : [] },
    ...(next ? [{ path: added, content: 'New transitive helper', file_class: 'reference' as const }] : [])];
  await f.put(f.local, 'alpha', shared('alpha', false)); await f.put(f.local, 'beta', shared('beta', false));
  await f.put(f.local, 'gamma', [prose('gamma', 'Directly uses inner', [inner]), { path: inner, content: 'Original inner convention', file_class: 'reference' }]);
  await f.put(f.local, 'untouched', [prose('untouched', 'Unrelated fixture. '.repeat(4000))]);
  const unchanged = manifest(f.root).shared_skills.skills.find(skill => skill.name === 'untouched');
  const diskBefore = readFileSync(join(f.root, 'skillpack.json'), 'utf8');
  f.observe();
  await expect(f.put(f.editor, 'alpha', shared('alpha', true))).rejects.toMatchObject({ code: 'permission_denied' });
  expectOnlyReads(f, ['alpha']);
  expect(readFileSync(join(f.root, 'skillpack.json'), 'utf8')).toBe(diskBefore);
  expect(existsSync(join(f.root, added))).toBe(false);
  await f.engine.executeRaw("UPDATE oauth_clients SET bound_slug_prefixes=ARRAY['skills/'] WHERE client_id='sparse-editor'");
  const editor = { ...f.editor, auth: { ...f.editor.auth!, boundSlugPrefixes: ['skills/'] } };
  f.observe();
  const result = await f.put(editor, 'alpha', shared('alpha', true));
  expectOnlyReads(f, ['alpha', 'beta', 'gamma']);
  expect(f.observed.flatMap(read => read.names).sort()).toEqual(['alpha', 'alpha', 'beta', 'beta', 'gamma', 'gamma']);
  expect((result.affected_skills as Array<{ name: string }>).map(skill => skill.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  for (const name of ['beta', 'gamma']) {
    const detail = await getSharedSkill(editor, { name });
    expect(detail.files.map(file => file.path)).toContain(added);
    const asset = await getSharedSkillAsset(editor, { ...detail, path: added });
    expect(Buffer.from(asset.content, 'base64').toString()).toBe('New transitive helper');
  }
  expect(manifest(f.root).shared_skills.skills.find(skill => skill.name === 'untouched')).toEqual(unchanged);
  f.observe();
  await f.put(editor, 'alpha', shared('alpha', false));
  expectOnlyReads(f, ['alpha', 'beta', 'gamma']); expect(existsSync(join(f.root, added))).toBe(false);
  expect(manifest(f.root).shared_skills.skills.find(skill => skill.name === 'untouched')).toEqual(unchanged);
}), 120_000);

test('an incomplete sealed inventory fails closed rather than dropping an unaffected manifest entry', () => fixture(async f => {
  await f.put(f.local, 'alpha', [prose('alpha')]); await f.put(f.local, 'beta', [prose('beta')]);
  const diskBefore = readFileSync(join(f.root, 'skillpack.json'), 'utf8');
  const damaged = manifest(f.root); damaged.shared_skills.skills = damaged.shared_skills.skills.filter(skill => skill.name !== 'beta');
  await f.engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE shared_skill_packs SET manifest=$1::text::jsonb WHERE source_id='default'", [JSON.stringify(damaged)]));
  });
  f.observe();
  await expect(f.put(f.editor, 'alpha', [prose('alpha', 'Must not commit')])).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(f.observed).toEqual([]);
  expect(readFileSync(join(f.root, 'skillpack.json'), 'utf8')).toBe(diskBefore);
  expect(readFileSync(join(f.root, 'skills/alpha/SKILL.md'), 'utf8')).toBe(prose('alpha').content);
}), 120_000);
