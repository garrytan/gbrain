/**
 * #3502: docs must not reference nonexistent gbrain commands or flags.
 *
 * `docs/tutorials/personal-brain.md` shipped a `gbrain install` step for two
 * months after the command it replaced was retired — every reader hit
 * "Unknown command: install". This guard scans README.md, docs/, and skills/
 * for `gbrain <verb>` invocations in code (fenced blocks + inline code spans)
 * and checks each verb against the live CLI surface: CLI_ONLY, operation
 * cliHints names (non-hidden), and aliases.
 *
 * Docs-CLI truth check: in docs/guides/, docs/migrations/, docs/mcp/, skills/
 * and the root agent entry points (AGENTS.md, INSTALL_FOR_AGENTS.md,
 * BOOTSTRAP_FOR_AGENTS.md, CLAUDE.md, llms.txt) each invocation's flags must
 * also pass the production argument pipeline
 * (parseGlobalFlags + validateCommandFlags, see test/helpers/
 * cli-command-surface.ts), so a documented flag the CLI rejects fails here.
 *
 * Escape hatches, in order of preference:
 *   1. Fix the doc to the current command.
 *   2. `<!-- gbrain-cli: historical -->` on the line above a code fence (or
 *      on/above a line with inline code) for examples that document an older
 *      release's CLI.
 *   3. ALLOWLIST below — shrink-only, every entry carries a reason, and an
 *      entry that no longer matches a violation fails the stale-entry test.
 *
 * Deliberately excluded (historical or speculative by design, per CLAUDE.md's
 * "historical docs are never rewritten" rule):
 *   - docs/GBRAIN_V0.md               — the v0 spec; documents v0's CLI
 *   - docs/designs/, docs/plans/      — future/speculative design docs
 *   - docs/UPGRADING_DOWNSTREAM_AGENTS.md — per-release upgrade chronicle
 *   - docs/test-audit/                — dated audit evidence that quotes the
 *     tests and docs it examined, including the dead commands they pinned
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { CLI_ONLY } from '../src/cli.ts';
import {
  codeRegions, flagRejection, gbrainInvocations, HISTORICAL_MARKER, liveCliVerbs,
} from './helpers/cli-command-surface.ts';

const ROOT = dirname(import.meta.dir);
const RERUN = 'bun test test/docs-cli-commands.test.ts';

const EXCLUDED = [
  'docs/GBRAIN_V0.md',
  'docs/UPGRADING_DOWNSTREAM_AGENTS.md',
  'docs/designs/',
  'docs/plans/',
  'docs/test-audit/',
];

/** Root files agents read first: scanned for verbs and flags. */
const AGENT_ENTRY_POINTS = ['AGENTS.md', 'INSTALL_FOR_AGENTS.md', 'BOOTSTRAP_FOR_AGENTS.md', 'CLAUDE.md', 'llms.txt'];

/** Trees and files whose invocations are checked for flags as well as verbs. */
const FLAG_CHECKED = ['docs/guides/', 'docs/migrations/', 'docs/mcp/', 'skills/', ...AGENT_ENTRY_POINTS];

/**
 * Shrink-only: file → the offending verbs/flags it may carry, with why.
 * Never add an entry for a doc that is simply out of date — fix the doc.
 */
const ALLOWLIST: Record<string, { tokens: string[]; reason: string }> = {
  'docs/guides/rls-and-you.md': {
    tokens: ['rls-exempt'],
    reason: 'explains that gbrain deliberately does NOT ship this command',
  },
};

interface Violation { file: string; line: number; token: string; message: string }

function* mdFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* mdFiles(p);
    else if (p.endsWith('.md')) yield p;
  }
}

function scanText(rel: string, text: string, valid: Set<string>): Violation[] {
  const checkFlags = FLAG_CHECKED.some((t) => (t.endsWith('/') ? rel.startsWith(t) : rel === t));
  const out: Violation[] = [];
  for (const { code, line, historical } of codeRegions(text)) {
    if (historical) continue;
    for (const inv of gbrainInvocations(code)) {
      const snippet = code.trim().slice(0, 100);
      if (!valid.has(inv.verb)) {
        out.push({ file: rel, line, token: inv.verb, message: `\`gbrain ${inv.verb}\` — unknown verb (not a registered command) — ${snippet}` });
        continue;
      }
      const why = checkFlags ? flagRejection(inv) : null;
      const flag = why?.match(/(--[\w-]+)/)?.[1];
      if (why) out.push({ file: rel, line, token: flag ?? inv.verb, message: `\`gbrain ${inv.verb}\` — ${why} — ${snippet}` });
    }
  }
  return out;
}

function scan(): Violation[] {
  const valid = liveCliVerbs();
  const files = [
    join(ROOT, 'README.md'), ...AGENT_ENTRY_POINTS.map((f) => join(ROOT, f)),
    ...mdFiles(join(ROOT, 'docs')), ...mdFiles(join(ROOT, 'skills')),
  ];
  const out: Violation[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (EXCLUDED.some((e) => rel === e || rel.startsWith(e))) continue;
    out.push(...scanText(rel, readFileSync(file, 'utf-8'), valid));
  }
  return out;
}

const allowed = (v: Violation) => ALLOWLIST[v.file]?.tokens.includes(v.token) ?? false;

describe('#3502 — docs reference only real gbrain commands and flags', () => {
  test('the agent entry points are scanned, flags included', () => {
    for (const f of AGENT_ENTRY_POINTS) expect(FLAG_CHECKED).toContain(f);
    expect(FLAG_CHECKED).toContain('docs/mcp/');
  });

  const violations = scan();

  test('every `gbrain <verb> [--flag]` in README/docs/skills resolves against the live CLI', () => {
    const open = violations.filter((v) => !allowed(v)).map((v) => `${v.file}:${v.line}: ${v.message}`);
    expect(
      open,
      `Docs name gbrain commands/flags the CLI rejects:\n${open.join('\n')}\n\n`
      + 'Fix the doc to the current command (check `gbrain <verb> --help`), or delete the claim if the '
      + `feature is gone. If the example documents an older release, put ${HISTORICAL_MARKER} on the line `
      + `above its code fence (or on the inline-code line).\nRerun: ${RERUN}`,
    ).toEqual([]);
  });

  test('ALLOWLIST has no stale entries', () => {
    const stale = Object.entries(ALLOWLIST).flatMap(([file, { tokens }]) =>
      tokens.filter((t) => !violations.some((v) => v.file === file && v.token === t)).map((t) => `${file}: ${t}`));
    expect(
      stale,
      `These ALLOWLIST entries no longer match a violation — remove them from test/docs-cli-commands.test.ts:\n`
      + `${stale.join('\n')}\nRerun: ${RERUN}`,
    ).toEqual([]);
  });

  test('scanner self-check: unknown verb and unknown flag are caught; the historical marker suppresses', () => {
    const valid = liveCliVerbs();
    const doc = [
      '```bash', 'gbrain notacommand --x', 'gbrain search "q" --no-such-flag', 'gbrain search "q" --limit 5', '```',
      HISTORICAL_MARKER, '```bash', 'gbrain notacommand', '```',
      `Run \`gbrain sync --no-such-flag\`. ${HISTORICAL_MARKER}`,
    ].join('\n');
    const found = scanText('docs/guides/x.md', doc, valid).map((v) => `${v.line}:${v.token}`);
    expect(found).toEqual(['2:notacommand', '3:--no-such-flag']);
  });

  test('the sanity anchors: install is dead, init/put/skillpack are live', () => {
    const valid = liveCliVerbs();
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
