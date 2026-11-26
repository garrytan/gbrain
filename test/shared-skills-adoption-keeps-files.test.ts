/**
 * Re-adopting a canonical pack after a reviewed edit keeps what the edit did not touch.
 *
 * 1. Protects: when the shared-content migration re-adopts a source's pack after the operator accepts a reviewed
 *    inventory edit (only one skill's SKILL.md changed), a reference file the skill published with put_skill stays in
 *    the canonical checkout and in the sealed revision, and a skill published private stays private to readers. A
 *    second re-adoption with nothing changed keeps the same head.
 * 2. Fails on: adoption rebuilding each skill from its SKILL.md alone, which deletes the skill's unchanged reference
 *    files from the checkout and publishes the skill as visible again.
 * 3. Existing coverage: test/shared-skills-catalog.test.ts adopts a fresh pack; test/shared-skills-pack-bounds-5476.test.ts
 *    adopts 75 prose-only skills. Neither re-adopts a skill that has reference files or a private flag.
 * 4. Seam: none. Real PGLite (and Postgres with DATABASE_URL) through isolatedSharedSkillsEngine and the canonical
 *    coordinator; the reviewed edit is a file write in the canonical checkout.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { adoptSharedSkillpack, submitSharedSkillMutation } from '../src/core/shared-skills/publication.ts';
import { listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { inventorySkillpack } from '../src/core/shared-skills/setup-files.ts';
import type { SharedSkillPolicy } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

const OPERATIONS = ['list_skills', 'get_skill', 'get_skill_asset', 'put_skill', 'delete_skill', 'set_skill_policy', 'list_brain_skillpack'];
const POLICY: SharedSkillPolicy = { version: 1, enabled: true, classes: ['prose', 'reference', 'asset', 'script'], audiences: ['readers'], requirements: [], allow_follow: true };
const REFERENCE = 'skills/alpha/references/guide.md';
const skillMd = (body: string) => `---\nname: alpha\ndescription: A synthetic fixture\ntriggers: [example task]\n---\n\n${body}\n`;

interface Fixture { engine: BrainEngine; root: string; local: OperationContext; reader: OperationContext; editor: OperationContext; incarnation: string }

async function fixture(run: (f: Fixture) => Promise<void>, databaseUrl?: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-adoption-keeps-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine(databaseUrl);
      const engine = isolated.engine;
      try {
        const root = join(dir, 'default'); mkdirSync(root);
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        await engine.setConfig('mcp.publish_skills', 'true');
        const local: OperationContext = { engine, config: { engine: databaseUrl ? 'postgres' : 'pglite' }, remote: false,
          sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations,bound_slug_prefixes)
          VALUES('reader','Synthetic reader','read','default',$1::text[],NULL),('editor','Synthetic editor','read write skill_editor','default',$1::text[],ARRAY['skills/alpha/'])`, [OPERATIONS]);
        const remote = (id: string, scopes: string[]): OperationContext => ({ ...local, remote: true,
          auth: { token: 'synthetic', clientId: id, principal: { kind: 'oauth_client', id }, scopes, sourceId: 'default', allowedOperations: OPERATIONS,
            ...(id === 'editor' ? { boundSlugPrefixes: ['skills/alpha/'] } : {}) } } as OperationContext);
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
        await setSharedSkillPolicy(local, 'default', POLICY, null);
        await run({ engine, root, local, reader: remote('reader', ['read']), editor: remote('editor', ['read', 'write', 'skill_editor']), incarnation: source.incarnation });
      } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Publishes alpha with a reference file through put_skill, then accepts a reviewed edit to its SKILL.md and re-adopts. */
async function readoptAfterEdit(f: Fixture, extra: Record<string, unknown>) {
  const published = await submitSharedSkillMutation(f.editor, 'put_skill', { request_id: randomUUID(), expected_revision: null,
    source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name: 'alpha',
    files: [{ path: 'skills/alpha/SKILL.md', content: skillMd('Use the guide.'), file_class: 'prose', depends_on: [REFERENCE] },
      { path: REFERENCE, content: 'Guide body', file_class: 'reference' }], ...extra });
  expect((published as { state?: string }).state).toBe('committed');
  const manifest = JSON.parse(readFileSync(join(f.root, 'skillpack.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ ...manifest, brain_resident: true }, null, 2)}\n`);
  const visibleBefore = (await listSharedSkills(f.reader)).skills.map(skill => skill.name);
  // The reviewed edit: only SKILL.md's prose changes, and the operator accepts the inventory it produced.
  writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Use the guide, carefully.'));
  const reviewed = inventorySkillpack(f.root)!;
  const adopted = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: reviewed.hashes });
  return { visibleBefore, adopted,
    referenceOnDisk: existsSync(join(f.root, REFERENCE)) ? readFileSync(join(f.root, REFERENCE), 'utf8') : null,
    skillOnDisk: readFileSync(join(f.root, 'skills/alpha/SKILL.md'), 'utf8'),
    visibleAfter: (await listSharedSkills(f.reader)).skills.map(skill => skill.name) };
}

const backends: Array<[string, string | undefined]> = [['PGLite', undefined], ...(process.env.DATABASE_URL ? [['Postgres', process.env.DATABASE_URL] as [string, string]] : [])];

for (const [name, url] of backends) {
  describe(`re-adoption after a reviewed SKILL.md edit (${name})`, () => {
    // Value: protects=an accepted SKILL.md edit never deletes the skill's unchanged reference files; fails_when=re-adoption rebuilds the skill from SKILL.md alone; why_new=no test re-adopted a skill with reference files; seam=none; no_claim=a reviewed edit that itself removes a reference
    test('the reference file stays in the checkout and the edited prose is adopted', () => fixture(async f => {
      const result = await readoptAfterEdit(f, {});
      expect({ reference: result.referenceOnDisk, skill: result.skillOnDisk })
        .toEqual({ reference: 'Guide body', skill: skillMd('Use the guide, carefully.') });
    }, url), 120_000);

    // Value: protects=a skill published private stays private after re-adoption; fails_when=re-adoption drops the put_skill private flag and readers see the skill; why_new=no test re-adopted a private skill; seam=none; no_claim=a manifest exclusion change
    test('a skill published private stays hidden from readers', () => fixture(async f => {
      const result = await readoptAfterEdit(f, { private: true });
      expect({ before: result.visibleBefore, after: result.visibleAfter }).toEqual({ before: [], after: [] });
    }, url), 120_000);

    // Value: protects=a second re-adoption with nothing changed publishes nothing new and exposes nothing; fails_when=it writes a new revision, deletes the reference file or shows the private skill; why_new=no test re-adopted twice; seam=none; no_claim=none
    test('a second re-adoption with nothing changed keeps the same head, the reference file and the private flag', () => fixture(async f => {
      const first = await readoptAfterEdit(f, { private: true });
      const head = async () => (await f.engine.executeRaw<{ revision: string }>('SELECT revision FROM shared_skill_heads WHERE source_id=$1 AND name=$2', ['default', 'alpha']))[0]?.revision;
      const afterFirst = await head();
      const again = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: inventorySkillpack(f.root)!.hashes });
      expect({ committed: again.receipts.every(receipt => (receipt.write_request as { state?: string } | undefined)?.state === 'committed'),
        head: await head(), reference: readFileSync(join(f.root, REFERENCE), 'utf8'), visible: (await listSharedSkills(f.reader)).skills.map(skill => skill.name) })
        .toEqual({ committed: true, head: afterFirst, reference: 'Guide body', visible: [] });
      expect(first.visibleAfter).toEqual([]);
    }, url), 120_000);
  });
}
