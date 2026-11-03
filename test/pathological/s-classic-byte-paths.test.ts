/**
 * GBRA-133 PR 1 item 3 (second half): classic sync reads Git paths as bytes.
 *
 * Before this, classic sync ran `git diff --name-status -M` without `-z` and
 * decoded stdout as UTF-8. A non-UTF-8 name (S-7, `notes/caf<0xE9>.md`) became
 * U+FFFD, the file "did not exist" and was checkpointed as deleted after the
 * pin with no message; tab and newline names (S-2, S-3) were decoded, then
 * skipped as malformed with only a log line naming no path; a gitlink (an
 * embedded repository or submodule, S-23/S-24) left the tree unindexed with
 * nothing said.
 *
 * Protects: such a name never reaches the importer as a lossy string. It is
 * held `unsupported_path` (`not_utf8` | `control_character`) under a key that
 * encodes its exact bytes, with an escaped display path, an item id bound to
 * the bytes and a fix whose argv never carries the name; the healthy sibling
 * imports, the cursor reaches HEAD, no failure-ledger row is written, the hold
 * stays while the file does and clears when a later commit renames it to a
 * valid name (which then imports). A gitlink is reported once, in the run it
 * appears. Quoted names keep importing. Sync's Git reads run with
 * GIT_OPTIONAL_LOCKS=0, so a sync never takes index.lock; writes do not.
 *
 * PGLite always, Postgres when DATABASE_URL is set (test/e2e wrapper).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SyncResult } from '../../src/commands/sync.ts';
import { gitHoldItem, readGitSourceHolds, type GitHoldRecord } from '../../src/core/persistence/sync-holds.ts';
import { git, gitRawOutput } from '../../src/core/sync-git.ts';
import { buildDetachedWorkingTreeManifest, computeSyncDelta } from '../../src/core/sync-delta.ts';
import { confirmRenameIdentities } from '../../src/core/sync-rename-identity.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, pathologicalArms, renderFix } from './harness.ts';
import { gitIn, md, observe, withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';

const CAFE = Buffer.concat([Buffer.from('notes/caf'), Buffer.from([0xe9]), Buffer.from('.md')]);
const itemId = (raw: Buffer) => createHash('sha256').update(raw).digest('hex').slice(0, 16);
const sh = (cwd: string, script: string) => execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

async function holdsOf(r: ProbeRepo): Promise<GitHoldRecord[]> {
  return (await readGitSourceHolds(r.engine, { sourceIds: [r.sourceId] }))[0]?.holds ?? [];
}

async function pageAt(engine: BrainEngine, sourceId: string, sourcePath: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL', [sourceId, sourcePath]);
  return row?.slug ?? null;
}

/** One seeded classic repo, first sync taken; `run` commits the odd input next to ok/healthy-1.md. */
async function withClassic(databaseUrl: string | undefined, run: (r: ProbeRepo) => Promise<void>): Promise<void> {
  await withProbeEngine(databaseUrl, async (engine, home) => {
    await withProbeRepo(engine, 'classic', home, async r => {
      await r.sync();
      r.write('ok/healthy-1.md', md('healthy one'));
      await run(r);
    });
  });
}

describe('unsupported_path key, display and fix (no engine)', () => {
  test('the key encodes the exact bytes, round-trips, and never collides with a Git path', async () => {
    const { encodeBytePathKey, decodeBytePathKey, displayBytePath, bytePathItemId } = await import('../../src/core/sync-byte-paths.ts');
    const tab = Buffer.from('notes/tab\there.md');
    const pct = Buffer.concat([Buffer.from('a%b/'), Buffer.from([0xff, 0x0a])]);
    expect(encodeBytePathKey(CAFE)).toBe('/gbrain-bytes/notes/caf%E9.md');
    expect(encodeBytePathKey(tab)).toBe('/gbrain-bytes/notes/tab%09here.md');
    expect(encodeBytePathKey(pct)).toBe('/gbrain-bytes/a%25b/%FF%0A');
    for (const raw of [CAFE, tab, pct, Buffer.from('notes/jos\u00e9.md')]) expect(decodeBytePathKey(encodeBytePathKey(raw))).toEqual(raw);
    expect(decodeBytePathKey('notes/caf%E9.md')).toBeNull();
    expect(decodeBytePathKey('/gbrain-bytes/notes/%ZZ.md')).toBeNull();
    expect(displayBytePath(CAFE)).toBe('notes/caf\\351.md');
    expect(displayBytePath(Buffer.from('notes/line\nbreak.md'))).toBe('notes/line\\nbreak.md');
    expect(bytePathItemId(CAFE)).toBe(itemId(CAFE));
  });

  test('the rename command in the fix reads the name from printf escapes, so it renames the real file', async () => {
    const { bytePathRenameCommand } = await import('../../src/core/sync-byte-paths.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-byte-rename-'));
    try {
      for (const raw of [CAFE, Buffer.from("notes/it's 100%\tdone\n.md")]) {
        mkdirSync(join(dir, 'notes'), { recursive: true });
        writeFileSync(Buffer.concat([Buffer.from(dir + '/'), raw]), 'x');
        const command = bytePathRenameCommand(raw, 'notes/renamed.md');
        expect(command).not.toContain('\ufffd');
        expect(/[\x00-\x1f\x7f-\x9f]/.test(command)).toBe(false);
        gitIn(dir, 'init', '-q'); gitIn(dir, 'add', '-A');
        sh(dir, command);
        expect(gitIn(dir, 'ls-files', '-z').split('\0').filter(Boolean)).toEqual(['notes/renamed.md']);
        rmSync(join(dir, '.git'), { recursive: true, force: true }); rmSync(join(dir, 'notes'), { recursive: true, force: true });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('sync status classes the hold as one page waiting on a rename, not an unknown systemic fault', async () => {
    const { classifySyncFault } = await import('../../src/core/persistence/sync-fault-class.ts');
    const { publicCategory } = await import('../../src/core/persistence/public-category.ts');
    const verdict = classifySyncFault({ code: 'unsupported_path', detail: 'not_utf8' });
    expect({ class: verdict.class, safe_actions: verdict.safe_actions, needs_human: verdict.needs_human }).toEqual({ class: 'page', safe_actions: ['none'], needs_human: true });
    expect(verdict.human_reason).toContain('renames the file');
    expect(publicCategory({ code: 'unsupported_path' })).toBe('content_refused');
  });
});

describe('sync Git reads take no optional lock (GIT_OPTIONAL_LOCKS=0)', () => {
  test('diff, ls-files, cat-file and rev-parse carry GIT_OPTIONAL_LOCKS=0; a ref write does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-optional-locks-'));
    const bin = join(dir, 'bin'), log = join(dir, 'git.log'), repo = join(dir, 'repo');
    try {
      const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      mkdirSync(bin); mkdirSync(repo);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nsub=""\nskip=0\nfor a in "$@"; do\n  if [ $skip = 1 ]; then skip=0; continue; fi\n  case "$a" in -c|-C) skip=1; continue;; esac\n  sub="$a"; break\ndone\n'
        + 'printf \'%s %s\\n\' "${GIT_OPTIONAL_LOCKS:-unset}" "$sub" >> "$PROBE_GIT_LOG"\nPATH=\'' + process.env.PATH + '\' exec ' + realGit + ' "$@"\n');
      chmodSync(join(bin, 'git'), 0o755);
      gitIn(repo, 'init', '-q', '-b', 'main'); gitIn(repo, 'config', 'user.name', 'Example'); gitIn(repo, 'config', 'user.email', 'example@example.invalid');
      writeFileSync(join(repo, 'a.md'), md('a')); gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-qm', 'a');
      const first = gitIn(repo, 'rev-parse', 'HEAD');
      gitIn(repo, 'mv', 'a.md', 'b.md'); writeFileSync(join(repo, 'b.md'), md('a') + 'a longer body, so the rename is inexact\n'); gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-qm', 'b');
      const second = gitIn(repo, 'rev-parse', 'HEAD');
      await withEnv({ PATH: bin + ':' + process.env.PATH, PROBE_GIT_LOG: log }, async () => {
        git(repo, ['rev-parse', 'HEAD']);
        git(repo, ['diff', '--name-status', first, second]);
        gitRawOutput(repo, ['ls-files', '-z']);
        expect(computeSyncDelta(repo, first, second).status).toBe('ok');
        buildDetachedWorkingTreeManifest(repo);
        const engine = { executeRaw: async () => [] } as unknown as Pick<BrainEngine, 'executeRaw'>;
        await confirmRenameIdentities(engine, repo, first, second, { added: [], modified: [], deleted: [], renamed: [{ from: 'a.md', to: 'b.md', similarity: 60 }] },
          { sourceId: 'default', sourcePathOf: p => p });
        git(repo, ['update-ref', 'refs/heads/probe', 'HEAD']);
      });
      const lines = readFileSync(log, 'utf8').trim().split('\n').map(line => { const [locks, sub] = line.split(' '); return { locks, sub }; });
      const reads = lines.filter(line => ['rev-parse', 'diff', 'ls-files', 'cat-file'].includes(line.sub!));
      expect(new Set(reads.map(line => line.sub))).toEqual(new Set(['rev-parse', 'diff', 'ls-files', 'cat-file']));
      expect(reads.filter(line => line.locks !== '0')).toEqual([]);
      expect(lines.filter(line => line.sub === 'update-ref')).toEqual([{ locks: 'unset', sub: 'update-ref' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`classic byte-path parsing (${backend})`, () => {
    test('S-7: a non-UTF-8 name is held unsupported_path/not_utf8 under its encoded key; the sibling imports and the cursor reaches HEAD', async () => {
      await withClassic(databaseUrl, async r => {
        r.write(CAFE, md('latin1')); r.commitAll('odd');
        const obs = await observe(r, 'ok/healthy-1');
        expect({ thrown: obs.thrown, healthy: obs.healthy, cursorAtHead: obs.cursorAtHead, ledger: obs.ledger }).toEqual({ thrown: null, healthy: true, cursorAtHead: true, ledger: [] });
        const holds = await holdsOf(r);
        const hold = holds.find(h => h.code === 'unsupported_path');
        expectItemFailure(hold && { key: hold.path, code: hold.code }, { key: '/gbrain-bytes/notes/caf%E9.md', code: 'unsupported_path' });
        expect(hold!.meta.reason).toBe('not_utf8');
        expect(hold!.message).toContain('notes/caf\\351.md');
        expect(hold!.message).toContain(itemId(CAFE));
        expect(JSON.stringify(holds)).not.toContain('\ufffd');
        const item = gitHoldItem(hold!);
        expect(item.docs).toBe('docs/guides/write-refusals.md#unsupported_path-not_utf8');
        const fix = item.fix;
        for (const arg of [fix.argv, fix.verify?.argv, fix.then?.argv].flatMap(argv => argv ?? [])) expect(arg).not.toMatch(/notes\/caf|[^\x20-\x7e]/);
        expect(renderFix(fix)).toBe(`gbrain sources status ${r.sourceId} --json`);
        expect(fix.actor).toBe('user');
        expect(fix.user_message).toContain(itemId(CAFE));
        expect(fix.user_message).toContain("printf 'notes/caf\\351.md\\000'");
        expect(fix.then?.argv).toEqual(['gbrain', 'sync', '--source', r.sourceId, '--no-pull']);

        r.write('ok/healthy-2.md', md('healthy two')); r.commitAll('next');
        const again = await observe(r, 'ok/healthy-2');
        expect({ thrown: again.thrown, healthy: again.healthy, cursorAtHead: again.cursorAtHead, ledger: again.ledger }).toEqual({ thrown: null, healthy: true, cursorAtHead: true, ledger: [] });
        expect((await holdsOf(r)).map(h => [h.path, h.code])).toEqual([['/gbrain-bytes/notes/caf%E9.md', 'unsupported_path']]);
      });
    }, 120_000);

    test('S-2/S-3: tab and newline names are held unsupported_path/control_character, not skipped as malformed', async () => {
      await withClassic(databaseUrl, async r => {
        r.write('notes/tab\there.md', md('tab')); r.write('notes/line\nbreak.md', md('newline')); r.commitAll('odd');
        const obs = await observe(r, 'ok/healthy-1');
        expect({ thrown: obs.thrown, healthy: obs.healthy, cursorAtHead: obs.cursorAtHead, ledger: obs.ledger, malformed: obs.malformedSkipped ?? 0 })
          .toEqual({ thrown: null, healthy: true, cursorAtHead: true, ledger: [], malformed: 0 });
        const holds = (await holdsOf(r)).map(h => ({ path: h.path, code: h.code, reason: h.meta.reason })).sort((a, b) => a.path.localeCompare(b.path));
        expect(holds).toEqual([
          { path: '/gbrain-bytes/notes/line%0Abreak.md', code: 'unsupported_path', reason: 'control_character' },
          { path: '/gbrain-bytes/notes/tab%09here.md', code: 'unsupported_path', reason: 'control_character' },
        ]);
        const message = (await holdsOf(r)).find(h => h.path.endsWith('tab%09here.md'))!.message;
        expect(message).toContain('notes/tab\\there.md');
        expect(/[\x00-\x1f]/.test(message)).toBe(false);
      });
    }, 120_000);

    test('S-7: a later commit renaming the file to a valid name imports it and clears the hold', async () => {
      await withClassic(databaseUrl, async r => {
        r.write(CAFE, md('latin1')); r.commitAll('odd');
        await observe(r, 'ok/healthy-1');
        expect((await holdsOf(r)).map(h => h.code)).toEqual(['unsupported_path']);
        sh(r.root, "git mv -- \"$(printf 'notes/caf\\351.md')\" notes/cafe.md");
        r.commitAll('rename to a valid name');
        const obs = await observe(r, 'notes/cafe');
        expect({ thrown: obs.thrown, healthy: obs.healthy, cursorAtHead: obs.cursorAtHead, ledger: obs.ledger }).toEqual({ thrown: null, healthy: true, cursorAtHead: true, ledger: [] });
        expect(await holdsOf(r)).toEqual([]);
      });
    }, 120_000);

    test('S-23: a gitlink is reported once, in the run it appears, and never blocks', async () => {
      await withClassic(databaseUrl, async r => {
        const nested = join(r.root, 'nested'); mkdirSync(nested);
        gitIn(nested, 'init', '-q'); writeFileSync(join(nested, 'n.md'), md('n'));
        gitIn(nested, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'add', '-A');
        gitIn(nested, '-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'n');
        r.commitAll('gitlink');
        expect(gitIn(r.root, 'ls-files', '-s', 'nested')).toStartWith('160000 ');
        const first = await r.sync() as SyncResult & { gitlinks_not_followed?: string[] };
        expect(first.gitlinks_not_followed).toEqual(['nested']);
        expect({ cursorAtHead: await r.lastCommit() === r.head(), holds: await holdsOf(r) }).toEqual({ cursorAtHead: true, holds: [] });
        r.write('ok/healthy-2.md', md('healthy two')); r.commitAll('next');
        const second = await r.sync() as SyncResult & { gitlinks_not_followed?: string[] };
        expect(second.gitlinks_not_followed).toBeUndefined();
        expect(await pageAt(r.engine, r.sourceId, 'ok/healthy-2.md')).toBe('ok/healthy-2');
      });
    }, 120_000);

    test('S-1: a name with double quotes still imports', async () => {
      await withClassic(databaseUrl, async r => {
        r.write('notes/say "hi".md', md('quoted')); r.commitAll('odd');
        const obs = await observe(r, 'ok/healthy-1');
        expect({ thrown: obs.thrown, cursorAtHead: obs.cursorAtHead, ledger: obs.ledger }).toEqual({ thrown: null, cursorAtHead: true, ledger: [] });
        expect(await pageAt(r.engine, r.sourceId, 'notes/say "hi".md')).not.toBeNull();
        expect(await holdsOf(r)).toEqual([]);
      });
    }, 120_000);

    test('S-52: the parser keeps a trailing space; the name is not a Markdown file, so it is skipped like any other, and the cursor reaches HEAD', async () => {
      await withClassic(databaseUrl, async r => {
        r.write('notes/trail.md ', md('trail')); r.commitAll('odd');
        const { computeLosslessSyncDelta } = await import('../../src/core/sync-delta.ts');
        const delta = await computeLosslessSyncDelta(r.root, (await r.lastCommit())!, r.head());
        expect(delta.status === 'ok' && delta.manifest.added.sort()).toEqual(['notes/trail.md ', 'ok/healthy-1.md']);
        const obs = await observe(r, 'ok/healthy-1');
        expect({ thrown: obs.thrown, healthy: obs.healthy, cursorAtHead: obs.cursorAtHead, ledger: obs.ledger }).toEqual({ thrown: null, healthy: true, cursorAtHead: true, ledger: [] });
        expect(existsSync(join(r.root, 'notes/trail.md '))).toBe(true);
      });
    }, 120_000);
  });
}
