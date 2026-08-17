/**
 * #2185 — known-flags registry generator for CLI_ONLY commands.
 *
 * gbrain's CLI_ONLY commands read flags ad hoc (`args.includes('--force')`,
 * per-command parseFlags helpers), so there is no parser to make strict. The
 * pre-dispatch validator in src/cli.ts needs to know each command's legal
 * flags; this script derives them from the source instead of a hand-typed
 * list that would rot.
 *
 * How: parse handleCliOnly's top-level `case 'X': {` blocks out of src/cli.ts,
 * collect every `import('./commands/Y.ts')` inside each block, then scan the
 * case-block text plus each imported module (plus one level of that module's
 * ./relative same-directory imports) for `--flag` string literals — including
 * help text, which deliberately over-includes: accepting a flag the handler
 * ignores is the pre-#2185 status quo for that flag, while missing a real
 * flag would break working invocations on upgrade.
 *
 * Output: src/core/cli-flag-registry.generated.ts (committed; freshness is
 * pinned by test/cli-flag-validation.test.ts the same way build:llms pins the
 * llms bundles). Regenerate: bun run build:flag-registry
 *
 * Hand-tuning lane: EXTRA_FLAGS below, for flags that live deeper than the
 * one-level scan (add with a comment naming the deep module).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, resolve as resolvePath, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** Flags that live deeper than the one-level module scan. Keep commented. */
const EXTRA_FLAGS: Record<string, string[]> = {
  // embed's pace knobs resolve inside src/core/pace-mode.ts (two levels deep).
  embed: ['--pace', '--pace-max-concurrency'],
  // sync shares the same pace surface via env/config plus CLI passthrough.
  sync: ['--pace', '--pace-max-concurrency'],
};

/**
 * Modules the import scan must SKIP. thin-client-routing.ts is a pure router —
 * its flag literals belong to the commands it routes (takes/search/jobs/cache/
 * quarantine), and each of those declares its own flags in its own case block;
 * scanning the router bleeds takes/quarantine flags into jobs (whose case
 * block imports it for the `jobs stats` thin-client route).
 */
const EXCLUDED_MODULES = ['thin-client-routing.ts'];

function isExcludedModule(p: string): boolean {
  return EXCLUDED_MODULES.some(m => p.endsWith(`/${m}`));
}

/** Universal helper flags every command may see (parsed or short-circuited upstream). */
const UNIVERSAL_FLAGS = ['--help', '--json', '--brain', '--source'];

const FLAG_RE = /--[a-z0-9][a-z0-9-]*/g;

function flagsInText(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(FLAG_RE)) {
    // Template-literal prefixes (`--bound-${key}` scans as `--bound-`) are
    // not real flags — a trailing hyphen would make the validator accept
    // every typo sharing the prefix.
    if (!m[0].endsWith('-')) out.add(m[0]);
  }
  return out;
}

/** One level of ./relative imports (static or dynamic) from a module's source.
 *  TYPE-ONLY imports are skipped: they carry no runtime behavior the command
 *  can consume, so their doc-comment prose must not register flags (observed:
 *  `import type { BrainEngine } from engine.ts` handed skillpack 10 phantom
 *  flags from engine.ts's comments — the 4th prose-bleed incident). */
function relativeImports(src: string, fromDir: string): string[] {
  const scanSrc = src.replace(/import\s+type\s+[^;]+;/g, '');
  const paths = new Set<string>();
  for (const m of scanSrc.matchAll(/from\s+'(\.\.?\/[^']+\.ts)'/g)) paths.add(m[1]);
  for (const m of scanSrc.matchAll(/import\('(\.\.?\/[^']+\.ts)'\)/g)) paths.add(m[1]);
  return [...paths]
    .map(p => resolvePath(fromDir, p))
    .filter(p => existsSync(p) && !isExcludedModule(p))
    .flatMap(p => [p, ...facadeExpansion(p)]);
}

/**
 * Peeled façade files (containment sprint) whose flag-bearing text moved into
 * sibling module dirs. Before the peels, that text lived inside the façade
 * itself and rode the one-level walk; scanning the façade now pulls its
 * modules back in so a peel can never silently shrink a command's flag set.
 */
function facadeExpansion(p: string): string[] {
  const rel = p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
  const collect = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...collect(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  };
  if (rel === 'src/core/operations.ts') return collect(join(ROOT, 'src/core/ops'));
  if (rel === 'src/commands/doctor.ts') return collect(join(ROOT, 'src/commands/doctor'));
  if (rel === 'src/commands/skillpack.ts') return collect(join(ROOT, 'src/commands/skillpack'));
  if (rel === 'src/commands/sync.ts') {
    // Only the modules PEELED OUT of sync.ts (their text used to live inside
    // it). Pre-existing sync-* siblings were always ordinary deps — sweeping
    // them in here would widen surfaces that never saw their text.
    const peeled = [
      'sync-cost-gate.ts',
      'sync-git.ts',
      'sync-anchor.ts',
      'sync-lock.ts',
      'sync-reconcile.ts',
      'sync-status-report.ts',
    ];
    return peeled.map(f => join(ROOT, 'src/core', f)).filter(p => existsSync(p));
  }
  return [];
}

export function buildFlagRegistry(): Record<string, string[]> {
  const cliSource = readFileSync(join(ROOT, 'src/cli.ts'), 'utf-8');

  // CLI_ONLY membership (the single source of truth in src/cli.ts). Strip
  // line comments first — the set literal carries commentary whose quoted
  // words ('Unknown command', 'pages') must not parse as members.
  const onlyMatch = cliSource.match(/const CLI_ONLY = new Set(?:<string>)?\(\[([\s\S]*?)\]\)/);
  if (!onlyMatch) throw new Error('CLI_ONLY set not found in src/cli.ts');
  const onlyBody = onlyMatch[1].replace(/\/\/[^\n]*/g, '');
  const commands = [...onlyBody.matchAll(/'([^']+)'/g)].map(m => m[1]);

  // handleCliOnly body — bounded at the function's closing brace (column 0).
  // Unbounded, the LAST case block absorbed every --flag literal in the rest
  // of cli.ts (printHelp's full flag surface included), handing whichever
  // command sits last in the switch a ~100-flag junk allowlist that made
  // strict validation a no-op for it.
  const fnStart = cliSource.indexOf('async function handleCliOnly');
  if (fnStart < 0) throw new Error('handleCliOnly not found in src/cli.ts');
  const fnTail = cliSource.slice(fnStart);
  const fnEndRel = fnTail.search(/\n\}\n/);
  const fnSrc = fnEndRel > 0 ? fnTail.slice(0, fnEndRel) : fnTail;

  // handleCliOnly dispatches through TWO styles: an `if (command === 'X')`
  // chain (DB-free commands like init/auth/schema) and a switch with
  // `case 'X':` labels. Segment on BOTH marker kinds; the text between a
  // marker and the next marker belongs to that label.
  const markRe = /(?:^\s*if \(command === '([a-z0-9-]+)'\)|^      case '([a-z0-9-]+)':)/gm;
  const marks: Array<{ label: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markRe.exec(fnSrc)) !== null) {
    marks.push({ label: (m[1] ?? m[2])!, start: m.index });
  }

  const blocks = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : fnSrc.length;
    const body = fnSrc.slice(marks[i].start, end);
    // Fall-through labels share the following block.
    blocks.set(marks[i].label, (blocks.get(marks[i].label) ?? '') + body);
  }

  // Safety flags carry destructive-bypass semantics: allowlisting one that
  // the handler never reads recreates the #2185 repro (`post-upgrade
  // --dry-run` accepted, ignored, migrations run for real). Presence isn't
  // enough — upgrade.ts prints a HINT naming another command's --dry-run,
  // which is depth-0 text for post-upgrade. These flags are only legal with
  // CONSUMPTION evidence in the command's own code: the flag as a TIGHT-QUOTED
  // standalone literal (`includes('--dry-run')`, `has('--dry-run')`,
  // `=== '--dry-run'`). Prose bleed embeds the flag inside a longer string, so
  // it never has quotes on both sides of the bare flag.
  const SAFETY_FLAGS = new Set(['--dry-run']);
  const consumes = (text: string, flag: string): boolean =>
    new RegExp(`['"\`]${flag}['"\`]`).test(text);

  const registry: Record<string, string[]> = {};
  for (const command of commands) {
    const block = blocks.get(command) ?? '';
    const flags = new Set<string>(UNIVERSAL_FLAGS);
    const depthZero = new Set<string>();
    let depthZeroText = block;
    for (const f of flagsInText(block)) { flags.add(f); depthZero.add(f); }

    // Modules imported inside the case block, plus one level of each module's
    // own ./relative imports.
    const commandModules = [...block.matchAll(/import\('(\.\/[^']+\.ts)'\)/g)]
      .map(mm => resolvePath(join(ROOT, 'src'), mm[1]))
      .filter(p => existsSync(p) && !isExcludedModule(p));
    for (const modPath of commandModules) {
      // A command module that IS a peeled façade counts its module files as
      // part of itself: their text scans at module depth and THEIR relative
      // imports scan at dep depth — exactly the pre-peel walk.
      const surface = [modPath, ...facadeExpansion(modPath)];
      for (const sfPath of surface) {
        const sfSrc = readFileSync(sfPath, 'utf-8');
        depthZeroText += sfSrc;
        for (const f of flagsInText(sfSrc)) { flags.add(f); depthZero.add(f); }
        for (const dep of relativeImports(sfSrc, dirname(sfPath))) {
          for (const f of flagsInText(readFileSync(dep, 'utf-8'))) flags.add(f);
        }
      }
    }

    for (const f of EXTRA_FLAGS[command] ?? []) { flags.add(f); depthZero.add(f); }
    for (const f of SAFETY_FLAGS) {
      if (flags.has(f) && !consumes(depthZeroText, f)) flags.delete(f);
    }
    registry[command] = [...flags].sort();
  }
  return registry;
}

export function renderRegistryModule(registry: Record<string, string[]>): string {
  const entries = Object.keys(registry)
    .sort()
    .map(cmd => `  '${cmd}': [${registry[cmd].map(f => `'${f}'`).join(', ')}],`)
    .join('\n');
  return `// AUTO-GENERATED by scripts/generate-flag-registry.ts — do not edit by hand.
// Regenerate: bun run build:flag-registry
// Freshness + drift pinned by test/cli-flag-validation.test.ts (#2185).
//
// Merge conflict here? Do not hand-merge it. This file is regenerated on most
// upstream waves, so a branch that also regenerates it conflicts on the whole
// body. Take the base branch's copy wholesale, then re-run the command above —
// the freshness test named above fails loudly if that regeneration was done
// against the wrong base.
//
// Per-command legal flags for CLI_ONLY commands, derived from each command's
// source (case block + imported modules + one level of relative imports +
// scripts/generate-flag-registry.ts EXTRA_FLAGS). Deliberately over-inclusive
// (help-text mentions count): accepting an ignored flag is the pre-#2185
// status quo; missing a real one breaks working invocations.
export const CLI_FLAG_REGISTRY: Record<string, readonly string[]> = {
${entries}
};
`;
}

if (import.meta.main) {
  const registry = buildFlagRegistry();
  const outPath = join(ROOT, 'src/core/cli-flag-registry.generated.ts');
  writeFileSync(outPath, renderRegistryModule(registry));
  const n = Object.keys(registry).length;
  const total = Object.values(registry).reduce((a, v) => a + v.length, 0);
  console.log(`wrote ${outPath} (${n} commands, ${total} flag entries)`);
}
