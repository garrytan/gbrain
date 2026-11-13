/**
 * W4 end to end through the real CLI, on a repo-less brain (gbrain init --pglite --no-embedding, no git repo) and a
 * repo brain (a git source added):
 *   - the reported alert: doctor run from a directory holding an agent's own skills folder
 *     (skills/<category>/<name>/SKILL.md, no RESOLVER.md, nothing gbrain installed) used to fail resolver_health and
 *     warn skill_currency (score 75, unhealthy, brain category 100). Now both report "not a gbrain skills folder";
 *     --skills-dir still grades it, and a gbrain-managed folder found the same way is still graded;
 *   - doctor --alert: exit 0 / 17 / 18, --json alert.level, the consecutive-unknown counter and its reset, a home whose
 *     state file cannot be read or written, the human output, and convergence on a larger synthetic brain.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDoctorHome, runGbrain, type DoctorHome } from './helpers/doctor-json-golden.ts';
import { pgliteSql } from './helpers/doctor-hot-checks-fixture.ts';

const homes: DoctorHome[] = [];
afterAll(() => { for (const h of homes) h.cleanup(); });

async function brain(kind: 'repo-less' | 'repo'): Promise<DoctorHome> {
  const h = makeDoctorHome(`w4-${kind}`);
  homes.push(h);
  const init = await runGbrain(h, ['init', '--pglite', '--no-embedding']);
  if (init.exitCode !== 0) throw new Error(`init failed: ${init.stderr}`);
  if (kind === 'repo') {
    const repo = join(h.home, 'notes');
    mkdirSync(repo);
    writeFileSync(join(repo, 'example.md'), '---\ntitle: Example\n---\nHello world\n');
    const git = (args: string[]) => Bun.spawnSync(['git', '-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', ...args], { cwd: repo });
    git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'init']);
    const add = await runGbrain(h, ['sources', 'add', 'notes', '--path', repo]);
    if (add.exitCode !== 0) throw new Error(`sources add failed: ${add.stderr}`);
  }
  return h;
}

/** An agent's own skills folder in the doctor's cwd: category folders, no resolver file, nothing gbrain wrote. */
function agentSkills(h: DoctorHome): string {
  const dir = join(h.work, 'skills');
  for (const [cat, name] of [['research', 'web-digest'], ['devops', 'deploy-notes']]) {
    mkdirSync(join(dir, cat, name), { recursive: true });
    writeFileSync(join(dir, cat, name, 'SKILL.md'), `---\nname: ${name}\ndescription: An example agent skill.\n---\n# ${name}\n`);
  }
  return dir;
}

const check = (report: any, name: string) => report.checks.find((c: any) => c.name === name);

async function corruptJsonb(h: DoctorHome, fix = false): Promise<void> {
  const cfg = JSON.parse(readFileSync(join(h.home, '.gbrain', 'config.json'), 'utf-8'));
  await pgliteSql(cfg.database_path)([[fix
    ? `DELETE FROM ingest_log WHERE source_ref = 'w4-alert-fixture'`
    : `INSERT INTO ingest_log (source_type, source_ref, pages_updated) VALUES ('fixture', 'w4-alert-fixture', to_jsonb('["notes/alpha-example"]'::text))`, []]]);
}

for (const kind of ['repo-less', 'repo'] as const) {
  describe(`${kind} brain`, () => {
    test('an agent skills folder found by walking up from the cwd is not graded against gbrain conventions', async () => {
      const h = await brain(kind);
      const dir = agentSkills(h);
      const run = await runGbrain(h, ['doctor', '--json']);
      const report = run.json as any;
      for (const name of ['resolver_health', 'skill_currency']) {
        expect(check(report, name)).toMatchObject({ status: 'ok', severity: 'info', message: `not a gbrain skills folder (${dir}); pass --skills-dir to grade it` });
      }
      expect(report.checks.filter((c: any) => c.category === 'skill' && c.status !== 'ok').map((c: any) => c.name)).toEqual([]);
      expect(report.category_scores.skill).toBe(100);
      expect(report.alert.level).toBe('none');

      const graded = (await runGbrain(h, ['doctor', '--json', '--skills-dir', dir])).json as any;
      expect(check(graded, 'resolver_health').status).toBe('fail');
      expect(check(graded, 'skill_currency').status).toBe('warn');
      expect(graded.health_score).toBeLessThan(report.health_score);
      expect(graded.alert.level).toBe('none');

      writeFileSync(join(dir, 'RESOLVER.md'), '# RESOLVER\n\n<!-- gbrain:skillpack:begin -->\n<!-- gbrain:skillpack:end -->\n');
      const managed = (await runGbrain(h, ['doctor', '--json'])).json as any;
      expect(check(managed, 'resolver_health').severity).toBeUndefined();
      expect(check(managed, 'resolver_health').message).not.toContain('not a gbrain skills folder');
    }, 180_000);

    test('doctor --alert: none (exit 0), act (exit 17), unknown (exit 18) with a consecutive counter that resets', async () => {
      const h = await brain(kind);
      agentSkills(h);
      const healthy = await runGbrain(h, ['doctor', '--alert', '--json']);
      expect(healthy.exitCode).toBe(0);
      expect((healthy.json as any).alert).toMatchObject({ level: 'none', items: [], unknown: [], consecutive_unknown: 0 });

      const first = await runGbrain(h, ['doctor', '--alert', '--json', '--budget-ms', '1']);
      expect(first.exitCode).toBe(18);
      expect((first.json as any).alert.level).toBe('unknown');
      expect((first.json as any).alert.consecutive_unknown).toBe(1);
      const second = await runGbrain(h, ['doctor', '--alert', '--json', '--budget-ms', '1']);
      expect(second.exitCode).toBe(18);
      const alert2 = (second.json as any).alert;
      expect(alert2.consecutive_unknown).toBe(2);
      expect(alert2.unknown[0].consecutive_unknown_runs).toBe(2);
      expect(alert2.unknown[0].message).toContain('Unknown for 2 consecutive alert run(s).');

      await corruptJsonb(h);
      const act = await runGbrain(h, ['doctor', '--alert', '--json']);
      expect(act.exitCode).toBe(17);
      const actAlert = (act.json as any).alert;
      expect(actAlert.level).toBe('act');
      expect(actAlert.consecutive_unknown).toBe(0);
      expect(actAlert.items.map((i: any) => i.check)).toEqual(['jsonb_integrity']);
      const human = await runGbrain(h, ['doctor', '--alert']);
      expect(human.exitCode).toBe(17);
      expect(human.stdout).toContain('Alert: act');
      expect(human.stdout).toContain('[ACT] jsonb_integrity');

      await corruptJsonb(h, true);
      const back = await runGbrain(h, ['doctor', '--alert', '--json']);
      expect(back.exitCode).toBe(0);
      expect((back.json as any).alert.level).toBe('none');
    }, 240_000);
  });
}

describe('doctor --alert state and scale', () => {
  test('a state file that cannot be read or written still reports and exits by level', async () => {
    const h = await brain('repo-less');
    mkdirSync(join(h.home, '.gbrain', 'doctor-alert-state.json'));
    const run = await runGbrain(h, ['doctor', '--alert', '--json', '--budget-ms', '1']);
    expect(run.exitCode).toBe(18);
    expect((run.json as any).alert.consecutive_unknown).toBeNull();
  }, 120_000);

  test('repeated alert runs on a larger synthetic repo-less brain converge to none', async () => {
    const h = await brain('repo-less');
    const dir = join(h.home, 'pages');
    mkdirSync(dir);
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `note-${i}.md`), `---\ntitle: Note ${i}\n---\nExample note ${i} about acme-example.\n`);
    const imported = await runGbrain(h, ['import', dir, '--no-embed', '--json'], {}, 300_000);
    expect(imported.exitCode).toBe(0);
    for (let i = 0; i < 2; i++) {
      const run = await runGbrain(h, ['doctor', '--alert', '--json']);
      expect((run.json as any).alert.unknown).toEqual([]);
      expect(run.exitCode).toBe(0);
    }
  }, 400_000);
});
