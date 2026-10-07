/**
 * #6188 fence repair receipts and commit messages.
 *
 * Protects: the durable `fence_repair` receipt a fence repair's write records
 * (`managed_file_repair` with `fenceRepair`, or a trusted local `put_page`
 * with `fence_repair`), its Git commit subject `gbrain: repair fence in
 * <path> (<classes>)` and, in a batched commit, one `<path> (<classes>)` body
 * line per repaired path; refusals of a fence repair routed to `gbrain repair
 * fences` (D6); `fence_repair` refused from every remote caller; location-only
 * privacy of receipts and commit messages.
 * Fails when: the commit note is dropped anywhere between the preparer and
 * `git commit` (file target, Git effect data, effect worker, commitGitTargets),
 * a malformed or mismatched receipt is written, an MCP caller can set
 * `fence_repair`, a fence repair's refusal names the frontmatter repair, or a
 * commit without metadata changes its message.
 * Why new: no test covered Git commit messages or a repair receipt;
 * test/repair-frontmatter.test.ts covers `managed_file_repair` without one.
 * Seams: none; real PGLite (and a Postgres arm) managed brains and real Git checkouts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { confinedRepairTarget, managedRepairRoot, prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../src/core/persistence/file-repair.ts';
import type { FenceRepairReceipt } from '../src/core/fence-repair/receipt.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-fence-receipts-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** The last commit's message without a trailing trailer paragraph: a host's git may append one (a co-author line); gbrain writes none. */
const lastMessage = (root: string) => git(root, 'log', '-1', '--format=%B').trimEnd().replace(/\n\n(?:[A-Za-z-]+: [^\n]*\n?)+$/, '');
const commits = (root: string) => Number(git(root, 'rev-list', '--count', 'HEAD').trim());

const FB = '<!--- gbrain:facts:begin -->', FE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
/** Privacy sentinel: a claim that must never reach a receipt, an effect row or a commit message. */
const CLAIM = 'Sentinelclaimrq7 renews yearly';
const row = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | private | medium | 2026-01-01 |  | call |  |`;
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\nA synthetic note.\n\n${body}`;
/** A facts fence without a header row: managed sync holds it for a model repair. */
const headerless = (title: string) => page(title, `${FB}\n${row(1, CLAIM)}\n${row(2, 'Another synthetic fact')}\n${FE}\n`);
const repaired = (title: string) => page(title, `${FB}\n${FH}\n${row(1, CLAIM)}\n${row(2, 'Another synthetic fact')}\n${FE}\n`);
const receiptFor = (before: string, after: string, classes = ['no_header']): FenceRepairReceipt => ({ actor: 'fence-repair', tier: 'llm', classes,
  rows: [1, 2], columns: ['#', 'claim'], model: 'example:fence-model', before_sha256: sha256(before), after_sha256: sha256(after), cost_usd: 0.002 });

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

const quiet = { info() {}, warn() {}, error() {} };
const localCtx = (engine: BrainEngine, sourceId: string, remote = false) =>
  ({ engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote, sourceId }) as unknown as OperationContext;

/** A managed source over a durability-hardened checkout holding `files`, synced once. */
async function managed(engine: BrainEngine, files: Record<string, string>) {
  const id = `fr-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  /** What the repair preview would bind: the publication digest of `content` at `path`. */
  const digestOf = async (path: string, content: string) => {
    const slug = path.replace(/\.md$/, '');
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: id, includeDeleted: true });
    const publication = await prepareRepairPublication(engine, { sourceId: id, slug, sourcePath: path, path, root, content, snapshot, base: snapshot, ...await repairScreenConfig(engine, id) });
    if (publication.status !== 'ready') throw new Error(`fixture publication is ${publication.status}`);
    return { slug, resultDigest: publication.digest, revision: snapshot?.revision };
  };
  return { id, root, read, digestOf };
}

/** Runs queued effects here (and waits for the consumer's) until no Git effect of the source is open. */
async function gitEffectsSettled(engine: BrainEngine, sourceId: string) {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    const open = await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='git' AND state<>'committed'", [sourceId]);
    if (!open.length) return;
    await Bun.sleep(100);
  }
  throw new Error('git effects did not settle');
}

const durableOutcome = async (engine: BrainEngine, requestId: string) =>
  (await engine.executeRaw<{ outcome: Record<string, unknown> | null }>('SELECT outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.outcome ?? null;
const gitEffectData = async (engine: BrainEngine, requestId: string) =>
  (await engine.executeRaw<{ data: Record<string, unknown> }>(`SELECT e.data FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE r.request_id=$1::uuid AND e.kind='git'`, [requestId]))[0]?.data;

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); } finally { await disposePersistenceConsumer(engine); }
    }
  });
}

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

test('commitGitTargets: a noted path committing alone takes its subject; a group keeps the generic subject and lists noted lines in path order', () => withEnv(env, async () => {
  const root = mkdtempSync(join(home, 'commit-notes-'));
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const path of ['a.md', 'notes/b.md', 'notes/c.md', 'z.md']) write(path, 'seed\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  const note = (path: string, classes: string) => ({ subject: `gbrain: repair fence in ${path} (${classes})`, line: `${path} (${classes})` });

  write('notes/b.md', 'repaired\n');
  expect((await commitGitTargets(root, ['notes/b.md'], undefined, new Map([['notes/b.md', note('notes/b.md', 'close_fence, header_alias')]]))).get('notes/b.md')).toEqual({ git: 'committed' });
  expect(lastMessage(root)).toBe('gbrain: repair fence in notes/b.md (close_fence, header_alias)');

  for (const path of ['z.md', 'notes/c.md', 'a.md']) write(path, 'batched\n');
  const batch = await commitGitTargets(root, ['z.md', 'notes/c.md', 'a.md'], undefined,
    new Map([['z.md', note('z.md', 'row_renumbered')], ['a.md', note('a.md', 'no_header')]]));
  expect([...batch.values()]).toEqual([{ git: 'committed' }, { git: 'committed' }, { git: 'committed' }]);
  expect(lastMessage(root)).toBe('gbrain: persist 3 canonical memory updates\n\na.md (no_header)\nz.md (row_renumbered)');

  // A preparer's text never adds lines or trailers: control characters are stripped.
  write('a.md', 'again\n');
  await commitGitTargets(root, ['a.md'], undefined, new Map([['a.md', { subject: 'gbrain: repair fence in a.md (close_fence)\n\nSigned-off-by: x', line: 'unused' }]]));
  expect(lastMessage(root)).toBe('gbrain: repair fence in a.md (close_fence)Signed-off-by: x');

  // Without notes, single and grouped commits keep their messages byte for byte.
  write('a.md', 'plain\n');
  await commitGitTargets(root, ['a.md']);
  expect(lastMessage(root)).toBe('gbrain: persist canonical memory update');
  write('a.md', 'plain again\n'); write('z.md', 'plain again\n');
  await commitGitTargets(root, ['a.md', 'z.md'], undefined, new Map());
  expect(lastMessage(root)).toBe('gbrain: persist 2 canonical memory updates');
}), 60_000);

test('a managed_file_repair with a fence receipt commits under the fence subject and its durable receipt carries fence_repair, location only', () => each(async engine => {
  const s = await managed(engine, { 'notes/alpha.md': headerless('Alpha') });
  const hold = ((await readGitSourceHolds(engine, { sourceIds: [s.id] }))[0]?.holds ?? []).find(h => h.path === 'notes/alpha.md');
  expect(hold?.code).toBe('invalid_fence');
  const before = s.read('notes/alpha.md'), after = repaired('Alpha');
  const { slug, resultDigest } = await s.digestOf('notes/alpha.md', after);
  const receipt = receiptFor(before, after);
  const requestId = randomUUID();
  const outcome = await submitManagedFileRepair(localCtx(engine, s.id), { sourceId: s.id, requestId, slug, path: 'notes/alpha.md', sourcePath: 'notes/alpha.md',
    content: after, beforeHash: sha256(before), resultDigest, noEmbed: true, fenceRepair: receipt });
  expect(outcome).toMatchObject({ state: 'committed', file_repaired: true, hold_cleared: true, fence_repair: receipt });
  expect((await durableOutcome(engine, requestId))?.fence_repair).toEqual(receipt);
  expect(s.read('notes/alpha.md')).toBe(after);
  const data = await gitEffectData(engine, requestId);
  expect(data).toMatchObject({ commit_subject: 'gbrain: repair fence in notes/alpha.md (no_header)', commit_line: 'notes/alpha.md (no_header)' });

  await gitEffectsSettled(engine, s.id);
  expect(lastMessage(s.root)).toBe('gbrain: repair fence in notes/alpha.md (no_header)');
  expect(git(s.root, 'status', '--porcelain', '--', 'notes/alpha.md')).toBe('');
  for (const text of [JSON.stringify(outcome), JSON.stringify(await durableOutcome(engine, requestId)), JSON.stringify(data), git(s.root, 'log', '--format=%B')]) {
    expect(text).not.toContain('Sentinelclaimrq7');
  }
}), 180_000);

test('without a receipt the repair keeps the generic subject and names the frontmatter repair; with one, refusals name gbrain repair fences', () => each(async engine => {
  const s = await managed(engine, { 'notes/plain.md': page('Plain', 'First version.\n') });
  const before = s.read('notes/plain.md'), after = page('Plain', 'Second version.\n');
  const { slug, resultDigest, revision } = await s.digestOf('notes/plain.md', after);
  const input = { sourceId: s.id, slug, path: 'notes/plain.md', sourcePath: 'notes/plain.md', content: after, resultDigest, expected_revision: revision, noEmbed: true };

  const stale = 'b'.repeat(64);
  const frontmatter = await refusal(() => submitManagedFileRepair(localCtx(engine, s.id), { ...input, requestId: randomUUID(), beforeHash: stale }));
  expect(frontmatter.code).toBe('changed_since_preview');
  expect(frontmatter.suggestion).toContain(`gbrain repair frontmatter --source ${s.id}`);
  expect(frontmatter.fix?.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', s.id]);
  const fences = await refusal(() => submitManagedFileRepair(localCtx(engine, s.id), { ...input, requestId: randomUUID(), beforeHash: stale,
    fenceRepair: { ...receiptFor(before, after, ['close_fence']), before_sha256: stale } }));
  expect(fences.code).toBe('changed_since_preview');
  expect(fences.suggestion).toContain(`gbrain repair fences --source ${s.id}`);
  expect(fences.fix?.argv).toEqual(['gbrain', 'repair', 'fences', '--source', s.id]);
  expect(JSON.stringify({ message: fences.message, suggestion: fences.suggestion, fix: fences.fix })).not.toContain('frontmatter');
  let confined: unknown;
  try { confinedRepairTarget(s.root, '../outside.md', s.id, 'fences'); } catch (error) { confined = error; }
  expect((confined as OperationError).suggestion).toContain('gbrain repair fences writes only regular files');

  const requestId = randomUUID();
  const outcome = await submitManagedFileRepair(localCtx(engine, s.id), { ...input, requestId, beforeHash: sha256(before) });
  expect(outcome).toMatchObject({ state: 'committed', file_repaired: true });
  expect(outcome).not.toHaveProperty('fence_repair');
  expect(await gitEffectData(engine, requestId)).not.toHaveProperty('commit_subject');
  await gitEffectsSettled(engine, s.id);
  expect(lastMessage(s.root)).toBe('gbrain: persist canonical memory update');
}), 180_000);

test('a malformed or mismatched fence receipt is refused before admission and by the preparer; nothing is written', () => each(async engine => {
  const s = await managed(engine, { 'notes/gamma.md': page('Gamma', 'First version.\n') });
  const before = s.read('notes/gamma.md'), after = page('Gamma', 'Second version.\n');
  const { slug, resultDigest, revision } = await s.digestOf('notes/gamma.md', after);
  const input = { sourceId: s.id, slug, path: 'notes/gamma.md', sourcePath: 'notes/gamma.md', content: after, beforeHash: sha256(before), resultDigest, expected_revision: revision, noEmbed: true };
  const receipt = receiptFor(before, after, ['close_fence']);
  const requests = async (requestId: string) => (await engine.executeRaw('SELECT 1 FROM persistence_requests WHERE request_id=$1::uuid', [requestId])).length;

  for (const [bad, why] of [[{ ...receipt, actor: 'someone-else' }, 'is malformed'], [{ ...receipt, classes: ['Close fence'] }, 'is malformed'],
    [{ ...receipt, before_sha256: 'c'.repeat(64) }, 'previewed file bytes'], [{ ...receipt, after_sha256: 'd'.repeat(64) }, 'repaired file bytes']] as const) {
    const requestId = randomUUID();
    const error = await refusal(() => submitManagedFileRepair(localCtx(engine, s.id), { ...input, requestId, fenceRepair: bad as unknown as FenceRepairReceipt }));
    expect(error.code).toBe('invalid_params');
    expect(error.message).toContain(why);
    expect(error.fix?.argv).toEqual(['gbrain', 'repair', 'fences', '--source', s.id]);
    expect(await requests(requestId)).toBe(0);
  }

  // The preparer checks the stored intent itself (a replay, or a caller that skipped the submit checks).
  const { ownerEpoch } = await managedRepairRoot(engine, s.id);
  const requestId = randomUUID();
  const stored = await refusal(() => submitPageMutation(localCtx(engine, s.id), { operation: 'put_page', waitMs: 30_000, managedFileImport: true, params: {
    kind: 'managed_file_repair', slug, source_id: s.id, request_id: requestId, path: 'notes/gamma.md', sourcePath: 'notes/gamma.md', content: after,
    beforeHash: sha256(before), resultDigest, ownerEpoch, expected_revision: revision, noEmbed: true, fenceRepair: { ...receipt, after_sha256: 'e'.repeat(64) } } }));
  expect(stored.code).toBe('invalid_params');
  expect(stored.message).toContain('repaired file bytes');
  expect(s.read('notes/gamma.md')).toBe(before);
  expect((await engine.getPage(slug, { sourceId: s.id }))?.compiled_truth).toContain('First version.');
}), 180_000);

test('put_page fence_repair is refused from remote callers and malformed values; a trusted local put_page records it and commits under the fence subject', () => each(async engine => {
  const s = await managed(engine, { 'notes/beta.md': page('Beta', 'First version.\n') });
  const snapshot = (await engine.readPageSnapshot('notes/beta', { sourceId: s.id }))!;
  const content = repaired('Beta');
  const receipt = receiptFor(s.read('notes/beta.md'), content, ['close_fence']);
  const params = { slug: 'notes/beta', source_id: s.id, content, expected_revision: snapshot.revision, fence_repair: receipt };

  const remote = await refusal(() => submitPageMutation(localCtx(engine, s.id, true), { operation: 'put_page', params: { ...params, request_id: randomUUID() } }));
  expect(remote).toMatchObject({ code: 'invalid_params', message: 'fence_repair is reserved for the trusted fence repair.' });
  const malformed = await refusal(() => submitPageMutation(localCtx(engine, s.id), { operation: 'put_page', params: { ...params, request_id: randomUUID(), fence_repair: { ...receipt, tier: 'manual' } } }));
  expect(malformed.code).toBe('invalid_params');
  const otherVerb = await refusal(() => submitPageMutation(localCtx(engine, s.id), { operation: 'capture', params: { content: 'A synthetic capture.', source_id: s.id, fence_repair: receipt } }));
  expect(otherVerb.code).toBe('invalid_params');
  expect(s.read('notes/beta.md')).toBe(page('Beta', 'First version.\n'));

  const requestId = randomUUID();
  const response = await submitPageMutation(localCtx(engine, s.id), { operation: 'put_page', params: { ...params, request_id: requestId } });
  expect(response).toMatchObject({ state: 'committed', fence_repair: receipt });
  expect((await durableOutcome(engine, requestId))?.fence_repair).toEqual(receipt);
  await gitEffectsSettled(engine, s.id);
  expect(lastMessage(s.root)).toBe('gbrain: repair fence in notes/beta.md (close_fence)');
  for (const text of [JSON.stringify(response), JSON.stringify(await gitEffectData(engine, requestId)), git(s.root, 'log', '--format=%B')]) {
    expect(text).not.toContain('Sentinelclaimrq7');
  }
}), 180_000);

test('fence repairs that commit in one Git group list one path and its classes per body line; an ordinary write in the group adds none', () => each(async engine => {
  const s = await managed(engine, { 'notes/one.md': page('One', 'First.\n'), 'notes/two.md': page('Two', 'First.\n'), 'notes/three.md': page('Three', 'First.\n') });
  const effectSql = (sql: string) => engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql); });
  const startCommits = commits(s.root);
  // Hold every new effect back so the three writes reach the runner as one group.
  await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
  try {
    for (const [path, classes] of [['notes/two.md', ['row_renumbered']], ['notes/one.md', ['close_fence', 'header_alias']]] as const) {
      const before = s.read(path), after = page(path === 'notes/one.md' ? 'One' : 'Two', 'Repaired.\n');
      const { slug, resultDigest, revision } = await s.digestOf(path, after);
      await submitManagedFileRepair(localCtx(engine, s.id), { sourceId: s.id, requestId: randomUUID(), slug, path, sourcePath: path, content: after,
        beforeHash: sha256(before), resultDigest, expected_revision: revision, noEmbed: true, fenceRepair: receiptFor(before, after, [...classes]) });
    }
    const three = (await engine.readPageSnapshot('notes/three', { sourceId: s.id }))!;
    await submitPageMutation(localCtx(engine, s.id), { operation: 'put_page', params: { slug: 'notes/three', source_id: s.id, request_id: randomUUID(),
      content: page('Three', 'Second.\n'), expected_revision: three.revision } });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()');
  }
  await effectSql(`UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git' AND state='queued' AND source_id='${s.id}'`);
  await gitEffectsSettled(engine, s.id);
  expect(commits(s.root)).toBe(startCommits + 1);
  expect(lastMessage(s.root)).toBe('gbrain: persist 3 canonical memory updates\n\nnotes/one.md (close_fence, header_alias)\nnotes/two.md (row_renumbered)');
}), 180_000);
