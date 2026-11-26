/**
 * Re-adopting a canonical pack never loses what a sealed skill was published with.
 *
 * 1. Protects: a pack adoption republishes each declared skill from its SKILL.md alone. For a sealed skill that holds
 *    more (other files, a private flag, requirements or routing put_skill supplied, a SKILL.md audience, media type or
 *    dependency of its own), re-adoption after a reviewed SKILL.md edit refuses by name: it writes nothing, deletes no
 *    checkout file, leaves the sealed revision as it was, and readers see no more than before. A new skill and a
 *    prose-only sealed skill still adopt; a retried adoption replays its receipt; a SKILL.md changed after review is
 *    refused; a re-adoption over the journal byte limit refuses and writes nothing.
 * 2. Fails on: re-adoption deleting a skill's other files from the checkout, publishing a private skill as visible,
 *    dropping requirements or routing, widening a SKILL.md audience, or publishing unreviewed bytes.
 * 3. Existing coverage: test/shared-skills-catalog.test.ts adopts a fresh pack; test/shared-skills-pack-bounds-5476.test.ts
 *    adopts 75 prose-only skills. Neither re-adopts a skill that holds more than its SKILL.md.
 * 4. Seam: none, except the one swap test, which changes SKILL.md back to its reviewed bytes when adoption looks up its
 *    request. Real PGLite (and Postgres with DATABASE_URL) through isolatedSharedSkillsEngine and the canonical
 *    coordinator.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { adoptSharedSkillpack, importSharedSkillProposal, prepareSharedSkillMutation, submitSharedSkillMutation } from '../src/core/shared-skills/publication.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { inventorySkillpack } from '../src/core/shared-skills/setup-files.ts';
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

/** Publishes alpha through put_skill and marks the pack brain-resident. */
async function publishAlpha(f: Fixture, files: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const published = await submitSharedSkillMutation(f.editor, 'put_skill', { request_id: randomUUID(), expected_revision: null,
    source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name: 'alpha', files, ...extra });
  expect((published as { state?: string }).state).toBe('committed');
  const manifest = JSON.parse(readFileSync(join(f.root, 'skillpack.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ ...manifest, brain_resident: true }, null, 2)}\n`);
}
const prose = (body = 'Use the guide.', more: Record<string, unknown> = {}) => ({ path: 'skills/alpha/SKILL.md', content: skillMd(body), file_class: 'prose', ...more });
const HEAD_SQL = `SELECT r.revision,r.files,r.metadata FROM shared_skill_heads h JOIN shared_skill_revisions r
  ON r.source_id=h.source_id AND r.source_incarnation=h.source_incarnation AND r.pack_id=h.pack_id AND r.name=h.name AND r.revision=h.revision
  WHERE h.source_id=$1 AND h.name=$2`;
async function headRow(f: Fixture) {
  return (await f.engine.executeRaw<{ revision: string; files: Array<{ path: string; content: string }>; metadata: Record<string, unknown> }>(HEAD_SQL, ['default', 'alpha']))[0];
}
/** Every file under the checkout's skills/ directory, with its bytes. */
function checkout(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => { for (const name of readdirSync(join(root, dir))) { const rel = `${dir}/${name}`; statSync(join(root, rel)).isDirectory() ? walk(rel) : (out[rel] = readFileSync(join(root, rel), 'utf8')); } };
  if (existsSync(join(root, 'skills'))) walk('skills');
  return out;
}
const readerView = async (f: Fixture) => (await listSharedSkills(f.reader)).skills.map(skill => skill.name);

/** A reviewed SKILL.md edit, then re-adoption: what it answered, and the checkout, head and reader view after it. */
async function readopt(f: Fixture) {
  writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Use the guide, carefully.'));
  const before = { checkout: checkout(f.root), head: await headRow(f), reader: await readerView(f) };
  const outcome = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: inventorySkillpack(f.root)!.hashes })
    .then(() => 'adopted', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
  return { outcome, before, after: { checkout: checkout(f.root), head: await headRow(f), reader: await readerView(f) } };
}

const backends: Array<[string, string | undefined]> = [['PGLite', undefined], ...(process.env.DATABASE_URL ? [['Postgres', process.env.DATABASE_URL] as [string, string]] : [])];

// Each case publishes alpha with something its SKILL.md alone would not reproduce.
const lossy: Array<[string, () => Array<Record<string, unknown>>, Record<string, unknown>]> = [
  ['another file (a reference)', () => [prose('Use the guide.', { depends_on: [REFERENCE] }), { path: REFERENCE, content: 'Guide body', file_class: 'reference' }], {}],
  ['the private flag', () => [prose()], { private: true }],
  ['requirements', () => [prose()], { requirements: ['tool:get_page'] }],
  ['its own description (a routing override)', () => [prose()], { description: 'An override description' }],
  ['a SKILL.md audience of its own', () => [prose('Use the guide.', { audience: ['oauth_client:editor'] })], {}],
  ['a SKILL.md media type of its own', () => [prose('Use the guide.', { media_type: 'text/x-markdown' })], {}],
];

for (const [name, url] of backends) {
  describe(`re-adoption after a reviewed SKILL.md edit (${name})`, () => {
    for (const [what, files, extra] of lossy) {
      // Value: protects=re-adoption never republishes a skill from SKILL.md alone when that would lose what it was published with; fails_when=it deletes checkout files, exposes the skill, drops requirements or routing, or widens its audience; why_new=no test re-adopted such a skill; seam=none; no_claim=publishing the reviewed edit (import_skill_proposal does that)
      test(`a skill published with ${what} refuses by name, and the checkout, sealed revision and reader view are unchanged`, () => fixture(async f => {
        await publishAlpha(f, files(), extra);
        const result = await readopt(f);
        // The refusal names the skill and the reviewed remedy, so the migration's stage reason carries both.
        expect(result.outcome).toStartWith('local_conflict: skills/alpha was not adopted: ');
        expect(result.outcome).toContain('import_skill_proposal');
        expect({ checkout: result.after.checkout, head: result.after.head, reader: result.after.reader })
          .toEqual({ checkout: result.before.checkout, head: result.before.head, reader: result.before.reader });
      }, url), 120_000);
    }

    // Value: protects=a prose-only sealed skill still adopts its reviewed edit; fails_when=the refusal also stops the plain case; why_new=pins the case the refusal leaves open; seam=none; no_claim=none
    test('a prose-only sealed skill still adopts the reviewed edit', () => fixture(async f => {
      await publishAlpha(f, [prose()]);
      const result = await readopt(f);
      const skill = result.after.head.files.find(file => file.path === 'skills/alpha/SKILL.md')!;
      expect({ outcome: result.outcome.split(':')[0], moved: result.after.head.revision !== result.before.head.revision, body: Buffer.from(skill.content, 'base64').toString(), reader: result.after.reader })
        .toEqual({ outcome: 'adopted', moved: true, body: skillMd('Use the guide, carefully.'), reader: ['alpha'] });
    }, url), 120_000);

    // Value: protects=an adoption retried after it committed replays its receipt; fails_when=a second revision is published; why_new=pins replay identity; seam=none; no_claim=none
    test('a new skill adopts, and the adoption retried after it committed replays the same revision', () => fixture(async f => {
      mkdirSync(join(f.root, 'skills/alpha'), { recursive: true });
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Fresh instructions.'));
      writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ name: 'example-pack', brain_resident: true, skills: ['skills/alpha'] }, null, 2)}\n`);
      const revision = (result: Awaited<ReturnType<typeof adoptSharedSkillpack>>) => (result.receipts[0] as { revision?: string }).revision;
      const first = await adoptSharedSkillpack(f.local, 'default');
      const again = await adoptSharedSkillpack(f.local, 'default');
      expect({ same: revision(again) === revision(first), reader: await readerView(f) }).toEqual({ same: true, reader: ['alpha'] });
    }, url), 120_000);

    // Value: protects=a frontmatter-private skill adopts and stays private on retry; fails_when=the refusal treats frontmatter privacy as lossy, or a retry republishes; why_new=pins the frontmatter-private case; seam=none; no_claim=none
    test('a frontmatter-private skill adopts, stays hidden, and a retry replays the same revision', () => fixture(async f => {
      mkdirSync(join(f.root, 'skills/alpha'), { recursive: true });
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), `---\nname: alpha\ndescription: A synthetic fixture\nprivate: true\n---\n\nPrivate instructions.\n`);
      writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ name: 'example-pack', brain_resident: true, skills: ['skills/alpha'] }, null, 2)}\n`);
      const revision = (result: Awaited<ReturnType<typeof adoptSharedSkillpack>>) => (result.receipts[0] as { revision?: string }).revision;
      const first = await adoptSharedSkillpack(f.local, 'default');
      const again = await adoptSharedSkillpack(f.local, 'default');
      expect({ same: revision(again) === revision(first), reader: await readerView(f) }).toEqual({ same: true, reader: [] });
    }, url), 120_000);

    // Value: protects=adoption publishes only the SKILL.md bytes whose hash was reviewed; fails_when=a SKILL.md changed between adoption's read and admission's re-read is published or wedges the writer; why_new=no test changed a file between the two reads; seam=SKILL.md is swapped back to its reviewed bytes when adoption looks up its request; no_claim=none
    test('a SKILL.md changed after review is refused, and the sealed revision is unchanged', () => fixture(async f => {
      await publishAlpha(f, [prose()]);
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Reviewed edit.'));
      const reviewed = inventorySkillpack(f.root)!;
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Unreviewed edit.'));
      const before = await headRow(f);
      const raw = f.engine.executeRaw.bind(f.engine);
      (f.engine as { executeRaw: unknown }).executeRaw = async (sql: string, ...rest: unknown[]) => {
        if (sql.startsWith('SELECT * FROM persistence_requests WHERE principal_kind')) writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Reviewed edit.'));
        return (raw as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
      };
      const outcome = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: reviewed.hashes }).then(() => 'adopted', (error: { code?: string }) => error.code);
      (f.engine as { executeRaw: unknown }).executeRaw = raw;
      expect({ outcome, head: await headRow(f) }).toEqual({ outcome: 'local_conflict', head: before });
    }, url), 60_000);

    // Value: protects=a re-adoption over the journal byte limit refuses by name, publishes nothing and deletes nothing; fails_when=it commits a partial revision or removes a checkout file; why_new=pins the fail-closed path; seam=persistence.limits.principal_intent_bytes is lowered after the first publication; no_claim=packs within the default 64 MiB limit
    test('a re-adoption over the journal byte limit refuses queue_capacity, publishes nothing and deletes nothing', () => fixture(async f => {
      await publishAlpha(f, [prose()]);
      await f.engine.setConfig('persistence.limits.principal_intent_bytes', '2048');
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd(`Use the guide, carefully. ${'x'.repeat(4096)}`));
      const before = { checkout: checkout(f.root), head: await headRow(f) };
      const outcome = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: inventorySkillpack(f.root)!.hashes })
        .then(() => 'adopted', (error: { code?: string }) => error.code);
      expect({ outcome, checkout: checkout(f.root), head: await headRow(f) }).toEqual({ outcome: 'queue_capacity', ...before });
    }, url), 120_000);

    // Value: protects=a skill private through both put_skill and its frontmatter stays private when an edit drops the marker; fails_when=the guard credits the frontmatter alone and publishes the skill visible; why_new=the guard read privacy from one source only; seam=none; no_claim=none
    test('a skill private through put_skill and frontmatter stays hidden when an edit drops the frontmatter marker', () => fixture(async f => {
      const privateMd = `---\nname: alpha\ndescription: A synthetic fixture\ntriggers: [example task]\nprivate: true\n---\n\nUse the guide.\n`;
      await publishAlpha(f, [{ path: 'skills/alpha/SKILL.md', content: privateMd, file_class: 'prose' }], { private: true });
      const result = await readopt(f);
      expect({ outcome: result.outcome.split(':')[0], reader: result.after.reader, head: result.after.head.revision })
        .toEqual({ outcome: 'local_conflict', reader: [], head: result.before.head.revision });
    }, url), 120_000);

    // Value: protects=adoption never publishes a file that was not in the reviewed inventory; fails_when=a SKILL.md added after the inventory is published unreviewed; why_new=the byte check skipped paths without a reviewed hash; seam=none; no_claim=none
    test('a SKILL.md added after the reviewed inventory is refused and not published', () => fixture(async f => {
      await publishAlpha(f, [prose()]);
      const manifest = JSON.parse(readFileSync(join(f.root, 'skillpack.json'), 'utf8')) as { skills: string[] };
      writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ ...manifest, skills: [...manifest.skills, 'skills/beta'] }, null, 2)}\n`);
      mkdirSync(join(f.root, 'skills/beta'), { recursive: true });
      const reviewed = inventorySkillpack(f.root)!;
      writeFileSync(join(f.root, 'skills/beta/SKILL.md'), '---\nname: beta\ndescription: Unreviewed\n---\n\nUnreviewed instructions.\n');
      const outcome = await adoptSharedSkillpack(f.local, 'default', { expected_hashes: reviewed.hashes }).then(() => 'adopted', (error: { code?: string }) => error.code);
      const beta = await f.engine.executeRaw('SELECT 1 FROM shared_skill_heads WHERE source_id=$1 AND name=$2', ['default', 'beta']);
      expect({ outcome, betaPublished: beta.length > 0 }).toEqual({ outcome: 'local_conflict', betaPublished: false });
    }, url), 120_000);

    // Value: protects=a prose-only skill sealed before tools_declared was recorded still adopts; fails_when=the missing field alone is read as a requirements change; why_new=revisions from older releases lack the field; seam=the sealed revision's metadata is edited to drop tools_declared, as an older release stored it; no_claim=none
    test('a prose-only skill sealed without tools_declared still adopts its reviewed edit', () => fixture(async f => {
      await publishAlpha(f, [prose()]);
      await f.engine.transaction(async tx => {
        await tx.executeRaw('SET LOCAL session_replication_role = replica');
        await tx.executeRaw(`UPDATE shared_skill_revisions r SET metadata = r.metadata - 'tools_declared' FROM shared_skill_heads h
          WHERE h.source_id=r.source_id AND h.source_incarnation=r.source_incarnation AND h.pack_id=r.pack_id AND h.name=r.name AND h.revision=r.revision AND h.name='alpha'`);
      });
      const result = await readopt(f);
      expect({ outcome: result.outcome.split(':')[0], moved: result.after.head.revision !== result.before.head.revision }).toEqual({ outcome: 'adopted', moved: true });
    }, url), 120_000);

    // Value: protects=the import_skill_proposal remedy cannot make a private skill public; fails_when=an import that omits private republishes the skill visible; why_new=the refusal now steers users to this path; seam=none; no_claim=none
    test('an import that omits private for a private skill refuses and the skill stays hidden', () => fixture(async f => {
      await publishAlpha(f, [prose()], { private: true });
      const head = await headRow(f);
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Imported edit.'));
      const hashes = { 'skills/alpha/SKILL.md': sha256(readFileSync(join(f.root, 'skills/alpha/SKILL.md'))), 'skillpack.json': sha256(readFileSync(join(f.root, 'skillpack.json'))) };
      const outcome = await importSharedSkillProposal(f.local, { request_id: randomUUID(), expected_revision: head.revision, source_id: 'default', source_incarnation: f.incarnation,
        pack_id: 'example-pack', name: 'alpha', files: [prose('Imported edit.')], expected_hashes: hashes }).then(() => 'imported', (error: { code?: string }) => error.code);
      expect({ outcome, reader: await readerView(f), head: (await headRow(f)).revision }).toEqual({ outcome: 'local_conflict', reader: [], head: head.revision });
    }, url), 120_000);

    // Value: protects=an import never erases a skill the checkout declares but has not published; fails_when=the regenerated skillpack.json drops the unpublished entry; why_new=the refusal now steers users to this path in mixed packs; seam=none; no_claim=none
    test('an import while skillpack.json declares an unpublished skill refuses, and the manifest keeps it', () => fixture(async f => {
      await publishAlpha(f, [prose()]);
      const head = await headRow(f);
      const manifest = JSON.parse(readFileSync(join(f.root, 'skillpack.json'), 'utf8')) as { skills: string[] };
      writeFileSync(join(f.root, 'skillpack.json'), `${JSON.stringify({ ...manifest, skills: [...manifest.skills, 'skills/beta'] }, null, 2)}\n`);
      mkdirSync(join(f.root, 'skills/beta'), { recursive: true });
      writeFileSync(join(f.root, 'skills/beta/SKILL.md'), '---\nname: beta\ndescription: New skill\n---\n\nNew instructions.\n');
      writeFileSync(join(f.root, 'skills/alpha/SKILL.md'), skillMd('Imported edit.'));
      const hashes = { 'skills/alpha/SKILL.md': sha256(readFileSync(join(f.root, 'skills/alpha/SKILL.md'))), 'skillpack.json': sha256(readFileSync(join(f.root, 'skillpack.json'))) };
      const outcome = await importSharedSkillProposal(f.local, { request_id: randomUUID(), expected_revision: head.revision, source_id: 'default', source_incarnation: f.incarnation,
        pack_id: 'example-pack', name: 'alpha', files: [prose('Imported edit.')], expected_hashes: hashes }).then(() => 'imported', (error: { code?: string }) => error.code);
      const after = JSON.parse(readFileSync(join(f.root, 'skillpack.json'), 'utf8')) as { skills: string[] };
      expect({ outcome, declared: after.skills.includes('skills/beta') }).toEqual({ outcome: 'local_conflict', declared: true });
    }, url), 120_000);

    // Value: protects=an adoption queued by an older release is checked again before it touches the checkout; fails_when=resume prepares a SKILL.md-only rebuild of a skill that holds other files; why_new=the check ran only at submission; seam=the request row is shaped like one an older release accepted (no skillAdoptionCheck) from this brain's own put_skill request; no_claim=none
    test('a queued adoption from an older release is refused on resume before it touches the checkout', () => fixture(async f => {
      await publishAlpha(f, [prose('Use the guide.', { depends_on: [REFERENCE] }), { path: REFERENCE, content: 'Guide body', file_class: 'reference' }]);
      const head = await headRow(f);
      const [request] = await f.engine.executeRaw<Record<string, any>>("SELECT * FROM persistence_requests WHERE operation='put_skill' ORDER BY sequence DESC LIMIT 1");
      const [pack] = await f.engine.executeRaw<{ revision: string }>('SELECT revision::text AS revision FROM shared_skill_packs WHERE source_id=$1', ['default']);
      const intent = typeof request.intent === 'string' ? JSON.parse(request.intent) : request.intent;
      const authority = typeof request.authority === 'string' ? JSON.parse(request.authority) : request.authority;
      const skillOnly = intent.proposals[0].files.filter((file: { path: string }) => file.path === 'skills/alpha/SKILL.md');
      const old = { ...request, intent: { ...intent, expected_revision: head.revision, affected: [{ name: 'alpha', revision: head.revision }], expected_pack_revision: pack.revision,
        proposals: [{ ...intent.proposals[0], files: skillOnly, expected_revision: head.revision }] },
        authority: { ...authority, skillAdoptionPreconditions: { alpha: head.revision } } };
      const before = checkout(f.root);
      const outcome = await prepareSharedSkillMutation(f.engine, old as never, f.local.config).then(() => 'prepared', (error: { code?: string }) => error.code);
      expect({ outcome, checkout: checkout(f.root), head: (await headRow(f)).revision }).toEqual({ outcome: 'local_conflict', checkout: before, head: head.revision });
    }, url), 120_000);
  });
}
