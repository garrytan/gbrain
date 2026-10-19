/**
 * GBRA-133 lane B: the odd inputs each probe commits next to a healthy sibling.
 * Row ids (S-n) match ~/.capy/work/gbra133/blockers.md. A case's mutate writes
 * the odd input (the runner has already written ok/healthy-1.md) and commits,
 * unless it needs another order. custom cases run their own flow.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitIn, md, type ProbeRepo, type SyncMode } from './s-blockers-fixture.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../../src/core/persistence/sync-status.ts';

export interface BlockerCase {
  id: string;
  name: string;
  /** Repo-relative odd path(s) (string) used to find a ledger row, refusal or hold that names it. */
  odd: string[];
  /** Slug the odd file would import as, when importing it is the right outcome. */
  oddSlug?: string;
  /** Runs after the first sync with ok/healthy-1.md already on disk; must leave HEAD with healthy-1 committed. */
  mutate(r: ProbeRepo): void | Promise<void>;
  /** Before the first sync (after the seed commit). */
  prepare?(r: ProbeRepo): void | Promise<void>;
  /** Build the repo root yourself (it must already hold a seed commit); the runner skips init and seed. */
  makeRoot?(home: string): string;
  skip?(mode: SyncMode): string | false;
  /** Sync with git pull (noPull false). */
  pull?: boolean;
  /** For pull cases: the upstream repo the healthy-2 commit must reach before the third sync. */
  upstream?(r: ProbeRepo): string;
  /** Skipping or refusing the odd file is the right outcome only when it is reported; importing it is not required. */
  importNotRequired?: boolean;
}

const BIN_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001ffa1e3d40000000049454e44ae426082', 'hex');
const sh = (cwd: string, cmd: string) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const commit = (r: ProbeRepo, msg = 'odd') => r.commitAll(msg);
const looseObjectPath = (r: ProbeRepo, sha: string) => join(r.root, '.git', 'objects', sha.slice(0, 2), sha.slice(2));

export const CASES: BlockerCase[] = [
  // ---- filenames --------------------------------------------------------------------------------
  { id: 'S-1', name: 'filename with double quotes', odd: ['notes/say "hi".md'], oddSlug: undefined,
    mutate: r => { r.write('notes/say "hi".md', md('quoted')); commit(r); } },
  { id: 'S-2', name: 'filename with a newline', odd: ['notes/line\nbreak.md'],
    mutate: r => { r.write('notes/line\nbreak.md', md('newline')); commit(r); } },
  { id: 'S-3', name: 'filename with a tab', odd: ['notes/tab\there.md'],
    mutate: r => { r.write('notes/tab\there.md', md('tab')); commit(r); } },
  { id: 'S-4', name: 'filename with a backslash', odd: ['notes/back\\slash.md'],
    mutate: r => { r.write('notes/back\\slash.md', md('backslash')); commit(r); } },
  { id: 'S-5', name: 'filename with a leading dash', odd: ['-dash.md', 'notes/--help.md'], oddSlug: 'notes/help',
    mutate: r => { r.write('-dash.md', md('dash')); r.write('notes/--help.md', md('help')); commit(r); } },
  { id: 'S-6', name: 'filename with a colon (POSIX)', odd: ['notes/a:b.md'], oddSlug: 'notes/a:b',
    mutate: r => { r.write('notes/a:b.md', md('colon')); commit(r); } },
  { id: 'S-7', name: 'non-UTF-8 filename (latin-1 byte 0xE9)', odd: ['notes/caf'],
    mutate: r => { r.write(Buffer.concat([Buffer.from('notes/caf'), Buffer.from([0xe9]), Buffer.from('.md')]), md('latin1')); commit(r); } },
  { id: 'S-8', name: 'NFD unicode filename', odd: ['notes/jose\u0301.md'], oddSlug: 'notes/jos\u00e9',
    mutate: r => { r.write('notes/jose\u0301.md', md('nfd')); commit(r); } },
  { id: 'S-9', name: 'NFC and NFD twins of one name', odd: ['notes/jos\u00e9.md', 'notes/jose\u0301.md'], importNotRequired: true,
    mutate: r => { r.write('notes/jos\u00e9.md', md('nfc')); r.write('notes/jose\u0301.md', md('nfd')); commit(r); } },
  { id: 'S-10', name: '255-byte filename component', odd: ['notes/' + 'a'.repeat(252) + '.md'], oddSlug: 'notes/' + 'a'.repeat(252),
    mutate: r => { r.write('notes/' + 'a'.repeat(252) + '.md', md('long')); commit(r); } },
  { id: 'S-11', name: 'very deep path (40 levels, ~3 KB)', odd: ['deep/'], oddSlug: undefined, importNotRequired: true,
    mutate: r => { r.write('deep/' + Array.from({ length: 40 }, (_, i) => 'level-' + String(i).padStart(2, '0') + '-' + 'x'.repeat(60)).join('/') + '/leaf.md', md('deep')); commit(r); } },
  { id: 'S-12', name: 'a directory named x.md', odd: ['notes/dir.md'], oddSlug: 'notes/dir.md/inner',
    mutate: r => { r.write('notes/dir.md/inner.md', md('inner')); commit(r); } },
  { id: 'S-13', name: 'filename with leading space and trailing-space directory', odd: ['notes/ lead.md', 'trail /x.md'],
    mutate: r => { r.write('notes/ lead.md', md('lead')); r.write('trail /x.md', md('trail')); commit(r); } },
  { id: 'S-14', name: 'case-only rename with core.ignorecase=true', odd: ['notes/case.md', 'notes/Case.md'], oddSlug: 'notes/case',
    prepare: r => { r.write('notes/Case.md', md('Case')); commit(r, 'case'); },
    mutate: r => { r.git('config', 'core.ignorecase', 'true'); r.git('mv', 'notes/Case.md', 'notes/case.md'); r.write('notes/case.md', md('case renamed')); commit(r); } },
  { id: 'S-15', name: 'two files differing only by case', odd: ['notes/Dup.md', 'notes/dup.md'], importNotRequired: true,
    mutate: r => { r.write('notes/Dup.md', md('Dup')); r.write('notes/dup.md', md('dup')); commit(r); } },

  // ---- symlinks ---------------------------------------------------------------------------------
  { id: 'S-16', name: 'symlink to a file inside the repo', odd: ['notes/link.md'], importNotRequired: true,
    mutate: r => { r.write('notes/real.md', md('real')); symlinkSync('real.md', join(r.root, 'notes/link.md')); commit(r); } },
  { id: 'S-17', name: 'symlink pointing outside the repo', odd: ['notes/out.md'], importNotRequired: true,
    mutate: r => { writeFileSync(join(r.home, 'outside-secret.md'), md('outside')); mkdirSync(join(r.root, 'notes'), { recursive: true }); symlinkSync(join(r.home, 'outside-secret.md'), join(r.root, 'notes/out.md')); commit(r); } },
  { id: 'S-18', name: 'dangling symlink', odd: ['notes/dangling.md'], importNotRequired: true,
    mutate: r => { mkdirSync(join(r.root, 'notes'), { recursive: true }); symlinkSync('nowhere.md', join(r.root, 'notes/dangling.md')); commit(r); } },
  { id: 'S-19', name: 'symlinked directory holding markdown', odd: ['linked'], importNotRequired: true,
    mutate: r => { r.write('real-dir/inside.md', md('inside')); symlinkSync('real-dir', join(r.root, 'linked')); commit(r); } },
  { id: 'S-20', name: 'symlink loop', odd: ['loop1.md', 'loop2.md'], importNotRequired: true,
    mutate: r => { symlinkSync('loop2.md', join(r.root, 'loop1.md')); symlinkSync('loop1.md', join(r.root, 'loop2.md')); commit(r); } },
  { id: 'S-21', name: 'typechange: imported file becomes a symlink', odd: ['notes/t.md'], importNotRequired: true,
    prepare: r => { r.write('notes/t.md', md('t')); r.write('notes/target.md', md('target')); commit(r, 't'); },
    mutate: r => { unlinkSync(join(r.root, 'notes/t.md')); symlinkSync('target.md', join(r.root, 'notes/t.md')); commit(r); } },
  { id: 'S-22', name: 'typechange: imported file becomes a directory', odd: ['notes/fd.md'], oddSlug: 'notes/fd.md/x',
    prepare: r => { r.write('notes/fd.md', md('fd')); commit(r, 'fd'); },
    mutate: r => { unlinkSync(join(r.root, 'notes/fd.md')); r.write('notes/fd.md/x.md', md('fdx')); commit(r); } },

  // ---- repository structure ---------------------------------------------------------------------
  { id: 'S-23', name: 'nested git repo committed as a gitlink (embedded repo)', odd: ['nested'], importNotRequired: true,
    mutate: r => {
      const nested = join(r.root, 'nested'); mkdirSync(nested);
      gitIn(nested, 'init', '-q'); writeFileSync(join(nested, 'n.md'), md('n'));
      gitIn(nested, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'add', '-A');
      gitIn(nested, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'n');
      commit(r);
    } },
  { id: 'S-24', name: 'submodule declared in .gitmodules but not initialized', odd: ['sub'], importNotRequired: true,
    mutate: r => {
      const up = join(r.home, 'sub-upstream-' + r.sourceId); mkdirSync(up); gitIn(up, 'init', '-q', '-b', 'main');
      writeFileSync(join(up, 's.md'), md('s')); gitIn(up, 'add', '-A'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 's');
      r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', up, 'sub');
      commit(r);
      rmSync(join(r.root, 'sub'), { recursive: true, force: true }); mkdirSync(join(r.root, 'sub'));
    } },
  { id: 'S-25', name: '.gitattributes filter=lfs on one markdown file (LFS pointer content, no lfs installed)', odd: ['notes/lfs.md'], oddSlug: 'notes/lfs',
    mutate: r => {
      r.write('.gitattributes', 'notes/lfs.md filter=lfs diff=lfs merge=lfs -text\n');
      r.write('notes/lfs.md', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 12345\n');
      commit(r);
    } },
  { id: 'S-26', name: '.gitattributes with a working-tree-encoding on one markdown file', odd: ['notes/utf16.md'], oddSlug: 'notes/utf16',
    mutate: r => {
      r.write('.gitattributes', 'notes/utf16.md working-tree-encoding=UTF-16 text\n');
      r.write('notes/utf16.md', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(md('utf16'), 'utf16le')]));
      commit(r);
    } },
  { id: 'S-27', name: 'sparse checkout leaves a committed file off disk', odd: ['hidden/h.md'], importNotRequired: true,
    mutate: r => {
      r.write('hidden/h.md', md('hidden')); commit(r);
      r.git('sparse-checkout', 'set', '--no-cone', '/*', '!/hidden/');
    } },
  { id: 'S-28', name: 'committed file deleted from the working tree (not committed)', odd: ['notes/gone.md'], importNotRequired: true,
    mutate: r => { r.write('notes/gone.md', md('gone')); commit(r); unlinkSync(join(r.root, 'notes/gone.md')); } },
  { id: 'S-29', name: 'working-tree edit of a committed file that differs from HEAD', odd: ['notes/dirty.md'], importNotRequired: true,
    mutate: r => { r.write('notes/dirty.md', md('committed')); commit(r); r.write('notes/dirty.md', md('uncommitted edit')); } },
  { id: 'S-30', name: 'unreadable file (mode 000)', odd: ['notes/locked.md'], importNotRequired: true,
    skip: () => (process.getuid?.() === 0 ? 'running as root: chmod 000 does not block reads' : false),
    mutate: r => { r.write('notes/locked.md', md('locked')); commit(r); chmodSync(join(r.root, 'notes/locked.md'), 0o000); } },
  { id: 'S-31', name: 'stale .git/index.lock (0 bytes)', odd: [], importNotRequired: true,
    mutate: r => { commit(r); writeFileSync(join(r.root, '.git/index.lock'), ''); } },
  { id: 'S-32', name: 'stale HEAD.lock and refs/heads/main.lock', odd: [], importNotRequired: true,
    mutate: r => { commit(r); writeFileSync(join(r.root, '.git/HEAD.lock'), ''); writeFileSync(join(r.root, '.git/refs/heads/main.lock'), ''); } },
  { id: 'S-33', name: 'missing blob object for a committed file (working tree intact)', odd: ['notes/corrupt.md'], oddSlug: 'notes/corrupt',
    mutate: r => {
      r.write('notes/corrupt.md', md('corrupt unique ' + r.sourceId)); commit(r);
      const sha = r.git('rev-parse', 'HEAD:notes/corrupt.md'); chmodSync(looseObjectPath(r, sha), 0o644); unlinkSync(looseObjectPath(r, sha));
    } },
  { id: 'S-34', name: 'detached HEAD with a new commit', odd: [], importNotRequired: true,
    mutate: r => { r.git('checkout', '-q', '--detach'); commit(r); } },
  { id: 'S-35', name: 'history rewrite: last_commit amended away and garbage-collected', odd: [], importNotRequired: true,
    mutate: r => {
      r.write('seed.md', md('seed rewritten')); r.git('add', '-A'); r.git('commit', '-q', '--amend', '-m', 'seed rewritten');
      r.git('reflog', 'expire', '--expire=now', '--all'); r.git('gc', '-q', '--prune=now');
    } },
  { id: 'S-36', name: 'history rewrite: last_commit still present but no longer an ancestor', odd: [], importNotRequired: true,
    mutate: r => { r.write('seed.md', md('seed amended')); r.git('add', '-A'); r.git('commit', '-q', '--amend', '-m', 'seed amended'); } },
  { id: 'S-37', name: 'orphan branch switch (unrelated history)', odd: [], importNotRequired: true,
    mutate: r => { r.git('checkout', '-q', '--orphan', 'other'); r.write('seed.md', md('orphan seed')); commit(r); } },
  { id: 'S-38', name: 'shallow clone refetched at depth 1 past last_commit', odd: [], importNotRequired: true,
    makeRoot: home => {
      const up = join(home, 'shallow-up-' + Math.random().toString(36).slice(2, 8)); mkdirSync(up);
      gitIn(up, 'init', '-q', '-b', 'main'); writeFileSync(join(up, 'seed.md'), md('seed')); gitIn(up, 'add', '-A');
      gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'seed');
      const root = up + '-clone';
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', '--depth', '1', 'file://' + up, root]);
      gitIn(root, 'config', 'user.name', 'Example'); gitIn(root, 'config', 'user.email', 'example@example.invalid');
      return root;
    },
    mutate: r => {
      const up = r.root.replace(/-clone$/, '');
      writeFileSync(join(up, 'mid.md'), md('mid')); gitIn(up, 'add', '-A'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'mid');
      renameSync(join(r.root, 'ok/healthy-1.md'), join(up, 'healthy-tmp.md'));
      mkdirSync(join(up, 'ok'), { recursive: true }); renameSync(join(up, 'healthy-tmp.md'), join(up, 'ok/healthy-1.md'));
      gitIn(up, 'add', '-A'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'healthy');
      r.git('fetch', '-q', '--depth', '1', 'origin', 'main'); r.git('reset', '-q', '--hard', 'FETCH_HEAD');
      r.git('reflog', 'expire', '--expire=now', '--all'); r.git('gc', '-q', '--prune=now');
    } },

  // ---- content ----------------------------------------------------------------------------------
  { id: 'S-39', name: 'NUL bytes in body', odd: ['notes/nul.md'], oddSlug: 'notes/nul',
    mutate: r => { r.write('notes/nul.md', md('nul') + 'before\u0000after\n'); commit(r); } },
  { id: 'S-40', name: 'invalid UTF-8 bytes in body', odd: ['notes/badutf8.md'], oddSlug: 'notes/badutf8',
    mutate: r => { r.write('notes/badutf8.md', Buffer.concat([Buffer.from(md('badutf8')), Buffer.from([0xc3, 0x28, 0xff, 0xfe, 0x0a])])); commit(r); } },
  { id: 'S-41', name: 'UTF-8 BOM before frontmatter', odd: ['notes/bom.md'], oddSlug: 'notes/bom',
    mutate: r => { r.write('notes/bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(md('bom'))])); commit(r); } },
  { id: 'S-42', name: 'CRLF line endings', odd: ['notes/crlf.md'], oddSlug: 'notes/crlf',
    mutate: r => { r.write('notes/crlf.md', md('crlf').replace(/\n/g, '\r\n')); commit(r); } },
  { id: 'S-43', name: 'zero-byte markdown file', odd: ['notes/empty.md'], importNotRequired: true,
    mutate: r => { r.write('notes/empty.md', ''); commit(r); } },
  { id: 'S-44', name: 'binary PNG bytes with a .md extension', odd: ['notes/binary.md'], importNotRequired: true,
    mutate: r => { r.write('notes/binary.md', BIN_PNG); commit(r); } },
  { id: 'S-45', name: 'frontmatter that parses to a YAML list (not a mapping)', odd: ['notes/yaml-list.md'], importNotRequired: true,
    mutate: r => { r.write('notes/yaml-list.md', '---\n- a\n- b\n---\nBody.\n'); commit(r); } },
  { id: 'S-46', name: 'frontmatter that parses to a scalar', odd: ['notes/yaml-scalar.md'], importNotRequired: true,
    mutate: r => { r.write('notes/yaml-scalar.md', '---\njust a string\n---\nBody.\n'); commit(r); } },
  { id: 'S-47', name: 'YAML alias bomb in frontmatter (7 levels: 280 bytes of YAML expand to 22.8 MB of JSON; 9 levels OOM-killed every arm at 15.5 GB RSS)', odd: ['notes/yaml-bomb.md'], importNotRequired: true,
    mutate: r => {
      const lines = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
      for (let i = 1; i < 7; i++) lines.push(String.fromCharCode(97 + i) + ': &' + String.fromCharCode(97 + i) + ' [' + Array(9).fill('*' + String.fromCharCode(96 + i)).join(',') + ']');
      r.write('notes/yaml-bomb.md', '---\ntitle: bomb\n' + lines.join('\n') + '\n---\nBody.\n'); commit(r);
    } },
  { id: 'S-48', name: 'frontmatter with odd typed values (title is a mapping, tags a number, date invalid)', odd: ['notes/yaml-types.md'], importNotRequired: true,
    mutate: r => { r.write('notes/yaml-types.md', '---\ntitle: {a: 1}\ntags: 42\ndate: 2026-13-45\ntype: [note]\nslug: 7\n---\nBody.\n'); commit(r); } },
  { id: 'S-49', name: 'single 4 MB line with no newline', odd: ['notes/oneline.md'], importNotRequired: true,
    mutate: r => { r.write('notes/oneline.md', '---\ntitle: oneline\n---\n' + 'word '.repeat(800_000)); commit(r); } },
  { id: 'S-50', name: 'lone UTF-16 surrogate escaped in frontmatter', odd: ['notes/surrogate.md'], importNotRequired: true,
    mutate: r => { r.write('notes/surrogate.md', '---\ntitle: "bad \\ud800 surrogate"\n---\nBody.\n'); commit(r); } },
  { id: 'S-56', name: 'managed cursor left unfinished on a target commit that is then rewritten away and garbage-collected', odd: [], importNotRequired: true,
    skip: mode => (mode === 'classic' ? 'managed cursor only' : false),
    mutate: async r => {
      for (let i = 0; i < 6; i++) r.write('batch/b' + i + '.md', md('batch ' + i));
      commit(r, 'batch');
      const partial = await performManagedSync(r.engine, { sourceId: r.sourceId, noPull: true, noEmbed: true, noExtract: true } as never, { maxPages: 1, maxMs: 60_000 });
      const st = await readSyncStatus(r.engine, r.sourceId) as unknown as { state?: string; reason?: string };
      if (partial.status !== 'partial' || st.state !== 'resumable') throw new Error('precondition: expected an unfinished cursor, got ' + partial.status + ' ' + st.state + '/' + st.reason);
      r.write('seed.md', md('seed rewritten under an open cursor')); r.git('add', '-A'); r.git('commit', '-q', '--amend', '-m', 'batch rewritten');
      r.git('reflog', 'expire', '--expire=now', '--all'); r.git('gc', '-q', '--prune=now');
    } },
  { id: 'S-57', name: 'classic pin left by a blocked run, then history rewritten away and garbage-collected', odd: [], importNotRequired: true,
    skip: mode => (mode === 'managed' ? 'classic pin only (the managed twin is S-56)' : process.getuid?.() === 0 ? 'root ignores mode 000' : false),
    mutate: async r => {
      r.write('notes/locked.md', md('locked')); commit(r, 'locked');
      chmodSync(join(r.root, 'notes/locked.md'), 0o000);
      await r.sync().catch(() => undefined);
      chmodSync(join(r.root, 'notes/locked.md'), 0o644);
      r.write('seed.md', md('seed rewritten under a pin')); r.git('add', '-A'); r.git('commit', '-q', '--amend', '-m', 'locked rewritten');
      r.git('reflog', 'expire', '--expire=now', '--all'); r.git('gc', '-q', '--prune=now');
    } },
  { id: 'S-58', name: 'upstream force-push rewrites history under a clone that syncs with pull', odd: [], importNotRequired: true, pull: true,
    skip: mode => (mode === 'managed' ? 'managed sync refuses git pull (writer_coordinator_required); it always runs --no-pull' : false),
    makeRoot: home => {
      const up = join(home, 'fp-up-' + Math.random().toString(36).slice(2, 8)); mkdirSync(up);
      gitIn(up, 'init', '-q', '-b', 'main'); gitIn(up, 'config', 'receive.denyCurrentBranch', 'ignore');
      writeFileSync(join(up, 'seed.md'), md('seed')); gitIn(up, 'add', '-A'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'seed');
      const root = up + '-clone';
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', 'file://' + up, root]);
      gitIn(root, 'config', 'user.name', 'Example'); gitIn(root, 'config', 'user.email', 'example@example.invalid');
      return root;
    },
    upstream: r => r.root.replace(/-clone$/, ''),
    mutate: r => {
      const up = r.root.replace(/-clone$/, '');
      mkdirSync(join(up, 'ok'), { recursive: true }); renameSync(join(r.root, 'ok/healthy-1.md'), join(up, 'ok/healthy-1.md'));
      writeFileSync(join(up, 'seed.md'), md('seed rewritten upstream'));
      gitIn(up, 'add', '-A'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-q', '--amend', '-m', 'seed rewritten upstream');
    } },
  { id: 'S-59', name: 'upstream force-push of a non-root commit (diverged, not unrelated) under a clone that syncs with pull', odd: [], importNotRequired: true, pull: true,
    skip: mode => (mode === 'managed' ? 'managed sync refuses git pull (writer_coordinator_required); it always runs --no-pull' : false),
    makeRoot: home => {
      const up = join(home, 'fp-up-' + Math.random().toString(36).slice(2, 8)); mkdirSync(up);
      gitIn(up, 'init', '-q', '-b', 'main'); gitIn(up, 'config', 'receive.denyCurrentBranch', 'ignore');
      writeFileSync(join(up, 'seed.md'), md('seed')); gitIn(up, 'add', '-A'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'seed');
      writeFileSync(join(up, 'second.md'), md('second')); gitIn(up, 'add', '-A'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'second');
      const root = up + '-clone';
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', 'file://' + up, root]);
      gitIn(root, 'config', 'user.name', 'Example'); gitIn(root, 'config', 'user.email', 'example@example.invalid');
      return root;
    },
    upstream: r => r.root.replace(/-clone$/, ''),
    mutate: r => {
      const up = r.root.replace(/-clone$/, '');
      mkdirSync(join(up, 'ok'), { recursive: true }); renameSync(join(r.root, 'ok/healthy-1.md'), join(up, 'ok/healthy-1.md'));
      writeFileSync(join(up, 'second.md'), md('second rewritten upstream'));
      gitIn(up, 'add', '-A'); gitIn(up, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-q', '--amend', '-m', 'second rewritten upstream');
    } },
  { id: 'S-51', name: 'NUL in a title committed together with a markdown delete (rename-identity confirmation)', odd: ['notes/nul-title.md'], importNotRequired: true,
    prepare: r => { r.write('notes/old.md', md('old')); commit(r, 'old'); },
    mutate: r => { unlinkSync(join(r.root, 'notes/old.md')); r.write('notes/nul-title.md', '# Meeting notes\u0000\u0000\u0000'); commit(r); } },
  { id: 'S-52', name: 'filename with trailing whitespace', odd: ['notes/trail.md '], oddSlug: undefined,
    mutate: r => { r.write('notes/trail.md ', md('trail')); commit(r); } },
  { id: 'S-53', name: 'UTF-16LE note with a BOM and no attributes (NULs once read as UTF-8)', odd: ['notes/utf16-raw.md'], importNotRequired: true,
    mutate: r => { r.write('notes/utf16-raw.md', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(md('utf16 raw'), 'utf16le')])); commit(r); } },
];
