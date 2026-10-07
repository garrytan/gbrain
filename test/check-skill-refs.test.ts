/**
 * scripts/check-skill-refs.mjs — the CLI-ref lane (#6197) and the
 * outside-root link rule (#6198), exercised on fixture skill trees.
 *
 * #6197: skills/maintain told agents to run `nohup gbrain embed refresh`
 * in an inline code span; `refresh` parses as a page slug, so the command
 * never refreshed anything. The lane scanned only fenced blocks and only
 * warned. It now scans inline spans too and fails on an unknown top-level
 * command or a known-bad subcommand.
 * #6198: skills linked `../../docs/protocol/AGENT_OPERATOR_v1.md`, which
 * dangles in every copied skill tree. A relative link that resolves outside
 * the skills root now fails (skills/migrations/** exempt).
 */
import { describe, expect, it, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const tmpRoots: string[] = [];
afterAll(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); });

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-refs-'));
  tmpRoots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, 'skills', rel, '..'), { recursive: true });
    writeFileSync(join(root, 'skills', rel), text);
  }
  return join(root, 'skills');
}

function check(skillsDir: string, ...extra: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(['bun', 'scripts/check-skill-refs.mjs', '--skills-dir', skillsDir, '--allowlist', join(skillsDir, 'no-allowlist.txt'), ...extra], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode ?? -1, out: `${r.stdout}${r.stderr}` };
}

const skill = (body: string) => `---\nname: demo\ndescription: demo\n---\n# Demo\n\n${body}\n`;

describe('check-skill-refs CLI-ref lane (#6197)', () => {
  it('fails on a known-bad subcommand inside an inline code span', () => {
    const r = check(fixture({ 'demo/SKILL.md': skill('Refresh with `nohup gbrain embed refresh > /tmp/e.log 2>&1 &`.') }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('`gbrain embed refresh` does not run as written');
    expect(r.out).toContain('gbrain embed --stale --dry-run');
  });

  it('fails on an unknown top-level command in an inline span', () => {
    const r = check(fixture({ 'demo/SKILL.md': skill('Run `gbrain frobnicate-pages --all` first.') }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('`gbrain frobnicate-pages` is not a gbrain command');
  });

  it('fails on an unknown top-level command in a fenced block', () => {
    const r = check(fixture({ 'demo/SKILL.md': skill('```bash\ngbrain sync --no-pull\ngbrain frobnicate-pages\n```') }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('`gbrain frobnicate-pages` is not a gbrain command');
  });

  it('passes real commands and ignores prose that only mentions gbrain', () => {
    const r = check(fixture({
      'demo/SKILL.md': skill([
        'Preview with `gbrain embed --stale --dry-run`, then `GBRAIN_HOME=/x gbrain sync --source alpha-example --no-pull`.',
        'Report: `Turned off gbrain update checks (re-enable: gbrain config set self_upgrade.mode notify).`',
        '````markdown\n```bash\ngbrain doctor --json\n```\n````',
        '```text\n🧠 gbrain checkup — 2 things worth your attention\n# gbrain frobnicate in a comment is not a command\n```',
      ].join('\n\n')),
    }));
    expect(r.out).not.toContain('FAIL');
    expect(r.code).toBe(0);
  });
});

describe('check-skill-refs outside-root links (#6198)', () => {
  it('fails a relative link that leaves the skills root, naming the fix', () => {
    const r = check(fixture({ 'demo/SKILL.md': skill('See the [protocol](../../docs/protocol/AGENT_OPERATOR_v1.md#quick-contract).') }), '--no-cli-refs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('[outside-root-link] skills/demo/SKILL.md:7');
    expect(r.out).toContain('bun scripts/portable-skill-links.ts');
  });

  it('keeps links inside the skills root and exempts skills/migrations/**', () => {
    const r = check(fixture({
      'demo/SKILL.md': skill('See [quality](../conventions/quality.md) and [the url](https://github.com/garrytan/gbrain/blob/master/docs/ENGINES.md).'),
      'conventions/quality.md': '# Quality\n',
      'migrations/v0.1.0.md': '# Old\n\nSee [docs](../../docs/ENGINES.md).\n',
    }), '--no-cli-refs');
    expect(r.out).not.toContain('FAIL');
    expect(r.code).toBe(0);
  });

  it('checks the generated plugin trees next to the skills dir', () => {
    const skillsDir = fixture({ 'demo/SKILL.md': skill('Clean.') });
    const variant = join(skillsDir, '..', 'plugin-variants', 'demo-variant', 'skills', 'demo');
    mkdirSync(variant, { recursive: true });
    writeFileSync(join(variant, 'SKILL.md'), skill('See [protocol](../../docs/protocol/AGENT_OPERATOR_v1.md).'));
    const r = check(skillsDir, '--no-cli-refs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('[outside-root-link] plugin-variants/demo-variant/skills/demo/SKILL.md:7');
  });
});

describe('check-skill-refs on the shipped trees', () => {
  it('passes on skills/, plugin/skills and plugin-variants/*/skills', () => {
    const r = Bun.spawnSync(['bun', 'scripts/check-skill-refs.mjs'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toContain('FAIL');
    expect(out).not.toContain('could not load --tools-json');
    expect(r.exitCode).toBe(0);
  });
});
