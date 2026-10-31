/**
 * #5206: writer activation with a source whose recorded local_path vanished is
 * a named `source_changed` blocker (detail `source_path_missing`) naming the
 * source, the missing path and the exits (`sources set-path`, `sources
 * remove`), in --dry-run too, instead of a bare ENOENT from lstat.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree, managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runSetPath } from '../src/commands/sources-set-path.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { flagRejection, gbrainInvocations, liveCliVerbs } from './helpers/cli-command-surface.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

/** O-DX-2: each `gbrain …` command the prose hint names resolves and parses with the real CLI's flags. */
function expectRunnableFix(fix: string) {
  const invocations = [...fix.matchAll(/gbrain [^,;]+/g)].flatMap(m => gbrainInvocations(m[0].replace(/\.$/, '')));
  expect(invocations.length).toBeGreaterThan(1);
  for (const inv of invocations) {
    expect(liveCliVerbs().has(inv.verb)).toBe(true);
    expect(flagRejection(inv)).toBeNull();
  }
}

async function fixture(run: (home: string, live: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-activation-missing-'));
  const live = join(home, 'live'); mkdirSync(live);
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await disposePersistenceConsumer(engine); await resetPgliteState(engine); await engine.setConfig('version', schemaVersion);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['live-example', live]);
      await claimWorktree(engine, 'live-example', live);
      await run(home, live);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('an unclaimed source whose recorded directory vanished blocks activation by name, dry run included', () => fixture(async home => {
  const gone = join(home, 'vanished-temp');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['stale-example', gone]);
  for (const dryRun of [true, false]) {
    const error = await activatePersistence(engine, { confirmQuiesced: true, dryRun }).catch(e => e);
    expect(error).toMatchObject({ code: 'source_changed', detail: 'source_path_missing', docs: 'docs/guides/write-refusals.md#activation_source_path_missing' });
    expect(error.message).toContain(`Source 'stale-example' records the local path ${gone}`);
    expect(error.message).not.toContain('ENOENT');
    expect(error.suggestion).toContain('gbrain sources set-path stale-example <directory>');
    expect(error.suggestion).toContain('gbrain sources remove stale-example --confirm-destructive');
    expectRunnableFix(error.suggestion);
  }
  expect(await managedPersistenceEnabled(engine)).toBe(false);
}), 60_000);

test('a claimed source whose recorded local_path vanished names its claimed checkout, and the printed set-path clears the blocker', () => fixture(async home => {
  const claimed = join(home, 'claimed'); mkdirSync(claimed);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['default-example', claimed]);
  await claimWorktree(engine, 'default-example', claimed);
  const gone = join(home, 'tmp-vanished');
  await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', ['default-example', gone]);
  for (const dryRun of [true, false]) {
    const error = await activatePersistence(engine, { confirmQuiesced: true, dryRun }).catch(e => e);
    expect(error).toMatchObject({ code: 'source_changed', detail: 'source_path_missing' });
    expect(error.message).toContain(`Source 'default-example' records the local path ${gone}`);
    expect(error.suggestion).toContain(`gbrain sources set-path default-example ${JSON.stringify(claimed)}`);
    expectRunnableFix(error.suggestion);
  }
  const log = console.log; console.log = () => {};
  try { await runSetPath(engine, ['default-example', claimed]); } finally { console.log = log; }
  expect(await activatePersistence(engine, { confirmQuiesced: true, dryRun: true })).toMatchObject({ enabled: false, activated: false, filesystem_sources: 2 });
}), 60_000);

// /ship coverage audit (GBRA-207, #7630).
// Value: protects=a claimed source whose recorded local_path is relative (".") blocks activation as source_path_missing naming
//   the relative path and its claimed checkout, never resolving "." against the process cwd; fails_when=the owner-host branch
//   drops its isAbsolute guard, so "." resolves to the cwd and activation reports source_changed (or matches a cwd checkout);
//   why_new=the 7630 suite covers only the unclaimed branch (no binding); seam=none; no_claim=a Postgres brain (PGLite only)
test('#7630: a claimed source whose recorded local_path is relative names the relative path and its claimed checkout', () => fixture(async home => {
  const claimed = join(home, 'claimed'); mkdirSync(claimed);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['default-example', claimed]);
  await claimWorktree(engine, 'default-example', claimed);
  await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id=$1", ['default-example']);
  for (const dryRun of [true, false]) {
    const error = await activatePersistence(engine, { confirmQuiesced: true, dryRun }).catch(e => e);
    expect(error).toMatchObject({ code: 'source_changed', detail: 'source_path_missing' });
    expect(error.message).toContain("Source 'default-example' records the relative local path .");
    expect(error.suggestion).toContain(`gbrain sources set-path default-example ${JSON.stringify(claimed)}`);
  }
  expect(await managedPersistenceEnabled(engine)).toBe(false);
}), 60_000);
