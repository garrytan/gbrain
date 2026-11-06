import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSources } from '../src/commands/sources.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const log = console.log; console.log = () => {};
  try { return await run(); } finally { console.log = log; }
};
const files: Array<[string, string]> = [['src/alpha-example.ts', 'export const alpha = 1;\n'], ['src/beta-example.py', 'beta = 2\n'], ['lib/gamma-example.go', 'package lib\n']];

// Value: protects=a first `sync --full` on a code-strategy source settles in one pass, each code file imported once (#8047);
//   fails_when=a code import's provenance stops recording the open full episode, so every round re-imports the same files and
//   the pass ends partial / not_converged (then settle_mismatch holds after three passes); why_new=the full-episode tests
//   cover Markdown imports only, whose provenance records the episode on its own path; seam=none; no_claim=image imports
//   (same provenance helper, not exercised here) or a Postgres brain (PGLite only)
test('#8047: sync --full on a fresh code-strategy source converges in one pass', () => managedBrain(async ({ engine }) => {
  await quiet(() => runSources(engine, ['set-strategy', 'default', 'code']));
  const result = await quiet(() => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, full: true }));
  expect({ status: result.status, reason: result.reason ?? null, imported: result.filesImported, outcome: result.pass?.outcome, remaining: result.pass?.remaining })
    .toEqual({ status: 'first_sync', reason: null, imported: files.length, outcome: 'synced', remaining: 0 });
  const again = await quiet(() => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true }));
  expect({ status: again.status, outcome: again.pass?.outcome ?? null }).toMatchObject({ status: 'up_to_date' });
}, { setup: ({ root }) => {
  git(root, 'init', '-q');
  for (const [path, text] of files) { mkdirSync(join(root, dirname(path)), { recursive: true }); writeFileSync(join(root, path), text); }
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'code files');
} }), 180_000);
