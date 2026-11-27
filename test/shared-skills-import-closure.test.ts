/**
 * A publication never widens a shared convention file in another skill that did not propose it.
 *
 * 1. Protects: when a skill publication (import_skill_proposal, put_skill or adoption) changes a shared file under
 *    skills/conventions/, every other published skill that holds that file is rebuilt with the new copy. When that copy
 *    would reach a wider audience, or change file class, in a skill that holds it already, the publication refuses
 *    local_conflict by name at submission and again at prepare. It writes nothing, both heads and the checkout stay as
 *    they were, and a reader still cannot fetch the restricted file. A copy that keeps or narrows the audience publishes.
 * 2. Fails on: an import or a remote put_skill that newly references a restricted convention with a wider audience
 *    republishing the other skill's copy to readers, or a queued request from an older release doing it at prepare.
 * 3. Existing coverage: test/shared-skills-publication-sparse.test.ts rebuilds dependents with a changed convention of
 *    the same policy; test/shared-skills-adoption-keeps-files.test.ts checks only the proposed skill's own files.
 * 4. Seam: none, except the prepare case, which shapes a request row like one an older release accepted from this
 *    brain's own committed put_skill request. Real PGLite (and Postgres with DATABASE_URL) through isolatedSharedSkillsEngine.
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
import { sha256 } from '../src/core/persistence/digest.ts';
import { importSharedSkillProposal, prepareSharedSkillMutation, submitSharedSkillMutation } from '../src/core/shared-skills/publication.ts';
import { getSharedSkill, getSharedSkillAsset } from '../src/core/shared-skills/catalog.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import type { SharedSkillPolicy } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

const OPERATIONS = ['list_skills', 'get_skill', 'get_skill_asset', 'put_skill', 'delete_skill'];
const POLICY: SharedSkillPolicy = { version: 1, enabled: true, classes: ['prose', 'reference'], audiences: ['readers', 'oauth_client:editor'], requirements: [], allow_follow: true };
const GUIDE = 'skills/conventions/guide.md';
const RESTRICTED = ['oauth_client:editor'];
const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: A synthetic ${name} fixture\n---\n\n${body}\n`;
const prose = (name: string, body: string, depends_on: string[] = []) => ({ path: `skills/${name}/SKILL.md`, content: skillMd(name, body), file_class: 'prose', depends_on });
const guide = (audience: string[]) => ({ path: GUIDE, content: 'Synthetic shared guide body.\n', file_class: 'reference', audience });

interface Fixture { engine: BrainEngine; root: string; local: OperationContext; reader: OperationContext; editor: OperationContext; incarnation: string }

async function fixture(run: (f: Fixture) => Promise<void>, databaseUrl?: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-closure-'));
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
          VALUES('reader','Synthetic reader','read','default',$1::text[],NULL),('editor','Synthetic editor','read write skill_editor','default',$1::text[],ARRAY['skills/'])`, [OPERATIONS]);
        const remote = (id: string, scopes: string[]): OperationContext => ({ ...local, remote: true,
          auth: { token: 'synthetic', clientId: id, principal: { kind: 'oauth_client', id }, scopes, sourceId: 'default', allowedOperations: OPERATIONS,
            ...(id === 'editor' ? { boundSlugPrefixes: ['skills/'] } : {}) } } as OperationContext);
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
        await setSharedSkillPolicy(local, 'default', POLICY, null);
        await run({ engine, root, local, reader: remote('reader', ['read']), editor: remote('editor', ['read', 'write', 'skill_editor']), incarnation: source.incarnation });
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
/** Alpha holds the guide restricted to the editor; beta does not hold it yet. */
async function publishBoth(f: Fixture) {
  for (const result of [await put(f, f.local, 'alpha', [prose('alpha', 'Use the guide.', [GUIDE]), guide(RESTRICTED)]), await put(f, f.local, 'beta', [prose('beta', 'Standalone.')])]) {
    expect((result as { state?: string }).state).toBe('committed');
  }
}
/** What the reader gets for alpha's guide: its body, or the refusal code. */
async function readerGuide(f: Fixture) {
  const detail = await getSharedSkill(f.reader, { source_id: 'default', pack_id: 'example-pack', name: 'alpha' });
  return getSharedSkillAsset(f.reader, { ...detail, path: GUIDE }).then(asset => Buffer.from(asset.content, 'base64').toString(), (error: { code?: string }) => error.code);
}
/** Beta's reviewed checkout edit that newly references the guide, imported with the current hash of every affected file. */
async function importBeta(f: Fixture, audience: string[]) {
  writeFileSync(join(f.root, 'skills/beta/SKILL.md'), skillMd('beta', 'Now uses the guide.'));
  const hashes = Object.fromEntries(['skills/alpha/SKILL.md', 'skills/beta/SKILL.md', GUIDE, 'skillpack.json'].map(path => [path, sha256(readFileSync(join(f.root, path)))]));
  return importSharedSkillProposal(f.local, { request_id: randomUUID(), expected_revision: await revisionOf(f, 'beta'), source_id: 'default', source_incarnation: f.incarnation,
    pack_id: 'example-pack', name: 'beta', files: [prose('beta', 'Now uses the guide.', [GUIDE]), guide(audience)], expected_hashes: hashes });
}

const backends: Array<[string, string | undefined]> = [['PGLite', undefined], ...(process.env.DATABASE_URL ? [['Postgres', process.env.DATABASE_URL] as [string, string]] : [])];

for (const [name, url] of backends) {
  describe(`a shared convention keeps its audience in the skills that already hold it (${name})`, () => {
    // Value: protects=an import of one skill cannot widen a restricted convention another skill holds; fails_when=the import republishes alpha's guide to readers; why_new=the loss check covered only the proposed skill; seam=none; no_claim=widening a convention on purpose (fork it, or adopt every skill that holds it)
    test('an import that newly references a restricted convention with a wider audience refuses, and nothing changes', () => fixture(async f => {
      await publishBoth(f);
      expect(await readerGuide(f)).toBe('skill_asset_not_found');
      const before = { heads: await heads(f) };
      const outcome = await importBeta(f, ['readers']).then(() => 'imported', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      const disk = checkout(f.root);
      expect(outcome).toStartWith('local_conflict: ');
      expect(outcome).toContain('skills/alpha');
      expect(outcome).toContain(GUIDE);
      expect({ heads: await heads(f), reader: await readerGuide(f), checkout: checkout(f.root) }).toEqual({ heads: before.heads, reader: 'skill_asset_not_found', checkout: disk });
    }, url), 120_000);

    // Value: protects=a remote editor cannot widen another skill's restricted convention through its own skill; fails_when=put_skill on beta republishes alpha's guide to readers; why_new=the remote widening check covered only the named skill; seam=none; no_claim=none
    test('a remote put_skill that newly references a restricted convention with a wider audience refuses, and nothing changes', () => fixture(async f => {
      await publishBoth(f);
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await put(f, f.editor, 'beta', [prose('beta', 'Now uses the guide.', [GUIDE]), guide(['readers'])])
        .then(() => 'published', (error: { code?: string }) => error.code);
      expect({ outcome, heads: await heads(f), reader: await readerGuide(f), checkout: checkout(f.root) })
        .toEqual({ outcome: 'local_conflict', heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
    }, url), 120_000);

    // Value: protects=the refusal does not block sharing a convention at the audience it already has; fails_when=a same-audience import refuses; why_new=the new check must not over-refuse; seam=none; no_claim=none
    test('an import that references the convention with the audience alpha already gives it publishes both skills', () => fixture(async f => {
      await publishBoth(f);
      const result = await importBeta(f, RESTRICTED);
      expect((result as { state?: string }).state).toBe('committed');
      expect(await readerGuide(f)).toBe('skill_asset_not_found');
    }, url), 120_000);

    // Value: protects=a request queued by an older release is checked again before it touches the checkout; fails_when=resume prepares a rebuild of alpha with the wider guide; why_new=no check ran at prepare; seam=the request row is shaped like one an older release accepted, from this brain's own committed put_skill; no_claim=none
    test('a queued publication from an older release that widens the convention is refused on resume before it touches the checkout', () => fixture(async f => {
      await publishBoth(f);
      // A plain put_skill: an adoption's own loss check would refuse the widened copy in beta itself, which is not the case here.
      expect((await put(f, f.local, 'beta', [prose('beta', 'Now uses the guide.', [GUIDE]), guide(RESTRICTED)]) as { state?: string }).state).toBe('committed');
      const [request] = await f.engine.executeRaw<Record<string, any>>("SELECT * FROM persistence_requests WHERE operation='put_skill' ORDER BY sequence DESC LIMIT 1");
      const [pack] = await f.engine.executeRaw<{ revision: string }>('SELECT revision::text AS revision FROM shared_skill_packs WHERE source_id=$1', ['default']);
      const intent = typeof request.intent === 'string' ? JSON.parse(request.intent) : request.intent;
      const current = Object.fromEntries((await heads(f)).map(head => [head.name, head.revision]));
      // As an older release admitted it: the widened guide makes alpha an affected skill, rebuilt at prepare.
      const widened = intent.proposals[0].files.map((file: { path: string }) => file.path === GUIDE ? { ...file, audience: ['readers'] } : file);
      const old = { ...request, intent: { ...intent, expected_revision: current.beta, affected: ['alpha', 'beta'].map(target => ({ name: target, revision: current[target] })),
        expected_pack_revision: pack.revision, proposals: [{ ...intent.proposals[0], files: widened, expected_revision: current.beta }] } };
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await prepareSharedSkillMutation(f.engine, old as never, f.local.config).then(() => 'prepared', (error: { code?: string }) => error.code);
      expect({ outcome, heads: await heads(f), reader: await readerGuide(f), checkout: checkout(f.root) })
        .toEqual({ outcome: 'local_conflict', heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
    }, url), 120_000);
  });
}
