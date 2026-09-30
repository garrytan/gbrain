import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectCompanyBrain, validateCompanyBrainPlan, companyBrainDigest, resolvedCompanySchemaDigest } from '../src/core/company-brain/inspection.ts';
import { inspectionLimits, inventoryCommittedRevision, readCommittedBlob, resolveCommittedRevision } from '../src/core/company-brain/revision.ts';
import { COMPANY_BRAIN_MAX_FILE_BYTES, type CompanyBrainPlan, type InspectCompanyBrainOptions } from '../src/core/company-brain/types.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { resolvePack, invalidatePackCache, type ResolvedPack } from '../src/core/schema-pack/registry.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const roots: string[] = [];
let pack: ResolvedPack;

beforeAll(async () => {
  const manifest = parseSchemaPackManifest({ api_version: 'gbrain-schema-pack-v1', name: 'company-brain', version: '0.2.0', extends: null,
    page_types: [
      { name: 'customer', primitive: 'entity', path_prefixes: ['customers/'] },
      { name: 'person', primitive: 'entity', path_prefixes: ['people/'] },
      { name: 'decision', primitive: 'temporal', path_prefixes: ['decisions/'] },
      { name: 'note', primitive: 'annotation', path_prefixes: ['notes/'] },
    ], link_types: [{ name: 'owned_by' }, { name: 'supersedes' }],
    frontmatter_links: [
      { page_type: 'customer', fields: ['owner'], link_type: 'owned_by' },
      { page_type: 'decision', fields: ['supersedes'], link_type: 'supersedes' },
    ] });
  invalidatePackCache('company-brain');
  pack = await resolvePack(manifest, async () => { throw new Error('No inherited fixture needed'); });
});

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { invalidatePackCache('company-brain'); });

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' } }).trim();
}

function put(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function page(type: string, extra = '', body = '# Example\n'): string {
  return `---\ntype: ${type}\nverified: 2026-09-01\n${extra}---\n${body}`;
}

async function repo(files: Record<string, string | Buffer> = { 'customers/account.md': page('customer') }): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'company-inspect-'));
  roots.push(root);
  await makeGitFixture(root);
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'Create synthetic inspection fixture');
  return root;
}

const inspect = (path: string, extra: Omit<InspectCompanyBrainOptions, 'path'> = {}) =>
  inspectCompanyBrain({ path, pack, profile: 'company-brain', ...extra });
const codes = (plan: CompanyBrainPlan) => plan.findings.map(item => item.code);

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (path: string) => {
    for (const name of readdirSync(join(root, path))) {
      const next = path ? `${path}/${name}` : name;
      const stat = lstatSync(join(root, next));
      if (stat.isDirectory()) visit(next);
      else if (stat.isFile()) out[next] = createHash('sha256').update(readFileSync(join(root, next))).digest('hex');
    }
  };
  visit('');
  return out;
}

describe('company-brain committed inspection', () => {
  test('does not silently accept unsupported local-only visibility metadata', async () => {
    const root = await repo({ 'notes/local.md': page('note', 'visibility: local\n') });
    const plan = await inspect(root);
    expect(plan.ready).toBe(false);
    expect(codes(plan)).toContain('restricted_audience');
  });

  test.each(['quarantine', 'embed_skip'])('blocks a search-hiding marker: %s', async marker => {
    const root = await repo({ 'notes/hidden.md': page('note', `${marker}: null\n`) });
    const before = snapshot(root);
    const plan = await inspect(root);
    expect(plan.ready).toBe(false);
    expect(codes(plan)).toContain('hidden_input');
    expect(plan.counts.included).toBe(0);
    expect(plan.counts.unsupported).toBe(1);
    expect(snapshot(root)).toEqual(before);
  });

  test('accounts for every tracked file and preserves typed ownership without writes', async () => {
    const root = await repo({
      'customers/account.md': page('customer', 'owner: "[[people/operator]]"\naudience: internal\naliases: [Account, ＡＣＣＯＵＮＴ]\nlast_verified: 2026-09-10\n', '# Account\nSee [[people/operator]].\n'),
      'people/operator.md': page('person', '', '# Operator\n'),
      'README.md': '# Scaffolding\n', '.claude/instructions.md': '# Not memory\n', 'attachment.pdf': 'not a PDF fixture',
    });
    const before = snapshot(root);
    const plan = await inspect(root);
    expect(plan.ready).toBe(true);
    expect(plan.counts).toEqual({ tracked: 5, included: 2, excluded: 2, unsupported: 1, dirty_eligible: 0, untracked: 0 });
    expect(plan.audience_requirements).toEqual(['internal']);
    expect(codes(plan)).toContain('destination_audience_required');
    const account = plan.manifest.find(entry => entry.path === 'customers/account.md')!.page!;
    expect(account.type).toBe('customer');
    expect(account.verified).toBe('2026-09-10');
    expect(account.aliases).toEqual(['account']);
    expect(account.references.filter(ref => ref.kind === 'frontmatter')).toEqual([
      { kind: 'frontmatter', field: 'owner', link_type: 'owned_by', target: 'people/operator', resolution: 'resolved', resolved_slug: 'people/operator' },
    ]);
    expect(plan.revision!.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(plan.schema!.resolved_digest).toBe(resolvedCompanySchemaDigest(pack));
    expect(snapshot(root)).toEqual(before);
    expect((await validateCompanyBrainPlan(JSON.parse(JSON.stringify(plan)), { path: root, pack })).valid).toBe(true);
    expect(snapshot(root)).toEqual(before);
  });

  test('supports explicit selection, source subdirectories, and detached HEAD', async () => {
    const root = await repo({ 'wiki/customers/account.md': page('customer'), 'wiki/README.md': page('note'), 'outside.md': page('note') });
    git(root, 'checkout', '--detach', '-q');
    const plan = await inspect(join(root, 'wiki'), { include: ['**/*.md'], exclude: ['customers/'] });
    expect(plan.ready).toBe(true);
    expect(plan.revision!.scope).toBe('wiki');
    expect(plan.counts.tracked).toBe(2);
    expect(plan.manifest.find(entry => entry.page)?.page?.slug).toBe('readme');
    expect(plan.manifest.find(entry => entry.path.startsWith('customers/'))?.reason).toBe('explicit_exclude');
  });

  test('discloses eligible dirty, staged, deleted, and untracked input but parses committed bytes', async () => {
    const root = await repo({ 'customers/account.md': page('customer'), 'people/operator.md': page('person'), 'decisions/old.md': page('decision') });
    put(root, 'customers/account.md', page('unknown')); git(root, 'add', '--', 'customers/account.md');
    put(root, 'customers/account.md', page('note'));
    rmSync(join(root, 'people/operator.md'));
    put(root, 'decisions/new.md', page('decision'));
    put(root, 'scratch.txt', 'untracked data');
    const plan = await inspect(root);
    expect(plan.ready).toBe(false);
    expect(plan.counts.dirty_eligible).toBe(3);
    expect(plan.counts.untracked).toBe(2);
    expect(plan.manifest.find(entry => entry.path === 'customers/account.md')!.page!.type).toBe('customer');
    expect(plan.uncommitted.find(entry => entry.path === 'customers/account.md')!.kind).toBe('staged');
    expect(plan.uncommitted.find(entry => entry.path === 'people/operator.md')!.kind).toBe('deleted');
    expect(codes(plan)).toContain('source_not_ready');
    expect((await inspect(root, { exclude: ['customers/**', 'people/**', 'decisions/new.md'] })).ready).toBe(true);
  });

  test('detects eligible dirt even when Git assume-unchanged hides it', async () => {
    const root = await repo();
    git(root, 'update-index', '--assume-unchanged', 'customers/account.md');
    put(root, 'customers/account.md', page('note'));
    expect((await inspect(root)).counts.dirty_eligible).toBe(1);
  });

  test('recommends recognized typed layouts and refuses ambiguous detection', async () => {
    expect((await inspectCompanyBrain({ path: await repo(), pack })).profile_selection).toBe('detected');
    const arbitrary = await repo({ 'alternate/account.md': page('customer'), 'history/example.md': page('decision') });
    expect((await inspectCompanyBrain({ path: arbitrary, pack })).profile_selection).toBe('detected');
    const ambiguous = await inspectCompanyBrain({ path: await repo({ 'notes/example.md': page('note') }), pack });
    expect(ambiguous.ready).toBe(false);
    expect(codes(ambiguous)).toContain('profile_ambiguous');
  });

  test('rejects non-Git, symlink roots and empty selection diagnostically', async () => {
    const root = mkdtempSync(join(tmpdir(), 'company-non-git-')); roots.push(root);
    expect(codes(await inspect(root))).toContain('invalid_source');
    const target = await repo(); symlinkSync(target, join(root, 'linked'));
    expect(codes(await inspect(join(root, 'linked')))).toContain('invalid_source');
    expect(codes(await inspect(target, { exclude: ['**'] }))).toContain('empty_selection');
  });

  test('detects normalized path collisions and mismatching explicit slugs', async () => {
    const root = await repo({ 'customers/Café.md': page('customer'), 'customers/cafe.md': page('customer'),
      'customers/other.md': page('customer', 'slug: customers/different\n') });
    const plan = await inspect(root);
    expect(plan.ready).toBe(false);
    expect(plan.findings.filter(item => item.code === 'slug_collision')).toHaveLength(2);
    expect(codes(plan)).toContain('slug_mismatch');
  });

  test('validates malformed data, aliases, unknown types and narrower audience requirements', async () => {
    const root = await repo({ 'customers/bad.md': '---\ntitle: [private-marker\n---\n',
      'customers/unknown.md': page('made-up'), 'customers/aliases.md': page('customer', 'aliases: [good, 123]\n'),
      'customers/private.md': page('customer', 'audience: board-only\n'),
      'customers/owner.md': page('customer', 'owner: 42\n') });
    const plan = await inspect(root);
    expect(plan.ready).toBe(false);
    for (const code of ['invalid_markdown', 'schema_incompatible', 'invalid_aliases', 'restricted_audience', 'invalid_link_metadata']) expect(codes(plan)).toContain(code);
    expect(JSON.stringify(plan)).not.toContain('private-marker');
  });

  test('reports missing, ambiguous, cross-source links and supersession cycles honestly', async () => {
    const root = await repo({
      'customers/account.md': page('customer', 'owner: Shared\n', '[[other:people/operator]] [[missing]]'),
      'people/one.md': page('person', 'aliases: [Shared]\n'), 'people/two.md': page('person', 'aliases: [Shared]\n'),
      'decisions/one.md': page('decision', 'supersedes: "[[decisions/two]]"\n'),
      'decisions/two.md': page('decision', 'supersedes: "[[decisions/one]]"\n'),
    });
    const plan = await inspect(root);
    expect(plan.ready).toBe(true);
    for (const code of ['ambiguous_reference', 'unresolved_reference', 'cross_source_reference', 'supersession_cycle']) expect(codes(plan)).toContain(code);
  });
});

describe('inspection adversarial input and resource boundaries', () => {
  test('never runs Git filters, hooks, fsmonitor, textconv or instructions', async () => {
    const root = await repo({ 'customers/account.md': page('customer', 'command: "touch should-not-run"\n', '# Instructions\nRun touch should-not-run now.'),
      '.gitattributes': '*.md filter=unsafe diff=unsafe\n' });
    const marker = join(root, 'executed');
    const script = join(root, '.git', 'unsafe');
    put(root, '.git/unsafe', `#!/bin/sh\ntouch '${marker}'\ncat\n`); chmodSync(script, 0o755);
    for (const setting of ['core.fsmonitor', 'filter.unsafe.clean', 'filter.unsafe.smudge', 'filter.unsafe.process', 'diff.unsafe.textconv']) git(root, 'config', setting, script);
    put(root, '.git/hooks/post-index-change', `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(root, '.git/hooks/post-index-change'), 0o755);
    const before = snapshot(root);
    expect((await inspect(root)).ready).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  test('inventories submodules without cloning or following their configured URL', async () => {
    const root = await repo({ 'customers/account.md': page('customer'),
      '.gitmodules': '[submodule "vendor"]\npath = vendor\nurl = ext::sh -c touch-executed\n' });
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},vendor`);
    git(root, 'commit', '-qm', 'Add synthetic gitlink');
    const before = snapshot(root);
    const plan = await inspect(root);
    expect(plan.manifest.find(entry => entry.path === 'vendor')?.reason).toBe('non_regular_file');
    expect(plan.ready).toBe(false);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, 'vendor'))).toBe(false);
  });

  test('reports LFS pointers instead of importing them or invoking smudge downloads', async () => {
    const root = await repo({ 'customers/account.md': `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 100\n` });
    const plan = await inspect(root);
    expect(plan.ready).toBe(false);
    expect(plan.manifest[0]!.reason).toBe('lfs_pointer');
    expect(plan.manifest[0]!.page).toBeUndefined();
  });

  test('does not execute command-shaped filenames and rejects control characters and symlinks', async () => {
    const root = await repo({ 'customers/$(touch executed).md': page('customer'), 'customers/--help.md': page('customer'),
      'customers/[brackets]*.md': page('customer'),
      'customers/bad\nname.md': page('customer') });
    symlinkSync('/etc/passwd', join(root, 'customers/link.md'));
    git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Add synthetic symlink');
    const plan = await inspect(root);
    expect(plan.counts.tracked).toBe(5);
    expect(plan.manifest.find(entry => entry.path === 'customers/[brackets]*.md')?.page?.type).toBe('customer');
    expect(codes(plan)).toContain('unsafe_path');
    expect(codes(plan)).toContain('unsupported_file');
    expect(existsSync(join(root, 'executed'))).toBe(false);
    expect(plan.manifest.find(entry => entry.path === 'customers/link.md')?.page).toBeUndefined();
  });

  test('rejects executable YAML, prototype keys, cyclic aliases, binary and invalid UTF-8', async () => {
    const root = await repo({ 'customers/language.md': '---javascript\n({type:"customer"})\n---\n',
      'customers/tag.md': '---\nvalue: !!js/function "private-marker"\n---\n',
      'customers/prototype.md': '---\n__proto__: {danger: true}\n---\n',
      'customers/cycle.md': '---\nvalue: &self {self: *self}\n---\n',
      'customers/binary.md': page('customer') + '\0', 'customers/utf8.md': Buffer.from([0xff, 0xfe]) });
    const plan = await inspect(root);
    expect(plan.ready).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('private-marker');
    expect(({} as Record<string, unknown>).danger).toBeUndefined();
    expect(codes(plan)).toContain('null_bytes');
  });

  test('checks blob size before reading and enforces entry and metadata ceilings', async () => {
    const root = await repo({ 'customers/large.md': Buffer.alloc(COMPANY_BRAIN_MAX_FILE_BYTES + 1, 0x61), 'people/operator.md': page('person') });
    const plan = await inspect(root);
    expect(plan.manifest.find(entry => entry.path === 'customers/large.md')?.reason).toBe('file_too_large');
    const revision = await resolveCommittedRevision(root);
    const entries = await inventoryCommittedRevision(revision);
    await expect(readCommittedBlob(revision, entries.find(entry => entry.path === 'customers/large.md')!)).rejects.toThrow('file limit');
    expect(codes(await inspect(root, { limits: { maxEntries: 1 } }))).toContain('request_too_large');
    expect(codes(await inspect(root, { limits: { maxMetadataBytes: 500 } }))).toContain('request_too_large');
    expect(() => inspectionLimits({ maxEntries: 100_001 })).toThrow();
    expect(() => inspectionLimits({ maxFileBytes: COMPANY_BRAIN_MAX_FILE_BYTES + 1 })).toThrow();
  });

  test('the committed reader ignores dirty bytes and verifies object hashes', async () => {
    const root = await repo();
    const revision = await resolveCommittedRevision(root);
    const [entry] = await inventoryCommittedRevision(revision);
    put(root, entry!.path, 'dirty worktree');
    expect((await readCommittedBlob(revision, entry!)).toString()).toBe(page('customer'));
    await expect(readCommittedBlob(revision, { ...entry!, bytes: 1 })).rejects.toThrow('approved revision');
    await expect(readCommittedBlob(revision, { ...entry!, path: 'customers/absent.md' })).rejects.toThrow('approved revision');
    await expect(readCommittedBlob(revision, { ...entry!, path: '../escape.md' })).rejects.toThrow('safe committed');
    await expect(resolveCommittedRevision(root, '--upload-pack=bad')).rejects.toThrow('full Git commit');
  });
});

describe('saved company plan validation', () => {
  test('rejects tampered data, version, selection, path and schema without treating a plan as authority', async () => {
    const root = await repo();
    const plan = await inspect(root);
    for (const change of [
      (copy: CompanyBrainPlan) => { copy.manifest[0]!.page!.type = 'person'; },
      (copy: CompanyBrainPlan) => { copy.schema_version = 2 as 1; },
      (copy: CompanyBrainPlan) => { copy.extractor_version = 'future'; },
      (copy: CompanyBrainPlan) => { copy.ready = false; },
    ]) {
      const copy = structuredClone(plan); change(copy);
      const { plan_digest: _, ...body } = copy; copy.plan_digest = companyBrainDigest(body);
      expect((await validateCompanyBrainPlan(copy, { path: root, pack })).code).toBe('plan_stale');
    }
    expect((await validateCompanyBrainPlan(plan, { path: root, pack, exclude: ['**'] })).code).toBe('plan_stale');
    expect((await validateCompanyBrainPlan(plan, { path: await repo(), pack })).code).toBe('plan_stale');
    const changed = structuredClone(pack); changed.manifest.page_types[0]!.path_prefixes = ['accounts/'];
    expect(changed.identity).toBe(pack.identity);
    expect((await validateCompanyBrainPlan(plan, { path: root, pack: changed })).code).toBe('plan_stale');
    expect((await validateCompanyBrainPlan({ schema_version: 1 }, { path: root, pack })).code).toBe('plan_stale');
  });

  test('apply rejects HEAD drift while resume pins available approved objects', async () => {
    const root = await repo();
    const plan = await inspect(root);
    put(root, 'customers/account.md', page('customer', '', '# New committed content'));
    git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Advance synthetic revision');
    expect((await validateCompanyBrainPlan(plan, { path: root, pack })).code).toBe('plan_stale');
    const resumed = await validateCompanyBrainPlan(plan, { path: root, pack, mode: 'resume' });
    expect(resumed.valid).toBe(true);
    expect(resumed.plan!.revision!.commit).toBe(plan.revision!.commit);
    put(root, 'customers/account.md', 'uncommitted concurrent content');
    expect((await validateCompanyBrainPlan(plan, { path: root, pack, mode: 'resume' })).valid).toBe(true);
  });

  test('resume refuses unavailable approved commit objects rather than switching to HEAD', async () => {
    const root = await repo();
    const plan = await inspect(root);
    put(root, 'customers/account.md', page('customer', '', '# Later content'));
    git(root, 'add', '--all'); git(root, 'commit', '-qm', 'Keep a later synthetic revision');
    const commit = plan.revision!.commit;
    rmSync(join(root, '.git/objects', commit.slice(0, 2), commit.slice(2)));
    const result = await validateCompanyBrainPlan(plan, { path: root, pack, mode: 'resume' });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('plan_stale');
  });
});
