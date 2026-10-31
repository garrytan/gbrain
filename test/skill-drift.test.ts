import { describe, expect, test } from 'bun:test';
import { analyzeSkillDrift, descriptionBytes, extractInvocations, nearest, type CliSurface } from '../src/core/skill-drift.ts';
import { cliSurface } from '../src/cli/skill-surface.ts';

const fake: CliSurface = {
  isCommand: n => ['pages', 'doctor', 'search'].includes(n),
  subcommands: c => (c === 'pages' ? ['purge-deleted', 'status'] : undefined),
  stripGlobalFlags: argv => argv.filter(a => a !== '--quiet'),
  unknownFlag: (c, args) => args.find(a => a.startsWith('--') && !['--json', '--dry-run', '--limit'].includes(a)) ?? null,
  legalFlags: () => ['--json', '--dry-run', '--limit'],
  isOperation: n => n === 'get_page',
  operationNames: () => ['get_page'],
};

const skill = (body: string, fm = '') => `---\nname: x\ndescription: d\n${fm}---\n\n${body}\n`;

describe('extractInvocations', () => {
  test('reads shell fences, inline spans and continued lines with their line numbers', () => {
    const md = skill('Run `gbrain doctor --json` first.\n\n```bash\n$ gbrain pages status \\\n  --json | jq .\nFOO=1 gbrain search "a b" --limit 5\n```');
    expect(extractInvocations(md).map(i => [i.line, i.argv])).toEqual([
      [6, ['doctor', '--json']],
      [9, ['pages', 'status', '--json']],
      [11, ['search', 'a b', '--limit', '5']],
    ]);
  });

  test('skips non-shell fences, frontmatter, placeholder commands and marked lines', () => {
    const md = skill('```json\n{"cmd": "gbrain doctor --bogus"}\n```\n`gbrain <command> --x`\n<!-- skill-drift-ok: wrong on purpose -->\n`gbrain doctor --bogus`\n`gbrain doctor --also-bogus` <!-- skill-drift-ok: same -->', 'note: "gbrain doctor --nope"\n');
    expect(extractInvocations(md)).toEqual([]);
  });

  test('keeps a multi-word placeholder as one token and stops at redirects and pipes', () => {
    expect(extractInvocations('`gbrain pages status <page slug> > out.txt`')[0]!.argv).toEqual(['pages', 'status', '<page slug>']);
  });
});

describe('analyzeSkillDrift', () => {
  test('flags an unknown subcommand, an unknown flag and an unknown operation, each with the nearest name', () => {
    const md = skill('`gbrain pages purgedeleted`\n\n`gbrain doctor --jsn`', 'tools:\n  - get_pagez\n  - mcp:nope_op\n  - shell\n  - web_search\n');
    const r = analyzeSkillDrift('skills/x/SKILL.md', md, fake);
    expect(r.findings.map(f => [f.code, f.token, f.suggestion ?? null])).toEqual([
      ['SKILL_DRIFT_UNKNOWN_SUBCOMMAND', 'pages purgedeleted', 'pages purge-deleted'],
      ['SKILL_DRIFT_UNKNOWN_FLAG', 'doctor --jsn', '--json'],
      ['SKILL_DRIFT_UNKNOWN_TOOL', 'get_pagez', 'get_page'],
      ['SKILL_DRIFT_UNKNOWN_TOOL', 'mcp:nope_op', null],
    ]);
    expect(r.findings.every(f => f.remedy.length > 0 && f.line > 0)).toBe(true);
  });

  test('counts invocations whose subcommands are not declared instead of calling them drift', () => {
    const r = analyzeSkillDrift('f', skill('`gbrain doctor anything --json`\n`gbrain unknowncmd --x`'), fake);
    expect(r).toEqual({ findings: [], invocations: 1, subcommandUnverified: 1 });
  });

  test('placeholder values and flags never count as drift', () => {
    const r = analyzeSkillDrift('f', skill('`gbrain pages status <slug> --<flag> --limit <n> ...`'), fake);
    expect(r.findings).toEqual([]);
  });

  test('the real CLI surface accepts real invocations and rejects drifted ones', () => {
    const real = cliSurface();
    const ok = analyzeSkillDrift('f', skill('`gbrain pages purge-deleted --dry-run --json`\n`gbrain search "q" --limit 5`\n`gbrain config get <key>`'), real);
    expect(ok.findings).toEqual([]);
    const bad = analyzeSkillDrift('f', skill('`gbrain config sett a b`\n`gbrain doctor --jsn`', 'tools:\n  - get_pagez\n'), real);
    expect(bad.findings.map(f => [f.code, f.suggestion])).toEqual([
      ['SKILL_DRIFT_UNKNOWN_SUBCOMMAND', 'config set'],
      ['SKILL_DRIFT_UNKNOWN_FLAG', '--json'],
      ['SKILL_DRIFT_UNKNOWN_TOOL', 'get_page'],
    ]);
  });
});

test('nearest returns only a close candidate', () => {
  expect(nearest('--limt', ['--limit', '--json'])).toBe('--limit');
  expect(nearest('--completely-different', ['--limit'])).toBeUndefined();
});

test('descriptionBytes measures folded and plain descriptions', () => {
  expect(descriptionBytes('---\nname: a\ndescription: hello\ntriggers: []\n---\n')).toBe(5);
  expect(descriptionBytes('---\nname: a\ndescription: |\n  one\n  two\ntools: []\n---\n')).toBe(Buffer.byteLength('|\n  one\n  two'));
  expect(descriptionBytes('no frontmatter')).toBe(0);
});
