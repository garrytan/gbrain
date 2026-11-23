/**
 * G3: the moved-skills notices on the CLI surfaces, through the GBRAIN_TEST_SKILLS_MOVED_REGISTRY seam
 * (src/cli/moved-registry-seam.ts): bundled-skill, skillpack scaffold (--all too), reference, status and pin.
 *
 * Protects: with a destination set each surface keeps working on gbrain's own copy and says where the skill went;
 * bundled-skill answers a moved name that is no longer bundled with the notice and exit 0. With the destination null
 * every surface prints exactly what it printed before (no notice, no moved field).
 * Fails when: a notice leaks while the destination is null, a surface drops its notice, or a moved name that left the
 * bundle still fails with skill_not_found once the destination is set.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const SKILLS = join(import.meta.dir, '..', 'skills');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const DEST = { name: 'catalog-example', install: 'example-tool add {skill}', url: 'https://example.com/skills' };
const SET = JSON.stringify({ schema_version: 1, destination: DEST, moved: ['briefing', 'retired-example'], kept: ['query'] });
const NULL = JSON.stringify({ schema_version: 1, destination: null, moved: ['briefing', 'retired-example'], kept: ['query'] });
const NOTICE = 'The briefing skill moved to catalog-example (https://example.com/skills). Install it from there with: example-tool add briefing.';

function cli(args: string[], registry?: string) {
  const home = tmp('g3-cli-home-');
  return runCli(args, { home, cwd: home, env: { GBRAIN_TEST_SKILLS_MOVED_REGISTRY: registry } });
}

describe('gbrain bundled-skill', () => {
  test('a moved skill still bundled is served, with the notice on stderr only when the destination is set', async () => {
    const set = await cli(['bundled-skill', 'briefing'], SET);
    expect(set.exitCode).toBe(0);
    expect(set.stdout.startsWith(readFileSync(join(SKILLS, 'briefing', 'SKILL.md'), 'utf8'))).toBe(true);
    expect(set.stderr).toContain(NOTICE);
    for (const registry of [NULL, undefined]) {
      const before = await cli(['bundled-skill', 'briefing'], registry);
      expect(before.exitCode).toBe(0);
      expect(before.stdout).toBe(set.stdout);
      expect(before.stderr).not.toContain('skill moved');
    }
  });

  test('a moved name no longer bundled prints the notice and exits 0 once the destination is set; before, skill_not_found', async () => {
    const set = await cli(['bundled-skill', 'retired-example'], SET);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain('The retired-example skill moved to catalog-example');
    const json = await cli(['bundled-skill', 'retired-example', '--json'], SET);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ schema_version: 1, name: 'retired-example' });
    expect(JSON.parse(json.stdout).moved).toContain('example-tool add retired-example');
    const before = await cli(['bundled-skill', 'retired-example'], NULL);
    expect(before.exitCode).not.toBe(0);
    expect(before.stderr).toContain('skill_not_found');
  });
});

describe('gbrain skillpack', () => {
  test('scaffold <name> still scaffolds the bundled copy and prints the notice; with a null destination it prints none', async () => {
    const ws = tmp('g3-cli-ws-');
    const set = await cli(['skillpack', 'scaffold', 'briefing', '--workspace', ws], SET);
    expect(set.exitCode).toBe(0);
    expect(existsSync(join(ws, 'skills', 'briefing', 'SKILL.md'))).toBe(true);
    expect(set.stderr).toContain(NOTICE);
    const ws2 = tmp('g3-cli-ws-');
    const before = await cli(['skillpack', 'scaffold', 'briefing', '--workspace', ws2], NULL);
    expect(before.exitCode).toBe(0);
    expect(existsSync(join(ws2, 'skills', 'briefing', 'SKILL.md'))).toBe(true);
    expect(before.stderr).not.toContain('skill moved');
    expect(before.stdout).toBe(set.stdout.replaceAll(ws, ws2));
  });

  test('scaffold --all prints the notice for each moved bundled skill', async () => {
    const ws = tmp('g3-cli-ws-');
    const set = await cli(['skillpack', 'scaffold', '--all', '--workspace', ws, '--dry-run'], SET);
    expect(set.exitCode).toBe(0);
    expect(set.stderr).toContain(NOTICE);
    expect(set.stderr).not.toContain('retired-example');
    const before = await cli(['skillpack', 'scaffold', '--all', '--workspace', ws, '--dry-run'], NULL);
    expect(before.stderr).not.toContain('skill moved');
  });

  test('reference <name> prints the notice; with a null destination it prints none', async () => {
    const ws = tmp('g3-cli-ws-');
    const set = await cli(['skillpack', 'reference', 'briefing', '--workspace', ws], SET);
    expect(set.exitCode).toBe(0);
    expect(set.stderr).toContain(NOTICE);
    const before = await cli(['skillpack', 'reference', 'briefing', '--workspace', ws], NULL);
    expect(before.exitCode).toBe(0);
    expect(before.stderr).not.toContain('skill moved');
    expect(before.stdout).toBe(set.stdout);
  });

  test('status marks a moved skill as moved next to its own state; with a null destination there is no moved state', async () => {
    const ws = tmp('g3-cli-ws-');
    const set = await cli(['skillpack', 'status', '--workspace', ws, '--json'], SET);
    expect(set.exitCode).toBe(0);
    const doc = JSON.parse(set.stdout);
    expect(doc.currency.counts.moved).toBe(1);
    expect(doc.currency.skills.find((s: { slug: string }) => s.slug === 'briefing')).toMatchObject({ status: 'new', moved: expect.stringContaining('example-tool add briefing') });
    const text = await cli(['skillpack', 'status', '--workspace', ws], SET);
    expect(text.stdout).toContain('moved: 1');
    expect(text.stdout).toContain('  briefing (new): The briefing skill moved');
    const before = JSON.parse((await cli(['skillpack', 'status', '--workspace', ws, '--json'], NULL)).stdout);
    expect(before.currency.counts.moved).toBeUndefined();
    expect(before.currency.skills.some((s: { moved?: string }) => s.moved)).toBe(false);
    const beforeText = (await cli(['skillpack', 'status', '--workspace', ws], NULL)).stdout;
    expect(beforeText).not.toContain('moved:');
    expect(beforeText).not.toContain('Moved (');
  });

  test('pin and unpin say a moved skill moved; with a null destination they print what they did before', async () => {
    const ws = tmp('g3-cli-ws-');
    const set = await cli(['skillpack', 'pin', 'briefing', '--workspace', ws], SET);
    expect(set.exitCode).toBe(0);
    expect(set.stderr).toContain(NOTICE);
    expect(set.stderr).toContain('--update-untouched no longer updates it');
    const unpin = await cli(['skillpack', 'unpin', 'briefing', '--workspace', ws], SET);
    expect(unpin.stderr).toContain(NOTICE);
    const before = await cli(['skillpack', 'pin', 'briefing', '--workspace', ws], NULL);
    expect(before.exitCode).toBe(0);
    expect(before.stderr).not.toContain('skill moved');
  });
});

describe('harness bridges', () => {
  test('a stub pointer for a moved skill still installs; scaffold, reference --harness and status say it moved, and say nothing with a null destination', async () => {
    const home = tmp('g3-cli-home-');
    const dest = tmp('g3-cli-dest-');
    const run = (args: string[], registry: string) => runCli(args, { home, env: { GBRAIN_TEST_SKILLS_MOVED_REGISTRY: registry } });
    expect((await run(['init', '--pglite', '--db-only', '--no-embedding', '--non-interactive'], NULL)).exitCode).toBe(0);
    expect((await run(['config', 'set', 'mcp.publish_skills', 'true'], NULL)).exitCode).toBe(0);
    const scaffold = await run(['skillpack', 'scaffold', '--harness', 'claude-code', '--stub', '--skill', 'briefing', '--dest', dest, '--json'], SET);
    expect(scaffold.exitCode, scaffold.stderr).toBe(0);
    expect(readFileSync(join(dest, 'briefing', 'SKILL.md'), 'utf8')).toContain('gbrain-skill-stub');
    expect(scaffold.stderr).toContain(NOTICE);
    const reference = await run(['skillpack', 'reference', '--harness', 'claude-code', '--dest', dest, 'briefing'], SET);
    expect(reference.exitCode).toBe(0);
    expect(reference.stderr).toContain(NOTICE);
    const status = await run(['skillpack', 'status', '--workspace', home], SET);
    expect(status.stdout).toContain(`    moved: ${NOTICE}`);
    const statusJson = JSON.parse((await run(['skillpack', 'status', '--workspace', home, '--json'], SET)).stdout);
    expect(statusJson.bridges[0].moved[0]).toContain(NOTICE);
    const before = await run(['skillpack', 'status', '--workspace', home], NULL);
    expect(before.stdout).toContain('Harness bridges');
    expect(before.stdout).not.toContain('moved:');
    expect(JSON.parse((await run(['skillpack', 'status', '--workspace', home, '--json'], NULL)).stdout).bridges[0].moved).toBeUndefined();
    const referenceBefore = await run(['skillpack', 'reference', '--harness', 'claude-code', '--dest', dest, 'briefing'], NULL);
    expect(referenceBefore.stderr).not.toContain('skill moved');
    expect(referenceBefore.stdout).toBe(reference.stdout);
  }, 180_000);
});

describe('the registry seam and an untrusted checkout', () => {
  // Spawned directly, not through runCli: that helper passes --no-env-file, which would keep Bun from loading the .env.
  test('a .env in the working directory cannot set GBRAIN_TEST_SKILLS_MOVED_REGISTRY, so a cloned repo cannot plant a notice', () => {
    const home = tmp('g3-cli-home-');
    const cwd = tmp('g3-cli-cwd-');
    writeFileSync(join(cwd, '.env'), `GBRAIN_TEST_SKILLS_MOVED_REGISTRY=${SET}\n`);
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'bundled-skill', 'briefing'],
      { cwd, env: { PATH: process.env.PATH ?? '', HOME: home, GBRAIN_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    const stderr = r.stderr.toString();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().startsWith(readFileSync(join(SKILLS, 'briefing', 'SKILL.md'), 'utf8'))).toBe(true);
    expect(stderr).toContain('Ignoring GBRAIN_TEST_SKILLS_MOVED_REGISTRY because a .env file in the current directory assigns it');
    expect(stderr).not.toContain('skill moved');
  });
});
