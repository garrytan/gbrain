/**
 * GBRA-133: a hardened Git stream whose last chunk the caller still holds when the stream closes (a level read pausing
 * at its loop budget) must leave nothing behind once it settled. Before, the held chunk's settle re-armed the
 * exited-stdout idle timer after the read had already ended, and that timer held the read (its `onChunk`, and through it
 * the pass that read) for five more seconds: test/sync-tree-reuse-gbra133.test.ts's collectability checks failed under load.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenedGitStream } from '../src/core/hardened-git.ts';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-held-chunk-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args]);
  git('init', '-q', '-b', 'main');
  for (let i = 0; i < 50; i++) writeFileSync(join(root, `note-${i}.md`), `note ${i}\n`);
  git('add', '-A'); git('commit', '-qm', 'notes');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function collectGarbage(): Promise<void> {
  for (let round = 0; round < 3; round++) { await Bun.sleep(0); Bun.gc(true); }
}

/** One read whose every chunk the caller holds until the stream has settled, as a paused level read's last chunk can be. */
async function heldRead(refs: Array<WeakRef<object>>): Promise<boolean> {
  const read = { chunks: 0 };
  refs.push(new WeakRef(read));
  const releases: Array<() => void> = [];
  const result = hardenedGitStream(root, ['ls-tree', '-r', '-z', 'HEAD'], { timeoutMs: 60_000,
    onChunk: () => { read.chunks++; return new Promise<void>(resolve => { releases.push(resolve); }); } });
  while (!releases.length) await Bun.sleep(5);
  let settled = false;
  void result.then(() => { settled = true; });
  for (let waited = 0; !settled && waited < 3_000; waited += 10) await Bun.sleep(10);
  const settledFirst = settled;
  for (const release of releases) release();
  await result;
  return settledFirst;
}

test('a chunk held past the stream close leaves nothing holding the read once it settled', async () => {
  const refs: Array<WeakRef<object>> = [];
  const settledFirst = [await heldRead(refs), await heldRead(refs), await heldRead(refs)];
  // Bun settles the stream while the caller still holds its chunk: the case under test.
  expect(settledFirst).toEqual([true, true, true]);
  await collectGarbage();
  expect(refs.map(ref => ref.deref() === undefined)).toEqual([true, true, true]);
});
