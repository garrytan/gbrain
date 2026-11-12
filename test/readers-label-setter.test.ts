/**
 * GST-2059 / GST-2476 (D1): gbrain repair visibility --readers sets a page's readable_by through the label-only door.
 *
 * 1. Protects: the operator command that names a page's readers on one page (--slug) or a listed set (--slugs-file),
 *    preview-bound (--apply --expect <hash>, a changed plan refuses preview_changed). Every reader must be an enabled
 *    member or an existing group; a list that leaves out the brain owner refuses unless --allow-without-owner (a group
 *    holding the owner does not count). The write keeps the trust tier, files no lower_page proposal, keeps the
 *    source_kind / ingested_via / ingested_at stamps, changes the page's file only on the readable_by line, and updates
 *    pages.page_readers in the same write, so remote reads see the readers at once. Works on a repo-less brain, a managed
 *    page with a file, a managed page under a declared storage.db_only path; a managed page with no file outside any
 *    db_only path is held canonical_file_missing with nothing written.
 * 2. Fails when: the readers write lowers the tier, files a proposal, stamps put_page provenance, re-renders the file,
 *    leaves page_readers stale, accepts an unknown member or group, drops the owner without the flag, applies a plan that
 *    changed since its preview, or writes a database label ahead of Git on a managed page with no file.
 * 3. Real seams: the managed-brain harness (claimed Git worktree, managed sync, the maintenance door, the Git effect), a
 *    repo-less brain, the gbrain repair command entry (remote:false), and tokens bound to members read through MCP dispatch
 *    (remote:true, transport http). PGLite, and Postgres with DATABASE_URL.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readLabelEdit, spliceLabelLines } from '../src/core/persistence/label-edit.ts';
import { readersGitCounts } from '../src/core/repair/readers.ts';
import { renderRepairResult, runRepairCommand } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { addGroup, addMember, bindCredential, disableMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const putPage = operations.find(op => op.name === 'put_page')!;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const OWNER = 'owner-example';
/** Keys out of canonical order, a slug key, provenance stamps (source_kind, ingested_via) in the frontmatter. */
const file = (slug: string, canary = 'canaryrdrplain') => ['---', 'title: Example Page', 'slug: ' + slug, 'source_kind: email-example', 'ingested_via: connector-example', 'type: note',
  'owner_note: kept', 'tags:', '  - alpha', '---', '', 'Body line one of ' + slug + ' ' + canary + '.', '', 'Second paragraph.', ''].join(NL);
const withLine = (text: string, line: string) => text.replace(NL + '---' + NL + NL, NL + line + NL + '---' + NL + NL);
const readersLine = (...readers: string[]) => 'readable_by: [' + readers.join(', ') + ']';
const ownerAnd = (...readers: string[]) => [...readers, OWNER].join(',');

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log;
  console.log = (...parts: unknown[]) => { printed += parts.map(String).join(' ') + NL; };
  try { await fn(); } finally { console.log = original; }
  return printed;
}
const runRepair = async (engine: BrainEngine, argv: string[]) => {
  try { return await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() => runRepairCommand(engine, argv))); }
  finally { _resetCliExitVerdictForTests(); }
};
const repair = async (engine: BrainEngine, argv: string[]) => JSON.parse(await runRepair(engine, [...argv, '--json'])).results[0];
const refusal = (engine: BrainEngine, argv: string[]) => repair(engine, argv).then(
  result => ({ code: 'none', message: JSON.stringify(result) }), (error: { code?: string; message: string }) => ({ code: error.code ?? 'unknown', message: error.message }));
const previewApply = async (engine: BrainEngine, argv: string[]) => {
  const preview = await repair(engine, argv);
  expect(preview.preview_hash).toBeString();
  const applied = await repair(engine, [...argv, '--apply', '--expect', preview.preview_hash]);
  expect(applied.failed).toEqual([]);
  return { preview, applied };
};
const STAMPS = 'SELECT trust_tier::text AS tier, source_kind, ingested_via, ingested_at::text AS ingested_at FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL';
const stamps = async (engine: BrainEngine, slug: string, sourceId = 'default') => (await engine.executeRaw(STAMPS, [sourceId, slug]))[0];
const row = async (engine: BrainEngine, slug: string, sourceId = 'default') => (await engine.executeRaw<{ frontmatter: Record<string, unknown>; page_readers: string[] | null }>(
  'SELECT frontmatter, page_readers FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]!;
const proposals = async (engine: BrainEngine) => engine.executeRaw<{ proposer: string }>('SELECT proposer FROM trust_proposals ORDER BY id');
const stampProvenance = (engine: BrainEngine, slug: string, sourceId = 'default') => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
  "UPDATE pages SET source_kind='mail-example', ingested_via='connector-example', ingested_at='2026-01-02T00:00:00Z' WHERE source_id=$1 AND slug=$2", [sourceId, slug]), TEST_WRITE_ATTRIBUTION));

/** alice-example and bob-example, the owner, group team-example (alice, bob) and group family-example (alice, the owner). */
async function seedMembers(engine: BrainEngine): Promise<void> {
  for (const id of ['alice-example', 'bob-example', OWNER]) await addMember(engine, id);
  await addGroup(engine, 'team-example', ['alice-example', 'bob-example']);
  await addGroup(engine, 'family-example', ['alice-example', OWNER]);
  await setOwner(engine, OWNER);
}

describe('the label editor writes readable_by as one flow-list line', () => {
  const text = ['---', 'title: A', 'type: note', '---', '', 'Body.', ''].join(NL);
  test('add, replace and remove splice only that line', () => {
    const added = spliceLabelLines(text, readLabelEdit({ set: { readable_by: ['alice-example', 'group:team-example'] }, remove: [] })!)!.text;
    expect(added).toBe(withLine(text, readersLine('alice-example', 'group:team-example')));
    const crlf = added.replace('title: A' + NL, 'title: A' + CR + NL);
    const replaced = spliceLabelLines(crlf, readLabelEdit({ set: { readable_by: [OWNER] }, remove: [] })!)!.text;
    expect(replaced).toBe(withLine(text, readersLine(OWNER)).replace('title: A' + NL, 'title: A' + CR + NL));
    expect(spliceLabelLines(added, readLabelEdit({ set: {}, remove: ['readable_by'] })!)!.text).toBe(text);
  });
  test('a block list, a duplicate key, or a reader that is not a plain principal is refused', () => {
    const block = text.replace('type: note', 'type: note' + NL + 'readable_by:' + NL + '  - alice-example');
    expect(spliceLabelLines(block, readLabelEdit({ set: { readable_by: [OWNER] }, remove: [] })!)).toBeNull();
    const twice = text.replace('type: note', 'type: note' + NL + 'readable_by: [a]' + NL + 'readable_by: [b]');
    expect(spliceLabelLines(twice, readLabelEdit({ set: {}, remove: ['readable_by'] })!)).toBeNull();
    for (const bad of [[], ['Alice Example'], ['group:'], ['a, b'], 'alice-example'] as unknown[]) {
      expect(() => readLabelEdit({ set: { readable_by: bad }, remove: [] })).toThrow();
    }
    expect(() => readLabelEdit({ set: { visibility: ['private'] }, remove: [] })).toThrow();
  });
  test('a reader YAML would read as a number, a boolean or null is quoted, so the file reads back as the same ids', () => {
    const spliced = spliceLabelLines(text, readLabelEdit({ set: { readable_by: ['1001', 'true', 'null', '1e3', 'alice-example'] }, remove: [] })!)!.text;
    expect(spliced).toBe(withLine(text, "readable_by: ['1001', 'true', 'null', '1e3', alice-example]"));
  });
});

for (const backend of testBackends()) describe('[' + backend + '] repair visibility --readers on a managed git source', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    writeFileSync(join(root, '.gitignore'), 'archive/' + NL);
    writeFileSync(join(root, 'gbrain.yml'), 'storage:' + NL + '  db_only:' + NL + '    - email/' + NL);
    mkdirSync(join(root, 'email'), { recursive: true });
    writeFileSync(join(root, 'email', '.keep'), '');
    durableGitRepo(root, ['.gitignore', 'gbrain.yml', 'email/.keep']);
  };
  async function seed(engine: BrainEngine, root: string, files: Record<string, string>) {
    mkdirSync(join(root, 'notes'), { recursive: true });
    for (const [slug, text] of Object.entries(files)) writeFileSync(join(root, slug + '.md'), text);
    git(root, 'add', '--', ...Object.keys(files).map(slug => slug + '.md'));
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'owner notes');
    await performManagedSync(engine, OPTS);
    await settleManagedGitEffects(engine);
    for (const slug of Object.keys(files)) {
      expect((await stamps(engine, slug))!.tier).toBe('operator_curated');
      await stampProvenance(engine, slug);
    }
    await seedMembers(engine);
  }
  const onDisk = (root: string, slug: string) => readFileSync(join(root, slug + '.md'), 'utf8');
  /** A page under the declared db_only path email/, written by put_page (no file in Git), with provenance stamps. */
  async function dbOnlyPage(engine: BrainEngine, ctx: Parameters<typeof putPage.handler>[0], slug: string) {
    await putPage.handler(ctx, { slug, content: file(slug), request_id: randomUUID(), wait_ms: 30_000 });
    await settleManagedGitEffects(engine);
    await stampProvenance(engine, slug);
  }
  /** The email/ folder stops being db_only and the page's local cache file is gone: a page with no file outside db_only. */
  function dropDbOnly(root: string, slug: string) {
    rmSync(join(root, slug + '.md'), { force: true });
    writeFileSync(join(root, 'gbrain.yml'), 'storage:' + NL + '  db_tracked:' + NL + '    - notes/' + NL);
    git(root, 'add', '--', 'gbrain.yml');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'email is no longer db_only');
  }

  test('one page: add, replace and remove readers; tier, provenance and every other byte of the file kept', () => managedBrain(async ({ engine, root }) => {
    const slug = 'notes/one-example';
    await seed(engine, root, { [slug]: file(slug) });
    const before = onDisk(root, slug), stamped = await stamps(engine, slug), frontmatter = (await row(engine, slug)).frontmatter;
    const argv = (readers: string) => ['visibility', '--slug', slug, '--readers', readers];
    const { preview, applied } = await previewApply(engine, argv(ownerAnd('alice-example')));
    expect(preview.listing).toEqual([{ item: 'default:' + slug, class: 'readers', detail: 'readers (none) -> [alice-example, ' + OWNER + ']' }]);
    expect(applied.applied).toBe(1);
    expect(applied.outcomes).toMatchObject({ readers_set: 1 });
    await settleManagedGitEffects(engine);
    expect(onDisk(root, slug)).toBe(withLine(before, readersLine('alice-example', OWNER)));
    expect(git(root, 'show', 'HEAD:' + slug + '.md')).toBe(withLine(before, readersLine('alice-example', OWNER)));
    expect(git(root, 'status', '--porcelain', '--', slug + '.md').trim()).toBe('');
    expect(await stamps(engine, slug)).toEqual(stamped);
    expect(await row(engine, slug)).toEqual({ frontmatter: { ...frontmatter, readable_by: ['alice-example', OWNER] }, page_readers: ['member:alice-example', 'member:' + OWNER] });
    expect(await proposals(engine)).toEqual([]);

    await previewApply(engine, argv(ownerAnd('group:team-example')));
    await settleManagedGitEffects(engine);
    expect(onDisk(root, slug)).toBe(withLine(before, readersLine('group:team-example', OWNER)));
    expect((await row(engine, slug)).page_readers).toEqual(['group:team-example', 'member:' + OWNER]);

    const removed = await previewApply(engine, argv('none'));
    expect(removed.applied.outcomes).toMatchObject({ readers_removed: 1 });
    await settleManagedGitEffects(engine);
    expect(onDisk(root, slug)).toBe(before);
    expect(await row(engine, slug)).toEqual({ frontmatter, page_readers: null });
    expect(await stamps(engine, slug)).toEqual(stamped);
    expect(await proposals(engine)).toEqual([]);
  }, { databaseUrl, setup }), 240_000);

  test('a listed set (--slugs-file): file pages and a db_only page, per-page outcomes in --json and counts in the text', () => managedBrain(async ({ engine, root, ctx }) => {
    const filed = ['notes/a-example', 'notes/b-example'], mail = 'email/listed-example';
    await seed(engine, root, Object.fromEntries(filed.map(slug => [slug, file(slug)])));
    await dbOnlyPage(engine, ctx, mail);
    const before = Object.fromEntries(filed.map(slug => [slug, onDisk(root, slug)]));
    const stamped = Object.fromEntries(await Promise.all([...filed, mail].map(async slug => [slug, await stamps(engine, slug)] as const)));
    const list = join(root, '..', 'readers-slugs.txt');
    writeFileSync(list, ['# pages for the assistant', ...filed, '', mail, 'notes/missing-example', ''].join(NL));
    const argv = ['visibility', '--slugs-file', list, '--readers', ownerAnd('group:team-example')];
    const preview = await repair(engine, argv);
    expect(preview.listing.map((entry: { item: string }) => entry.item).sort()).toEqual([mail, ...filed].map(slug => 'default:' + slug).sort());
    expect(preview.residuals).toMatchObject({ named_not_found: 1 });
    expect(preview.apply_command).toContain('--slugs-file ' + list);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const text = await runRepair(engine, [...argv, '--apply', '--expect', preview.preview_hash]);
    expect(text).toContain('outcomes: readers_set=3');
    expect(text).toMatch(/git: committed=\d+, pending=\d+, failed=0, skipped=\d+/);
    await settleManagedGitEffects(engine);
    // The two tracked files reach Git through the Git effect (the one door); the db_only page has no file. The run admits its pages
    // together: Postgres publishes them as one group, so both files land in one commit. PGLite publishes one page at a time and
    // its Git effects share a commit only when both are ready, so there each file lands in at most its own commit.
    const commits = git(root, 'rev-list', head + '..HEAD').trim().split(NL);
    if (backend === 'postgres') expect(commits).toHaveLength(1);
    else expect(commits.length).toBeLessThanOrEqual(filed.length);
    for (const commit of commits) expect(filed.map(slug => slug + '.md')).toEqual(expect.arrayContaining(git(root, 'show', '--name-only', '--format=', commit).trim().split(NL)));
    expect(git(root, 'diff', '--name-only', head, 'HEAD').trim().split(NL).sort()).toEqual(filed.map(slug => slug + '.md'));
    expect(await readersGitCounts(engine, { brain_id: preview.scope?.brain_id ?? '', source_ids: ['default'] }, preview.preview_hash)).toEqual({ committed: 2, pending: 0, failed: 0, skipped: 1 });
    for (const slug of filed) expect(onDisk(root, slug)).toBe(withLine(before[slug]!, readersLine('group:team-example', OWNER)));
    for (const slug of [...filed, mail]) {
      expect(await stamps(engine, slug)).toEqual(stamped[slug]);
      expect((await row(engine, slug)).page_readers).toEqual(['group:team-example', 'member:' + OWNER]);
    }
    expect(git(root, 'ls-files', 'email').trim()).toBe('email/.keep');
    expect(await proposals(engine)).toEqual([]);
    const again = await repair(engine, argv);
    expect(again.listing).toEqual([]);
    expect(again.residuals).toMatchObject({ readers_already_set: 3 });
  }, { databaseUrl, setup }), 240_000);

  test('a db_only page: only the database label is written, tier and provenance kept, no file', () => managedBrain(async ({ engine, root, ctx }) => {
    const slug = 'email/mail-example';
    await dbOnlyPage(engine, ctx, slug);
    await seedMembers(engine);
    const before = await stamps(engine, slug), frontmatter = (await row(engine, slug)).frontmatter, proposalsBefore = await proposals(engine);
    const { applied } = await previewApply(engine, ['visibility', '--slug', slug, '--readers', ownerAnd('alice-example')]);
    await settleManagedGitEffects(engine);
    expect(applied.outcome_items).toEqual([expect.objectContaining({ item: 'default:' + slug, outcome: 'readers_set' })]);
    expect(await stamps(engine, slug)).toEqual(before);
    expect(await row(engine, slug)).toEqual({ frontmatter: { ...frontmatter, readable_by: ['alice-example', OWNER] }, page_readers: ['member:alice-example', 'member:' + OWNER] });
    expect(await proposals(engine)).toEqual(proposalsBefore);
    expect(git(root, 'ls-files', 'email').trim()).toBe('email/.keep');
  }, { databaseUrl, setup }), 240_000);

  test('a page with no file outside any db_only path is held canonical_file_missing: nothing written, no put_page provenance, tier kept', () => managedBrain(async ({ engine, root, ctx }) => {
    const slug = 'email/nofile-example';
    await dbOnlyPage(engine, ctx, slug);
    await seedMembers(engine);
    dropDbOnly(root, slug);
    const before = await stamps(engine, slug), stored = await row(engine, slug), proposalsBefore = await proposals(engine);
    const argv = ['visibility', '--slug', slug, '--readers', ownerAnd('alice-example')];
    const { applied } = await previewApply(engine, argv);
    expect(applied.applied).toBe(0);
    expect(applied.outcome_items).toEqual([expect.objectContaining({ item: 'default:' + slug, outcome: 'canonical_file_missing', reason: expect.stringContaining('storage.db_only') })]);
    expect(renderRepairResult(applied, { diff: false })).toContain('outcomes: canonical_file_missing=1');
    expect(await stamps(engine, slug)).toEqual(before);
    expect(await row(engine, slug)).toEqual(stored);
    expect(stored.frontmatter.readable_by).toBeUndefined();
    expect(await proposals(engine)).toEqual(proposalsBefore);
    expect(git(root, 'ls-files', 'email').trim()).toBe('email/.keep');
    expect((await repair(engine, argv)).listing).toHaveLength(1);
  }, { databaseUrl, setup }), 240_000);
});

/** A repo-less brain (no managed persistence, no checkout: the default keyless install) is the database record. */
for (const backend of testBackends()) describe('[' + backend + '] repair visibility --readers on a repo-less brain', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const SRC = 'readers-src';
  const PAGES = { shared: { slug: 'notes/shared-example', canary: 'canaryrdrshared' }, other: { slug: 'notes/other-example', canary: 'canaryrdrother' } } as const;
  /** A canary counts only as a whole token: no letter or digit right after it. */
  const has = (text: string, canary: string) => new RegExp(canary + '(?![A-Za-z0-9])').test(text);

  async function repoless(fn: (engine: BrainEngine, home: string) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-readers-repoless-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          __resetPrivateVisibilityCacheForTests();
          await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
          for (const { slug, canary } of Object.values(PAGES)) {
            expect((await importFromContent(engine, slug, file(slug, canary), { noEmbed: true, sourceId: SRC })).status).toBe('imported');
            await engine.transaction(tx => withCoordinatedWrite(tx, [SRC], () => withTrustBackfill(tx, () => tx.executeRaw(
              "UPDATE pages SET trust_tier='operator_curated', source_kind='mail-example', ingested_via='connector-example', ingested_at='2026-01-02T00:00:00Z' WHERE source_id=$1 AND slug=$2",
              [SRC, slug])), TEST_WRITE_ATTRIBUTION));
          }
          await seedMembers(engine);
          await fn(engine, home);
        } finally { await disposePersistenceConsumer(engine); await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const one = (readers: string, ...more: string[]) => ['visibility', '--source', SRC, '--slug', PAGES.shared.slug, '--readers', readers, ...more];

  test('a listed set keeps the tier and provenance and updates page_readers; a bound member key reads it through MCP, another does not, the owner does', () => repoless(async (engine, home) => {
    const tokens: Record<string, string> = {};
    for (const member of ['alice-example', 'bob-example', OWNER]) {
      const minted = await mintLegacyToken(engine, { name: member, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      tokens[member] = minted.token;
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
    }
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const call = async (who: string, op: string, params: Record<string, unknown>) => {
      const auth = await provider.verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
      return out.content.map(c => c.text).join(NL);
    };
    const reads = async (who: string) => ({
      get_page: has(await call(who, 'get_page', { slug: PAGES.shared.slug }), PAGES.shared.canary),
      list_pages: (await call(who, 'list_pages', { limit: 100 })).split(/[^A-Za-z0-9/_-]+/).includes(PAGES.shared.slug),
      search: has(await call(who, 'search', { query: 'second paragraph', match: 'keyword', fields: 'full', limit: 50 }), PAGES.shared.canary),
    });
    const every = (value: boolean) => ({ get_page: value, list_pages: value, search: value });
    expect(await reads('bob-example')).toEqual(every(true));

    const list = join(home, 'slugs.txt');
    writeFileSync(list, [PAGES.shared.slug, PAGES.other.slug].join(NL) + NL);
    const before = await Promise.all(Object.values(PAGES).map(page => stamps(engine, page.slug, SRC)));
    const { applied } = await previewApply(engine, ['visibility', '--source', SRC, '--slugs-file', list, '--readers', ownerAnd('alice-example')]);
    expect(applied.applied).toBe(2);
    expect(await Promise.all(Object.values(PAGES).map(page => stamps(engine, page.slug, SRC)))).toEqual(before);
    for (const { slug } of Object.values(PAGES)) {
      const stored = await row(engine, slug, SRC);
      expect(stored.frontmatter.readable_by).toEqual(['alice-example', OWNER]);
      expect(stored.frontmatter.source_kind).toBe('email-example');
      expect(stored.page_readers).toEqual(['member:alice-example', 'member:' + OWNER]);
    }
    expect(await proposals(engine)).toEqual([]);

    expect(await reads('alice-example')).toEqual(every(true));
    expect(await reads('bob-example')).toEqual(every(false));
    expect(await reads(OWNER)).toEqual(every(true));
  }), 240_000);

  test('a listed set of 150 pages applies page by page (no run-wide transaction) and lists each page in --json', () => repoless(async (engine, home) => {
    const slugs = Array.from({ length: 150 }, (_, index) => 'bulk/page-' + String(index).padStart(3, '0'));
    for (const slug of slugs) expect((await importFromContent(engine, slug, file(slug), { noEmbed: true, sourceId: SRC })).status).toBe('imported');
    const list = join(home, 'bulk.txt');
    writeFileSync(list, slugs.join(NL) + NL);
    const { preview, applied } = await previewApply(engine, ['visibility', '--source', SRC, '--slugs-file', list, '--readers', ownerAnd('group:team-example')]);
    expect(preview.listing).toHaveLength(150);
    expect(applied.applied).toBe(150);
    expect(applied.outcome_items).toHaveLength(150);
    expect(await engine.executeRaw("SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug LIKE 'bulk/%' AND page_readers = ARRAY['group:team-example','member:owner-example']", [SRC])).toEqual([{ n: 150 }]);
  }), 240_000);

  test('an unknown member or group, a disabled member, or a list without the owner refuses before anything is written; the flag passes', () => repoless(async engine => {
    const frontmatter = (await row(engine, PAGES.shared.slug, SRC)).frontmatter;
    expect(await refusal(engine, one(ownerAnd('zed-example')))).toMatchObject({ code: 'access_member_invalid', message: expect.stringContaining('zed-example') });
    expect(await refusal(engine, one(ownerAnd('group:nobody-example')))).toMatchObject({ code: 'access_member_invalid', message: expect.stringContaining('nobody-example') });
    expect(await refusal(engine, one('Not A Reader'))).toMatchObject({ code: 'invalid_params' });
    expect(await refusal(engine, one('alice-example'))).toMatchObject({ code: 'invalid_params', message: expect.stringContaining(OWNER) });
    // A group that holds the owner does not name the owner.
    expect(await refusal(engine, one('group:family-example'))).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('--allow-without-owner') });
    await disableMember(engine, 'bob-example');
    expect(await refusal(engine, one(ownerAnd('bob-example')))).toMatchObject({ code: 'access_member_invalid', message: expect.stringContaining('bob-example') });
    // A configured owner that is disabled now still counts: re-enabled, its keys would read the page again.
    await disableMember(engine, OWNER);
    expect(await refusal(engine, one('alice-example'))).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('not enabled now') });
    expect((await row(engine, PAGES.shared.slug, SRC)).frontmatter).toEqual(frontmatter);

    const { applied } = await previewApply(engine, one('alice-example', '--allow-without-owner'));
    expect(applied.applied).toBe(1);
    expect((await row(engine, PAGES.shared.slug, SRC)).page_readers).toEqual(['member:alice-example']);
  }), 240_000);

  test('a changed plan refuses preview_changed: other readers, another flag, or a page whose readers moved; a reader disabled since refuses', () => repoless(async engine => {
    const preview = await repair(engine, one(ownerAnd('alice-example')));
    expect(await refusal(engine, [...one(ownerAnd('bob-example')), '--apply', '--expect', preview.preview_hash])).toMatchObject({ code: 'preview_changed' });
    expect(await refusal(engine, [...one(ownerAnd('alice-example'), '--allow-without-owner'), '--apply', '--expect', preview.preview_hash])).toMatchObject({ code: 'preview_changed' });
    await previewApply(engine, one(ownerAnd('group:team-example')));
    expect(await refusal(engine, [...one(ownerAnd('alice-example')), '--apply', '--expect', preview.preview_hash])).toMatchObject({ code: 'preview_changed' });
    expect((await row(engine, PAGES.shared.slug, SRC)).page_readers).toEqual(['group:team-example', 'member:' + OWNER]);

    const next = await repair(engine, one(ownerAnd('alice-example')));
    await disableMember(engine, 'alice-example');
    expect(await refusal(engine, [...one(ownerAnd('alice-example')), '--apply', '--expect', next.preview_hash])).toMatchObject({ code: 'access_member_invalid' });
    expect((await row(engine, PAGES.shared.slug, SRC)).page_readers).toEqual(['group:team-example', 'member:' + OWNER]);
  }), 240_000);

  test('--readers needs --slug or --slugs-file, refuses --class and a bare --apply; the owner flag needs --readers', () => repoless(async engine => {
    expect(await refusal(engine, ['visibility', '--source', SRC, '--readers', OWNER])).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('--slug') });
    expect(await refusal(engine, [...one(OWNER), '--class', 'aliases'])).toMatchObject({ code: 'invalid_params' });
    expect(await refusal(engine, [...one(OWNER), '--apply'])).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('preview') });
    expect(await refusal(engine, ['visibility', '--source', SRC, '--allow-without-owner', '--slug', PAGES.shared.slug])).toMatchObject({ code: 'invalid_params' });
  }), 120_000);
});
