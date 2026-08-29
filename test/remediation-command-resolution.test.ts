/**
 * #3697 — remediation text must name commands that actually resolve.
 *
 * Error messages, hints, and CHANGELOG "To take advantage" blocks routinely
 * rotted into naming commands that do not exist (`gbrain extract status
 * --rebuild-rollup`), flags the command never parses (`gbrain think --ab`,
 * `gbrain embed --source-id`), or subcommands that were never wired
 * (`gbrain takes nudge --hush`). Remediation text is the one string nobody
 * ever runs: it is emitted only on a failure path and read only by someone
 * already stuck — so it rots silently, in the worst possible place.
 *
 * Two mechanical gates (classes 1/2/4 of the issue; class 3 — a command that
 * runs but lies — needs scenario tests and review discipline, see
 * scripts/check-test-discriminates.sh and CONTRIBUTING.md's Discrimination
 * test field from #3665):
 *
 *   1. CHANGELOG (topmost entry only): every `gbrain <verb>` in fenced code /
 *      inline spans resolves to a live command. Historical entries document
 *      their era's CLI and are never rewritten (CLAUDE.md), so only the entry
 *      being shipped is gated — rot is caught while the author is still here.
 *
 *   2. src remediation strings: any string in src TS files that names
 *      `gbrain <verb> ... --flag` must use a verb that resolves AND flags
 *      present in that command's CLI_FLAG_REGISTRY row. The registry is
 *      deliberately over-inclusive (help-text mentions count), so a flag it
 *      does not know for that command is a strong rot signal. Verbs without
 *      any --flag in the same string are NOT gated (prose like "this gbrain
 *      build expects" would drown the signal) — documented limitation.
 *
 * The companion sibling is test/docs-cli-commands.test.ts (#3502), which
 * gates verbs in README/docs/skills.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { CLI_ONLY, cliAliases } from '../src/cli.ts';
import { operations } from '../src/core/operations.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';

const ROOT = dirname(import.meta.dir);

function validCommands(): Set<string> {
  const valid = new Set<string>(CLI_ONLY);
  for (const op of operations) {
    const name = op.cliHints?.name;
    if (name && !op.cliHints?.hidden) valid.add(name);
  }
  for (const alias of cliAliases.keys()) valid.add(alias);
  return valid;
}

/** Flags accepted globally (parsed before command dispatch) or so widely
 *  shared that a per-command registry miss would be a false positive. */
const GLOBAL_FLAGS = new Set([
  '--help', '--json', '--quiet', '--progress-json', '--progress-interval', '--brain',
]);

/**
 * Known registry gaps: the command genuinely parses the flag but the
 * generated registry row misses it (regenerating the registry is a separate
 * scripts/ concern). Keyed `verb → flags`. Keep this SHORT — every entry
 * should cite where the flag is actually parsed.
 */
const REGISTRY_GAPS: Record<string, string[]> = {
  // init.ts:~3130 parses `--repo` (args.find((a, i) => args[i-1] === '--repo')).
  'init': ['--repo'],
};

// ── Gate 1: CHANGELOG topmost entry ─────────────────────────────────────────

/**
 * Already-shipped rot in the CURRENT top entry, allowlisted because
 * historical entries are never rewritten (CLAUDE.md). Each entry falls out
 * of gate scope automatically when the next release pushes a new top entry —
 * prune it from here then.
 */
const CHANGELOG_ALLOWLIST = new Set([
  // v0.46.25.0 wrote `gbrain migrate-engine`; the real grammar is
  // `gbrain migrate --to <engine>` (migrate-engine.ts is the module name,
  // not the command).
  'migrate-engine',
]);

function topChangelogEntry(): string {
  const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf-8');
  const first = text.indexOf('\n## [');
  if (first === -1) return '';
  const second = text.indexOf('\n## [', first + 1);
  return second === -1 ? text.slice(first) : text.slice(first, second);
}

function commandPosition(prefix: string): boolean {
  const p = prefix.trimEnd();
  return p === '' || /[|;&`(={[]$/.test(p) || /\$$/.test(p);
}

function scanChangelogTopEntry(): string[] {
  const valid = validCommands();
  const violations: string[] = [];
  const lines = topChangelogEntry().split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; continue; }
    const candidates: string[] = [];
    if (inFence) {
      const t = l.trim();
      if (/^(#|\/\/|--|\*)/.test(t)) continue;
      candidates.push(l);
    } else {
      for (const m of l.matchAll(/`(gbrain [^`]+)`/g)) candidates.push(m[1]!);
    }
    for (const code of candidates) {
      for (const m of code.matchAll(/\bgbrain\s+([A-Za-z][\w-]*)/g)) {
        const verb = m[1]!;
        if (!/^[a-z][a-z0-9_-]{2,}$/.test(verb)) continue;
        if (!commandPosition(code.slice(0, m.index))) continue;
        if (valid.has(verb)) continue;
        if (CHANGELOG_ALLOWLIST.has(verb)) continue;
        violations.push(`CHANGELOG.md (top entry): \`gbrain ${verb}\` is not a real command — ${code.trim().slice(0, 90)}`);
      }
    }
  }
  return violations;
}

// ── Gate 2: src remediation strings ─────────────────────────────────────────

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

const SRC_EXCLUDED = [
  'src/commands/migrations/',    // historical: each names its era's CLI
];

function srcExcluded(rel: string): boolean {
  if (SRC_EXCLUDED.some((e) => rel.startsWith(e))) return true;
  if (rel.endsWith('.generated.ts')) return true;      // fix the generator's inputs, not the output
  if (rel.endsWith('schema-embedded.ts')) return true; // generated from src/schema.sql (which IS scanned via this file's strings? no — sql comments; gated by hand-fix #3697)
  return false;
}

function scanSrcStrings(): string[] {
  const valid = validCommands();
  const violations: string[] = [];
  for (const file of tsFiles(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file);
    if (srcExcluded(rel)) continue;
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const t = l.trim();
      if (/^(\/\/|\*|\/\*|--)/.test(t)) continue;   // TS comments + SQL comment lines
      if (!/['"`]/.test(l)) continue;               // only string-bearing lines
      // Tail stops at quote/backtick so we never leak across string boundaries.
      for (const m of l.matchAll(/\bgbrain\s+([a-z][a-z0-9_-]{2,})\b([^'"`\n]*)/g)) {
        const verb = m[1]!;
        // Prose separators end the command: an em-dash clause or a new
        // sentence after the mention is instruction text, not the command's
        // own argv ("...gbrain binary path — pass --gbrain-bin ...").
        const tail = (m[2] ?? '').split(/\s—\s|\.\s|;\s|\?\s|!\s/)[0]!;
        const flags = [...tail.matchAll(/--[a-z][a-z0-9-]*/g)].map((f) => f[0]);
        if (flags.length === 0) continue; // prose-mention; not gated (see header)
        if (!valid.has(verb)) {
          violations.push(`${rel}:${i + 1}: \`gbrain ${verb}\` is not a real command — ${t.slice(0, 100)}`);
          continue;
        }
        const registry = (CLI_FLAG_REGISTRY as Record<string, readonly string[]>)[verb];
        if (!registry) continue; // op-dispatched commands map flags to op params
        for (const flag of flags) {
          if (registry.includes(flag)) continue;
          if (GLOBAL_FLAGS.has(flag)) continue;
          if (REGISTRY_GAPS[verb]?.includes(flag)) continue;
          violations.push(`${rel}:${i + 1}: \`gbrain ${verb} ... ${flag}\` — flag not in ${verb}'s registry row — ${t.slice(0, 100)}`);
        }
      }
    }
  }
  return violations;
}

describe('#3697 — remediation text resolves against the live CLI surface', () => {
  test('CHANGELOG top entry: every gbrain verb resolves', () => {
    const violations = scanChangelogTopEntry();
    expect(
      violations,
      `The entry being shipped names gbrain commands that do not resolve:\n${violations.join('\n')}\n` +
      `Fix the command text (or, if the command should exist, wire it).`,
    ).toEqual([]);
  });

  test('src strings: every `gbrain <verb> --flag` uses a real verb + registered flags', () => {
    const violations = scanSrcStrings();
    expect(
      violations,
      `Remediation strings name commands/flags that do not resolve:\n${violations.join('\n')}\n` +
      `Fix the string, or add a cited entry to REGISTRY_GAPS if the generated registry is missing a real flag.`,
    ).toEqual([]);
  });

  // The scanner must actually catch the classes it exists for — otherwise this
  // gate is itself the #3665 pattern (an assertion nobody checks discriminates).
  test('scanner self-check: the historical rot shapes would have been caught', () => {
    // fake verb: never a command
    expect(validCommands().has('reinit-everything')).toBe(false);
    // fake flag on a real verb: the shipped #3697 instances. If a future
    // registry regen adds these flags, the commands grew them for real and
    // this pin should flip WITH the hint text.
    const think = (CLI_FLAG_REGISTRY as Record<string, readonly string[]>)['think'];
    expect(think).toBeDefined();
    expect(think!.includes('--ab')).toBe(false);
    const embed = (CLI_FLAG_REGISTRY as Record<string, readonly string[]>)['embed'];
    expect(embed).toBeDefined();
    expect(embed!.includes('--source-id')).toBe(false);
  });
});
