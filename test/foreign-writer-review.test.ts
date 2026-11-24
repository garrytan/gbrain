import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { foreignWriterReviewPlan, applyForeignWriterReview } from '../src/commands/sources-foreign-writer-review.ts';
import { foreignWritersEntry } from '../src/commands/doctor/checks/foreign-writers.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { installOwnerGuard, ownerGuardStatus, uninstallOwnerGuard } from '../src/core/git/commit-guard.ts';
import { recordCommit } from '../src/core/git/commit-ledger.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-foreign-review-'));
const repo = join(root, 'repo');
const identity = { GIT_AUTHOR_NAME: 'Alice Example', GIT_AUTHOR_EMAIL: 'alice-example@example.invalid', GIT_COMMITTER_NAME: 'Alice Example', GIT_COMMITTER_EMAIL: 'alice-example@example.invalid' };
const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let engine: PGLiteEngine;
const doctor = async (): Promise<Check> => ((await foreignWritersEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext)) as Check[])[0]!;

beforeAll(async () => {
  mkdirSync(repo); git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Alice Example']); git(['config', 'user.email', 'alice-example@example.invalid']);
  writeFileSync(join(repo, 'seed.md'), 'seed\n'); git(['add', 'seed.md']); git(['commit', '-q', '-m', 'seed']);
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES ('reviewed','Reviewed',$1)`, [repo]);
  writeFileSync(join(repo, 'ledger.md'), 'ledger\n'); git(['add', 'ledger.md']); git(['commit', '-q', '-m', 'ledger start']); recordCommit(repo, { sha: git(['rev-parse', 'HEAD']), writer: 'commit_push' });
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

test('reviewed historical commits warn only with an active enforce guard; new or unguarded commits still fail', async () => {
  writeFileSync(join(repo, 'old.md'), 'old\n'); git(['add', 'old.md']); git(['commit', '-q', '-m', 'historical foreign']);
  const historical = git(['rev-parse', 'HEAD']);
  installOwnerGuard(repo, 'enforce');
  const reason = 'historical owner-reviewed evidence retained $(echo not-executed)';
  const plan = await foreignWriterReviewPlan(engine, { sourceId: 'reviewed', shas: [historical], reason });
  expect(plan.apply_command).toContain("--reason 'historical owner-reviewed evidence retained $(echo not-executed)'");
  await applyForeignWriterReview(engine, { sourceId: 'reviewed', shas: [historical], reason, expect: plan.plan_hash });
  let check = await doctor();
  expect(check.status).toBe('warn');
  expect(check.details!.contained_count).toBe(1);
  expect(check.message).toContain('reviewed historical foreign commit');

  const hooksPath = dirname(ownerGuardStatus(repo).hook);
  git(['config', '--worktree', 'core.hooksPath', '/dev/null']);
  check = await doctor();
  expect(check.status).toBe('fail');
  expect((check.details! as { foreign: Array<{ sha: string }> }).foreign.map(c => c.sha)).toContain(historical);
  git(['config', '--worktree', 'core.hooksPath', hooksPath]);
  expect((await doctor()).status).toBe('warn');

  uninstallOwnerGuard(repo);
  check = await doctor();
  expect(check.status).toBe('fail');
  expect((check.details! as { foreign: Array<{ sha: string }> }).foreign.map(c => c.sha)).toContain(historical);
  installOwnerGuard(repo, 'enforce');

  writeFileSync(join(repo, 'new.md'), 'new\n'); git(['add', 'new.md']); git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'new bypass']);
  const newer = git(['rev-parse', 'HEAD']);
  check = await doctor();
  expect(check.status).toBe('fail');
  const details = check.details! as { foreign: Array<{ sha: string }>; contained: Array<{ sha: string }> };
  expect(details.foreign.map(c => c.sha)).toEqual([newer]);
  expect(details.contained.map(c => c.sha)).toEqual([historical]);

  await expect(applyForeignWriterReview(engine, { sourceId: 'reviewed', shas: [newer], reason: 'must not apply stale preview', expect: plan.plan_hash })).rejects.toMatchObject({ code: 'preview_changed' });
}, 60_000);
