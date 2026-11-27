/**
 * A publication never widens a shared convention file in another skill that did not propose it.
 *
 * 1. Protects: when a skill publication (import_skill_proposal, put_skill or adoption) changes a shared file under
 *    skills/conventions/, every other published skill that holds that file is rebuilt with the new copy. When that copy
 *    would reach a wider audience, or change file class, in a skill that holds it already, the publication refuses
 *    local_conflict by name at submission and again at prepare. It writes nothing, both heads and the checkout stay as
 *    they were, and a reader still cannot fetch the restricted file. A copy that keeps or narrows the audience publishes.
 *    A proposed skill also may not show such a file to more callers than the other skills that hold it already do,
 *    counting each holder's SKILL.md audience and private flag, so a readers file in a hidden skill stays hidden.
 * 2. Fails on: an import or a remote put_skill that newly references a restricted convention with a wider audience
 *    republishing the other skill's copy to readers, a public skill republishing a convention that only a restricted or
 *    private skill holds, or a queued request from an older release doing either at prepare.
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
import { normalizeSkillFiles, skillMetadata } from '../src/core/shared-skills/manifest.ts';
import type { SharedSkillPolicy } from '../src/core/shared-skills/model.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

const OPERATIONS = ['list_skills', 'get_skill', 'get_skill_asset', 'put_skill', 'delete_skill'];
const POLICY: SharedSkillPolicy = { version: 1, enabled: true, classes: ['prose', 'reference', 'asset'], audiences: ['readers', 'oauth_client:editor'], requirements: [], allow_follow: true };
const GUIDE = 'skills/conventions/guide.md';
const RESTRICTED = ['oauth_client:editor'];
const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: A synthetic ${name} fixture\n---\n\n${body}\n`;
const prose = (name: string, body: string, depends_on: string[] = []) => ({ path: `skills/${name}/SKILL.md`, content: skillMd(name, body), file_class: 'prose', depends_on });
const guide = (audience: string[], file_class = 'reference') => ({ path: GUIDE, content: 'Synthetic shared guide body.\n', file_class, audience });
const ROOT = 'skills/conventions/root.md';
const root = (depends_on: string[] = []) => ({ path: ROOT, content: 'Synthetic shared root.\n', file_class: 'reference', audience: ['readers'], depends_on });

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
async function put(f: Fixture, ctx: OperationContext, name: string, files: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return submitSharedSkillMutation(ctx, 'put_skill', { request_id: randomUUID(), expected_revision: await revisionOf(f, name),
    source_id: 'default', source_incarnation: f.incarnation, pack_id: 'example-pack', name, files, ...extra });
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
/** What the reader gets for a skill's copy of the guide: its body, or the refusal code. */
async function readerCopy(f: Fixture, skill: string) {
  const detail = await getSharedSkill(f.reader, { source_id: 'default', pack_id: 'example-pack', name: skill });
  return getSharedSkillAsset(f.reader, { ...detail, path: GUIDE }).then(asset => Buffer.from(asset.content, 'base64').toString(), (error: { code?: string }) => error.code);
}
/** Alpha holds a readers guide, but alpha itself is hidden from the reader (its SKILL.md audience, or private); beta does not hold the guide yet. */
async function publishHidden(f: Fixture, hide: 'audience' | 'private') {
  const alpha = hide === 'audience' ? [{ ...prose('alpha', 'Use the guide.', [GUIDE]), audience: RESTRICTED }, guide(['readers'])] : [prose('alpha', 'Use the guide.', [GUIDE]), guide(['readers'])];
  for (const result of [await put(f, f.local, 'alpha', alpha, hide === 'private' ? { private: true } : {}), await put(f, f.local, 'beta', [prose('beta', 'Standalone.')])]) {
    expect((result as { state?: string }).state).toBe('committed');
  }
  expect(await readerCopy(f, 'alpha').catch((error: { code?: string }) => error.code)).toBe('skill_not_found');
}
/** Beta's reviewed checkout edit that newly references the guide. */
const stageBeta = (f: Fixture) => writeFileSync(join(f.root, 'skills/beta/SKILL.md'), skillMd('beta', 'Now uses the guide.'));
/** Imports beta's staged edit with the current hash of every affected file (staging it first unless `staged`). */
async function importBeta(f: Fixture, audience: string[], file_class = 'reference', staged = false) {
  if (!staged) stageBeta(f);
  const hashes = Object.fromEntries(['skills/alpha/SKILL.md', 'skills/beta/SKILL.md', GUIDE, 'skillpack.json'].map(path => [path, sha256(readFileSync(join(f.root, path)))]));
  return importSharedSkillProposal(f.local, { request_id: randomUUID(), expected_revision: await revisionOf(f, 'beta'), source_id: 'default', source_incarnation: f.incarnation,
    pack_id: 'example-pack', name: 'beta', files: [prose('beta', 'Now uses the guide.', [GUIDE]), guide(audience, file_class)], expected_hashes: hashes });
}

const backends: Array<[string, string | undefined]> = [['PGLite', undefined], ...(process.env.DATABASE_URL ? [['Postgres', process.env.DATABASE_URL] as [string, string]] : [])];

for (const [name, url] of backends) {
  describe(`a shared convention keeps its audience in the skills that already hold it (${name})`, () => {
    // Value: protects=an import of one skill cannot widen a restricted convention another skill holds; fails_when=the import republishes alpha's guide to readers; why_new=the loss check covered only the proposed skill; seam=none; no_claim=widening a convention on purpose (fork it, or adopt every skill that holds it)
    test('an import that newly references a restricted convention with a wider audience refuses, and nothing changes', () => fixture(async f => {
      await publishBoth(f);
      expect(await readerGuide(f)).toBe('skill_asset_not_found');
      stageBeta(f);
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await importBeta(f, ['readers'], 'reference', true).then(() => 'imported', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      expect(outcome).toStartWith('local_conflict: ');
      expect(outcome).toContain('skills/alpha');
      expect(outcome).toContain(GUIDE);
      expect({ heads: await heads(f), reader: await readerGuide(f), checkout: checkout(f.root) }).toEqual({ heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
    }, url), 120_000);

    // Value: protects=a dependency rewrite that stops another skill reaching a restricted file still publishes; fails_when=the check compares a file the rebuilt skill no longer holds and refuses; why_new=the dependent check now runs at submission; seam=none; no_claim=none
    test('a shared rewrite that drops the restricted file from the other skill publishes', () => fixture(async f => {
      const ROOT = 'skills/conventions/root.md';
      const root = (depends_on: string[]) => ({ path: ROOT, content: 'Synthetic shared root.\n', file_class: 'reference', audience: ['readers'], depends_on });
      for (const result of [await put(f, f.local, 'alpha', [prose('alpha', 'Use the root.', [ROOT]), root([GUIDE]), guide(RESTRICTED)]), await put(f, f.local, 'beta', [prose('beta', 'Standalone.')])]) {
        expect((result as { state?: string }).state).toBe('committed');
      }
      const result = await put(f, f.local, 'beta', [prose('beta', 'Uses both.', [ROOT, GUIDE]), root([]), guide(['readers'])]);
      const beta = await getSharedSkill(f.reader, { source_id: 'default', pack_id: 'example-pack', name: 'beta' });
      const betaGuide = await getSharedSkillAsset(f.reader, { ...beta, path: GUIDE }).then(asset => Buffer.from(asset.content, 'base64').toString(), (error: { code?: string }) => error.code);
      expect({ state: (result as { state?: string }).state, betaGuide, alphaGuide: await readerGuide(f) })
        .toEqual({ state: 'committed', betaGuide: 'Synthetic shared guide body.\n', alphaGuide: 'skill_asset_not_found' });
    }, url), 120_000);

    // Value: protects=a remote editor cannot widen another skill's restricted convention through its own skill, and the refusal hides that skill; fails_when=put_skill on beta republishes alpha's guide to readers, or the refusal names alpha; why_new=the remote widening check covered only the named skill; seam=none; no_claim=none
    test('a remote put_skill that newly references a restricted convention with a wider audience refuses, and nothing changes', () => fixture(async f => {
      await publishBoth(f);
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await put(f, f.editor, 'beta', [prose('beta', 'Now uses the guide.', [GUIDE]), guide(['readers'])])
        .then(() => 'published', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      // A remote caller learns the shared path it proposed and a count, never the other skill's name or file class.
      expect(outcome).toBe(`local_conflict: The publication was refused: ${GUIDE} would reach a wider audience or another file class in 1 other skill that already holds it. Nothing was written.`);
      expect({ heads: await heads(f), reader: await readerGuide(f), checkout: checkout(f.root) })
        .toEqual({ heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
    }, url), 120_000);

    // Value: protects=the refusal does not block sharing a convention at the audience it already has; fails_when=a same-audience import refuses; why_new=the new check must not over-refuse; seam=none; no_claim=none
    test('an import that references the convention with the audience alpha already gives it publishes both skills', () => fixture(async f => {
      await publishBoth(f);
      const result = await importBeta(f, RESTRICTED);
      expect((result as { state?: string }).state).toBe('committed');
      expect(await readerGuide(f)).toBe('skill_asset_not_found');
    }, url), 120_000);

    // Value: protects=readers covers every principal, so naming one principal narrows a readers file and still publishes; fails_when=the check compares audience labels literally and refuses a real narrowing; why_new=the new check must not over-refuse; seam=none; no_claim=none
    test('an import that gives a readers convention a narrower audience publishes, and the narrower audience applies to alpha', () => fixture(async f => {
      for (const result of [await put(f, f.local, 'alpha', [prose('alpha', 'Use the guide.', [GUIDE]), guide(['readers'])]), await put(f, f.local, 'beta', [prose('beta', 'Standalone.')])]) {
        expect((result as { state?: string }).state).toBe('committed');
      }
      expect(await readerGuide(f)).toBe('Synthetic shared guide body.\n');
      const result = await importBeta(f, RESTRICTED);
      expect((result as { state?: string }).state).toBe('committed');
      expect(await readerGuide(f)).toBe('skill_asset_not_found');
    }, url), 120_000);

    // Value: protects=the refusal stays bounded however many skills hold the convention, so a queued request settles inside its receipt reservation; fails_when=the message lists every dependent; why_new=the reasons list grows with the closure; seam=none; no_claim=the exact receipt reservation size
    test('a refusal that names many skills stays bounded', () => fixture(async f => {
      for (const name of ['alpha', 'gamma', 'delta', 'epsilon']) {
        expect((await put(f, f.local, name, [prose(name, 'Use the guide.', [GUIDE]), guide(RESTRICTED)]) as { state?: string }).state).toBe('committed');
      }
      expect((await put(f, f.local, 'beta', [prose('beta', 'Standalone.')]) as { state?: string }).state).toBe('committed');
      const outcome = await importBeta(f, ['readers']).then(() => 'imported', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      expect(outcome).toStartWith('local_conflict: ');
      expect(outcome).toContain('; and 1 more.');
      expect(outcome.split('would publish').length - 1).toBe(3);
    }, url), 120_000);

    // Value: protects=a publication cannot change a convention's file class in a skill that already holds it; fails_when=the import republishes alpha's reference guide as an asset; why_new=class changes had no dependent check; seam=none; no_claim=none
    test('an import that gives the convention another file class refuses, and nothing changes', () => fixture(async f => {
      await publishBoth(f);
      stageBeta(f);
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await importBeta(f, RESTRICTED, 'asset', true).then(() => 'imported', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      expect(outcome).toStartWith('local_conflict: ');
      expect(outcome).toContain('as asset instead of reference');
      expect({ heads: await heads(f), reader: await readerGuide(f), checkout: checkout(f.root) }).toEqual({ heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
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

    // Value: protects=a remote editor cannot show a convention to every reader through a public skill while the only skill holding it is hidden from readers; fails_when=put_skill on beta republishes alpha's guide to readers; why_new=the dependent check compared file audiences only, so a readers file in a restricted skill counted as already public; seam=none; no_claim=copying the bytes to a file under beta's own directory, which no shared-file check can see
    test('a remote put_skill that shows a convention held only by a restricted skill to readers refuses, and nothing changes', () => fixture(async f => {
      await publishHidden(f, 'audience');
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await put(f, f.editor, 'beta', [prose('beta', 'Now uses the guide.', [GUIDE]), guide(['readers'])])
        .then(() => 'published', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      expect(outcome).toBe(`local_conflict: The publication was refused: ${GUIDE} would reach a wider audience than the 1 skill that already holds it gives it. Nothing was written.`);
      expect({ heads: await heads(f), reader: await readerCopy(f, 'beta'), checkout: checkout(f.root) })
        .toEqual({ heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
    }, url), 120_000);

    // Value: protects=a private skill's convention stays off the remote catalog when another skill is imported; fails_when=the import publishes alpha's guide to readers through beta; why_new=no check read the holder's private flag; seam=none; no_claim=none
    test('an import that shows a convention held only by a private skill to readers refuses by name, and nothing changes', () => fixture(async f => {
      await publishHidden(f, 'private');
      stageBeta(f);
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await importBeta(f, ['readers'], 'reference', true).then(() => 'imported', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      expect(outcome).toBe(`local_conflict: The publication was refused: ${GUIDE} would reach a wider audience than skills/alpha gives it. Nothing was written.`);
      expect({ heads: await heads(f), reader: await readerCopy(f, 'beta'), checkout: checkout(f.root) })
        .toEqual({ heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
    }, url), 120_000);

    // Value: protects=a copy no wider than the hidden holder gives it still publishes; fails_when=a narrowing copy refuses; why_new=the new check must not over-refuse; seam=none; no_claim=none
    test('a copy of a hidden convention that is no wider than its holder gives it publishes', () => fixture(async f => {
      await publishHidden(f, 'audience');
      const result = await put(f, f.editor, 'beta', [prose('beta', 'Now uses the guide.', [GUIDE]), guide(RESTRICTED)]);
      expect({ state: (result as { state?: string }).state, reader: await readerCopy(f, 'beta') }).toEqual({ state: 'committed', reader: 'skill_asset_not_found' });
    }, url), 120_000);

    // Value: protects=a convention that another skill already shows to readers still publishes through a new skill; fails_when=the check counts only the hidden holder and refuses; why_new=the new check must not over-refuse; seam=none; no_claim=none
    test('a convention that another skill already shows to readers publishes through a new skill', () => fixture(async f => {
      for (const files of [[prose('gamma', 'Use the guide.', [GUIDE]), guide(['readers'])], [{ ...prose('alpha', 'Use the guide.', [GUIDE]), audience: RESTRICTED }, guide(['readers'])]]) {
        const name = files[0].path.split('/')[1];
        expect((await put(f, f.local, name, files) as { state?: string }).state).toBe('committed');
      }
      const result = await put(f, f.editor, 'beta', [prose('beta', 'Now uses the guide.', [GUIDE]), guide(['readers'])]);
      expect({ state: (result as { state?: string }).state, reader: await readerCopy(f, 'beta') }).toEqual({ state: 'committed', reader: 'Synthetic shared guide body.\n' });
    }, url), 120_000);

    // Value: protects=a rewrite that gives a public skill a hidden skill's convention cannot vouch for itself; fails_when=the copy gamma gains in the same publication counts as an earlier disclosure, or a private proposer skips the check; why_new=only sealed copies may authorize a wider audience; seam=none; no_claim=none
    for (const proposer of ['public', 'private'] as const) {
      test(`a ${proposer} skill cannot show a private skill's convention to readers by giving it to a public skill through a shared rewrite`, () => fixture(async f => {
        await publishHidden(f, 'private');
        expect((await put(f, f.local, 'gamma', [prose('gamma', 'Use the root.', [ROOT]), root()]) as { state?: string }).state).toBe('committed');
        const before = { heads: await heads(f), checkout: checkout(f.root) };
        const caller = proposer === 'public' ? f.editor : f.local;
        const outcome = await put(f, caller, 'beta', [prose('beta', 'Use the root.', [ROOT]), root([GUIDE]), guide(['readers'])], proposer === 'private' ? { private: true } : {})
          .then(() => 'published', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
        expect(outcome).toBe(proposer === 'public'
          ? `local_conflict: The publication was refused: ${GUIDE} would reach a wider audience than the 1 skill that already holds it gives it. Nothing was written.`
          : `local_conflict: The publication was refused: ${GUIDE} would reach a wider audience than skills/alpha gives it. Nothing was written.`);
        expect({ heads: await heads(f), reader: await readerCopy(f, 'gamma'), checkout: checkout(f.root) })
          .toEqual({ heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
      }, url), 120_000);
    }

    // Value: protects=a hidden skill's own edit cannot hand its file to a public skill through a shared rewrite; fails_when=the proposal that keeps hiding the file is not counted as a holder, so gamma shows it to readers; why_new=the holder check skipped proposals; seam=none; no_claim=none
    test('a hidden skill that rewrites a shared file so a public skill gains its convention refuses', () => fixture(async f => {
      expect((await put(f, f.local, 'gamma', [prose('gamma', 'Use the root.', [ROOT]), root()]) as { state?: string }).state).toBe('committed');
      expect((await put(f, f.local, 'alpha', [{ ...prose('alpha', 'Use the root.', [ROOT, GUIDE]), audience: RESTRICTED }, root(), guide(['readers'])]) as { state?: string }).state).toBe('committed');
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await put(f, f.editor, 'alpha', [{ ...prose('alpha', 'Use the root.', [ROOT, GUIDE]), audience: RESTRICTED }, root([GUIDE]), guide(['readers'])])
        .then(() => 'published', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      expect(outcome).toBe(`local_conflict: The publication was refused: ${GUIDE} would reach a wider audience than the 1 skill that already holds it gives it. Nothing was written.`);
      expect({ heads: await heads(f), reader: await readerCopy(f, 'gamma'), checkout: checkout(f.root) })
        .toEqual({ heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
    }, url), 120_000);

    // Value: protects=adding a brand-new helper to a convention that a restricted skill also holds still publishes; fails_when=the restricted skill, which gains the helper in the same publication, counts as a holder that hides it; why_new=the new check must not over-refuse; seam=none; no_claim=none
    test('a new helper added to a convention that a restricted skill also holds publishes', () => fixture(async f => {
      for (const files of [[prose('beta', 'Use the root.', [ROOT]), root()], [{ ...prose('alpha', 'Use the root.', [ROOT]), audience: RESTRICTED }, root()]]) {
        const name = files[0].path.split('/')[1];
        expect((await put(f, f.local, name, files) as { state?: string }).state).toBe('committed');
      }
      const result = await put(f, f.editor, 'beta', [prose('beta', 'Use the root.', [ROOT]), root([GUIDE]), guide(['readers'])]);
      expect({ state: (result as { state?: string }).state, reader: await readerCopy(f, 'beta') }).toEqual({ state: 'committed', reader: 'Synthetic shared guide body.\n' });
    }, url), 120_000);

    // Value: protects=a skill the owner's policy now hides keeps its convention hidden; fails_when=a revoked readers audience on the holder's SKILL.md still counts as showing the file to the editor; why_new=the catalog applies the source policy to both audiences; seam=none; no_claim=none
    test('a convention held by a skill whose readers audience the policy revoked stays hidden from a remote put_skill', () => fixture(async f => {
      for (const [name, files] of [['alpha', [prose('alpha', 'Use the guide.', [GUIDE]), guide(RESTRICTED)]], ['beta', [{ ...prose('beta', 'Standalone.'), audience: RESTRICTED }]]] as const) {
        expect((await put(f, f.local, name, [...files]) as { state?: string }).state).toBe('committed');
      }
      const [policy] = await f.engine.executeRaw<{ epoch: string }>('SELECT epoch FROM shared_skill_policies WHERE source_id=$1', ['default']);
      await setSharedSkillPolicy(f.local, 'default', { ...POLICY, audiences: RESTRICTED }, policy.epoch);
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await put(f, f.editor, 'beta', [{ ...prose('beta', 'Now uses the guide.', [GUIDE]), audience: RESTRICTED }, guide(RESTRICTED)])
        .then(() => 'published', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
      expect(outcome).toBe(`local_conflict: The publication was refused: ${GUIDE} would reach a wider audience than the 1 skill that already holds it gives it. Nothing was written.`);
      expect({ heads: await heads(f), checkout: checkout(f.root) }).toEqual(before);
    }, url), 120_000);

    // Value: protects=a request queued by an older release that shows a hidden skill's convention to readers is checked again before it touches the checkout; fails_when=resume publishes beta with alpha's guide; why_new=no check ran at prepare; seam=the request row is shaped like one an older release accepted, from this brain's own committed put_skill; no_claim=none
    test('a queued publication from an older release that shows a hidden convention to readers is refused on resume', () => fixture(async f => {
      await publishHidden(f, 'audience');
      const [request] = await f.engine.executeRaw<Record<string, any>>("SELECT * FROM persistence_requests WHERE operation='put_skill' ORDER BY sequence DESC LIMIT 1");
      const [pack] = await f.engine.executeRaw<{ revision: string }>('SELECT revision::text AS revision FROM shared_skill_packs WHERE source_id=$1', ['default']);
      const intent = typeof request.intent === 'string' ? JSON.parse(request.intent) : request.intent;
      const current = Object.fromEntries((await heads(f)).map(head => [head.name, head.revision]));
      const files = normalizeSkillFiles('beta', [prose('beta', 'Now uses the guide.', [GUIDE]), guide(['readers'])]);
      const old = { ...request, intent: { ...intent, expected_revision: current.beta, affected: ['alpha', 'beta'].map(target => ({ name: target, revision: current[target] })),
        expected_pack_revision: pack.revision, proposals: [{ name: 'beta', files, metadata: skillMetadata('beta', files, {}), expected_revision: current.beta }] } };
      const before = { heads: await heads(f), checkout: checkout(f.root) };
      const outcome = await prepareSharedSkillMutation(f.engine, old as never, f.local.config).then(() => 'prepared', (error: { code?: string }) => error.code);
      expect({ outcome, heads: await heads(f), reader: await readerCopy(f, 'beta'), checkout: checkout(f.root) })
        .toEqual({ outcome: 'local_conflict', heads: before.heads, reader: 'skill_asset_not_found', checkout: before.checkout });
    }, url), 120_000);
  });
}
