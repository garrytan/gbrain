/**
 * Safe whole-skill updates of installed skillpacks (GBRA-225 PR 3):
 * src/core/skillpack/{safe-update,update-journal,state,file-lock}.ts, the
 * `skillpack_update_incomplete` doctor check and the CLI exit-code contract.
 *
 * Every case runs on real files in temp dirs outside any git repository
 * (repo-less brains are first class), with its own state file and backups
 * dir (or an isolated GBRAIN_HOME for the spawned CLI).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';

import { runScaffold } from '../src/core/skillpack/scaffold.ts';
import {
  DIFF_LINE_CAP, recordScaffoldBases, runSkillpackRestore, runSkillpackUpdate, setSkillPinned, skillsRootKey, type UpdateOptions,
} from '../src/core/skillpack/safe-update.ts';
import { listJournals, sha256 } from '../src/core/skillpack/update-journal.ts';
import { loadState, saveState } from '../src/core/skillpack/state.ts';
import {
  SKILLS_LOCK_HISTORY_FILENAME, SKILLS_MANIFEST_FILENAME, computeSkillsManifest, droppedHistoryEntries, loadVerifiedSkillsLockHistory,
  mergeSkillsLockHistory, parseSkillsLockHistory, renderSkillsLockHistory, renderSkillsManifest,
} from '../src/core/skills-integrity.ts';
import { runSkillpackUpdateChecks } from '../src/commands/doctor/checks/skillpack-update.ts';

const REPO = join(import.meta.dir, '..');
const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

const skill = (name: string, body: string) => `---\nname: ${name}\ntriggers:\n  - run the ${name} flow\n---\n# ${name}\n\n${body}\n`;
const V1 = { 'demo/SKILL.md': skill('demo', 'v1'), 'demo/references/notes.md': 'notes v1\n', 'other/SKILL.md': skill('other', 'v1') };
const V2 = { 'demo/SKILL.md': skill('demo', 'v2'), 'demo/references/notes.md': 'notes v2\n', 'other/SKILL.md': skill('other', 'v2') };
const V3 = { 'demo/SKILL.md': skill('demo', 'v3'), 'demo/references/notes.md': 'notes v3\n', 'other/SKILL.md': skill('other', 'v3') };

/** Write a bundle release: files, then the history (append-only) and the lock, as scripts/generate-skills-manifest.ts does. */
function release(gbrainRoot: string, files: Record<string, string>): void {
  const skillsDir = join(gbrainRoot, 'skills');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(skillsDir, rel)), { recursive: true });
    writeFileSync(join(skillsDir, rel), body);
  }
  const historyPath = join(skillsDir, SKILLS_LOCK_HISTORY_FILENAME);
  const previous = existsSync(historyPath) ? parseSkillsLockHistory(readFileSync(historyPath, 'utf-8')) : null;
  writeFileSync(historyPath, renderSkillsLockHistory(mergeSkillsLockHistory(previous, computeSkillsManifest(skillsDir))));
  writeFileSync(join(skillsDir, SKILLS_MANIFEST_FILENAME), renderSkillsManifest(skillsDir));
}

interface Env { gbrainRoot: string; ws: string; home: string; statePath: string; backups: string; skillsRoot: string }

function setup(): Env {
  const gbrainRoot = tmp('sp-safe-gbrain-');
  mkdirSync(join(gbrainRoot, 'src'), { recursive: true });
  writeFileSync(join(gbrainRoot, 'src', 'cli.ts'), '// stub\n');
  writeFileSync(join(gbrainRoot, 'openclaw.plugin.json'), JSON.stringify({ name: 'gbrain-test', version: '0.0.1', skills: ['skills/demo', 'skills/other'], shared_deps: [] }));
  release(gbrainRoot, V1);
  const ws = tmp('sp-safe-ws-');
  const home = tmp('sp-safe-home-');
  const gb = join(home, '.gbrain');
  return { gbrainRoot, ws, home, statePath: join(gb, 'skillpack-state.json'), backups: join(gb, 'skillpack-backups'), skillsRoot: skillsRootKey(join(ws, 'skills')) };
}

async function scaffold(env: Env, opts: { record?: boolean } = {}): Promise<void> {
  const result = runScaffold({ gbrainRoot: env.gbrainRoot, targetWorkspace: env.ws, skillSlug: null });
  if (opts.record !== false) await recordScaffoldBases(join(env.ws, 'skills'), result.files, { statePath: env.statePath });
}

function update(env: Env, extra: Partial<UpdateOptions> = {}) {
  return runSkillpackUpdate({ gbrainRoot: env.gbrainRoot, skillsRoot: env.skillsRoot, slugs: null, statePath: env.statePath, backups: env.backups, validate: () => [], ...extra });
}

const read = (env: Env, rel: string) => readFileSync(join(env.ws, 'skills', rel), 'utf-8');
const write = (env: Env, rel: string, body: string) => writeFileSync(join(env.ws, 'skills', rel), body);
const outcome = (result: Awaited<ReturnType<typeof update>>, slug: string) => result.skills.find(s => s.slug === slug)!;

describe('base recording and whole-skill update', () => {
  test('scaffold records bases; an untouched skill updates whole, journaled; a second run is a no-op (repo-less)', async () => {
    const env = setup();
    expect(spawnSync('git', ['-C', env.ws, 'rev-parse', '--git-dir']).status).not.toBe(0);
    await scaffold(env);
    const record = loadState({ statePath: env.statePath }).roots![env.skillsRoot]!.demo!;
    expect(record.files['demo/SKILL.md']).toBe(sha256(V1['demo/SKILL.md']));
    release(env.gbrainRoot, V2);

    const preview = await update(env, { dryRun: true });
    expect(outcome(preview, 'demo').result).toBe('would_update');
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);
    expect(existsSync(env.backups)).toBe(false);

    const result = await update(env);
    expect(result.summary).toMatchObject({ updated: 2, failed: 0, skipped: 0 });
    expect(read(env, 'demo/references/notes.md')).toBe(V2['demo/references/notes.md']);
    const [journal] = listJournals(env.backups);
    expect(journal!.status).toBe('complete');
    expect(journal!.skills.every(s => s.status === 'committed')).toBe(true);
    expect(loadState({ statePath: env.statePath }).roots![env.skillsRoot]!.demo!.files['demo/SKILL.md']).toBe(sha256(V2['demo/SKILL.md']));
    expect(readdirNames(env.skillsRoot).filter(n => n.startsWith('.gbrain-skillpack'))).toEqual([]);

    const again = await update(env);
    expect(again.summary.current).toBe(2);
    expect(again.journal).toBeNull();
  });

  test('base precedence: a file that differs from its base is local_edits even when it equals a released version', async () => {
    const env = setup();
    release(env.gbrainRoot, V2);
    await scaffold(env); // base = v2
    write(env, 'demo/SKILL.md', V1['demo/SKILL.md']); // a past release, not the base
    release(env.gbrainRoot, V3);
    const result = await update(env, { acceptHistorical: true });
    expect(outcome(result, 'demo')).toMatchObject({ result: 'skipped', reason: 'local_edits' });
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);
    expect(read(env, 'demo/references/notes.md')).toBe(V2['demo/references/notes.md']);
    expect(outcome(result, 'other').result).toBe('updated');
  });

  test('a file with no base that matches only a released version needs --accept-historical', async () => {
    const env = setup();
    await scaffold(env, { record: false }); // an install from before bases were recorded
    release(env.gbrainRoot, V2);
    const without = await update(env);
    expect(outcome(without, 'demo')).toMatchObject({ result: 'skipped', reason: 'historical_only' });
    expect(outcome(without, 'demo').historical.sort()).toEqual(['demo/SKILL.md', 'demo/references/notes.md']);
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);

    const withFlag = await update(env, { acceptHistorical: true });
    expect(outcome(withFlag, 'demo').result).toBe('updated');
    expect(read(env, 'demo/SKILL.md')).toBe(V2['demo/SKILL.md']);
    expect(loadState({ statePath: env.statePath }).roots![env.skillsRoot]!.demo!.files['demo/SKILL.md']).toBe(sha256(V2['demo/SKILL.md']));
  });

  test('a history that fails its lock hash disables whole-file updates (history_unverified)', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    appendFileSync(join(env.gbrainRoot, 'skills', SKILLS_LOCK_HISTORY_FILENAME), ' ');
    const result = await update(env);
    expect(result.history.verified).toBe(false);
    expect(outcome(result, 'demo')).toMatchObject({ result: 'skipped', reason: 'history_unverified' });
    expect(result.summary.updated).toBe(0);
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);
  });

  test('a pinned skill is skipped until unpinned', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    expect(await setSkillPinned(env.skillsRoot, 'demo', true, { statePath: env.statePath })).toBe(true);
    const pinned = await update(env);
    expect(outcome(pinned, 'demo')).toMatchObject({ result: 'skipped', reason: 'pinned' });
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);
    await setSkillPinned(env.skillsRoot, 'demo', false, { statePath: env.statePath });
    expect(outcome(await update(env), 'demo').result).toBe('updated');
  });

  test('a symlinked file in the closure is refused, not followed', async () => {
    const env = setup();
    await scaffold(env);
    const outside = join(tmp('sp-safe-outside-'), 'x.md');
    writeFileSync(outside, 'outside\n');
    rmSync(join(env.ws, 'skills', 'demo/references/notes.md'));
    symlinkSync(outside, join(env.ws, 'skills', 'demo/references/notes.md'));
    release(env.gbrainRoot, V2);
    const result = await update(env);
    expect(outcome(result, 'demo')).toMatchObject({ result: 'skipped', reason: 'unsafe_target' });
    expect(readFileSync(outside, 'utf-8')).toBe('outside\n');
  });

  test('diffs for skipped skills are bounded to 200 lines per file and redact secret-looking values', async () => {
    const env = setup();
    await scaffold(env);
    const secret = `ghp_${'Zq7Lm2Np9Rt4Vx8Bc3Df6Gh1Jk5'.slice(0, 36).padEnd(36, 'x')}`;
    write(env, 'demo/references/notes.md', `token: ${secret}\n` + Array.from({ length: 400 }, (_, i) => `local line ${i}`).join('\n') + '\n');
    release(env.gbrainRoot, V2);
    const result = await update(env);
    const diff = outcome(result, 'demo').diffs!.find(d => d.rel === 'demo/references/notes.md')!;
    expect(diff.truncated).toBe(true);
    expect(diff.diff.split('\n').length).toBeLessThanOrEqual(DIFF_LINE_CAP + 2);
    expect(diff.diff).not.toContain(secret);
    expect(diff.diff).toContain('REDACTED');
    expect((await update(env, { noDiff: true })).skills.every(s => s.diffs === undefined)).toBe(true);
  });
});

describe('commit protocol', () => {
  test('a file changed between classification and its rename aborts the skill and rolls back only files untouched since', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    let renames = 0;
    let first = '';
    const result = await update(env, {
      slugs: ['demo'],
      hooks: {
        afterRename: rel => { if (renames++ === 0) first = rel; },
        beforeRename: rel => { if (renames === 1) writeFileSync(join(env.ws, 'skills', rel), 'edited mid-update\n'); },
      },
    });
    const demo = outcome(result, 'demo');
    expect(demo.result).toBe('failed');
    expect(demo.touched).toEqual([first]);
    expect(demo.rollback_skipped).toEqual([]);
    expect(read(env, first)).toBe(V1[first as keyof typeof V1]);
    const second = first === 'demo/SKILL.md' ? 'demo/references/notes.md' : 'demo/SKILL.md';
    expect(read(env, second)).toBe('edited mid-update\n');
    expect(listJournals(env.backups)[0]!.skills[0]!.status).toBe('rolled_back');
    expect(result.restore_command).toContain('gbrain skillpack restore');
    expect(loadState({ statePath: env.statePath }).roots![env.skillsRoot]!.demo!.files[first]).toBe(sha256(V1[first as keyof typeof V1]));
  });

  test('rollback leaves a renamed file that was edited again after the rename', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    let renames = 0;
    let first = '';
    const result = await update(env, {
      slugs: ['demo'],
      hooks: {
        afterRename: rel => {
          if (renames++ > 0) return;
          first = rel;
          writeFileSync(join(env.ws, 'skills', rel), 'edited after rename\n');
        },
        beforeRename: rel => { if (renames === 1) writeFileSync(join(env.ws, 'skills', rel), 'edited mid-update\n'); },
      },
    });
    expect(outcome(result, 'demo').rollback_skipped).toEqual([first]);
    expect(read(env, first)).toBe('edited after rename\n');
  });

  test('a failed post-update check rolls the skill back', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    const result = await update(env, { slugs: ['demo'], validate: () => ['forced failure'] });
    expect(outcome(result, 'demo')).toMatchObject({ result: 'failed', failure: 'forced failure' });
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);
    expect(read(env, 'demo/references/notes.md')).toBe(V1['demo/references/notes.md']);
  });

  test('the default checks pass a real update (conformance, triggers, resolver)', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    const result = await update(env, { validate: undefined });
    expect(result.summary).toMatchObject({ updated: 2, failed: 0 });
  });

  test('a crash leaves a pending journal: doctor reports it, the next run refuses, restore recovers', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    const script = join(tmp('sp-safe-script-'), 'crash.ts');
    writeFileSync(script, `import { runSkillpackUpdate } from ${JSON.stringify(join(REPO, 'src/core/skillpack/safe-update.ts'))};
await runSkillpackUpdate({ gbrainRoot: ${JSON.stringify(env.gbrainRoot)}, skillsRoot: ${JSON.stringify(env.skillsRoot)}, slugs: ['demo'],
  statePath: ${JSON.stringify(env.statePath)}, backups: ${JSON.stringify(env.backups)}, validate: () => [], hooks: { afterRename: () => process.exit(9) } });
`);
    expect(spawnSync('bun', [script], { stdio: 'ignore', timeout: 60_000 }).status).toBe(9);

    const [incomplete] = (await runSkillpackUpdateChecks(undefined, env.backups));
    expect(incomplete).toMatchObject({ name: 'skillpack_update_incomplete', status: 'warn' });
    const id = listJournals(env.backups)[0]!.id;
    expect(incomplete!.message).toContain(`gbrain skillpack restore ${id}`);
    await expect(update(env)).rejects.toMatchObject({ code: 'skillpack_update_incomplete' });
    expect((await update(env, { dryRun: true })).pending_journals).toEqual([id]);

    await runSkillpackRestore({ id, statePath: env.statePath, backups: env.backups });
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);
    expect(read(env, 'demo/references/notes.md')).toBe(V1['demo/references/notes.md']);
    expect((await runSkillpackUpdateChecks(undefined, env.backups)).map(c => c.name)).toEqual(['skillpack_backups']);
    expect(outcome(await update(env), 'demo').result).toBe('updated');
  }, 90_000);
});

describe('restore', () => {
  test('refuses a file changed after the update unless it is named in --skip', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    const { journal } = await update(env, { slugs: ['demo'] });
    write(env, 'demo/references/notes.md', 'my later edit\n');
    await expect(runSkillpackRestore({ id: journal!, statePath: env.statePath, backups: env.backups })).rejects.toMatchObject({ code: 'skillpack_restore_conflict' });
    expect(read(env, 'demo/SKILL.md')).toBe(V2['demo/SKILL.md']);

    await runSkillpackRestore({ id: journal!, skip: ['demo/references/notes.md'], statePath: env.statePath, backups: env.backups });
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);
    expect(read(env, 'demo/references/notes.md')).toBe('my later edit\n');
    const record = loadState({ statePath: env.statePath }).roots![env.skillsRoot]!.demo!;
    expect(record.files['demo/SKILL.md']).toBe(sha256(V1['demo/SKILL.md']));
  });

  test('is idempotent', async () => {
    const env = setup();
    await scaffold(env);
    release(env.gbrainRoot, V2);
    const { journal } = await update(env);
    const first = await runSkillpackRestore({ id: journal!, statePath: env.statePath, backups: env.backups });
    expect(first.files.every(f => f.action === 'restore')).toBe(true);
    const snapshot = [read(env, 'demo/SKILL.md'), read(env, 'demo/references/notes.md'), read(env, 'other/SKILL.md')];
    const second = await runSkillpackRestore({ id: journal!, statePath: env.statePath, backups: env.backups });
    expect(second.files.every(f => f.action === 'already_restored')).toBe(true);
    expect([read(env, 'demo/SKILL.md'), read(env, 'demo/references/notes.md'), read(env, 'other/SKILL.md')]).toEqual(snapshot);
    expect(snapshot[0]).toBe(V1['demo/SKILL.md']);
  });
});

describe('shared state lock', () => {
  test('concurrent scaffold, update and pin across two workspaces lose no state records', async () => {
    const a = setup();
    const b: Env = { ...a, ws: tmp('sp-safe-ws-b-') };
    b.skillsRoot = skillsRootKey(join(b.ws, 'skills'));
    await scaffold(b);
    release(a.gbrainRoot, V2);
    const dir = tmp('sp-safe-script-');
    const startAt = Date.now() + 1500;
    const mod = (name: string) => JSON.stringify(join(REPO, 'src/core/skillpack', name));
    const scripts = {
      a: `import { runScaffold } from ${mod('scaffold.ts')};
import { recordScaffoldBases, setSkillPinned } from ${mod('safe-update.ts')};
while (Date.now() < ${startAt}) await Bun.sleep(5);
const r = runScaffold({ gbrainRoot: ${JSON.stringify(a.gbrainRoot)}, targetWorkspace: ${JSON.stringify(a.ws)}, skillSlug: null });
await recordScaffoldBases(${JSON.stringify(join(a.ws, 'skills'))}, r.files, { statePath: ${JSON.stringify(a.statePath)} });
for (let i = 0; i < 150; i++) await setSkillPinned(${JSON.stringify(skillsRootKey(join(a.ws, 'skills')))}, 'p' + i, true, { statePath: ${JSON.stringify(a.statePath)} });
`,
      b: `import { runSkillpackUpdate, setSkillPinned } from ${mod('safe-update.ts')};
while (Date.now() < ${startAt}) await Bun.sleep(5);
const r = await runSkillpackUpdate({ gbrainRoot: ${JSON.stringify(b.gbrainRoot)}, skillsRoot: ${JSON.stringify(b.skillsRoot)}, slugs: null, statePath: ${JSON.stringify(b.statePath)}, backups: ${JSON.stringify(b.backups)}, validate: () => [] });
if (r.summary.updated !== 2) process.exit(3);
for (let i = 0; i < 150; i++) await setSkillPinned(${JSON.stringify(b.skillsRoot)}, 'q' + i, true, { statePath: ${JSON.stringify(b.statePath)} });
`,
    };
    const run = (body: string, name: string) => new Promise<number | null>(resolve => {
      const path = join(dir, `${name}.ts`);
      writeFileSync(path, body);
      spawn('bun', [path], { stdio: 'ignore' }).on('exit', code => resolve(code));
    });
    expect(await Promise.all([run(scripts.a, 'a'), run(scripts.b, 'b')])).toEqual([0, 0]);
    const roots = loadState({ statePath: a.statePath }).roots!;
    const rootA = roots[skillsRootKey(join(a.ws, 'skills'))]!;
    expect(rootA.demo!.files['demo/SKILL.md']).toBe(sha256(V2['demo/SKILL.md']));
    expect(Object.keys(rootA).filter(k => rootA[k]!.pinned).length).toBe(150);
    const rootB = roots[b.skillsRoot]!;
    expect(rootB.demo!.files['demo/SKILL.md']).toBe(sha256(V2['demo/SKILL.md']));
    expect(Object.keys(rootB).filter(k => rootB[k]!.pinned).length).toBe(150);
  }, 90_000);
});

describe('CLI contract', () => {
  const cli = (env: Env, args: string[]) => spawnSync('bun', [join(REPO, 'src/cli.ts'), 'skillpack', ...args], {
    cwd: env.gbrainRoot, env: { ...process.env, GBRAIN_HOME: env.home }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 60_000,
  });

  test('exit 0 with skips, 1 only with --fail-on-skipped, 2 on failure; never prompts with stdin closed', () => {
    const env = setup();
    expect(cli(env, ['scaffold', '--all', '--workspace', env.ws]).status).toBe(0);
    expect(loadState({ statePath: env.statePath }).roots![env.skillsRoot]!.other!.files['other/SKILL.md']).toBe(sha256(V1['other/SKILL.md']));
    write(env, 'other/SKILL.md', skill('other', 'my edit'));
    release(env.gbrainRoot, V2);

    const preview = cli(env, ['reference', '--all', '--update-untouched', '--dry-run', '--workspace', env.ws]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain('would update');
    expect(read(env, 'demo/SKILL.md')).toBe(V1['demo/SKILL.md']);

    const ok = cli(env, ['reference', '--all', '--update-untouched', '--json', '--workspace', env.ws]);
    expect(ok.status).toBe(0);
    const okJson = JSON.parse(ok.stdout);
    expect(okJson.summary).toMatchObject({ updated: 1, skipped: 1, failed: 0 });
    expect(okJson.skills.find((s: { slug: string }) => s.slug === 'other').reason).toBe('local_edits');

    release(env.gbrainRoot, V3);
    const strict = cli(env, ['reference', '--all', '--update-untouched', '--fail-on-skipped', '--no-diff', '--workspace', env.ws]);
    expect(strict.status).toBe(1);
    expect(read(env, 'demo/SKILL.md')).toBe(V3['demo/SKILL.md']);

    release(env.gbrainRoot, { 'demo/SKILL.md': '# demo v4 without frontmatter\n' });
    const failed = cli(env, ['reference', 'demo', '--update-untouched', '--workspace', env.ws]);
    expect(failed.status).toBe(2);
    expect(failed.stdout).toMatch(/gbrain skillpack restore \S+/);
    expect(read(env, 'demo/SKILL.md')).toBe(V3['demo/SKILL.md']);

    expect(cli(env, ['pin', 'demo', '--workspace', env.ws]).status).toBe(0);
    expect(loadState({ statePath: env.statePath }).roots![env.skillsRoot]!.demo!.pinned).toBe(true);
    expect(cli(env, ['restore', '--list', '--json']).status).toBe(0);
  }, 120_000);
});

describe('state file and history', () => {
  test('a v1 state file loads with its packs and saves as v2', () => {
    const dir = tmp('sp-safe-state-');
    const statePath = join(dir, 'skillpack-state.json');
    const pack = { name: 'acme-example', version: '1.0.0', author: 'alice-example', source: './pack', source_kind: 'local', pinned_commit: null, tarball_sha256: null, tier: 'local', scaffolded_at: '2026-01-01T00:00:00.000Z', workspace: dir, skill_slugs: ['x'] };
    writeFileSync(statePath, JSON.stringify({ schema_version: 'gbrain-skillpack-state-v1', packs: [pack] }));
    const state = loadState({ statePath });
    expect(state.packs).toEqual([pack] as never);
    expect(state.roots).toEqual({});
    saveState(state, { statePath });
    expect(JSON.parse(readFileSync(statePath, 'utf-8')).schema_version).toBe('gbrain-skillpack-state-v2');
  });

  test('history merge is append-only and its lock hash is verified', () => {
    const env = setup();
    const skillsDir = join(env.gbrainRoot, 'skills');
    const v1 = parseSkillsLockHistory(readFileSync(join(skillsDir, SKILLS_LOCK_HISTORY_FILENAME), 'utf-8'));
    release(env.gbrainRoot, V2);
    const v2 = parseSkillsLockHistory(readFileSync(join(skillsDir, SKILLS_LOCK_HISTORY_FILENAME), 'utf-8'));
    expect(droppedHistoryEntries(v1, v2)).toEqual([]);
    expect(v2.files['demo/SKILL.md']).toEqual([sha256(V1['demo/SKILL.md']), sha256(V2['demo/SKILL.md'])].sort());
    expect(droppedHistoryEntries(v2, v1).length).toBeGreaterThan(0);
    expect(loadVerifiedSkillsLockHistory(skillsDir).ok).toBe(true);
    appendFileSync(join(skillsDir, SKILLS_LOCK_HISTORY_FILENAME), '\n');
    expect(loadVerifiedSkillsLockHistory(skillsDir)).toMatchObject({ ok: false });
  });
});

function readdirNames(dir: string): string[] {
  return require('fs').readdirSync(dir) as string[];
}
