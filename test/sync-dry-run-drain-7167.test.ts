/**
 * #7167: `foresights sync --dry-run` on a large managed source sat for five minutes and then failed `partial` / `writer_pending`
 * with `drain_stalled` (`no_progress`). The CLI runs a sync as a drain, and the drain's governor stops a pass that commits
 * nothing for five minutes; a dry run commits nothing by design, so a long read of a big source was abandoned as a writer
 * stall. A dry run now previews once, outside the drain, and reports the writer's open requests as a field instead of
 * waiting on them.
 *
 * The governor's five minutes are reached here by a clock that runs 20,000 times faster than real time while the dry run
 * reads (the drain reads `Date.now`); the dry run itself never reads the clock for a decision. On Postgres, master
 * reproduced the report exactly (`partial`, `writer_pending`, `drain_stalled`, `no_progress`); on PGLite the governor's
 * head read queues behind the dry run's own statements, so there master returned the preview with a drain report.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync/perform.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); };
const note = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\nA synthetic observation about ${title}.\n`;
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  for (let d = 0; d < 4; d++) {
    mkdirSync(join(root, `notes-${d}`), { recursive: true });
    for (let i = 0; i < 60; i++) writeFileSync(join(root, `notes-${d}/n${i}.md`), note(`notes-${d}/n${i}`));
  }
  commit(root);
};

let clock: { mockRestore(): void } | null = null;
afterEach(() => { clock?.mockRestore(); clock = null; });

for (const backend of testBackends()) test(`[${backend}] a dry run on the drain path is never abandoned as a writer stall: it previews, reports the writer state, and returns`, () => managedBrain(async ({ engine }) => {
  const real = Date.now.bind(Date), start = real();
  clock = spyOn(Date, 'now').mockImplementation(() => start + (real() - start) * 20_000);
  let result;
  try {
    result = await performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, dryRun: true, drain: true, governMs: 10 });
  } finally { clock.mockRestore(); clock = null; }
  expect(result.status).toBe('dry_run');
  expect(result.reason).toBeUndefined();
  expect(result.drain).toBeUndefined();
  expect(result.writer).toEqual({ open_requests: 0, oldest_open_age_seconds: null, next: ['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json'] });
  expect(Number((await engine.executeRaw<{ n: number | string }>("SELECT count(*) AS n FROM pages WHERE source_id='default'"))[0]!.n)).toBe(0);
}, { setup, ...(backend === 'postgres' ? { databaseUrl: process.env.DATABASE_URL } : {}) }), 240_000);
