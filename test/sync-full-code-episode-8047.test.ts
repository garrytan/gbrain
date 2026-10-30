import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSources } from '../src/commands/sources.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  for (const [path, text] of [['src/alpha.ts', 'export const alpha = 1;\n'], ['src/beta.py', 'beta = 2\n']]) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test', 'commit', '-qm', 'code files');
};

test('a fresh read-only code source settles its full sync', () => managedBrain(async ({ engine }) => {
  await runSources(engine, ['set-strategy', 'default', 'code']);
  await runSources(engine, ['mirror-readonly', 'default']);
  const outcome = await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, full: true })
    .then(result => ({ status: result.status, reason: result.reason }), error => ({ thrown: error instanceof Error ? error.name : String(error) }));

  expect('status' in outcome && (outcome.status === 'first_sync' || outcome.status === 'synced')).toBe(true);
}, { setup }), 120_000);
