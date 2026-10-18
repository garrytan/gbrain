/**
 * #5182 — `writer activate` names every filesystem source whose Git effects it
 * would leave skipped.
 *
 * Protects: the activation report (dry run and real run) carries one
 * `git_durability_not_enabled` warning per source whose owner will not commit
 * or push page writes, decided by the effect runner's own policy (a recorded
 * setting wins; with nothing recorded the legacy harden hook decides), with a
 * read-only `git-durability --enable --dry-run` fix that says enabling
 * re-queues the skipped effects; a person sees the same warnings on stderr.
 * Activation still proceeds.
 * Fails when: activation goes back to a silent `git_durability` listing only
 * (no warnings), warns on a source whose hook makes it durable, or refuses.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree, managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdminCli } from '../src/commands/persistence-admin.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { gitAsync } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

/** Four claimed git roots: no hook, a legacy harden hook, recorded disabled, recorded enabled. */
async function fixture(run: (ids: { bare: string; hooked: string; off: string; on: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-activate-5182-'));
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await disposePersistenceConsumer(engine); await resetPgliteState(engine); await engine.setConfig('version', schemaVersion);
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
      const tag = randomUUID().slice(0, 8);
      const ids = { bare: `bare-${tag}`, hooked: `hooked-${tag}`, off: `off-${tag}`, on: `on-${tag}` };
      for (const [kind, id] of Object.entries(ids)) {
        const root = join(home, kind); mkdirSync(root);
        await gitAsync(root, 'init', '-q', '-b', 'main');
        if (kind === 'hooked') {
          const hook = join(root, '.git', 'hooks', 'post-commit');
          writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(hook, 0o755);
        }
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
        const binding = await claimWorktree(engine, id, root, localHostId());
        if (kind === 'off' || kind === 'on') {
          await engine.executeRaw('UPDATE persistence_host_bindings SET git_durability=$1 WHERE worktree_id=$2::uuid',
            [kind === 'on' ? 'enabled' : 'disabled', binding.worktree_id]);
        }
      }
      try { await run(ids); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

function expectWarnings(report: Awaited<ReturnType<typeof activatePersistence>>, ids: { bare: string; off: string }): void {
  const warnings = report.warnings ?? [];
  expect(warnings.map(w => [w.source_id, w.state]).sort()).toEqual([[ids.bare, 'unknown'], [ids.off, 'off']].sort());
  for (const warning of warnings) {
    expect(warning.code).toBe('git_durability_not_enabled');
    expect(warning.enable_command).toBe(`gbrain sources writer git-durability ${warning.source_id} --enable --dry-run`);
    expect(warning.message).toContain('re-queues the Git effects skipped');
    expect(warning.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'git-durability', warning.source_id, '--enable', '--dry-run', '--json']);
    expect(warning.fix.consent).toEqual([]);
    expect(warning.fix.verify?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', warning.source_id, '--json']);
  }
}

test('dry run and real activation warn for the sources whose Git effects would be skipped, and activation proceeds', () => fixture(async ids => {
  const preview = await activatePersistence(engine, { confirmQuiesced: true, dryRun: true });
  expect(preview).toMatchObject({ enabled: false, activated: false, filesystem_sources: 4 });
  expectWarnings(preview, ids);
  const applied = await activatePersistence(engine, { confirmQuiesced: true });
  expect(applied).toMatchObject({ enabled: true, activated: true, filesystem_sources: 4 });
  expectWarnings(applied, ids);
  expect(await managedPersistenceEnabled(engine)).toBe(true);
}), 120_000);

test('a person sees each warning on stderr; --json keeps stderr clean', () => fixture(async ids => {
  const capture = async (args: string[]) => {
    let stderr = '';
    const write = process.stderr.write, out = process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try { await runPersistenceAdminCli('writer', args, engine); } finally { process.stderr.write = write; process.stdout.write = out; }
    return stderr;
  };
  const human = await capture(['activate', '--confirm-quiesced', '--dry-run']);
  expect(human).toContain(`warning: Source ${ids.bare}: Git durability is not recorded and no harden post-commit hook is installed`);
  expect(human).toContain(`warning: Source ${ids.off}: Git durability is disabled on its binding`);
  expect(human).not.toContain(ids.hooked);
  expect(human).not.toContain(ids.on);
  expect(await capture(['activate', '--confirm-quiesced', '--dry-run', '--json'])).not.toContain('warning:');
}), 120_000);
