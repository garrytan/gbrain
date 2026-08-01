/**
 * #3502: docs must not reference nonexistent gbrain commands.
 *
 * `docs/tutorials/personal-brain.md` shipped a `gbrain install` step for two
 * months after the command it replaced was retired — every reader hit
 * "Unknown command: install". This guard scans README.md, docs/, and skills/
 * for `gbrain <verb>` invocations in code (fenced blocks + inline code spans)
 * and checks each verb against the live CLI surface: CLI_ONLY, operation
 * cliHints names (non-hidden), and aliases.
 *
 * Deliberately excluded (historical or speculative by design, per CLAUDE.md's
 * "historical docs are never rewritten" rule):
 *   - docs/GBRAIN_V0.md               — the v0 spec; documents v0's CLI
 *   - docs/designs/, docs/plans/      — future/speculative design docs
 *   - docs/migrations/, skills/migrations/ — per-release migration notes,
 *     written against that release's CLI
 *   - docs/UPGRADING_DOWNSTREAM_AGENTS.md — per-release upgrade chronicle
 *
 * Heuristics keep prose out: only fenced code + inline spans are scanned,
 * comment lines and diagram lines are skipped, and the verb must sit in
 * command position (start of command text, or after a shell operator).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { CLI_ONLY, cliAliases } from '../src/cli.ts';
import { operations } from '../src/core/operations.ts';

const ROOT = dirname(import.meta.dir);

const EXCLUDED = [
  'docs/GBRAIN_V0.md',
  'docs/UPGRADING_DOWNSTREAM_AGENTS.md',
  'docs/designs/',
  'docs/plans/',
  'docs/migrations/',
  'skills/migrations/',
];

/** Known-intentional references to commands that deliberately don't exist. */
const ALLOWLIST: Record<string, string[]> = {
  // The doc explains that gbrain does NOT ship this command, on purpose.
  'docs/guides/rls-and-you.md': ['rls-exempt'],
};

function validCommands(): Set<string> {
  const valid = new Set<string>(CLI_ONLY);
  for (const op of operations) {
    const name = op.cliHints?.name;
    if (name && !op.cliHints?.hidden) valid.add(name);
  }
  for (const alias of cliAliases.keys()) valid.add(alias);
  return valid;
}

function* mdFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* mdFiles(p);
    else if (p.endsWith('.md')) yield p;
  }
}

interface CodeLine { code: string; line: number }

/** Fenced-block lines + inline code spans that START with `gbrain `. */
function codeRegions(text: string): CodeLine[] {
  const out: CodeLine[] = [];
  const lines = text.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; continue; }
    if (inFence) {
      const t = l.trim();
      if (/^(#|\/\/|--|\*)/.test(t)) continue;        // comment lines
      if (/[│┌┐└┘├┤─═╔╗╚╝]/.test(l)) continue;        // ASCII-art diagrams
      out.push({ code: l, line: i + 1 });
      continue;
    }
    for (const m of l.matchAll(/`(gbrain [^`]+)`/g)) out.push({ code: m[1], line: i + 1 });
  }
  return out;
}

/** True when `gbrain` sits at command position (not mid-prose). */
function commandPosition(prefix: string): boolean {
  const p = prefix.trimEnd();
  return p === '' || /[|;&`(={[]$/.test(p) || /\$$/.test(p);
}

function scan(): string[] {
  const valid = validCommands();
  const violations: string[] = [];
  const files = [
    join(ROOT, 'README.md'),
    ...mdFiles(join(ROOT, 'docs')),
    ...mdFiles(join(ROOT, 'skills')),
  ];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (EXCLUDED.some((e) => rel === e || rel.startsWith(e))) continue;
    const text = readFileSync(file, 'utf-8');
    for (const { code, line } of codeRegions(text)) {
      for (const m of code.matchAll(/\bgbrain\s+([A-Za-z][\w-]*)/g)) {
        const verb = m[1];
        if (!/^[a-z][a-z0-9_-]{2,}$/.test(verb)) continue;   // flags, <slots>, v0.x
        if (!commandPosition(code.slice(0, m.index))) continue;
        if (valid.has(verb)) continue;
        if (ALLOWLIST[rel]?.includes(verb)) continue;
        violations.push(`${rel}:${line}: \`gbrain ${verb}\` is not a real command — ${code.trim().slice(0, 90)}`);
      }
    }
  }
  return violations;
}

describe('#3502 — docs reference only real gbrain commands', () => {
  test('every `gbrain <verb>` in README/docs/skills resolves to a live command', () => {
    const violations = scan();
    expect(violations).toEqual([]);
  });

  test('the sanity anchors: install is dead, init/put/skillpack are live', () => {
    const valid = validCommands();
    expect(valid.has('install')).toBe(false); // retired v0.36.0.0 — the #3502 bug
    expect(valid.has('init')).toBe(true);
    expect(valid.has('put')).toBe(true);
    expect(valid.has('skillpack')).toBe(true);
  });

  test('pages + bench are dispatchable (documented surfaces; #2035 bug class)', () => {
    // `pages` had a live handleCliOnly case but was dropped from CLI_ONLY;
    // `bench` (bench-publish.ts) was documented but never wired at all.
    expect(CLI_ONLY.has('pages')).toBe(true);
    expect(CLI_ONLY.has('bench')).toBe(true);
  });
});
