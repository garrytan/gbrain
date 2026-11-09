/** #9024: committed sync content is read through git's smudge filters (git-crypt, git-lfs), not as the stored blob. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSyncContent, type SyncDiscovery, type SyncEntry } from '../src/core/persistence/sync-discovery.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

describe('#9024: readSyncContent applies smudge filters', () => {
  test('a committed file is returned smudged', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-smudge-'));
    try {
      git(root, 'init', '-q');
      git(root, 'config', 'filter.upper.clean', 'cat');
      git(root, 'config', 'filter.upper.smudge', 'tr a-z A-Z');
      writeFileSync(join(root, '.gitattributes'), '*.md filter=upper\n');
      writeFileSync(join(root, 'note.md'), 'stored form\n');
      git(root, 'add', '-A');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'init');
      const discovery = { root, gitRoot: root, target: 'HEAD' } as unknown as SyncDiscovery;
      const entry = { path: 'note.md', working: false } as unknown as SyncEntry;
      let outcome: string;
      try { outcome = readSyncContent(discovery, entry); } catch (e) { outcome = `error: ${(e as Error).message}`; }
      expect(outcome).toBe('STORED FORM\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
