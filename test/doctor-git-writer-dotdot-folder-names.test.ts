/**
 * Doctor `commits_outside_source_root` compares unpushed commits with the source roots of a checkout. It recorded a
 * source root as the whole checkout whenever `relative(checkoutTop, sourceRoot)` started with `..`, which also matches a
 * source folder named `..x`, so a local commit that changed files outside that folder was never reported.
 * Protects: a source folder named `..x` is the root, so a commit that changed `other.md` or a sibling folder `..xy`
 * (shares the name prefix) is reported as outside it, while a commit only inside `..x` is not, as with a folder named `notes`.
 * Authoring gate: (1) which unpushed commits doctor reports as outside the source root; (2) a startsWith('..') check that
 * is not component-aware; (3) doctor-git-writer-7381.test.ts only registers a source folder named `brain`; (4) no seam,
 * the real doctor entry on in-memory PGLite and real git repositories with a bare upstream. A source root outside its
 * checkout cannot be registered here (the checkout is found from the root itself), so that escape case has no test.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { gitWriterEntry } from '../src/commands/doctor/checks/git-writer.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-writer-dotdot-')));
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (root: string, rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
let n = 0;

/** A checkout with an upstream and committed seed files in `<folder>`, `<folder>y` (shares the name prefix) and at the root. */
function checkout(folder: string): string {
  const bare = join(dir, `origin-${n}.git`), work = join(dir, `work-${n++}`);
  git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, ['clone', '-q', bare, work]);
  git(work, ['config', 'user.email', 'writer@example.invalid']); git(work, ['config', 'user.name', 'Example Writer']); git(work, ['config', 'commit.gpgsign', 'false']);
  for (const path of [`${folder}/seed.md`, `${folder}y/seed.md`, 'other.md']) write(work, path, 'seed\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'seed']); git(work, ['push', '-q', '-u', 'origin', 'main']);
  return work;
}
const outside = async (): Promise<Check> => {
  const checks = (await gitWriterEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext)) as Check[];
  return checks.find(c => c.name === 'commits_outside_source_root')!;
};
type Found = { roots: string[]; commits: Array<{ paths: string[] }> };

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'"); });

for (const folder of ['..x', 'notes']) {
  test(`a source folder named ${folder}: an unpushed commit outside it is reported, one inside it is not`, async () => {
    const work = checkout(folder);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source', join(work, folder)]);
    write(work, `${folder}/seed.md`, 'edited inside the source root\n');
    git(work, ['commit', '-q', '-am', 'inside the source root']);
    expect((await outside()).status).toBe('ok');

    write(work, 'other.md', 'swept\n'); write(work, `${folder}y/seed.md`, 'swept too\n');
    git(work, ['commit', '-q', '-am', 'cron: swept']);
    const check = await outside();
    expect(check.status).toBe('warn');
    const [found] = (check.details as { checkouts: Found[] }).checkouts;
    expect(found!.roots).toEqual([folder]);
    expect(found!.commits.map(c => [...c.paths].sort())).toEqual([[`${folder}y/seed.md`, 'other.md'].sort()]);
  }, 60_000);
}
