/**
 * Two skills cannot publish paths that one case-insensitive checkout would store as one entry.
 *
 * 1. Protects: skill names are lowercase, so skill directories never collide, but every skill can publish files under
 *    skills/conventions/. When one skill holds skills/conventions/Guide.md, another skill's skills/conventions/guide.md
 *    (or a file inside a skills/conventions/GUIDE.md/ directory) would overwrite it or fail to check out on macOS and
 *    Windows. Submission and prepare refuse such a publication with local_conflict and write nothing; a remote caller's
 *    refusal names only the path it proposed. Sharing the exact same path still publishes, and a pack that already held
 *    a collision before this check keeps publishing its other changes.
 * 2. Fails on: a case-sensitive (Linux) brain host publishing the second spelling, so the canonical checkout and every
 *    clone of it carry two paths that differ only by letter case; or a request queued by an older release doing it at prepare.
 * 3. Existing coverage: normalizeSkillFiles refuses case-colliding paths inside one skill, and prepareBundleFiles refuses
 *    them inside one write set; nothing compared a publication with the files other skills already published.
 * 4. Seam: the prepare case shapes a request row like one an older release accepted, from this brain's own committed
 *    put_skill request; the old-collision case renames an already-published file in the sealed rows and the checkout,
 *    because no supported path can publish a collision any more. Real PGLite (and Postgres with DATABASE_URL).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { prepareSharedSkillMutation, submitSharedSkillMutation } from '../src/core/shared-skills/publication.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import type { SharedSkillPolicy } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const OPERATIONS = ['list_skills', 'get_skill', 'get_skill_asset', 'put_skill', 'delete_skill'];
const POLICY: SharedSkillPolicy = { version: 1, enabled: true, classes: ['prose', 'reference', 'asset'], audiences: ['readers'], requirements: [], allow_follow: true };
const UPPER = 'skills/conventions/Guide.md';
const LOWER = 'skills/conventions/guide.md';
const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: A synthetic ${name} fixture\n---\n\n${body}\n`;
const prose = (name: string, body: string, depends_on: string[] = []) => ({ path: `skills/${name}/SKILL.md`, content: skillMd(name, body), file_class: 'prose', depends_on });
const shared = (path: string) => ({ path, content: 'Synthetic shared guide body.\n', file_class: 'reference', audience: ['readers'] });

interface Fixture { engine: BrainEngine; root: string; local: OperationContext; editor: OperationContext; incarnation: string }

async function fixture(run: (f: Fixture) => Promise<void>, databaseUrl?: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-case-collisions-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine(databaseUrl);
      const engine = isolated.engine;
      try {
        const root = join(dir, 'default'); mkdirSync(root);
        // Its own Git root, so the worktree claim never walks up to a checkout that holds the temp dir.
        execFileSync('git', ['init', '-q', root]);
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        await engine.setConfig('mcp.publish_skills', 'true');
        const local: OperationContext = { engine, config: { engine: databaseUrl ? 'postgres' : 'pglite' }, remote: false,
          sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations,bound_slug_prefixes)
          VALUES('editor','Synthetic editor','read write skill_editor','default',$1::text[],ARRAY['skills/'])`, [OPERATIONS]);
        const editor = { ...local, remote: true, auth: { token: 'synthetic', clientId: 'editor', principal: { kind: 'oauth_client', id: 'editor' },
          scopes: ['read', 'write', 'skill_editor'], sourceId: 'default', allowedOperations: OPERATIONS, boundSlugPrefixes: ['skills/'] } } as OperationContext;
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
        await setSharedSkillPolicy(local, 'default', POLICY, null);
        await run({ engine, root, local, editor, incarnation: source.incarnation });
      } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const HEAD_SQL = `SELECT h.name,h.revision FROM shared_skill_heads h WHERE h.source_id=$1 ORDER BY h.name`;
const heads = async (f: Fixture) => f.engine.executeRaw<{ name: string; revision: string }>(HEAD_SQL, ['default']);
const revisionOf = async (f: Fixture, name: string) => (await heads(f)).find(head => head.name === name)?.revision ?? null;
/** Every file under the checkout's skills/ directory plus skillpack.json, with its bytes. */
function checkout(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => { for (const name of readdirSync(join(root, dir))) { const rel = `${dir}/${name}`; statSync(join(root, rel)).isDirectory() ? walk(rel) : (out[rel] = readFileSync(join(root, rel), 'utf8')); } };
  if (existsSync(join(root, 'skills'))) walk('skills');
  out['skillpack.json'] = readFileSync(join(root, 'skillpack.json'), 'utf8');
  return out;
}
async function put(f: Fixture, ctx: OperationContext, name: string, files: Array<Record<string, unknown>>) {
  return submitSharedSkillMutation(ctx, 'put_skill', { request_id: randomUUID(), expected_revision: await revisionOf(f, name),
    source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name, files });
}
const committed = (result: unknown) => expect((result as { state?: string }).state).toBe('committed');
const outcomeOf = (promise: Promise<unknown>) => promise.then(() => 'published', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
/** Alpha holds the upper-case guide; beta does not hold any shared file yet. */
async function publishBoth(f: Fixture) {
  committed(await put(f, f.local, 'alpha', [prose('alpha', 'Use the guide.', [UPPER]), shared(UPPER)]));
  committed(await put(f, f.local, 'beta', [prose('beta', 'Standalone.')]));
}

const backends: Array<[string, string | undefined]> = [['PGLite', undefined], ...(process.env.DATABASE_URL ? [['Postgres', process.env.DATABASE_URL] as [string, string]] : [])];

for (const [name, url] of backends) {
  describe(`two skills cannot publish paths that collide by letter case (${name})`, () => {
    // Value: protects=a second spelling of another skill's shared file never reaches the checkout; fails_when=beta's guide.md publishes next to alpha's Guide.md; why_new=the case check covered one skill only; seam=none; no_claim=case-insensitive brain hosts, which refuse earlier because the file already exists on disk
    test('a trusted put_skill whose shared file differs only by case from another skill\'s refuses, and nothing changes', () => fixture(async f => {
      await publishBoth(f);
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await outcomeOf(put(f, f.local, 'beta', [prose('beta', 'Now uses the guide.', [LOWER]), shared(LOWER)]));
      expect(outcome).toBe(`local_conflict: The publication was refused: ${LOWER} collides with ${UPPER} on a case-insensitive checkout. Nothing was written.`);
      expect({ heads: await heads(f), checkout: checkout(f.root) }).toEqual(before);
    }, url), 120_000);

    // Value: protects=a remote editor learns only its own path; fails_when=the remote put publishes, or the refusal spells the other skill's file; why_new=as above; seam=none; no_claim=none
    test('a remote put_skill with the colliding spelling refuses and names only the path it proposed', () => fixture(async f => {
      await publishBoth(f);
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await outcomeOf(put(f, f.editor, 'beta', [prose('beta', 'Now uses the guide.', [LOWER]), shared(LOWER)]));
      expect(outcome).toBe(`local_conflict: The publication was refused: ${LOWER} collides by letter case with a file another skill publishes. Nothing was written.`);
      expect({ heads: await heads(f), checkout: checkout(f.root) }).toEqual(before);
    }, url), 120_000);

    // Value: protects=a file and a directory of the same folded name never coexist; fails_when=beta publishes a file inside skills/conventions/GUIDE.md/; why_new=as above; seam=none; no_claim=none
    test('a file inside a directory whose name folds to another skill\'s shared file refuses, and nothing changes', () => fixture(async f => {
      await publishBoth(f);
      const nested = 'skills/conventions/GUIDE.md/notes.md';
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await outcomeOf(put(f, f.local, 'beta', [prose('beta', 'Now uses the notes.', [nested]), shared(nested)]));
      expect(outcome).toBe(`local_conflict: The publication was refused: ${nested} collides with ${UPPER} on a case-insensitive checkout. Nothing was written.`);
      expect({ heads: await heads(f), checkout: checkout(f.root) }).toEqual(before);
    }, url), 120_000);

    // Value: protects=sharing the exact path is not a collision; fails_when=the check refuses a second holder of the same spelling; why_new=the new check must not over-refuse; seam=none; no_claim=none
    test('a second skill that holds the exact same shared path publishes', () => fixture(async f => {
      await publishBoth(f);
      committed(await put(f, f.local, 'beta', [prose('beta', 'Now uses the guide.', [UPPER]), shared(UPPER)]));
      expect(Object.keys(checkout(f.root)).filter(path => path.startsWith('skills/conventions/'))).toEqual([UPPER]);
    }, url), 120_000);

    // Value: protects=a pack that already holds a collision from before this check does not wedge; fails_when=an unrelated edit of a skill that holds one spelling refuses; why_new=the check refuses only collisions a publication adds; seam=the old collision is made by renaming beta's published file in the sealed rows and the checkout; no_claim=repairing the old collision
    test('an edit in a pack that already holds a case collision still publishes', () => fixture(async f => {
      const OTHER = 'skills/conventions/other.md';
      committed(await put(f, f.local, 'alpha', [prose('alpha', 'Use the guide.', [UPPER]), shared(UPPER)]));
      committed(await put(f, f.local, 'beta', [prose('beta', 'Use the other guide.', [OTHER]), shared(OTHER)]));
      // As an older release could have published it: beta's shared file is spelled guide.md next to alpha's Guide.md.
      const manifest = readFileSync(join(f.root, 'skillpack.json'), 'utf8').replaceAll(OTHER, LOWER);
      await f.engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await withCoordinatedWrite(tx, ['default'], async () => {
          await tx.executeRaw('UPDATE shared_skill_revisions SET files=replace(files::text,$1,$2)::jsonb WHERE source_id=$3', [OTHER, LOWER, 'default']);
          await tx.executeRaw('UPDATE shared_skill_packs SET manifest=replace(manifest::text,$1,$2)::jsonb,manifest_hash=$3 WHERE source_id=$4', [OTHER, LOWER, sha256(Buffer.from(manifest)), 'default']);
        }, TEST_WRITE_ATTRIBUTION);
      });
      renameSync(join(f.root, OTHER), join(f.root, LOWER));
      writeFileSync(join(f.root, 'skillpack.json'), manifest);
      committed(await put(f, f.local, 'alpha', [prose('alpha', 'Use the guide, edited.', [UPPER]), shared(UPPER)]));
      expect(readFileSync(join(f.root, 'skills/alpha/SKILL.md'), 'utf8')).toBe(skillMd('alpha', 'Use the guide, edited.'));
    }, url), 120_000);

    // Value: protects=a request queued by an older release is checked again before it touches the checkout; fails_when=resume prepares beta's guide.md next to alpha's Guide.md; why_new=no check ran at prepare; seam=the request row is shaped like one an older release accepted, from this brain's own committed put_skill; no_claim=none
    test('a queued publication from an older release that adds the colliding spelling is refused on resume before it touches the checkout', () => fixture(async f => {
      const OTHER = 'skills/conventions/other.md';
      await publishBoth(f);
      committed(await put(f, f.local, 'beta', [prose('beta', 'Use the other guide.', [OTHER]), shared(OTHER)]));
      const [request] = await f.engine.executeRaw<Record<string, any>>("SELECT * FROM persistence_requests WHERE operation='put_skill' ORDER BY sequence DESC LIMIT 1");
      const [pack] = await f.engine.executeRaw<{ revision: string }>('SELECT revision::text AS revision FROM shared_skill_packs WHERE source_id=$1', ['default']);
      const intent = typeof request.intent === 'string' ? JSON.parse(request.intent) : request.intent;
      const current = Object.fromEntries((await heads(f)).map(head => [head.name, head.revision]));
      // As an older release admitted it: beta's other.md is spelled guide.md, next to alpha's Guide.md.
      const renamed = JSON.parse(JSON.stringify(intent.proposals[0].files).replaceAll(OTHER, LOWER));
      const old = { ...request, intent: { ...intent, expected_revision: current.beta, affected: [{ name: 'beta', revision: current.beta }],
        expected_pack_revision: pack.revision, before_hashes: { ...intent.before_hashes, [LOWER]: null },
        proposals: [{ ...intent.proposals[0], files: renamed, expected_revision: current.beta }] } };
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await prepareSharedSkillMutation(f.engine, old as never, f.local.config).then(() => 'prepared', (error: { code?: string }) => error.code);
      expect({ outcome, heads: await heads(f), checkout: checkout(f.root) }).toEqual({ outcome: 'local_conflict', ...before });
    }, url), 120_000);
  });
}
