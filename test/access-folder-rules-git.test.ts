/**
 * GBRA-218 (PR A2): folder rules on a git-backed source.
 *
 * 1. Protects: `<source root>/.gbrain/access.yml` is read by sync from the synced
 *    commit (also when it is the only changed path) and applied before the
 *    commit's pages are imported; narrowing applies, widening is held until
 *    gbrain access apply, which commits `.gbrain/access.approved` through the
 *    door. A malformed file keeps the last applied rules and hides what it
 *    touches. A rebuilt database reaches the same rules from git alone. The
 *    persisted store survives a removed .git, and rule migrate moves rules
 *    between stores without a moment where one is missing.
 * 2. Fails when: a git commit alone widens access; sync skips a policy-only
 *    commit; a bad file opens or keeps open a folder; a rebuild loses rules;
 *    a migrate or a missing checkout drops rules.
 * 3. Existing coverage (access-folder-rules) pins the database store.
 * 4. Real seams: real git repositories (one with a bare remote), performSync,
 *    gbrain git commit-push through commitPolicyFile, the CLI module, PGLite.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { policyStatus } from '../src/core/access/policy.ts';
import { readCommittedPolicy, syncAccessPolicyAt, commitPolicyFile, POLICY_FILE } from '../src/core/access/policy-git.ts';
import { acquireCommitLock } from '../src/core/git/commit-push.ts';
import { withEnv } from './helpers/with-env.ts';

const SRC = 'gt-src';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function writePage(root: string, slug: string, body = 'Notes.') {
  mkdirSync(join(root, slug, '..'), { recursive: true });
  writeFileSync(join(root, `${slug}.md`), `---\ntype: note\ntitle: ${slug}\n---\n# ${slug}\n\n${body}\n`);
}
function writePolicy(root: string, text: string, file = POLICY_FILE) {
  mkdirSync(join(root, '.gbrain'), { recursive: true });
  writeFileSync(join(root, file), text);
}
const POLICY = (rules: Array<[string, string, string]>) => ['version: 1', 'rules:', ...rules.flatMap(([id, prefix, readers]) => [`  - id: ${id}`, `    prefix: ${prefix}`, `    readable_by: [${readers}]`])].join('\n') + '\n';

async function seedBrain(engine: PGLiteEngine, root: string): Promise<PGLiteEngine> {
  await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}')", [SRC, root]);
  for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
  return engine;
}

async function stamps(engine: PGLiteEngine): Promise<Record<string, string[] | null>> {
  const rows = await engine.executeRaw<{ slug: string; folder_rule_ids: string[] | null }>('SELECT slug, folder_rule_ids FROM pages WHERE source_id = $1 ORDER BY slug', [SRC]);
  return Object.fromEntries(rows.map(r => [r.slug, r.folder_rule_ids]));
}

async function cli(engine: PGLiteEngine, args: string[]): Promise<any> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runAccessRules(engine, args[0]!, [...args.slice(1), '--json'], true); } finally { spy.mockRestore(); }
  return JSON.parse(lines.join('\n'));
}

const sync = (engine: PGLiteEngine, root: string, full = false) => performSync(engine, { sourceId: SRC, repoPath: root, noPull: true, noEmbed: true, ...(full ? { full: true } : {}) });

describe('folder access rules, git store', () => {
  let root: string;
  let engine: PGLiteEngine;
  const spares: PGLiteEngine[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const e = new PGLiteEngine();
      await e.connect({ engine: 'pglite' } as never);
      await e.initSchema();
      spares.push(e);
    }
    root = mkdtempSync(join(tmpdir(), 'gbrain-frgit-'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t.co');
    git(root, 'config', 'user.name', 't');
    for (const s of ['notes/open', 'partners/alice-example/plan', 'partners/team/notes']) writePage(root, s);
    writePolicy(root, POLICY([['team', 'partners/', 'alice-example, bob-example']]));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'pages and policy');
    engine = await seedBrain(spares[0]!, root);
  }, 120_000);

  afterAll(async () => {
    for (const e of spares) await e.disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  test('the first sync reads the committed policy before importing, persists the git store and stamps pages', async () => {
    await sync(engine, root, true);
    const s = await policyStatus(engine, SRC);
    expect({ store: s.store, rules: s.rules.map(r => r.id) }).toEqual({ store: 'git', rules: ['team'] });
    expect(await stamps(engine)).toEqual({ 'notes/open': null, 'partners/alice-example/plan': [`${SRC}:team`], 'partners/team/notes': [`${SRC}:team`] });
  }, 120_000);

  test('a policy-only commit is applied by the next sync (narrowing at once)', async () => {
    writePolicy(root, POLICY([['team', 'partners/', 'alice-example, bob-example'], ['alice', 'partners/alice-example/', 'alice-example']]));
    git(root, 'commit', '-q', '-am', 'narrow');
    await sync(engine, root);
    expect((await stamps(engine))['partners/alice-example/plan']).toEqual([`${SRC}:alice`, `${SRC}:team`]);
    expect((await policyStatus(engine, SRC)).held).toEqual([]);
  }, 120_000);

  test('a committed widening is held; gbrain access apply commits access.approved through the door and applies it', async () => {
    writePolicy(root, POLICY([['team', 'partners/', 'alice-example, bob-example']]));
    git(root, 'commit', '-q', '-am', 'drop alice rule');
    await sync(engine, root);
    const held = await policyStatus(engine, SRC);
    expect({ rules: held.rules.map(r => r.id), held: held.held.map(h => `${h.rule}:${h.kind}`) }).toEqual({ rules: ['alice', 'team'], held: ['alice:removed'] });
    const preview = await cli(engine, ['apply', '--source', SRC]);
    expect(preview.widening[0].gains).toEqual(['bob-example']);
    const applied = await cli(engine, ['apply', '--source', SRC, '--yes', '--expect', preview.plan_hash]);
    expect({ outcome: applied.git.outcome, path: applied.git.path }).toEqual({ outcome: 'committed_local', path: '.gbrain/access.approved' });
    expect(git(root, 'log', '-1', '--format=%s')).toContain('approve folder rules');
    expect(readCommittedPolicy(root).approved).toContain('id: team');
    expect((await policyStatus(engine, SRC)).rules.map(r => r.id)).toEqual(['team']);
    expect((await stamps(engine))['partners/alice-example/plan']).toEqual([`${SRC}:team`]);
  }, 120_000);

  test('a hand-edited access.approved does not widen: the removal stays held and the file is reported', async () => {
    writePolicy(root, POLICY([]));
    writePolicy(root, POLICY([]), '.gbrain/access.approved');
    git(root, 'commit', '-q', '-am', 'remove everything by hand');
    const r = await syncAccessPolicyAt(engine, SRC, root);
    expect({ approved: r?.approved_file, held: r?.proposal?.held.map(h => h.rule) }).toEqual({ approved: 'untrusted', held: ['team'] });
    expect((await policyStatus(engine, SRC)).rules.map(r => r.id)).toEqual(['team']);
    writePolicy(root, POLICY([['team', 'partners/', 'alice-example, bob-example']]));
    writePolicy(root, POLICY([['team', 'partners/', 'alice-example, bob-example']]), '.gbrain/access.approved');
    git(root, 'commit', '-q', '-am', 'restore');
    await syncAccessPolicyAt(engine, SRC, root);
    expect((await policyStatus(engine, SRC)).held).toEqual([]);
  }, 120_000);

  test('a malformed file keeps the applied rules and hides the prefixes it names; an unparseable one hides the source', async () => {
    writePolicy(root, POLICY([['team', 'partners/', 'alice-example, bob-example'], ['hr', 'hr/', 'Not Valid']]));
    git(root, 'commit', '-q', '-am', 'bad readers');
    const r = await syncAccessPolicyAt(engine, SRC, root);
    expect(r?.state).toBe('invalid');
    let s = await policyStatus(engine, SRC);
    expect({ rules: s.rules.map(x => x.id), invalid: s.invalid.map(c => c.prefix) }).toEqual({ rules: ['team'], invalid: ['hr/', 'partners/'] });
    expect((s.invalid[0]!.detail as { problems: Array<{ line: number }> }).problems[0]!.line).toBe(6);
    writePolicy(root, 'version: 1\nrules: [\n');
    git(root, 'commit', '-q', '-am', 'broken yaml');
    await syncAccessPolicyAt(engine, SRC, root);
    s = await policyStatus(engine, SRC);
    expect(s.invalid.map(c => c.prefix)).toEqual(['']);
    writePolicy(root, POLICY([['team', 'partners/', 'alice-example, bob-example']]));
    git(root, 'commit', '-q', '-am', 'fixed');
    await syncAccessPolicyAt(engine, SRC, root);
    expect((await policyStatus(engine, SRC)).invalid).toEqual([]);
  }, 120_000);

  test('gbrain access rule add on a git source commits access.yml through the door and applies it at once', async () => {
    const r = await cli(engine, ['rule', 'add', '--source', SRC, '--prefix', 'partners/alice-example/', '--readers', 'alice-example', '--id', 'alice', '--yes']);
    expect({ store: r.store, state: r.state, outcome: r.git.outcome, path: r.git.path }).toEqual({ store: 'git', state: 'applied', outcome: 'committed_local', path: POLICY_FILE });
    expect(readCommittedPolicy(root).yml).toContain('id: alice');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect((await stamps(engine))['partners/alice-example/plan']).toEqual([`${SRC}:alice`, `${SRC}:team`]);
  }, 120_000);

  test('a busy commit lock refuses after one retry and leaves the file as it was', async () => {
    const lock = acquireCommitLock(root);
    try {
      await withEnv({ GBRAIN_COMMIT_LOCK_WAIT_SECONDS: '0' }, async () => {
        expect(() => commitPolicyFile(root, POLICY_FILE, () => 'version: 1\nrules: []\n', 'should not land')).toThrow(expect.objectContaining({ code: 'commit_lock_busy' }));
      });
    } finally { lock.release(); }
    expect(readCommittedPolicy(root).yml).toContain('id: alice');
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, 60_000);

  test('a rebuilt database reaches the same applied rules from git alone', async () => {
    const before = (await policyStatus(engine, SRC)).rules;
    const fresh = await seedBrain(spares[1]!, root);
    await sync(fresh, root, true);
    expect((await policyStatus(fresh, SRC)).rules).toEqual(before);
    expect(await stamps(fresh)).toEqual(await stamps(engine));
  }, 120_000);

  test('the persisted store survives a removed .git: rules stay applied and edits refuse access_policy_store_mismatch', async () => {
    renameSync(join(root, '.git'), join(root, '.git-away'));
    try {
      await expect(runAccessRules(engine, 'rule', ['add', '--source', SRC, '--prefix', 'x/', '--readers', 'alice-example', '--yes'], true)).rejects.toMatchObject({ code: 'access_policy_store_mismatch' });
      const s = await policyStatus(engine, SRC);
      expect({ store: s.store, rules: s.rules.map(r => r.id) }).toEqual({ store: 'git', rules: ['alice', 'team'] });
    } finally { renameSync(join(root, '.git-away'), join(root, '.git')); }
  }, 60_000);

  test('rule migrate moves the rules to the database and back with no rule missing at any phase', async () => {
    const rules = (await policyStatus(engine, SRC)).rules;
    const toDb = await cli(engine, ['rule', 'migrate', '--source', SRC, '--yes']);
    expect({ to: toDb.to, phase: toDb.phase }).toEqual({ to: 'database', phase: 'switched' });
    expect((await policyStatus(engine, SRC)).rules).toEqual(rules);
    writePolicy(root, POLICY([]));
    git(root, 'commit', '-q', '-am', 'ignored while the database is the record');
    expect((await syncAccessPolicyAt(engine, SRC, root))?.state).toBe('skipped');
    expect((await policyStatus(engine, SRC)).rules).toEqual(rules);
    const toGit = await cli(engine, ['rule', 'migrate', '--source', SRC, '--yes']);
    expect({ to: toGit.to, phase: toGit.phase, sync: toGit.receipts.sync }).toEqual({ to: 'git', phase: 'switched', sync: 'unchanged' });
    expect(readCommittedPolicy(root).yml).toContain('id: alice');
    expect((await policyStatus(engine, SRC)).rules).toEqual(rules);
  }, 120_000);

  test('a commit with a bare remote pushes, and two sources in one repo each read their own root', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'gbrain-frgit-bare-'));
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-frgit-two-'));
    try {
      git(bare, 'init', '-q', '--bare', '-b', 'main');
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 't@t.co');
      git(repo, 'config', 'user.name', 't');
      for (const sub of ['sub-a', 'sub-b']) writePage(join(repo, sub), 'partners/x/plan');
      writePolicy(join(repo, 'sub-a'), POLICY([['x', 'partners/x/', 'alice-example']]));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'two sources');
      git(repo, 'remote', 'add', 'origin', bare);
      git(repo, 'push', '-q', '-u', 'origin', 'main');
      const e = await seedBrain(spares[2]!, join(repo, 'sub-a'));
      {
        await e.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('gt-b', 'gt-b', $1, '{}')", [join(repo, 'sub-b')]);
        expect((await syncAccessPolicyAt(e, SRC, join(repo, 'sub-a')))?.state).toBe('applied');
        expect((await syncAccessPolicyAt(e, 'gt-b', join(repo, 'sub-b')))?.state).toBe('skipped');
        const r = await cli(e, ['rule', 'add', '--source', 'gt-b', '--prefix', 'partners/x/', '--readers', 'bob-example', '--yes']);
        expect({ store: r.store, outcome: r.git.outcome }).toEqual({ store: 'git', outcome: 'pushed' });
        expect(existsSync(join(repo, 'sub-b', POLICY_FILE))).toBe(true);
        expect(git(bare, 'log', '-1', '--format=%s', 'main')).toContain('partners/x/');
        expect((await policyStatus(e, SRC)).rules.map(x => x.readable_by)).toEqual([['member:alice-example']]);
        expect((await policyStatus(e, 'gt-b')).rules.map(x => x.readable_by)).toEqual([['member:bob-example']]);
      }
    } finally { rmSync(bare, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
  }, 120_000);
});

describe('a moved prefix on a git source (L4)', () => {
  let root: string;
  let engine: PGLiteEngine;
  const hidden = async (slug: string) => {
    const [row] = await engine.executeRaw<{ hidden: boolean }>(
      `SELECT (folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(source_id, slug)) AS hidden FROM pages WHERE source_id = $1 AND slug = $2`, [SRC, slug]);
    return row?.hidden;
  };

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    root = mkdtempSync(join(tmpdir(), 'gbrain-frgit-move-'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t.co');
    git(root, 'config', 'user.name', 't');
    for (const s of ['projects/old-example/doc', 'projects/new-example/doc']) writePage(root, s);
    writePolicy(root, POLICY([['mv', 'projects/old-example/', 'alice-example']]));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'pages and policy');
    await seedBrain(engine, root);
    await sync(engine, root, true);
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  test('a committed move restricts the new folder at once; the old folder stays hidden until apply, then opens', async () => {
    expect({ old: await hidden('projects/old-example/doc'), new: await hidden('projects/new-example/doc') }).toEqual({ old: true, new: false });
    writePolicy(root, POLICY([['mv', 'projects/new-example/', 'alice-example']]));
    git(root, 'commit', '-q', '-am', 'move mv');
    await sync(engine, root);
    const status = await policyStatus(engine, SRC);
    expect(status.held.map(h => `${h.kind}:${h.prefix}`)).toEqual(['prefix_released:projects/old-example/']);
    expect({ old: await hidden('projects/old-example/doc'), new: await hidden('projects/new-example/doc') }).toEqual({ old: true, new: true });
    expect((await stamps(engine))['projects/new-example/doc']).toEqual([`${SRC}:mv`]);
    const preview = await cli(engine, ['apply', '--source', SRC]);
    expect(preview.widening.map((w: { change: { kind: string; prefix: string }; sample: string[] }) => ({ kind: w.change.kind, prefix: w.change.prefix, sample: w.sample })))
      .toEqual([{ kind: 'prefix_released', prefix: 'projects/old-example/', sample: ['projects/old-example/doc'] }]);
    const applied = await cli(engine, ['apply', '--source', SRC, '--yes', '--expect', preview.plan_hash]);
    expect(applied.git.path).toBe('.gbrain/access.approved');
    expect({ old: await hidden('projects/old-example/doc'), new: await hidden('projects/new-example/doc') }).toEqual({ old: false, new: true });
    expect((await policyStatus(engine, SRC)).rules.map(r => `${r.id}:${r.prefix}`)).toEqual(['mv:projects/new-example/']);
  }, 120_000);
});
