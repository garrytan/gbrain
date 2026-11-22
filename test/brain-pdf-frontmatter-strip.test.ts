/**
 * brain-pdf's invocation, run as written in skills/brain-pdf/SKILL.md (and its generated plugin copy) with a fake
 * `gbrain` whose `publish` is the real CLI and a fake make-pdf. #5772: the frontmatter strip keeps a body --- rule and
 * a page without frontmatter whole, and stops on a page with nothing to render. #10020: the PDF leaves out what
 * `gbrain publish` leaves out, the work files live in a private directory, and a failed render exits non-zero
 * without claiming success.
 */

import { describe, test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';

const REPO = resolve(import.meta.dir, '..');

/** The skill's Invocation block. */
function invocation(skillPath: string): string {
  const text = readFileSync(join(REPO, skillPath), 'utf-8');
  const block = /## Invocation\n\n```bash\n([\s\S]*?)\n```/.exec(text);
  if (!block) throw new Error(`no invocation block in ${skillPath}`);
  return block[1]!;
}

interface Run { status: number | null; stdout: string; stderr: string; rendered: string | null; outDirParent: string | null; outDirMode: number | null; tmp: string }

function run(skillPath: string, page: string, opts: { renderFails?: boolean } = {}): Run {
  const root = mkdtempSync(join(tmpdir(), 'brain-pdf-test-'));
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  const bin = join(root, 'bin');
  for (const dir of [home, tmp, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'page.md'), page);
  const gbrain = join(bin, 'gbrain');
  writeFileSync(gbrain, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    `  get) cat '${join(root, 'page.md')}' ;;`,
    '  config) exit 1 ;;',
    `  publish) shift; exec bun '${join(REPO, 'src/cli.ts')}' publish "$@" ;;`,
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'));
  const pdf = join(home, '.claude/skills/gstack/make-pdf/dist/pdf');
  mkdirSync(dirname(pdf), { recursive: true });
  writeFileSync(pdf, opts.renderFails
    ? '#!/usr/bin/env bash\necho "render crashed" >&2\nexit 1\n'
    : '#!/usr/bin/env bash\ncp "$2" "$3"\n');
  chmodSync(gbrain, 0o755);
  chmodSync(pdf, 0o755);
  try {
    const r = spawnSync('bash', ['-c', invocation(skillPath)], {
      env: { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, TMPDIR: tmp },
      encoding: 'utf-8',
    });
    const out = /^Rendered: (.+)$/m.exec(r.stdout)?.[1] ?? null;
    const made = out !== null && existsSync(out);
    return {
      status: r.status, stdout: r.stdout, stderr: r.stderr, tmp,
      rendered: made ? readFileSync(out, 'utf-8') : null,
      outDirParent: made ? dirname(dirname(out)) : null,
      outDirMode: made ? statSync(dirname(out)).mode & 0o777 : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const skill of ['skills/brain-pdf/SKILL.md', 'plugin/skills/brain-pdf/SKILL.md']) {
  describe(`brain-pdf invocation (${skill})`, () => {
    test('#5772: removes only the leading frontmatter block; a body --- rule and what follows survive', () => {
      const r = run(skill, '---\ntitle: X\ntype: note\n---\n# X\n\npara1\n\n---\n\npara2 after hr\n');
      expect(r.status).toBe(0);
      expect(r.rendered).toBe('# X\n\npara1\n\n---\n\npara2 after hr\n');
    });

    test('#5772: a page without frontmatter keeps every line', () => {
      const page = '# Plain page\n\nline two\n\nline three\n';
      expect(run(skill, page).rendered).toBe(page);
    });

    test('#5772: a page that is only frontmatter stops instead of rendering an empty PDF', () => {
      const r = run(skill, '---\ntitle: X\n---\n');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('nothing to render for path/to/page');
      expect(r.stdout).not.toContain('Rendered:');
    });

    test('#10020: the PDF leaves out the private Timeline and fact rows', () => {
      const r = run(skill, '# X\n\nBody.\n\n<!--- gbrain:facts:begin -->\n| 1 | private fact |\n<!--- gbrain:facts:end -->\n\n## Timeline\n\n- 2026-01-01 private entry\n');
      expect(r.status).toBe(0);
      expect(r.rendered).toBe('# X\n\nBody.\n');
    });

    test('a guest page leaves out its attribution warning and frontmatter', () => {
      const r = run(skill, "[outside guest · alice-example · group-a · 2026-01-01 · not the owner's words, not verified]\n---\ntitle: X\nreadable_by: [alice-example]\n---\n# X\n\nBody.\n");
      expect(r.status).toBe(0);
      expect(r.rendered).toBe('# X\n\nBody.\n');
    });

    test('work files and the PDF live in a private directory, not a shared /tmp path', () => {
      const r = run(skill, '# X\n\nBody.\n');
      expect(r.status).toBe(0);
      expect(r.outDirParent).toBe(r.tmp);
      expect(r.outDirMode).toBe(0o700);
    });

    test('a failed render exits non-zero and never prints Rendered:', () => {
      const r = run(skill, '# X\n\nBody.\n', { renderFails: true });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain('Rendered:');
      expect(r.stderr).toContain('make-pdf failed for path/to/page');
    });
  });
}
