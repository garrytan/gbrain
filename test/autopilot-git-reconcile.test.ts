/**
 * Autopilot reconciles Git checkouts in a bounded child: the daemon's event loop keeps running (lease renewals,
 * heartbeat) while the child fetches and pushes, a refusal comes back as a log line, and a hung child is killed.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileGitInChild } from '../src/commands/autopilot-git-reconcile.ts';
import { withEnv } from './helpers/with-env.ts';

let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'autopilot-git-reconcile-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeCli(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test('the event loop keeps ticking while the reconcile child runs, and a publish is logged', async () => {
  const cli = fakeCli('slow.sh', `[ "$1 $2 $3" = "sources git-reconcile --json" ] || exit 9
sleep 2
echo '{"results":[{"sources":["source-a"],"root":"/r","status":"published"},{"sources":["source-b"],"root":"/s","status":"in_sync"}],"exit":0}'`);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 50);
  const started = Date.now();
  const outcome = await withEnv({ GBRAIN_JOB_CHILD_CLI: cli }, () => reconcileGitInChild()).finally(() => clearInterval(timer));
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  expect(ticks).toBeGreaterThanOrEqual(25);
  expect(outcome).toEqual({ ok: true, exit: 0, lines: ['source-a: published'] });
}, 30_000);

test('a refusal that needs the user is reported, not thrown', async () => {
  const cli = fakeCli('refuse.sh', `echo '{"results":[{"sources":["source-a"],"root":"/r","status":"needs_user","error":{"code":"publish_secret_found","message":"a secret"}}],"exit":1}'
exit 1`);
  expect(await withEnv({ GBRAIN_JOB_CHILD_CLI: cli }, () => reconcileGitInChild()))
    .toEqual({ ok: false, exit: 1, lines: ['source-a: needs_user publish_secret_found: a secret'] });
}, 30_000);

test('a child that hangs past the bound is killed and reported', async () => {
  const cli = fakeCli('hang.sh', 'exec sleep 30');
  const started = Date.now();
  const outcome = await withEnv({ GBRAIN_JOB_CHILD_CLI: cli }, () => reconcileGitInChild(500));
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(outcome.ok).toBe(false);
  expect(outcome.lines[0]).toStartWith('sources git-reconcile ');
}, 30_000);
