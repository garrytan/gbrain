import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { releaseCorpusClaim } from '../src/core/sweep-claim-cleanup.ts';

test('preserving a released claim moves it to Trash and never unlinks', async () => {
  const calls: unknown[][] = [];
  const io = {
    mkdir: async (...args: unknown[]) => { calls.push(['mkdir', ...args]); },
    rename: async (...args: unknown[]) => { calls.push(['rename', ...args]); },
    rm: async () => { throw new Error('unlink forbidden'); },
  };
  expect(await releaseCorpusClaim('/private/corpus/file.in-progress', true, io as any)).toBe(true);
  expect(calls[0]).toEqual(['mkdir', join(homedir(), '.Trash'), { recursive: true, mode: 0o700 }]);
  expect(calls[1][0]).toBe('rename');
  expect(calls[1][1]).toBe('/private/corpus/file.in-progress');
  expect(String(calls[1][2]).startsWith(join(homedir(), '.Trash', 'gbrain-corpus-claim-'))).toBe(true);
});

test('a failed preservation retains the claim rather than falling back to unlink', async () => {
  let removed = false;
  const io = { mkdir: async () => {}, rename: async () => { throw new Error('refused'); },
    rm: async () => { removed = true; } };
  expect(await releaseCorpusClaim('/private/claim', true, io as any)).toBe(false);
  expect(removed).toBe(false);
});

test('ordinary native cleanup stays compatible when preservation is not selected', async () => {
  const calls: unknown[][] = [];
  const io = { mkdir: async () => { throw new Error('unexpected'); },
    rename: async () => { throw new Error('unexpected'); },
    rm: async (...args: unknown[]) => { calls.push(args); } };
  expect(await releaseCorpusClaim('/private/claim', false, io as any)).toBe(true);
  expect(calls).toEqual([['/private/claim', { force: true }]]);
});

import { acquireCorpusClaim } from '../src/core/sweep.ts';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { withEnv } from './helpers/with-env.ts';
test('native stale-claim reacquisition preserves the previous bytes when selected', async () => {
  const realHome = homedir();
  const dir = mkdtempSync(join(tmpdir(), 'stale-claim-proof-'));
  const claim = join(dir, 'synthetic.in-progress');
  const previous = 'synthetic predecessor claim ' + randomUUID();
  const claimTrash = join(realHome, '.Trash');
  const before = new Set(existsSync(claimTrash) ? readdirSync(claimTrash) : []);
  writeFileSync(claim, previous);
  utimesSync(claim, new Date('2000-01-01'), new Date('2000-01-01'));
  try {
    await withEnv({ GBRAIN_SWEEP_PRESERVE_CLAIMS: '1' }, async () => {
      expect(await acquireCorpusClaim(claim)).toBe(true);
      expect(JSON.parse(readFileSync(claim, 'utf8')).pid).toBe(process.pid);
      const preserved = readdirSync(claimTrash).filter(name => !before.has(name) && name.startsWith('gbrain-corpus-claim-'));
      expect(preserved).toHaveLength(1);
      expect(readFileSync(join(claimTrash, preserved[0]), 'utf8')).toBe(previous);
    });
  } finally {
    const trash = join(realHome, '.Trash'); mkdirSync(trash, { recursive: true });
    renameSync(dir, join(trash, 'stale-claim-proof-' + randomUUID()));
  }
});
