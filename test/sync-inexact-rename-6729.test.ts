/**
 * #6729: an inexact Git rename (R<100) is a similarity guess, so it keeps the old page's identity only when the files
 * confirm it (a shared frontmatter id, or a unique slug: line or title). Every other pair is a delete plus an add, the
 * old page keeps its facts, links and aliases on its soft-deleted slug, the run records it, the purge leaves it alone
 * until the pair is settled (no time window), doctor names it, and a restore keeps the old page when a person asks for it.
 * Classic sync, managed sync and the dirty-tree manifest each keep an R<100 fixture; R100 variants sit beside them.
 * New modules are imported lazily so this file loads (and fails by behavior) on a master without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const write = (root: string, path: string, body: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); };
const BODY = Array.from({ length: 30 }, (_, i) => `- Shared meeting ${i}: discussed the project roadmap, hiring and next steps.`).join('\n');
const doc = (front: string, tail = '') => `---\n${front}\n---\n\n${BODY}\n${tail}`;
const diffStatus = (root: string) => git(root, 'diff', '--name-status', '-M', 'HEAD~1', 'HEAD').split('\n').sort();
const repairCtx = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

for (const kind of testBackends()) describe(`inexact Git rename identity (#6729, ${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-6729-'));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1').catch(() => undefined);
    if (close) await close(); else await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  async function classic(files: Record<string, string>) {
    const id = `c${randomUUID().replace(/-/g, '').slice(0, 14)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q', '-b', 'main');
    for (const [path, body] of Object.entries(files)) write(root, path, body);
    commit(root, 'initial');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    const sync = (extra: Record<string, unknown> = {}) => performSync(engine, { repoPath: root, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1, ...extra });
    await sync();
    return { id, root, sync };
  }
  async function managed(files: Record<string, string>) {
    const id = `m${randomUUID().replace(/-/g, '').slice(0, 14)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
    for (const [path, body] of Object.entries(files)) write(root, path, body);
    commit(root, 'initial');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const sync = (extra: Record<string, unknown> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, ...extra });
    await sync();
    return { id, root, sync };
  }
  const pageRow = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; deleted_at: string | null }>(
    'SELECT id, deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0];
  const factSlugs = (sourceId: string) => engine.executeRaw<{ entity_slug: string; fact: string }>('SELECT entity_slug, fact FROM facts WHERE source_id=$1 ORDER BY fact', [sourceId]);
  const redirects = (sourceId: string) => engine.executeRaw<{ alias_slug: string; canonical_slug: string }>('SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id=$1 ORDER BY alias_slug', [sourceId]);
  const aliasOwner = async (sourceId: string, alias: string) => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM page_aliases WHERE source_id=$1 AND alias_norm=$2 ORDER BY slug', [sourceId, alias])).map(row => row.slug);

  test('classic: crossed inexact pairs with one shared title keep their own facts and aliases, are recorded, held from purge, named by doctor, and the restore fix keeps one', () => withEnv(env, async () => {
    const s = await classic({
      'people/a-x-com.md': doc('type: person\ntitle: Colleague\naliases: [Ali]', 'Works on payments.\n'),
      'people/b-x-com.md': doc('type: person\ntitle: Colleague\naliases: [Bea]', 'Works on search.\n'),
      'people/peer.md': '---\ntype: person\ntitle: Peer\n---\n\nA different person.\n',
    });
    const a = (await pageRow(s.id, 'people/a-x-com'))!, b = (await pageRow(s.id, 'people/b-x-com'))!, peer = (await pageRow(s.id, 'people/peer'))!;
    await engine.insertFact({ fact: 'A works on payments', entity_slug: 'people/a-x-com', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    await engine.insertFact({ fact: 'B works on search', entity_slug: 'people/b-x-com', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    await engine.executeRaw("INSERT INTO links(from_page_id,to_page_id,link_type,link_source) VALUES($1,$2,'knows','test')", [a.id, peer.id]);
    // Both files move and are rewritten; Git pairs them by body similarity alone, and their shared title cannot confirm either pair.
    git(s.root, 'mv', 'people/a-x-com.md', 'people/bob.md'); git(s.root, 'mv', 'people/b-x-com.md', 'people/alice.md');
    write(s.root, 'people/bob.md', doc('type: person\ntitle: Colleague\naliases: [Bobby]', 'Works on search.\n'));
    write(s.root, 'people/alice.md', doc('type: person\ntitle: Colleague\naliases: [Alicia]', 'Works on payments.\n'));
    commit(s.root, 'move and rewrite both');
    for (const line of diffStatus(s.root)) expect(line).toMatch(/^R0\d\d\t/);
    const result = await s.sync();
    expect(result).toMatchObject({ status: 'synced', renamed: 0 });
    const alice = (await pageRow(s.id, 'people/alice'))!, bob = (await pageRow(s.id, 'people/bob'))!;
    expect([alice.id, bob.id]).not.toContain(a.id);
    expect([alice.id, bob.id]).not.toContain(b.id);
    expect((await pageRow(s.id, 'people/a-x-com'))!.deleted_at).not.toBeNull();
    expect(await factSlugs(s.id)).toEqual([{ entity_slug: 'people/a-x-com', fact: 'A works on payments' }, { entity_slug: 'people/b-x-com', fact: 'B works on search' }]);
    expect(await aliasOwner(s.id, 'ali')).toEqual(['people/a-x-com']);
    expect(await aliasOwner(s.id, 'bea')).toEqual(['people/b-x-com']);
    expect(await redirects(s.id)).toEqual([]);
    expect(result.identityDowngrades?.map(entry => [entry.from, entry.to, entry.reason]).sort()).toEqual([
      ['people/a-x-com.md', 'people/alice.md', 'title_not_unique'], ['people/b-x-com.md', 'people/bob.md', 'title_not_unique']]);
    expect(result.identityDowngrades?.find(entry => entry.from === 'people/a-x-com.md')).toMatchObject({ old_slug: 'people/a-x-com', new_slug: 'people/alice', facts: 1, links: 1, aliases: 1 });

    // The purge leaves both old pages while their records are open.
    expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs.filter(slug => slug.endsWith('-x-com'))).toEqual([]);
    expect(await pageRow(s.id, 'people/a-x-com')).toBeDefined();

    // Doctor names them; the fix is the first pair's preview-bound remedy (ask_user, destructive) and restoring the old page is
    // the alternative it names. Take the alternative here (the remedy has its own suite), then verify clears that pair.
    const { renameIdentityDowngradesEntry } = await import('../src/commands/doctor/checks/rename-identity-downgrades.ts');
    const doctor = async () => (await renameIdentityDowngradesEntry.run({ engine } as unknown as DoctorContext)) as unknown as Array<{ status: string; details: { count: number; by_source: Array<{ source_id: string; count: number }>; samples: Array<{ old_slug: string; new_slug: string }>; restore_unavailable_sources?: string[] }; fix?: Record<string, unknown> & { argv: string[]; why: string; plan_hash: string; verify: { argv: string[] } } }>;
    const mine = (finding: Awaited<ReturnType<typeof doctor>>[number]) => finding.details.by_source.find(entry => entry.source_id === s.id)?.count ?? 0;
    const [finding] = await doctor();
    expect(finding!.status).toBe('warn');
    expect(mine(finding!)).toBe(2);
    const { purgeStaleCheckpoints } = await import('../src/core/op-checkpoint.ts');
    const age = () => engine.executeRaw("UPDATE op_checkpoints SET updated_at = now() - interval '30 days' WHERE op = 'sync-identity-downgrade' AND fingerprint = ANY($1::text[])", [[String(a.id), String(b.id)]]);
    const close = (id: number) => engine.executeRaw("UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,disposition}', jsonb_build_object('kind', 'closed', 'at', now()::text)) WHERE op = 'sync-identity-downgrade' AND fingerprint = $1", [String(id)]);
    if (kind === 'postgres') {
      // An unbound classic Postgres source refuses page writes outside its checkout, so no surface offers the restore
      // there; the pairs still hold their old pages, with no time window, until a disposition.
      // The doctor fix there is the pair's remedy (a classic carry).
      const { new_slug: carryOnto } = finding!.details.samples[0]!;
      const carryPreview = ['gbrain', 'repair', 'rename-identity', '--source', s.id, '--slug', carryOnto];
      expect(structuredClone(finding!.fix)).toMatchObject({ argv: [...carryPreview, '--apply', '--expect', finding!.fix!.plan_hash, '--yes'], preview_argv: carryPreview, consent: ['destructive'], ask_user: true });
      expect(finding!.fix!.why).not.toContain('gbrain restore');
      expect(finding!.details.restore_unavailable_sources).toContain(s.id);
      await age(); await purgeStaleCheckpoints(engine);
      expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs.filter(slug => slug.endsWith('-x-com'))).toEqual([]);
      await close(a.id);
      expect(mine((await doctor())[0]!)).toBe(1);
      expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toContain('people/a-x-com');
      return;
    }
    const { old_slug: slug, new_slug: newSlug } = finding!.details.samples[0]!, sourceId = s.id;
    const restored = { 'people/a-x-com': { id: a.id, fact: 'A works on payments', alias: 'ali' }, 'people/b-x-com': { id: b.id, fact: 'B works on search', alias: 'bea' } }[slug!]!;
    const other = slug === 'people/a-x-com' ? { slug: 'people/b-x-com', id: b.id } : { slug: 'people/a-x-com', id: a.id };
    expect(slug).toMatch(/^people\/[ab]-x-com$/);
    const preview = ['gbrain', 'repair', 'rename-identity', '--source', s.id, '--slug', newSlug];
    expect(structuredClone(finding!.fix)).toMatchObject({ argv: [...preview, '--apply', '--expect', finding!.fix!.plan_hash, '--yes'], preview_argv: preview, consent: ['destructive'], actor: 'agent', ask_user: true,
      user_message: expect.stringContaining(slug), verify: { argv: ['gbrain', 'doctor', '--only', 'rename_identity_downgrades', '--json'] } });
    expect(finding!.fix!.why).toContain(`gbrain restore ${slug} --source-id ${s.id} --force`);
    const { deriveNext } = await import('../src/core/agent-output.ts');
    expect(deriveNext(finding!.fix as never, { transport: 'cli', isCallable: () => false, preapproved: () => true })).toBe('ask_user');
    // Run the alternative (gbrain restore <slug> --source-id <id> --force) through its operation, then the verify.
    const { operationsByName } = await import('../src/core/operations.ts');
    await operationsByName.restore_page!.handler({ ...repairCtx(engine), sourceId } as never, { slug, source_id: sourceId, force: true });
    expect((await pageRow(s.id, slug!))).toMatchObject({ id: restored.id, deleted_at: null });
    expect(await factSlugs(s.id)).toContainEqual({ entity_slug: slug, fact: restored.fact });
    expect(await aliasOwner(s.id, restored.alias)).toEqual([slug]);
    const [after] = await doctor();
    expect(mine(after!)).toBe(1);
    expect((await pageRow(s.id, other.slug))!.deleted_at).not.toBeNull();
    // No time window: a month-old open record survives the checkpoint sweep and still holds its old page, and doctor
    // still names it; only a disposition releases it. A restored page deleted again later is not held by its old record.
    await age(); await purgeStaleCheckpoints(engine);
    expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).not.toContain(other.slug);
    expect(mine((await doctor())[0]!)).toBe(1);
    await engine.softDeletePage(slug!, { sourceId: s.id });
    expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toContain(slug);
    expect((await engine.executeRaw('SELECT fingerprint FROM op_checkpoints WHERE op = $1 AND fingerprint = ANY($2::text[])', ['sync-identity-downgrade', [String(a.id), String(b.id)]])).map(row => (row as { fingerprint: string }).fingerprint)).toEqual([String(other.id)]);
    await close(other.id);
    expect(mine((await doctor())[0]!)).toBe(0);
    expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toContain(other.slug);
  }), 180_000);

  test('classic: a move plus edit keeps its identity through a unique title, and an exact move needs no signal', () => withEnv(env, async () => {
    const s = await classic({ 'notes/plan.md': doc('title: Roadmap Q3 planning'), 'notes/untitled.md': doc('type: note') });
    const plan = (await pageRow(s.id, 'notes/plan'))!, untitled = (await pageRow(s.id, 'notes/untitled'))!;
    await engine.insertFact({ fact: 'Roadmap ships in Q3', entity_slug: 'notes/plan', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    git(s.root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); write(s.root, 'notes/roadmap.md', doc('title: Roadmap Q3 planning', 'An added paragraph.\n'));
    git(s.root, 'mv', 'notes/untitled.md', 'notes/moved.md');
    commit(s.root, 'move and edit');
    expect(diffStatus(s.root)).toEqual([expect.stringMatching(/^R0\d\d\tnotes\/plan.md\tnotes\/roadmap.md$/), 'R100\tnotes/untitled.md\tnotes/moved.md']);
    expect(await s.sync()).toMatchObject({ status: 'synced', renamed: 2, added: 0, deleted: 0 });
    expect((await pageRow(s.id, 'notes/roadmap'))!.id).toBe(plan.id);
    expect((await pageRow(s.id, 'notes/moved'))!.id).toBe(untitled.id);
    expect(await factSlugs(s.id)).toEqual([{ entity_slug: 'notes/roadmap', fact: 'Roadmap ships in Q3' }]);
  }), 180_000);

  test('classic: an id-bearing move and edit in two commits before one sync keeps its identity (same id and title); a no-signal move and edit does not', () => withEnv(env, async () => {
    const s = await classic({ 'notes/x.md': doc('id: note-6729-x\ntitle: First title'), 'notes/plain.md': doc('type: note') });
    const x = (await pageRow(s.id, 'notes/x'))!, plain = (await pageRow(s.id, 'notes/plain'))!;
    await engine.insertFact({ fact: 'X has a fact', entity_slug: 'notes/x', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    git(s.root, 'mv', 'notes/x.md', 'notes/y.md'); commit(s.root, 'move');
    write(s.root, 'notes/y.md', `---\nid: note-6729-x\ntitle: First title\n---\n\nRewritten from scratch, nothing like before.\n`); commit(s.root, 'rewrite');
    git(s.root, 'mv', 'notes/plain.md', 'notes/plain-2.md'); write(s.root, 'notes/plain-2.md', doc('type: note', 'An edit.\n')); commit(s.root, 'move and edit plain');
    const result = await s.sync();
    expect(result.status).toBe('synced');
    expect((await pageRow(s.id, 'notes/y'))!.id).toBe(x.id);
    expect(await factSlugs(s.id)).toEqual([{ entity_slug: 'notes/y', fact: 'X has a fact' }]);
    expect((await pageRow(s.id, 'notes/plain-2'))!.id).not.toBe(plain.id);
    expect((await pageRow(s.id, 'notes/plain'))!.deleted_at).not.toBeNull();
    expect(result.identityDowngrades?.map(entry => [entry.from, entry.reason])).toEqual([['notes/plain.md', 'no_identity_signal']]);
  }), 180_000);

  test('classic: a template id reused by a new note while the old note is deleted stays a delete plus an add', () => withEnv(env, async () => {
    const s = await classic({ 'templates/meeting.md': doc('id: tmpl-6729\ntitle: Meeting template'), 'notes/standup-1.md': doc('id: tmpl-6729\ntitle: Standup one') });
    const one = (await pageRow(s.id, 'notes/standup-1'))!;
    await engine.insertFact({ fact: 'Standup one decided X', entity_slug: 'notes/standup-1', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    git(s.root, 'rm', '-q', 'notes/standup-1.md');
    write(s.root, 'notes/standup-2.md', doc('id: tmpl-6729\ntitle: Standup two', 'Different decisions.\n'));
    commit(s.root, 'replace one note with another from the template');
    await s.sync();
    expect((await pageRow(s.id, 'notes/standup-2'))!.id).not.toBe(one.id);
    expect(await factSlugs(s.id)).toEqual([{ entity_slug: 'notes/standup-1', fact: 'Standup one decided X' }]);
  }), 180_000);

  test('classic: an unpaired add and delete sharing an id no live page holds need continuity: a template id reused by a new note stays a delete plus an add, the same file name in a new folder is a rename', () => withEnv(env, async () => {
    const s = await classic({ 'notes/standup-1.md': doc('id: tmpl-6729-free\ntitle: Standup one'), 'notes/retro.md': doc('id: retro-6729\ntitle: Retro') });
    const one = (await pageRow(s.id, 'notes/standup-1'))!, retro = (await pageRow(s.id, 'notes/retro'))!;
    await engine.insertFact({ fact: 'Standup one decided X', entity_slug: 'notes/standup-1', visibility: 'world', source: 'synthetic' }, { source_id: s.id });
    git(s.root, 'rm', '-q', 'notes/standup-1.md');
    write(s.root, 'notes/standup-2.md', `---\nid: tmpl-6729-free\ntitle: Standup two\n---\n\nA different meeting entirely.\n`);
    git(s.root, 'rm', '-q', 'notes/retro.md');
    write(s.root, 'archive/retro.md', `---\nid: retro-6729\ntitle: Retro, archived\n---\n\nRewritten summary.\n`);
    commit(s.root, 'replace one note from the template, archive another');
    expect(diffStatus(s.root)).toEqual(['A\tarchive/retro.md', 'A\tnotes/standup-2.md', 'D\tnotes/retro.md', 'D\tnotes/standup-1.md']);
    const result = await s.sync();
    expect(result.status).toBe('synced');
    expect((await pageRow(s.id, 'notes/standup-2'))!.id).not.toBe(one.id);
    expect(await factSlugs(s.id)).toEqual([{ entity_slug: 'notes/standup-1', fact: 'Standup one decided X' }]);
    expect((await pageRow(s.id, 'archive/retro'))!.id).toBe(retro.id);
  }), 180_000);

  test('dirty tree: an uncommitted move plus edit with no signal is a delete plus an add; one with a unique title keeps its identity', () => withEnv(env, async () => {
    const s = await classic({ 'notes/draft.md': doc('type: note'), 'notes/spec.md': doc('title: Storage spec 6729') });
    const draft = (await pageRow(s.id, 'notes/draft'))!, spec = (await pageRow(s.id, 'notes/spec'))!;
    git(s.root, 'mv', 'notes/draft.md', 'notes/draft-2.md'); write(s.root, 'notes/draft-2.md', doc('type: note', 'Edited.\n'));
    git(s.root, 'mv', 'notes/spec.md', 'notes/storage-spec.md'); write(s.root, 'notes/storage-spec.md', doc('title: Storage spec 6729', 'Edited.\n'));
    git(s.root, 'add', '-A');
    expect(git(s.root, 'diff', '--cached', '--name-status', '-M').split('\n').every(line => /^R0\d\d\t/.test(line))).toBe(true);
    const result = await s.sync({ workingTree: true });
    expect(result.status).toBe('synced');
    expect((await pageRow(s.id, 'notes/draft-2'))!.id).not.toBe(draft.id);
    expect((await pageRow(s.id, 'notes/storage-spec'))!.id).toBe(spec.id);
  }), 180_000);

  test('H1-only pages: a unique H1 keeps a moved and edited page in classic, managed and dirty-tree sync; a shared H1 or a title changed in the brain does not', () => withEnv(env, async () => {
    const h1 = (title: string, tail = '') => `# ${title}\n\n${BODY}\n${tail}`;
    for (const mode of ['classic', 'managed'] as const) {
      const s = await (mode === 'classic' ? classic : managed)({
        'notes/plan.md': h1(`Roadmap ${mode} h1 6729`), 'notes/spec.md': h1(`Spec ${mode} h1 6729`), 'notes/draft.md': h1(`Draft ${mode} h1 6729`),
        'people/a.md': h1('Colleague', 'Works on payments.\n'), 'people/b.md': h1('Colleague', 'Works on search.\n'),
      });
      const plan = (await pageRow(s.id, 'notes/plan'))!, spec = (await pageRow(s.id, 'notes/spec'))!, draft = (await pageRow(s.id, 'notes/draft'))!;
      const a = (await pageRow(s.id, 'people/a'))!, b = (await pageRow(s.id, 'people/b'))!;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('UPDATE pages SET title=$3 WHERE source_id=$1 AND slug=$2', [s.id, 'notes/spec', 'Retitled in the brain']);
      if (mode === 'managed') await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      git(s.root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); write(s.root, 'notes/roadmap.md', h1(`Roadmap ${mode} h1 6729`, 'Edited.\n'));
      git(s.root, 'mv', 'notes/spec.md', 'notes/spec-2.md'); write(s.root, 'notes/spec-2.md', h1(`Spec ${mode} h1 6729`, 'Edited.\n'));
      git(s.root, 'mv', 'people/a.md', 'people/bob.md'); git(s.root, 'mv', 'people/b.md', 'people/alice.md');
      write(s.root, 'people/bob.md', h1('Colleague', 'Works on search.\nNow Bob.\n')); write(s.root, 'people/alice.md', h1('Colleague', 'Works on payments.\nNow Alice.\n'));
      commit(s.root, 'move and edit');
      for (const line of diffStatus(s.root)) expect(line).toMatch(/^R0\d\d\t/);
      const result = await s.sync();
      expect(result.status).toBe('synced');
      expect((await pageRow(s.id, 'notes/roadmap'))!.id).toBe(plan.id);
      expect((await pageRow(s.id, 'notes/spec-2'))!.id).not.toBe(spec.id);
      expect([(await pageRow(s.id, 'people/alice'))!.id, (await pageRow(s.id, 'people/bob'))!.id]).not.toContain(a.id);
      expect([(await pageRow(s.id, 'people/alice'))!.id, (await pageRow(s.id, 'people/bob'))!.id]).not.toContain(b.id);
      expect(result.identityDowngrades?.map(entry => [entry.from, entry.reason]).sort()).toEqual([
        ['notes/spec.md', 'no_identity_signal'], ['people/a.md', 'title_not_unique'], ['people/b.md', 'title_not_unique']]);
      git(s.root, 'mv', 'notes/draft.md', 'notes/draft-2.md'); write(s.root, 'notes/draft-2.md', h1(`Draft ${mode} h1 6729`, 'Edited.\n'));
      git(s.root, 'add', '-A');
      expect(git(s.root, 'diff', '--cached', '--name-status', '-M')).toMatch(/^R0\d\d\tnotes\/draft.md\tnotes\/draft-2.md$/);
      expect((await s.sync({ workingTree: true })).status).toBe('synced');
      expect((await pageRow(s.id, 'notes/draft-2'))!.id).toBe(draft.id);
    }
  }), 240_000);

  test('dirty tree: a rename verdict is bound to the bytes it read; a file edited between the verdict and the identity move moves nothing, and the next sync re-checks it (classic and managed)', () => withEnv(env, async () => {
    for (const mode of ['classic', 'managed'] as const) {
      const s = await (mode === 'classic' ? classic : managed)({ 'notes/spec.md': doc(`title: Drift spec 6729 ${mode}`) });
      const spec = (await pageRow(s.id, 'notes/spec'))!;
      git(s.root, 'mv', 'notes/spec.md', 'notes/spec-2.md'); write(s.root, 'notes/spec-2.md', doc(`title: Drift spec 6729 ${mode}`, 'Edited.\n'));
      git(s.root, 'add', '-A');
      expect(git(s.root, 'diff', '--cached', '--name-status', '-M')).toMatch(/^R0\d\d\tnotes\/spec.md\tnotes\/spec-2.md$/);
      // The edit lands after the verdict read the file (on its stored-title lookup) and before the identity move.
      let drifted = false;
      const racing = new Proxy(engine, { get(target, key) {
        if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          const rows = await target.executeRaw(sql, params);
          if (!drifted && sql.startsWith('SELECT slug, source_path, title FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND (source_path')) {
            drifted = true; write(s.root, 'notes/spec-2.md', doc('id: drifted-6729\ntitle: A different document', 'Edited.\n'));
          }
          return rows;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as BrainEngine;
      if (mode === 'classic') {
        const result = await performSync(racing, { repoPath: s.root, sourceId: s.id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1, workingTree: true });
        expect(result).toMatchObject({ status: 'blocked_by_failures', failedFiles: 1 });
      } else {
        await expect(performManagedSync(racing, { sourceId: s.id, noPull: true, workingTree: true })).rejects.toMatchObject({ code: 'source_changed' });
      }
      expect(drifted).toBe(true);
      expect(await pageRow(s.id, 'notes/spec')).toMatchObject({ id: spec.id, deleted_at: null });
      expect(await pageRow(s.id, 'notes/spec-2')).toBeUndefined();
      // Classic re-checks on the next sync; managed rediscovers through the --retry-failed its refusal names.
      const again = await s.sync({ workingTree: true, ...(mode === 'managed' ? { retryFailed: true } : {}) });
      expect(again.identityDowngrades?.map(entry => [entry.from, entry.reason])).toEqual([['notes/spec.md', 'id_one_side']]);
      expect((await pageRow(s.id, 'notes/spec-2'))!.id).not.toBe(spec.id);
    }
  }), 240_000);

  test('dirty tree: an untracked move (plain mv) keeps its page through its id and file name; an untracked note reusing a deleted note\'s id under another name does not', () => withEnv(env, async () => {
    const s = await classic({ 'notes/keep.md': doc('id: untracked-6729-keep\ntitle: Keep me'), 'notes/old.md': doc('id: untracked-6729-tmpl\ntitle: Old note') });
    const keep = (await pageRow(s.id, 'notes/keep'))!, old = (await pageRow(s.id, 'notes/old'))!;
    rmSync(join(s.root, 'notes/keep.md')); write(s.root, 'archive/keep.md', `---\nid: untracked-6729-keep\ntitle: Keep me, archived\n---\n\nShort now.\n`);
    rmSync(join(s.root, 'notes/old.md')); write(s.root, 'notes/new.md', `---\nid: untracked-6729-tmpl\ntitle: New note\n---\n\nUnrelated.\n`);
    expect(git(s.root, 'status', '--porcelain').split('\n').map(line => line.trim()).sort()).toEqual(['?? archive/', '?? notes/new.md', 'D notes/keep.md', 'D notes/old.md']);
    expect((await s.sync({ workingTree: true })).status).toBe('synced');
    expect((await pageRow(s.id, 'archive/keep'))!.id).toBe(keep.id);
    expect((await pageRow(s.id, 'notes/new'))!.id).not.toBe(old.id);
  }), 180_000);

  test('three pages sharing one title: an inexact move of one of them is a delete plus an add', () => withEnv(env, async () => {
    const s = await classic({ 'notes/a.md': doc('title: Weekly sync'), 'notes/b.md': doc('title: Weekly sync', 'B.\n'), 'notes/c.md': doc('title: Weekly sync', 'C.\n') });
    const a = (await pageRow(s.id, 'notes/a'))!;
    git(s.root, 'mv', 'notes/a.md', 'notes/a-2.md'); write(s.root, 'notes/a-2.md', doc('title: Weekly sync', 'An edit.\n'));
    commit(s.root, 'move and edit one');
    expect(diffStatus(s.root)).toEqual([expect.stringMatching(/^R0\d\d\tnotes\/a.md\tnotes\/a-2.md$/)]);
    const result = await s.sync();
    expect((await pageRow(s.id, 'notes/a-2'))!.id).not.toBe(a.id);
    expect(result.identityDowngrades?.map(entry => entry.reason)).toEqual(['title_not_unique']);
  }), 180_000);

  test('2,000 id-bearing files moved to a new folder and edited (Git pairs most inexactly, the rest as delete plus add) all become renames through one cat-file stream within 20 s', async () => {
    const { confirmRenameIdentities } = await import('../src/core/sync-rename-identity.ts');
    const { buildSyncManifest } = await import('../src/core/sync.ts');
    const root = join(home, 'bulk'); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q', '-b', 'main');
    const N = 2000;
    for (let i = 0; i < N; i++) writeFileSync(join(root, `notes/n${i}.md`), doc(`id: bulk-${i}\ntitle: Bulk note ${i}`));
    const base = commit(root, 'bulk');
    for (let i = 0; i < N; i++) { rmSync(join(root, `notes/n${i}.md`)); mkdirSync(join(root, 'moved'), { recursive: true }); writeFileSync(join(root, `moved/n${i}.md`), doc(`id: bulk-${i}\ntitle: Bulk note ${i} moved`, 'Edited.\n')); }
    const target = commit(root, 'bulk move and edit');
    const manifest = buildSyncManifest(git(root, '-c', 'diff.renameLimit=5000', 'diff', '--name-status', '-M', base, target));
    expect(manifest.renamed.length).toBeGreaterThan(N / 2);
    expect(manifest.renamed.every(rename => (rename.similarity ?? 100) < 100)).toBe(true);
    const engine0 = { executeRaw: async () => [] } as unknown as BrainEngine;
    const started = performance.now();
    const confirmed = await confirmRenameIdentities(engine0, root, base, target, manifest, { sourceId: 'bulk' });
    const elapsed = performance.now() - started;
    expect(confirmed.renamed.length).toBe(N);
    expect(confirmed.renamed.every(rename => rename.from.replace('notes/', '') === rename.to.replace('moved/', ''))).toBe(true);
    expect(confirmed.added).toEqual([]);
    expect(confirmed.deleted).toEqual([]);
    // Stated budget: 4,000 frontmatter heads (both sides) through one cat-file stream plus the pure decision in under 20 s on a
    // 4-vCPU CI machine (about 2.5 s measured locally), so a large reorganization never stalls discovery.
    expect(elapsed).toBeLessThan(20_000);
  }, 300_000);

  test('a case-respelling move plus edit keeps its page in classic and managed sync; in managed sync a conflicting explicit id does not inherit', () => withEnv(env, async () => {
    for (const mode of ['classic', 'managed'] as const) {
      const s = await (mode === 'classic' ? classic : managed)({ 'notes/Foo Bar.md': doc('title: First title'), 'notes/Id Doc.md': doc('id: id-doc-one-6729\ntitle: Id doc') });
      const foo = (await pageRow(s.id, 'notes/foo-bar'))!, idDoc = (await pageRow(s.id, 'notes/id-doc'))!;
      git(s.root, 'mv', 'notes/Foo Bar.md', 'notes/foo-bar.md'); write(s.root, 'notes/foo-bar.md', doc('title: A new title', 'An edit.\n'));
      commit(s.root, 'respell and edit');
      expect(diffStatus(s.root)).toEqual([expect.stringMatching(/^R0\d\d\tnotes\/Foo Bar.md\tnotes\/foo-bar.md$/)]);
      const result = await s.sync();
      expect(result.status).toBe('synced');
      expect((await pageRow(s.id, 'notes/foo-bar'))).toMatchObject({ id: foo.id, deleted_at: null });
      expect(result.identityDowngrades ?? []).toEqual([]);
      if (mode === 'classic') continue;
      // Managed discovery's same-slug takeover: only a conflicting explicit id vetoes it, before anything is written.
      git(s.root, 'mv', 'notes/Id Doc.md', 'notes/id-doc.md'); write(s.root, 'notes/id-doc.md', doc('id: id-doc-two-6729\ntitle: Id doc', 'Another document.\n'));
      commit(s.root, 'respell with a different id');
      await expect(s.sync()).rejects.toMatchObject({ code: 'page_identity_changed', detail: 'rename_identity_conflict' });
      expect((await pageRow(s.id, 'notes/id-doc'))).toMatchObject({ id: idDoc.id, deleted_at: null });
    }
  }), 240_000);

  test('managed: a held rename whose fixed file carries a different explicit id does not inherit the held page', () => withEnv(env, async () => {
    const s = await managed({ 'notes/x.md': doc('id: held-6729-one\ntitle: Held X\nslug: notes/x') });
    const x = (await pageRow(s.id, 'notes/x'))!;
    git(s.root, 'mv', 'notes/x.md', 'notes/y.md'); commit(s.root, 'exact move onto a stale slug: line');
    expect(diffStatus(s.root)).toEqual(['R100\tnotes/x.md\tnotes/y.md']);
    const held = await s.sync();
    expect(held.held?.[0]).toMatchObject({ path: 'notes/y.md' });
    write(s.root, 'notes/y.md', doc('id: held-6729-two\ntitle: Another document'));
    commit(s.root, 'replace the held file with a different document');
    await s.sync();
    const y = (await pageRow(s.id, 'notes/y'))!;
    expect(y.id).not.toBe(x.id);
    expect((await pageRow(s.id, 'notes/x'))!.id).toBe(x.id);
  }), 180_000);

  test('dirty tree reads the working-tree side from disk: an id only the working file carries, and an unstaged id conflict on a staged rename, both stay delete plus add (classic and managed)', () => withEnv(env, async () => {
    for (const mode of ['classic', 'managed'] as const) {
      const s = await (mode === 'classic' ? classic : managed)({ 'notes/w.md': doc('title: Working one'), 'notes/s.md': doc('id: staged-6729-one\ntitle: Staged one') });
      const w = (await pageRow(s.id, 'notes/w'))!, st = (await pageRow(s.id, 'notes/s'))!;
      git(s.root, 'mv', 'notes/w.md', 'notes/w-2.md'); write(s.root, 'notes/w-2.md', doc('id: working-6729\ntitle: Working two', 'Edited.\n'));
      git(s.root, 'mv', 'notes/s.md', 'notes/s-2.md'); write(s.root, 'notes/s-2.md', doc('id: staged-6729-one\ntitle: Staged two', 'Edited.\n'));
      git(s.root, 'add', '-A');
      // The index still pairs s.md -> s-2.md under the same id; only the working file changes it.
      write(s.root, 'notes/s-2.md', doc('id: staged-6729-two\ntitle: Staged two', 'Edited.\n'));
      expect(git(s.root, 'diff', '--cached', '--name-status', '-M').split('\n').every(line => /^R0\d\d\t/.test(line))).toBe(true);
      const result = await s.sync({ workingTree: true });
      expect(result.status).toBe('synced');
      expect(result.identityDowngrades?.map(entry => [entry.from, entry.reason, entry.read]).sort()).toEqual([
        ['notes/s.md', 'id_conflict', { from: 'commit', to: 'working_tree' }], ['notes/w.md', 'id_one_side', { from: 'commit', to: 'working_tree' }]]);
      expect((await pageRow(s.id, 'notes/w-2'))!.id).not.toBe(w.id);
      expect((await pageRow(s.id, 'notes/s-2'))!.id).not.toBe(st.id);
    }
  }), 240_000);

  test('managed: crossed inexact pairs with one shared title never swap identities; a unique title keeps one', () => withEnv(env, async () => {
    const s = await managed({
      'people/a-x-com.md': doc('type: person\ntitle: Colleague\naliases: [Ali]', 'Works on payments.\n'),
      'people/b-x-com.md': doc('type: person\ntitle: Colleague\naliases: [Bea]', 'Works on search.\n'),
      'notes/plan.md': doc('title: Managed roadmap 6729'),
    });
    const a = (await pageRow(s.id, 'people/a-x-com'))!, b = (await pageRow(s.id, 'people/b-x-com'))!, plan = (await pageRow(s.id, 'notes/plan'))!;
    git(s.root, 'mv', 'people/a-x-com.md', 'people/bob.md'); git(s.root, 'mv', 'people/b-x-com.md', 'people/alice.md');
    write(s.root, 'people/bob.md', doc('type: person\ntitle: Colleague\naliases: [Bobby]', 'Works on search.\n'));
    write(s.root, 'people/alice.md', doc('type: person\ntitle: Colleague\naliases: [Alicia]', 'Works on payments.\n'));
    git(s.root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); write(s.root, 'notes/roadmap.md', doc('title: Managed roadmap 6729', 'Edited.\n'));
    commit(s.root, 'move and rewrite');
    for (const line of diffStatus(s.root)) expect(line).toMatch(/^R0\d\d\t/);
    const result = await s.sync();
    expect(result).toMatchObject({ status: 'synced', renamed: 1 });
    const alice = (await pageRow(s.id, 'people/alice'))!, bob = (await pageRow(s.id, 'people/bob'))!;
    expect([alice.id, bob.id]).not.toContain(a.id);
    expect([alice.id, bob.id]).not.toContain(b.id);
    expect((await pageRow(s.id, 'people/a-x-com'))!.deleted_at).not.toBeNull();
    expect((await pageRow(s.id, 'notes/roadmap'))!.id).toBe(plan.id);
    expect(await aliasOwner(s.id, 'ali')).toEqual(['people/a-x-com']);
    expect(await redirects(s.id)).toEqual([{ alias_slug: 'notes/plan', canonical_slug: 'notes/roadmap' }]);
    expect(result.identityDowngrades?.map(entry => entry.from).sort()).toEqual(['people/a-x-com.md', 'people/b-x-com.md']);
    const { readSyncStatus } = await import('../src/core/persistence/sync-status.ts');
    expect((await readSyncStatus(engine, s.id, { detail: false })).identity_downgrades.map(entry => entry.old_slug).sort()).toEqual(['people/a-x-com', 'people/b-x-com']);
  }), 180_000);

  test('managed: a file whose explicit id differs from the page holding its slug does not take that page over', () => withEnv(env, async () => {
    const s = await managed({ 'notes/Foo Bar.md': doc('id: doc-one-6729\ntitle: Document one') });
    const one = (await pageRow(s.id, 'notes/foo-bar'))!;
    git(s.root, 'rm', '-q', 'notes/Foo Bar.md');
    write(s.root, 'notes/foo-bar.md', doc('id: doc-two-6729\ntitle: Document two', 'A different document.\n'));
    commit(s.root, 'replace with a different document at the same slug');
    await expect(s.sync()).rejects.toMatchObject({ code: 'page_identity_changed', detail: 'rename_identity_conflict' });
    expect((await pageRow(s.id, 'notes/foo-bar'))).toMatchObject({ id: one.id, deleted_at: null });
  }), 180_000);
});
