/**
 * GST-4066: a single-file gbrain binary embeds the shared conventions its skills link to as ../conventions/<file>,
 * so a host running it has no conventions folder on disk and those links do not open. `gbrain skillpack conventions
 * <dir>` writes the embedded files into <dir>/conventions, never overwriting a file you changed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { bundledSkills } from '../src/core/skills/bundled.ts';
import { writeIfAbsent } from '../src/commands/skillpack/conventions.ts';
import { readdirSync } from 'node:fs';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-conventions-4066-'));
  roots.push(home);
  return home;
}
const SKILLS = join(import.meta.dir, '..', 'skills');
const cli = (home: string, args: string[]) => runCli(['skillpack', 'conventions', ...args], { env: { HOME: home, GBRAIN_HOME: home }, cwd: home });
const EXPECTED = [...new Set(bundledSkills('owner').flatMap(s => s.assets).filter(a => a.startsWith('conventions/')))].sort();

describe('gbrain skillpack conventions', () => {
  test('writes every convention the bundled skills link to into <dir>/conventions, byte-identical, with no brain', async () => {
    const home = emptyHome();
    const out = join(home, 'host-skills');
    const r = await cli(home, [out, '--json']);
    expect(r.exitCode).toBe(0);
    expect(EXPECTED.length).toBeGreaterThan(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ schema_version: 1, conventions_dir: join(out, 'conventions'), written: EXPECTED, unchanged: [], kept: [] });
    for (const f of EXPECTED) expect(readFileSync(join(out, f), 'utf8')).toBe(readFileSync(join(SKILLS, f), 'utf8'));
    expect(existsSync(join(home, '.gbrain'))).toBe(false);
  });

  test('a second run changes nothing, and a convention you edited is kept and named', async () => {
    const home = emptyHome();
    const out = join(home, 'host-skills');
    mkdirSync(join(out, 'conventions'), { recursive: true });
    writeFileSync(join(out, EXPECTED[0]!), 'my own edit\n');
    const first = await cli(home, [out, '--json']);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).kept).toEqual([EXPECTED[0]]);
    expect(readFileSync(join(out, EXPECTED[0]!), 'utf8')).toBe('my own edit\n');
    const second = await cli(home, [out]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain(join(out, 'conventions'));
    expect(second.stdout).toContain(`kept ${EXPECTED[0]}`);
  });

  test('a missing folder or an extra argument is refused and writes nothing', async () => {
    const home = emptyHome();
    const bare = await cli(home, []);
    expect(bare.exitCode).not.toBe(0);
    expect(bare.stderr).toContain('gbrain skillpack conventions <dir>');
    const extra = await cli(home, [join(home, 'a'), join(home, 'b')]);
    expect(extra.exitCode).not.toBe(0);
    expect(existsSync(join(home, 'a'))).toBe(false);
  });

  test('a convention that appears after the existence check is never replaced, and no temporary file is left', () => {
    const dir = join(emptyHome(), 'conventions');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'quality.md');
    writeFileSync(target, 'written by someone else meanwhile\n');
    expect(writeIfAbsent(target, 'gbrain copy\n')).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('written by someone else meanwhile\n');
    expect(writeIfAbsent(join(dir, 'fresh.md'), 'gbrain copy\n')).toBe(true);
    expect(readFileSync(join(dir, 'fresh.md'), 'utf8')).toBe('gbrain copy\n');
    expect(readdirSync(dir).sort()).toEqual(['fresh.md', 'quality.md']);
  });
});
