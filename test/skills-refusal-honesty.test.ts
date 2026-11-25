/**
 * Bundled skills, recipes and integration docs are loaded by agents. None of
 * them may tell an agent to hide a model refusal, switch models without saying
 * so, or pad an access request so a gateway approves more than the job needs.
 * A refusal is reported to the user; access starts narrow and widens with the
 * user's agreement.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIRS = ['skills', 'plugin/skills', 'plugin-variants', 'recipes', 'docs/integrations'];

const BANNED: Array<[string, RegExp]> = [
  ['silent model switch', /switch(es|ing)? silently|silently switch|silent[ _]switch/i],
  ['hidden switch', /(don'?t|do not|never) announce the switch/i],
  ['hidden refusal', /(don'?t|do not|never) show (the )?refusals?( to the user)?|never show refusal/i],
  ['over-broad access', /be expansive|expansive (scope|purpose)|must be expansive/i],
  ['filter stop retried as a plain failure', /just a failed chapter/i],
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(md|ya?ml)$/.test(e.name) ? [p] : [];
  });
}

describe('agent-loaded text reports refusals and asks for narrow access', () => {
  it('no skill, recipe or integration doc coaches hiding a refusal or padding scope', () => {
    const hits: string[] = [];
    for (const dir of DIRS) {
      for (const file of files(join(ROOT, dir))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          for (const [name, re] of BANNED) {
            if (re.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1} ${name}: ${line.trim()}`);
          }
        });
      }
    }
    expect(hits).toEqual([]);
  });

  it('cross-modal refusal routing defaults to reporting the refusal', () => {
    const yaml = readFileSync(join(ROOT, 'skills/conventions/cross-modal.yaml'), 'utf8');
    expect(yaml).toMatch(/^\s*behavior: "report"/m);
    expect(yaml).not.toMatch(/^\s*chain:/m);
    expect(yaml).not.toMatch(/behavior:.*\bor next_in_chain\b/);
  });

  it('another model reviews a refused request only when the user picks one', () => {
    for (const rel of ['skills/cross-modal-review/SKILL.md', 'skills/conventions/model-routing.md', 'skills/conventions/cross-modal.yaml']) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(text).not.toMatch(/or when\s+\`?refusal_routing\.behavior|is \`next_in_chain\`;|Fallback chain, when one runs/);
    }
  });
});
