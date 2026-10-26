/**
 * Wave C 1A (spec §10 1A, §4.5, §17 ceo-r3-native-1, dx-r3-native-1/2, eng-r3-native-5, eng-r3-outside-6): the secret
 * scan at the door and the pre-push backstop (src/core/persistence/push-scan.ts). Protects:
 *   - a planted PEM block in a 30 MiB door write (across a 1 MiB read chunk) is refused secret_found before HEAD moves,
 *     and neither the refusal nor its fix prints the key; a remote-facing refusal names only the rule and fingerprint;
 *   - a value cut across two parts of a split page (.<name>.gbparts/NNNN-*.gbpart) is refused, though neither part
 *     holds it alone;
 *   - only bytes new to Git are scanned: a 20 MiB page holding an old token takes a clean append past 24 MiB (the forced
 *     probe writes the same bytes as a new file and is refused);
 *   - gbrain git commit-push refuses the same before git commit with the path and line, restores the index, and
 *     --allow-secret is the user's override;
 *   - a clean filter that transforms a covered file refuses git_clean_filter_refused (its fix line clears it), a
 *     non-transforming filter and a small file are unchanged, and a file changed after the scan refuses;
 *   - a secret in a mid-range external commit with clean commits on top holds the push git_push_secret_found naming
 *     that commit, path, rule and fingerprint, also after a later clean door write; the fix (allowlist the fingerprint
 *     through gbrain git commit-push) releases it without rewriting history;
 *   - blobs the door or an earlier backstop cleared are recorded under the rule-set id, and the backstop scans only
 *     blobs nothing cleared under the current rule set.
 * Real repositories and a local bare remote; the door runs without an engine (commitThroughDoor).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { pushGitRoot } from '../src/core/persistence/effect-git.ts';
import { commitThroughDoor } from '../src/core/persistence/git-door.ts';
import { scanSeams } from '../src/core/persistence/push-scan.ts';
import { createStreamScanner } from '../src/core/secret-scan-stream.ts';
import { SCAN_RULESET_ID } from '../src/core/secret-scan.ts';
import { git } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

const MiB = 1024 ** 2;
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_BODY = PEM.split('\n')[5]!;
const TOKEN = 'AKIA' + 'QX7EXAMPLEZ3K9TB';
const homes: string[] = [];
afterEach(() => {
  scanSeams.afterDoorScan = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

interface Repo { home: string; root: string; remote: string }

function repo(): Repo {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-push-scan-')));
  homes.push(home);
  const root = join(home, 'brain'), remote = join(home, 'remote.git');
  git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  git(root, 'add', 'initial.md'); git(root, 'commit', '-q', '-m', 'Initial');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
  return { home, root, remote };
}

const LINE = 'Acme example meeting note, nothing secret in this line at all.\n';
/** Plain text of exactly \`bytes\` bytes. */
const filler = (bytes: number) => { const text = LINE.repeat(Math.ceil(bytes / LINE.length)); return text.slice(0, bytes - 1) + '\n'; };
const write = (root: string, rel: string, data: string | Buffer) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), data); return join(root, rel); };
const head = (root: string) => git(root, 'rev-parse', 'HEAD').trim();
const remoteTip = (r: Repo) => git(r.remote, 'rev-parse', 'refs/heads/main').trim();
const door = (root: string, ...rels: string[]) => commitThroughDoor(root, rels.map(rel => ({ path: join(root, rel) })));
// Bun's toMatchObject writes its asymmetric matchers into the received object, so values read afterwards are asserted on copies.
const caught = async (work: () => unknown): Promise<any> => { try { await work(); } catch (error) { return error; } throw new Error('expected a refusal'); };
const printed = (error: any) => JSON.stringify({ message: error.message, suggestion: error.suggestion, detail: error.detail, fix: error.fix, why: error.why });
const findings = (bytes: string) => { const scanner = createStreamScanner(); scanner.push(Buffer.from(bytes)); return scanner.finish(); };
const ledgerText = (root: string) => { const path = join(root, '.git', 'gbrain-scan-cleared'); return existsSync(path) ? readFileSync(path, 'utf8') : ''; };
const env = (r: Repo) => ({ GBRAIN_HOME: join(r.home, 'gbrain-home'), GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' });

describe('Wave C 1A: the door scan', () => {
  test('a PEM block in a 30 MiB door write, across a read chunk, is refused before HEAD moves and never printed', () => { const r = repo(); return withEnv(env(r), async () => {
    const before = head(r.root);
    const at = 16 * MiB - Math.floor(PEM.length / 2);
    const body = filler(30 * MiB);
    write(r.root, 'notes/big.md', body.slice(0, at) + '\n' + PEM + body.slice(at));
    const error = await caught(() => door(r.root, 'notes/big.md'));
    expect(error.code).toBe('secret_found');
    expect(head(r.root)).toBe(before);
    expect(printed(error)).not.toContain(PEM_BODY);
    expect(printed(error)).not.toContain('notes/big.md');
    expect(JSON.parse(error.detail)).toEqual({ findings: [{ rule: 'private_key_pem', fingerprint: expect.stringMatching(/^sha256:[0-9a-f]+$/) }] });
    expect(error.fix).toMatchObject({ ask_user: true });
    expect(error.fix.argv).toBeUndefined();
  }); }, 120_000);

  test('a value cut across two parts of a split page is refused, though neither part holds it alone', () => { const r = repo(); return withEnv(env(r), async () => {
    const before = head(r.root);
    const left = LINE.repeat(40) + 'aws_key = ' + TOKEN.slice(0, 9);
    const right = TOKEN.slice(9) + '\n' + LINE.repeat(40);
    expect([findings(left), findings(right), findings(left + right).map(f => f.pattern)]).toEqual([[], [], [expect.stringContaining('aws')]]);
    write(r.root, 'notes/big.md', '---\ntitle: Big\n---\nhead\n');
    write(r.root, 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', left);
    write(r.root, 'notes/.big.gbparts/0002-bbbbbbbb.gbpart', right);
    const error = await caught(() => door(r.root, 'notes/big.md', 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', 'notes/.big.gbparts/0002-bbbbbbbb.gbpart'));
    expect(error.code).toBe('secret_found');
    expect(printed(error)).not.toContain(TOKEN.slice(4));
    expect(head(r.root)).toBe(before);
  }); }, 120_000);

  test('a PEM block straddling a part seam is refused', () => { const r = repo(); return withEnv(env(r), async () => {
    const before = head(r.root);
    const cut = Math.floor(PEM.length / 2);
    write(r.root, 'notes/big.md', 'head\n');
    write(r.root, 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', LINE.repeat(10) + PEM.slice(0, cut));
    write(r.root, 'notes/.big.gbparts/0002-bbbbbbbb.gbpart', PEM.slice(cut) + LINE.repeat(10));
    const error = await caught(() => door(r.root, 'notes/big.md', 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', 'notes/.big.gbparts/0002-bbbbbbbb.gbpart'));
    expect(error.code).toBe('secret_found');
    expect(printed(error)).not.toContain(PEM_BODY);
    expect(head(r.root)).toBe(before);
  }); }, 120_000);

  test('only bytes new to Git are scanned: a 20 MiB page with an old token takes a clean append past 24 MiB', () => { const r = repo(); return withEnv(env(r), async () => {
    const old = filler(10 * MiB) + 'aws_key = ' + TOKEN + '\n' + filler(10 * MiB);
    write(r.root, 'notes/old.md', old);
    git(r.root, 'add', 'notes/old.md'); git(r.root, 'commit', '-q', '-m', 'An old page');
    const appended = old + filler(5 * MiB);
    write(r.root, 'notes/old.md', appended);
    const commit = await door(r.root, 'notes/old.md');
    expect(commit).toBe(head(r.root));
    expect(git(r.root, 'cat-file', '-s', 'HEAD:notes/old.md').trim()).toBe(String(Buffer.byteLength(appended)));
    write(r.root, 'notes/copy.md', appended);
    expect((await caught(() => door(r.root, 'notes/copy.md'))).code).toBe('secret_found');
  }); }, 120_000);

  test('a transforming clean filter refuses git_clean_filter_refused, and its fix line clears it', () => { const r = repo(); return withEnv(env(r), async () => {
    git(r.root, 'config', 'filter.upper.clean', 'tr a-z A-Z'); git(r.root, 'config', 'filter.upper.smudge', 'cat');
    git(r.root, 'config', 'filter.same.clean', 'cat'); git(r.root, 'config', 'filter.same.smudge', 'cat');
    write(r.root, '.gitattributes', 'notes/*.md filter=upper\nkeep/*.md filter=same\n');
    git(r.root, 'add', '.gitattributes'); git(r.root, 'commit', '-q', '-m', 'Attributes');
    const before = head(r.root);
    write(r.root, 'notes/big.md', filler(25 * MiB));
    const error = await caught(() => door(r.root, 'notes/big.md'));
    expect(error.code).toBe('git_clean_filter_refused');
    expect(error.fix).toMatchObject({ ask_user: true });
    expect(head(r.root)).toBe(before);
    write(r.root, 'notes/small.md', 'A small page\n');
    expect(await door(r.root, 'notes/small.md')).toBe(head(r.root));
    write(r.root, 'keep/big.md', filler(25 * MiB));
    expect(await door(r.root, 'keep/big.md')).toBe(head(r.root));
    appendFileSync(join(r.root, '.gitattributes'), 'notes/big.md -filter -text\n');
    git(r.root, 'add', '.gitattributes'); git(r.root, 'commit', '-q', '-m', 'Exempt the large page');
    expect(await door(r.root, 'notes/big.md')).toBe(head(r.root));
    expect(git(r.root, 'rev-parse', 'HEAD:notes/big.md').trim()).toBe(git(r.root, 'hash-object', '--no-filters', 'notes/big.md').trim());
  }); }, 120_000);

  test('a file changed after the scan refuses, and HEAD stays', () => { const r = repo(); return withEnv(env(r), async () => {
    const before = head(r.root);
    write(r.root, 'notes/big.md', filler(25 * MiB));
    scanSeams.afterDoorScan = root => appendFileSync(join(root, 'notes/big.md'), 'aws_key = ' + TOKEN + '\n');
    const error = await caught(() => door(r.root, 'notes/big.md'));
    expect(error.code).toBe('git_unavailable');
    expect(error.message + error.suggestion).toContain('changed while it was being scanned');
    expect(head(r.root)).toBe(before);
  }); }, 120_000);
});

describe('Wave C 1A: the scan in gbrain git commit-push', () => {
  test('refused before git commit with the path and line, index restored; --allow-secret is the user\'s override', () => { const r = repo(); return withEnv(env(r), async () => {
    const before = head(r.root);
    const body = filler(30 * MiB);
    write(r.root, 'notes/big.md', body + PEM);
    const error = await caught(() => commitAndPush({ repo: r.root, paths: ['notes/big.md'], message: 'Big page', cwd: r.root }));
    expect(error.code).toBe('secret_found');
    expect(error.message).toContain('notes/big.md line ' + (body.split('\n').length));
    expect(printed(error)).not.toContain(PEM_BODY);
    expect(head(r.root)).toBe(before);
    expect(git(r.root, 'diff', '--cached', '--name-only').trim()).toBe('');
    expect(remoteTip(r)).toBe(before);
    expect(commitAndPush({ repo: r.root, paths: ['notes/big.md'], message: 'Big page', cwd: r.root, allowSecret: true })).toMatchObject({ outcome: 'pushed' });
    expect(remoteTip(r)).toBe(head(r.root));
  }); }, 120_000);

  test('a transforming clean filter refuses there too', () => { const r = repo(); return withEnv(env(r), async () => {
    git(r.root, 'config', 'filter.upper.clean', 'tr a-z A-Z'); git(r.root, 'config', 'filter.upper.smudge', 'cat');
    write(r.root, '.gitattributes', 'notes/*.md filter=upper\n');
    git(r.root, 'add', '.gitattributes'); git(r.root, 'commit', '-q', '-m', 'Attributes');
    const before = head(r.root);
    write(r.root, 'notes/big.md', filler(25 * MiB));
    expect((await caught(() => commitAndPush({ repo: r.root, paths: ['notes/big.md'], message: 'Big page', cwd: r.root }))).code).toBe('git_clean_filter_refused');
    expect(head(r.root)).toBe(before);
  }); }, 120_000);
});

describe('Wave C 1A: the pre-push backstop', () => {
  /** An external commit adding a 25 MiB file with a token, then a clean external commit on top. */
  const external = (r: Repo) => {
    write(r.root, 'notes/export.md', filler(12 * MiB) + 'aws_key = ' + TOKEN + '\n' + filler(13 * MiB));
    git(r.root, 'add', 'notes/export.md'); git(r.root, 'commit', '-q', '-m', 'Imported by hand');
    const bad = head(r.root);
    write(r.root, 'notes/later.md', 'A later note\n');
    git(r.root, 'add', 'notes/later.md'); git(r.root, 'commit', '-q', '-m', 'Later');
    return bad;
  };

  test('a secret in a mid-range external commit holds the push, also after a later clean door write; the allowlist fix releases it', () => { const r = repo(); return withEnv(env(r), async () => {
    const pushed = remoteTip(r);
    const bad = external(r);
    write(r.root, 'notes/clean.md', 'A clean page through the door\n');
    await door(r.root, 'notes/clean.md');
    const held = await caught(() => pushGitRoot(r.root));
    expect(held.code).toBe('git_push_secret_found');
    const detail = JSON.parse(held.detail);
    expect({ ...detail }).toMatchObject({ commit: bad, path: 'notes/export.md', rule: expect.stringContaining('aws'), fingerprint: expect.stringMatching(/^sha256:/) });
    expect(held.message).toContain(bad.slice(0, 12));
    expect(printed(held)).not.toContain(TOKEN.slice(4));
    expect(structuredClone(held.fix)).toMatchObject({ ask_user: true, argv: ['gbrain', 'git', 'commit-push', '--path', r.root, '-m', expect.any(String), '--', '.gbrain-scan-allow'] });
    expect(JSON.stringify(held.fix)).not.toMatch(/rebase|filter-branch|filter-repo|reset|--force/);
    expect(remoteTip(r)).toBe(pushed);
    write(r.root, 'notes/another.md', 'Another clean page\n');
    expect((await caught(() => commitAndPush({ repo: r.root, paths: ['notes/another.md'], message: 'Another', cwd: r.root }))).code).toBe('git_push_secret_found');
    expect(remoteTip(r)).toBe(pushed);
    const tip = head(r.root);
    write(r.root, '.gbrain-scan-allow', detail.fingerprint + '\n');
    const fix = Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...held.fix.argv.slice(1)], { env: { ...process.env }, cwd: r.root });
    expect({ exit: fix.exitCode, stderr: fix.exitCode ? fix.stderr.toString() : '' }).toEqual({ exit: 0, stderr: '' });
    expect(git(r.root, 'merge-base', '--is-ancestor', tip, 'HEAD').trim()).toBe('');
    expect(git(r.root, 'merge-base', '--is-ancestor', bad, 'refs/heads/main').trim()).toBe('');
    expect(remoteTip(r)).toBe(head(r.root));
  }); }, 180_000);

  test('the backstop skips blobs the door cleared under the current rule set and scans again under another', () => { const r = repo(); return withEnv(env(r), async () => {
    write(r.root, 'notes/clear.md', filler(25 * MiB));
    await door(r.root, 'notes/clear.md');
    const ledger = join(r.root, '.git', 'gbrain-scan-cleared');
    const cleared = git(r.root, 'rev-parse', 'HEAD:notes/clear.md').trim();
    expect(readFileSync(ledger, 'utf8').split('\n')).toContain(SCAN_RULESET_ID + ' ' + cleared);
    expect(await pushGitRoot(r.root)).toEqual({ push: 'committed' });
    external(r);
    const blob = git(r.root, 'rev-parse', 'HEAD~1:notes/export.md').trim();
    appendFileSync(ledger, 'secret-scan-old-rules ' + blob + '\n');
    expect((await caught(() => pushGitRoot(r.root))).code).toBe('git_push_secret_found');
    appendFileSync(ledger, SCAN_RULESET_ID + ' ' + blob + '\n');
    expect(await pushGitRoot(r.root)).toEqual({ push: 'committed' });
  }); }, 180_000);
});

describe('Wave C 1A review: the committed tree is the scanned tree', () => {
  test('commit-push takes back a commit whose covered file changed after its scan', () => { const r = repo(); return withEnv(env(r), async () => {
    const before = head(r.root);
    write(r.root, 'notes/big.md', filler(25 * MiB));
    scanSeams.afterDoorScan = root => appendFileSync(join(root, 'notes/big.md'), 'aws_key = ' + TOKEN + '\n');
    const error = await caught(() => commitAndPush({ repo: r.root, paths: ['notes/big.md'], message: 'Big page', cwd: r.root }));
    expect(error.code).toBe('git_unavailable');
    expect(error.message).toContain('changed after its secret scan');
    expect(head(r.root)).toBe(before);
    expect(remoteTip(r)).toBe(before);
    expect(git(r.root, 'diff', '--cached', '--name-only').trim()).toBe('');
  }); }, 120_000);

  test('a merge resolution file is scanned before the merge is pushed', () => { const r = repo(); return withEnv(env(r), async () => {
    write(r.root, 'notes/big.md', filler(25 * MiB));
    git(r.root, 'add', 'notes/big.md'); git(r.root, 'commit', '-q', '-m', 'Big'); git(r.root, 'push', '-q');
    const other = join(r.home, 'other');
    git(r.home, 'clone', '-q', r.remote, other);
    git(other, 'config', 'user.name', 'Other Machine'); git(other, 'config', 'user.email', 'other@example.invalid');
    appendFileSync(join(other, 'notes/big.md'), 'Their line\n');
    git(other, 'add', 'notes/big.md'); git(other, 'commit', '-q', '-m', 'Theirs'); git(other, 'push', '-q');
    const theirs = git(other, 'rev-parse', 'HEAD').trim();
    appendFileSync(join(r.root, 'notes/big.md'), 'Our line\n');
    git(r.root, 'add', 'notes/big.md'); git(r.root, 'commit', '-q', '-m', 'Ours');
    const merged = write(r.home, 'merged.md', filler(25 * MiB) + 'Our line\nTheir line\naws_key = ' + TOKEN + '\n');
    const error = await caught(() => commitAndPush({ repo: r.root, pushOnly: true, keepCheckout: true, cwd: r.root,
      resolutions: new Map([['notes/big.md', { kind: 'file' as const, path: merged }]]), expectRemote: theirs }));
    expect(error.code).toBe('git_push_secret_found');
    expect(remoteTip(r)).toBe(theirs);
  }); }, 180_000);

  test('a seam is checked against the committed neighbour, not a dirty working-tree copy', () => { const r = repo(); return withEnv(env(r), async () => {
    write(r.root, 'notes/big.md', 'head\n');
    write(r.root, 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', LINE.repeat(40) + 'aws_key = ' + TOKEN.slice(0, 9));
    git(r.root, 'add', 'notes'); git(r.root, 'commit', '-q', '-m', 'First part');
    const before = head(r.root);
    write(r.root, 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', LINE.repeat(41));
    write(r.root, 'notes/.big.gbparts/0002-bbbbbbbb.gbpart', TOKEN.slice(9) + '\n' + LINE.repeat(40));
    expect((await caught(() => door(r.root, 'notes/.big.gbparts/0002-bbbbbbbb.gbpart'))).code).toBe('secret_found');
    expect(head(r.root)).toBe(before);
  }); }, 120_000);

  test('the backstop checks seams between parts external commits add', () => { const r = repo(); return withEnv(env(r), async () => {
    const pushed = remoteTip(r);
    write(r.root, 'notes/big.md', 'head\n');
    write(r.root, 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', LINE.repeat(40) + 'aws_key = ' + TOKEN.slice(0, 9));
    git(r.root, 'add', 'notes'); git(r.root, 'commit', '-q', '-m', 'First part by hand');
    write(r.root, 'notes/.big.gbparts/0002-bbbbbbbb.gbpart', TOKEN.slice(9) + '\n' + LINE.repeat(40));
    git(r.root, 'add', 'notes'); git(r.root, 'commit', '-q', '-m', 'Second part by hand');
    const held = await caught(() => pushGitRoot(r.root));
    expect(held.code).toBe('git_push_secret_found');
    expect(JSON.parse(held.detail)).toMatchObject({ path: 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', commit: head(r.root) });
    expect(remoteTip(r)).toBe(pushed);
  }); }, 120_000);

  test('a blob cleared only by an allowlist entry is not cached: removing the entry holds the push again', () => { const r = repo(); return withEnv(env(r), async () => {
    const fingerprint = findings('aws_key = ' + TOKEN + '\n')[0]!.fingerprint;
    write(r.root, '.gbrain-scan-allow', fingerprint + '\n');
    write(r.root, 'notes/big.md', filler(25 * MiB) + 'aws_key = ' + TOKEN + '\n');
    await door(r.root, 'notes/big.md');
    const blob = git(r.root, 'rev-parse', 'HEAD:notes/big.md').trim();
    expect(ledgerText(r.root)).not.toContain(blob);
    rmSync(join(r.root, '.gbrain-scan-allow'));
    expect((await caught(() => pushGitRoot(r.root))).code).toBe('git_push_secret_found');
    write(r.root, '.gbrain-scan-allow', 'notes/big.md\n');
    expect(await pushGitRoot(r.root)).toEqual({ push: 'committed' });
    expect(ledgerText(r.root)).not.toContain(blob);
  }); }, 180_000);

  test('a split head is covered at the door and by the backstop, whatever its size', () => { const r = repo(); return withEnv(env(r), async () => {
    const pushed = remoteTip(r);
    write(r.root, 'notes/.big.gbparts/0001-aaaaaaaa.gbpart', LINE.repeat(10));
    write(r.root, 'notes/big.md', '---\ntitle: Big\n---\naws_key = ' + TOKEN + '\n');
    expect((await caught(() => door(r.root, 'notes/big.md', 'notes/.big.gbparts/0001-aaaaaaaa.gbpart'))).code).toBe('secret_found');
    write(r.root, 'notes/small.md', 'aws_key = ' + TOKEN + '\n');
    expect(await door(r.root, 'notes/small.md')).toBe(head(r.root));
    git(r.root, 'add', 'notes'); git(r.root, 'commit', '-q', '-m', 'Split page by hand');
    const held = await caught(() => pushGitRoot(r.root));
    expect(held.code).toBe('git_push_secret_found');
    expect(JSON.parse(held.detail).path).toBe('notes/big.md');
    expect(remoteTip(r)).toBe(pushed);
  }); }, 120_000);
});
