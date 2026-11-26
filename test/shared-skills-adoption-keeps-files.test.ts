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
import { execFileSync } from 'node:child_process';
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
import { getSharedSkill, listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { inventorySkillpack } from '../src/core/shared-skills/setup-files.ts';
import { runSharedSkillsMigration } from '../src/core/shared-skills/migration.ts';
import type { SharedSkillPolicy } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

const OPERATIONS = ['list_skills', 'get_skill', 'get_skill_asset', 'put_skill', 'delete_skill', 'set_skill_policy', 'list_brain_skillpack'];
const POLICY: SharedSkillPolicy = { version: 1, enabled: true, classes: ['prose', 'reference', 'asset', 'script'], audiences: ['readers', 'oauth_client:editor'], requirements: ['tool:get_page'], allow_follow: true };
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
        // Its own Git root, so the worktree claim never walks up to a checkout that holds the temp dir (TMPDIR inside a repo).
        execFileSync('git', ['init', '-q', root]);
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


/** Publishes alpha (SKILL.md depending on one reference file) through put_skill and marks the pack brain-resident. */
async function publishWithReference(f: Fixture, extra: Record<string, unknown> = {}) {
  await submitSharedSkillMutation(f.editor, 'put_skill', { request_id: randomUUID(), expected_revision: null,
    source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name: 'alpha',
    files: [{ path: 'skills/alpha/SKILL.md', content: skillMd('Use the guide.'), file_class: 'prose', depends_on: [REFERENCE] },
      { path: REFERENCE, content: 'Guide body', file_class: 'reference' }], ...extra });
  const manifest = JSON.parse(readFileSync(join(f.root, 'skillpack.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ ...manifest, brain_resident: true }, null, 2)}\n`);
}
const HEAD_SQL = `SELECT r.revision,r.files,r.metadata FROM shared_skill_heads h JOIN shared_skill_revisions r
  ON r.source_id=h.source_id AND r.source_incarnation=h.source_incarnation AND r.pack_id=h.pack_id AND r.name=h.name AND r.revision=h.revision
  WHERE h.source_id=$1 AND h.name=$2`;
async function headRow(f: Fixture) {
  return (await f.engine.executeRaw<{ revision: string; files: Array<{ path: string; content: string }>; metadata: { requirements: string[]; tools_declared: boolean } }>(HEAD_SQL, ['default', 'alpha']))[0];
}
const headFiles = async (f: Fixture) => (await headRow(f)).files;
const headMetadata = async (f: Fixture) => (await headRow(f)).metadata;
const headRevision = async (f: Fixture) => (await headRow(f)).revision;
/** The digest the migration names in its conflict message, for --accept-reviewed-inventory. */
async function acceptableDigest(f: Fixture): Promise<string> {
  const report = await runSharedSkillsMigration(f.local);
  const reason = report.sources.find(row => row.source_id === 'default')?.stages.map(stage => stage.reason ?? '').join(' ') ?? '';
  const match = /--accept-reviewed-inventory default=([a-f0-9]{64})/.exec(reason);
  expect(match).not.toBeNull();
  return match![1];
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

    // Value: protects=an adoption retried after it committed replays its receipt; fails_when=the carried sealed state changes the request and a second revision is published; why_new=no test adopted a fresh pack twice through this path; seam=none; no_claim=none
    test('a fresh adoption retried after it committed replays the same revision', () => fixture(async f => {
      mkdirSync(join(f.root, 'skills/alpha'), { recursive: true });
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Fresh instructions.'));
      writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ name: 'example-pack', brain_resident: true, skills: ['skills/alpha'] }, null, 2)}\n`);
      const revision = (result: Awaited<ReturnType<typeof adoptSharedSkillpack>>) => (result.receipts[0] as { revision?: string }).revision;
      const first = await adoptSharedSkillpack(f.local, 'default');
      const again = await adoptSharedSkillpack(f.local, 'default');
      expect({ first: revision(first), again: revision(again), requests: again.receipts.length }).toEqual({ first: revision(first), again: revision(first), requests: 1 });
      expect(revision(first)).toBeString();
    }, url), 120_000);

    // Value: protects=a fresh adoption of a skill private through its frontmatter replays its receipt; fails_when=the carried private flag changes the request and a second revision is published; why_new=no test retried a frontmatter-private adoption; seam=none; no_claim=none
    test('a fresh adoption of a frontmatter-private skill retried after it committed replays the same revision', () => fixture(async f => {
      mkdirSync(join(f.root, 'skills/alpha'), { recursive: true });
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), `---\nname: alpha\ndescription: A synthetic fixture\nprivate: true\n---\n\nPrivate instructions.\n`);
      writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ name: 'example-pack', brain_resident: true, skills: ['skills/alpha'] }, null, 2)}\n`);
      const revision = (result: Awaited<ReturnType<typeof adoptSharedSkillpack>>) => (result.receipts[0] as { revision?: string }).revision;
      const first = await adoptSharedSkillpack(f.local, 'default');
      const again = await adoptSharedSkillpack(f.local, 'default');
      expect({ same: revision(again) === revision(first), visible: (await listSharedSkills(f.reader)).skills.map(skill => skill.name) })
        .toEqual({ same: true, visible: [] });
    }, url), 120_000);

    // Value: protects=re-adoption keeps a file's restricted audience and media type, so a reader sees no more than before; fails_when=the carried file falls back to the readers audience or the default media type; why_new=no test re-adopted a restricted file; seam=none; no_claim=none
    test('a reference file with a restricted audience and its own media type keeps both, and readers see no more', () => fixture(async f => {
      await submitSharedSkillMutation(f.editor, 'put_skill', { request_id: randomUUID(), expected_revision: null,
        source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name: 'alpha',
        files: [{ path: 'skills/alpha/SKILL.md', content: skillMd('Use the guide.'), file_class: 'prose', depends_on: [REFERENCE] },
          { path: REFERENCE, content: 'Guide body', file_class: 'reference', audience: ['oauth_client:editor'], media_type: 'text/plain' }] });
      const manifest = JSON.parse(readFileSync(join(f.root, 'skillpack.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ ...manifest, brain_resident: true }, null, 2)}\n`);
      const readerFiles = async () => (await getSharedSkill(f.reader, { name: 'alpha' })).files.map((file: { path: string }) => file.path).sort();
      const before = await readerFiles();
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Use the guide, carefully.'));
      await adoptSharedSkillpack(f.local, 'default', { expected_hashes: inventorySkillpack(f.root)!.hashes });
      const head = (await f.engine.executeRaw<{ files: Array<{ path: string; audience: string[]; media_type: string }> }>(`SELECT r.files FROM shared_skill_heads h JOIN shared_skill_revisions r
        ON r.source_id=h.source_id AND r.source_incarnation=h.source_incarnation AND r.pack_id=h.pack_id AND r.name=h.name AND r.revision=h.revision
        WHERE h.source_id=$1 AND h.name=$2`, ['default', 'alpha']))[0];
      const reference = head.files.find(file => file.path === REFERENCE);
      expect({ audience: reference?.audience, media_type: reference?.media_type, readerBefore: before, readerAfter: await readerFiles() })
        .toEqual({ audience: ['oauth_client:editor'], media_type: 'text/plain', readerBefore: before, readerAfter: before });
      expect(before).not.toContain(REFERENCE);
    }, url), 120_000);

    // Value: protects=removing a guide never deletes a nested file the operator kept; fails_when=adoption drops the unreachable nested file and the publisher unlinks it; why_new=no test removed a transitive dependency; seam=none; no_claim=none
    test('a reviewed removal of a guide refuses while a file only it reached is still in the checkout, and deletes nothing', () => fixture(async f => {
      const NESTED = 'skills/alpha/references/nested.md';
      await submitSharedSkillMutation(f.editor, 'put_skill', { request_id: randomUUID(), expected_revision: null,
        source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name: 'alpha',
        files: [{ path: 'skills/alpha/SKILL.md', content: skillMd('Use the guide.'), file_class: 'prose', depends_on: [REFERENCE] },
          { path: REFERENCE, content: 'Guide body', file_class: 'reference', depends_on: [NESTED] },
          { path: NESTED, content: 'Nested body', file_class: 'reference' }] });
      const manifest = JSON.parse(readFileSync(join(f.root, 'skillpack.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ ...manifest, brain_resident: true }, null, 2)}\n`);
      rmSync(join(f.root, REFERENCE));
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('No guide any more.'));
      const reviewed = inventorySkillpack(f.root)!;
      // The nested file is still in the checkout, and nothing names it any more: adoption must not delete it.
      const outcome = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: { ...reviewed.hashes, [REFERENCE]: null } })
        .then(() => 'adopted', (error: { code?: string }) => error.code);
      expect({ outcome, reference: existsSync(join(f.root, REFERENCE)), nested: existsSync(join(f.root, NESTED)) ? readFileSync(join(f.root, NESTED), 'utf8') : null })
        .toEqual({ outcome: 'local_conflict', reference: false, nested: 'Nested body' });
    }, url), 120_000);

    // Value: protects=adoption publishes exactly the bytes whose hash was reviewed; fails_when=a carried file read before admission differs from the reviewed bytes that admission re-reads; why_new=no test changed a file between the carry read and admission; seam=the file is swapped back when adoption looks up its request; no_claim=none
    test('a carried file changed between the carry read and admission is never published', () => fixture(async f => {
      await publishWithReference(f);
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Use the guide, carefully.'));
      writeFileSync(join(f.root, REFERENCE), 'Reviewed guide');
      const reviewed = inventorySkillpack(f.root)!;
      writeFileSync(join(f.root, REFERENCE), 'Unreviewed guide');
      const raw = f.engine.executeRaw.bind(f.engine);
      let swapped = false;
      (f.engine as { executeRaw: unknown }).executeRaw = async (sql: string, ...rest: unknown[]) => {
        if (!swapped && sql.startsWith('SELECT * FROM persistence_requests WHERE principal_kind')) { swapped = true; writeFileSync(join(f.root, REFERENCE), 'Reviewed guide'); }
        return (raw as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
      };
      const outcome = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: reviewed.hashes })
        .then(() => 'adopted', (error: { code?: string }) => error.code);
      (f.engine as { executeRaw: unknown }).executeRaw = raw;
      const sealed = (await headFiles(f)).find(file => file.path === REFERENCE);
      // The unreviewed bytes are refused before admission; the sealed reference is still the published one.
      expect({ outcome, sealed: sealed ? Buffer.from(sealed.content, 'base64').toString() : null }).toEqual({ outcome: 'local_conflict', sealed: 'Guide body' });
    }, url), 120_000);

    // Value: protects=re-adoption keeps the tool requirements put_skill published; fails_when=requirements become [] and tools_declared false, so the catalog offers every tool; why_new=no test re-adopted a skill with requirements; seam=none; no_claim=none
    test('re-adoption keeps the requirements and tools_declared put_skill published', () => fixture(async f => {
      await publishWithReference(f, { requirements: ['tool:get_page'] });
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Use the guide, carefully.'));
      await adoptSharedSkillpack(f.local, 'default', { expected_hashes: inventorySkillpack(f.root)!.hashes });
      const metadata = await headMetadata(f);
      expect({ requirements: metadata.requirements, tools_declared: metadata.tools_declared }).toEqual({ requirements: ['tool:get_page'], tools_declared: true });
    }, url), 120_000);

    // Value: protects=the migration adopts a reviewed removal of a reference file; fails_when=its accepted inventory has no entry for the removed path and adoption refuses local_conflict; why_new=no test removed a file through the migration; seam=none; no_claim=none
    test('the migration adopts an accepted inventory that removes a reference file', () => fixture(async f => {
      await publishWithReference(f);
      expect((await runSharedSkillsMigration(f.local)).sources.find(row => row.source_id === 'default')?.inventory).toBeTruthy();
      rmSync(join(f.root, REFERENCE));
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('No guide any more.').replace('triggers: [example task]\n', 'triggers: [example task]\n'));
      const digest = await acceptableDigest(f);
      const accepted = await runSharedSkillsMigration(f.local, { acceptReviewedInventory: { default: digest } });
      const row = accepted.sources.find(source => source.source_id === 'default')!;
      expect({ conflict: row.stages.some(stage => stage.status === 'conflict'), sealedPaths: (await headFiles(f)).map(file => file.path).sort() })
        .toEqual({ conflict: false, sealedPaths: ['skills/alpha/SKILL.md'] });
    }, url), 120_000);

    // Value: protects=an accepted edit to a reference file alone is published; fails_when=the migration marks projection complete while the sealed revision still serves the old reference; why_new=no test edited only a reference file; seam=none; no_claim=none
    test('the migration publishes an accepted edit to a reference file alone', () => fixture(async f => {
      await publishWithReference(f);
      await runSharedSkillsMigration(f.local);
      writeFileSync(join(f.root, REFERENCE), 'Guide body, revised');
      const digest = await acceptableDigest(f);
      await runSharedSkillsMigration(f.local, { acceptReviewedInventory: { default: digest } });
      const sealed = (await headFiles(f)).find(file => file.path === REFERENCE);
      expect(sealed ? Buffer.from(sealed.content, 'base64').toString() : null).toBe('Guide body, revised');
    }, url), 120_000);

    // Value: protects=a re-adoption over the journal byte limit refuses by name, publishes nothing and deletes nothing; fails_when=it commits a partial revision or removes a checkout file; why_new=pins the fail-closed path until shared files are stored once per publication; seam=persistence.limits.principal_intent_bytes is lowered after the first publication; no_claim=packs that fit the default 64 MiB limit
    test('a re-adoption over the journal byte limit refuses queue_capacity, publishes nothing and deletes nothing', () => fixture(async f => {
      await publishWithReference(f);
      const before = await headRevision(f);
      await f.engine.setConfig('persistence.limits.principal_intent_bytes', '2048');
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd(`Use the guide, carefully. ${'x'.repeat(4096)}`));
      const outcome = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: inventorySkillpack(f.root)!.hashes })
        .then(() => 'adopted', (error: { code?: string }) => error.code);
      expect({ outcome, head: await headRevision(f), reference: readFileSync(join(f.root, REFERENCE), 'utf8'), skill: readFileSync(join(f.root, 'skills/alpha/SKILL.md'), 'utf8').includes('carefully') })
        .toEqual({ outcome: 'queue_capacity', head: before, reference: 'Guide body', skill: true });
    }, url), 120_000);
  });
}
