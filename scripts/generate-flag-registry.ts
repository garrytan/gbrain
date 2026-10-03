/**
 * #2185 — known-flags registry generator for CLI_ONLY commands.
 *
 * gbrain's CLI_ONLY commands read flags ad hoc (`args.includes('--force')`,
 * per-command parseFlags helpers), so there is no parser to make strict. The
 * pre-dispatch validator in src/cli.ts needs to know each command's legal
 * flags; this script derives them from the source instead of a hand-typed
 * list that would rot.
 *
 * How: per CLI_ONLY command (one record in src/cli/command-table.ts), gather
 * its dispatch text: the record's module under src/cli/commands/ (the former
 * `case 'X':` / plain `if (command === 'X')` body, moved verbatim in refactor
 * wave 1) plus every block of the explicit handleCliOnly pipeline in
 * src/cli.ts (handleCliOnly and its @cliPipelineStage functions, see
 * scripts/lib/cli-pipeline.ts) segmented on its dispatch markers — every
 * `if (command === 'X' …)` head, plain or compound, and `case 'X':` labels (see
 * segmentDispatchBlocks). Collect every `import('…/commands/Y.ts')` in that
 * text, then scan the text plus each imported module (plus one level of that
 * module's ./relative same-directory imports) for `--flag` string literals. `//` and
 * `/* *\/` comments are stripped at EVERY depth before the scan (prose is not
 * consumption; see stripComments) — a helper's doc comment must not legalise a
 * flag for a command that merely imports one function from it. String
 * literals include help text, which deliberately over-includes: accepting a flag the handler
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
import { dirname, resolve as resolvePath, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { flattenCliPipeline, parseSource, readCommandModule, readTableRecords } from './lib/cli-pipeline.ts';

/** Read source with CRLF normalized to LF: the parser's block-boundary and
 *  comment-strip regexes are LF-anchored (`\n}\n`, `//[^\n]*`), so Windows
 *  checkouts (autocrlf=true) would otherwise widen scan windows and inflate
 *  the last command's flag list. Deterministic on every platform. */
function readSrc(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** Flags that live deeper than the one-level module scan. Keep commented. */
const EXTRA_FLAGS: Record<string, string[]> = {
  // embed's pace knobs resolve inside src/core/pace-mode.ts (two levels deep).
  embed: ['--pace', '--pace-max-concurrency'],
  // sync shares the same pace surface via env/config plus CLI passthrough.
  sync: ['--pace', '--pace-max-concurrency'],
  // Deferred persistence routing reaches runForget in recall.ts two levels deep.
  forget: ['--reason', '--request-id'],
};

/**
 * Modules the import scan must SKIP. thin-client-routing.ts is a pure router —
 * its flag literals belong to the commands it routes (takes/search/jobs/cache/
 * quarantine), and each of those declares its own flags in its own case block;
 * scanning the router bleeds takes/quarantine flags into jobs (whose case
 * block imports it for the `jobs stats` thin-client route). ownership.ts
 * contains writer-transfer recovery instructions; those flags belong to the
 * sources command, not doctor checks that inspect ownership. job-isolation.ts
 * builds the INTERNAL `jobs run-child` argv (`--job-id`, `--allow-shell-jobs`):
 * those literals are what a worker passes to its child, not flags an importer
 * parses — autopilot imports it only to resolve the child CLI, and `jobs`
 * declares both flags in its own source.
 */
const EXCLUDED_MODULES = ['thin-client-routing.ts', 'persistence-delegate.ts', 'job-isolation.ts', 'ownership.ts'];

function isExcludedModule(p: string): boolean {
  // Basename comparison is path-separator agnostic: on Windows p ends in
  // '\\thin-client-routing.ts' so endsWith('/thin-client-routing.ts') is
  // false and the skip silently no-ops, inflating every command that
  // imports the router with its flags.
  return EXCLUDED_MODULES.some(m => p.split(/[\\/]/).pop() === m);
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
  // Compare in forward-slash space: on Windows p uses '\\' separators and
  // would never match the relative-path constants below, silently skipping
  // the peeled-module expansion. Same cross-platform drift class as the
  // isExcludedModule separator check above.
  const rel = (p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p).replace(/\\/g, '/');
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
  if (rel === 'src/commands/migrate-embeddings.ts') return [join(ROOT, 'src/core/embedding-migration-cli.ts')];
  if (rel === 'src/commands/mcp.ts') return [
    join(ROOT, 'src/commands/mcp-admin.ts'),
    join(ROOT, 'src/commands/mcp-admin-http.ts'),
  ];
  if (rel === 'src/commands/doctor.ts') return collect(join(ROOT, 'src/commands/doctor'));
  if (rel === 'src/commands/decide.ts') return collect(join(ROOT, 'src/commands/decide'));
  // Refactor wave 1 (W4 serve-http) peeled runServeHttp into flat
  // serve-http-<area>.ts modules; their text (e.g. the expired-magic-link
  // page's `--url` / `--oauth-request` hint) used to live in serve-http.ts.
  if (rel === 'src/commands/serve-http.ts') {
    return ['oauth', 'metrics', 'admin-api', 'spa', 'mcp', 'webhooks']
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
      .map(m => join(ROOT, `src/commands/serve-http-${m}.ts`))
      .filter(p => existsSync(p));
  }
  // Refactor wave 1 (W3): the MIGRATIONS array moved to one file per migration.
  if (rel === 'src/core/migrate.ts') return collect(join(ROOT, 'src/core/schema-migrations'));
  if (rel === 'src/commands/skillpack.ts') return collect(join(ROOT, 'src/commands/skillpack'));
  // connectors is a peeled command dir (index.ts dispatches to auth/sync/status);
  // scan the whole dir at module depth so a safety flag consumed in a subcommand
  // module (sync.ts: `=== '--dry-run'`) carries its evidence into depth-zero.
  if (rel === 'src/commands/connectors/index.ts') return collect(join(ROOT, 'src/commands/connectors'));
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
    // Refactor wave 1 moves sync's phases into src/commands/sync/; that dir's
    // text is sync.ts's own text, so it joins the surface from its first file.
    return [
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
      ...peeled.map(f => join(ROOT, 'src/core', f)).filter(p => existsSync(p)),
      ...collect(join(ROOT, 'src/commands/sync')),
    ];
  }
  // Refactor wave 1 subcommand tables for jobs/autopilot (cut-line) land in
  // same-named command dirs; empty until those peels happen.
  if (rel === 'src/commands/jobs.ts') {
    // The built-in handler bodies registerBuiltinHandlers used to hold inline
    // moved to src/core/minions/handlers/ (W4 jobs). Only those modules: the
    // directory's pre-existing handlers (shell, subagent, ...) were always
    // ordinary deps, so globbing it would widen jobs' surface.
    const peeledHandlers = [
      'autopilot-cycle.ts', 'autopilot-global-maintenance.ts', 'backlinks.ts', 'chronicle-extract.ts',
      'cycle-phase.ts', 'embed-catch-up.ts', 'embed.ts', 'enrich.ts', 'extract-atoms-drain.ts',
      'extract-conversation-facts.ts', 'extract-ner.ts', 'extract-takes-from-pages.ts',
      'extract-timeline-from-meetings.ts', 'extract.ts', 'facts-absorb.ts', 'import.ts',
      'integrity-auto.ts', 'integrity.ts', 'job-pull.ts', 'lint-fix.ts', 'lint.ts', 'loops-extract.ts',
      'orphans.ts', 'purge.ts', 'reindex.ts', 'repair-jsonb.ts', 'sync-retry-failed.ts', 'sync.ts',
      'unify-types.ts',
    ];
    return [
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
      ...peeledHandlers.map(f => join(ROOT, 'src/core/minions/handlers', f)).filter(p => existsSync(p)),
      ...collect(join(ROOT, 'src/commands/jobs')),
    ];
  }
  if (rel === 'src/commands/autopilot.ts') {
    // W4 autopilot split runAutopilot's daemon into flat autopilot-*.ts
    // siblings (the existing autopilot-fanout/-pause convention). Only the
    // modules peeled out of autopilot.ts: pre-existing siblings were always
    // ordinary deps, so a glob would widen the surface.
    const peeled = ['autopilot-daemon.ts', 'autopilot-dispatch.ts', 'autopilot-probes.ts'];
    return [
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
      ...peeled.map(f => join(ROOT, 'src/commands', f)).filter(p => existsSync(p)),
      ...collect(join(ROOT, 'src/commands/autopilot')),
    ];
  }
  return [];
}

/**
 * A block-level `import('./commands/X.ts')` whose destructured bindings are
 * ALL SCREAMING_CASE constants borrows a value (a message string), not a
 * handler — `const { THIN_CLIENT_REGISTER_MESSAGE } = await import(
 * './commands/agent-register.ts')` in the agent-register pre-connect guard.
 * Promoting such a module to depth zero scans its one-level deps
 * (sources-ops / config / auth / oauth-provider …) as if the command owned
 * them: that handed the agent row 38 phantom flags (--confirm-destructive,
 * --force, --remove, …). The handler proper (`const { runX } = …`) still
 * reaches the module through its own import walk, so no real flag is lost.
 */
export function isValueOnlyImport(block: string, importIndex: number): boolean {
  const lineStart = block.lastIndexOf('\n', importIndex) + 1;
  const head = block.slice(lineStart, importIndex);
  const m = head.match(/const\s*\{([^}]*)\}\s*=\s*await\s*$/);
  if (!m) return false;
  const bindings = m[1].split(',').map(b => b.trim()).filter(b => b.length > 0);
  return bindings.length > 0 && bindings.every(b => /^[A-Z][A-Z0-9_]*$/.test(b));
}

/**
 * Segment handleCliOnly's body into per-command text blocks.
 *
 * handleCliOnly dispatches through TWO styles: an `if (command === 'X')`
 * chain (DB-free commands like init/auth/schema) and a switch with
 * `case 'X':` labels. Segment on BOTH marker kinds; the text between a
 * marker and the next marker belongs to that label. Repeated labels
 * (fall-through cases, a command with several `if` branches) union their
 * blocks.
 *
 * The `if` chain has THREE shapes, and every one is a marker for X:
 *   if (command === 'X') {                        plain
 *   if (command === 'X' && args[0] === 'sub') {   compound — the sub-owned
 *                                                 no-DB bypasses (eval
 *                                                 longmemeval / brainbench /
 *                                                 …), the `<cmd> --help`
 *                                                 pre-engine branches, agent
 *                                                 register
 *   if (\n    command === 'X' &&\n    (...)       multi-line compound
 * Invariant: ownership follows the `command === 'X'` head, never the
 * condition's tail. Pre-fix only the plain shape matched, so a compound
 * block's text was attributed to the PRECEDING marker: every `eval <sub>`
 * bypass landed on `dream`, every `<cmd> --help` bypass on `status`, and the
 * eval row lacked --retrieval-only/--by-type/--no-trajectory/--keyword-only —
 * the documented `gbrain eval longmemeval` invocation exited 1 as an unknown
 * flag. `[ \t]*` (not `\s*`) keeps the marker anchored to its own line; `\(\s*`
 * lets the multi-line shape's newline through. A bare `command === 'X'` inside
 * a non-`if` expression (the serve `degradable` const) is deliberately NOT a
 * marker.
 */
/**
 * Strip `//` line comments and `/* … *\/` block comments from a block's
 * text, preserving newlines (so line-anchored scans such as isValueOnlyImport
 * still see the same line structure) and leaving string / template literals
 * intact (a `'https://…'` literal is not a comment). Prose in a comment is not
 * evidence a command reads a flag: cli.ts's `reindex --help` comment ("…the
 * --multimodal flags the dispatcher parses") handed the PRECEDING marker
 * (storage) a phantom --multimodal because the comment sat between the two
 * markers. Regex literals are not modelled — `//` inside one would truncate
 * that line — which is acceptable for dispatch-block text (none there today).
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      // Keep the newlines the comment spanned so line structure survives.
      out += src.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j++;
        else if (quote !== '`' && src[j] === '\n') break; // unterminated: stop at EOL
        j++;
      }
      out += src.slice(i, Math.min(n, j + 1));
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function segmentDispatchBlocks(fnSrc: string): Map<string, string> {
  const markRe = /(?:^[ \t]*if \(\s*command === '([a-z0-9-]+)'|^      case '([a-z0-9-]+)':)/gm;
  const marks: Array<{ label: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markRe.exec(fnSrc)) !== null) {
    marks.push({ label: (m[1] ?? m[2])!, start: m.index });
  }

  const blocks = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : fnSrc.length;
    // Comments are prose, not consumption: strip them before any flag scan.
    const body = stripComments(fnSrc.slice(marks[i].start, end));
    // Fall-through labels share the following block.
    blocks.set(marks[i].label, (blocks.get(marks[i].label) ?? '') + body);
  }
  return blocks;
}

/** @param root repository root; a fixture tree in tests (test/cli-synthetic-command.test.ts). */
export function buildFlagRegistry(root: string = ROOT): Record<string, string[]> {
  // CLI_ONLY membership: one record per command in the command table
  // (src/cli/command-table.ts), read by AST so the generator never executes
  // the table.
  const records = readTableRecords(root);
  const commands = records.map(r => r.name);

  // Dispatch text per command, from two sources (refactor wave 1, W4 cli):
  //  1. the explicit handleCliOnly pipeline in src/cli.ts: handleCliOnly and
  //     every @cliPipelineStage function it calls, each segmented on its own
  //     (bounded at the function, so no function's tail bleeds into the next;
  //     unbounded, the LAST block once absorbed every --flag literal in the
  //     rest of cli.ts, printHelp included, a ~100-flag junk allowlist);
  //  2. each record's module under src/cli/commands/ (the former plain
  //     `if (command === 'x')` branch or switch case, moved verbatim).
  // Import specifiers resolve relative to the file the text came from.
  const blocks = new Map<string, Array<{ text: string; dir: string }>>();
  const addBlock = (label: string, text: string, dir: string) => blocks.set(label, [...(blocks.get(label) ?? []), { text, dir }]);
  const pipeline = flattenCliPipeline(parseSource(root, 'src/cli.ts'));
  for (const fn of [pipeline.entry, ...pipeline.stages]) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
    for (const [label, text] of segmentDispatchBlocks(fn.getText())) addBlock(label, text, join(root, 'src'));
  }
  for (const record of records) {
    const mod = record.loadSpecifier ? readCommandModule(root, record.loadSpecifier) : null;
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- mod.path comes from the repo's own command table literal import specifiers; build-time only
    if (mod) addBlock(record.name, stripComments(readSrc(join(root, mod.path))), dirname(join(root, mod.path)));
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
  const SAFETY_FLAGS = new Set(['--dry-run', '--allow-noncanonical-root']);
  // Reindex scope/mode flags can bleed through upgrade's imported modules even
  // though upgrade does not forward them. Require direct consumption on the
  // affected dispatch surfaces so callers never get silently ignored selectors.
  const SCOPING_FLAGS_BY_COMMAND: Record<string, string[]> = {
    reindex: ['--type'],
    upgrade: ['--type', '--aliases'],
    'post-upgrade': ['--type', '--aliases'],
  };
  const consumes = (text: string, flag: string): boolean =>
    new RegExp(`['"\`]${flag}['"\`]`).test(text);

  const registry: Record<string, string[]> = {};
  for (const command of commands) {
    const parts = blocks.get(command) ?? [];
    const flags = new Set<string>(UNIVERSAL_FLAGS);
    const depthZero = new Set<string>();
    let depthZeroText = parts.map(p => p.text).join('');
    for (const f of flagsInText(depthZeroText)) { flags.add(f); depthZero.add(f); }

    // COMMAND modules imported inside the case block (`./commands/*.ts`
    // only), plus one level of each module's own ./relative imports. Core
    // helpers a dispatch block reaches for directly (`./core/bootstrap/
    // uninstall.ts` in the agent-register pre-connect guard, `./core/
    // doctor-remote.ts`, `./core/ai/gateway.ts`, …) are NOT command modules:
    // scanning them as one handed the agent row ~45 phantom flags from the
    // uninstall command's surface (--delete-brain, --confirm-destructive,
    // --break-lock, --force, --remove) the moment the compound
    // `command === 'agent' && args[0] === 'register'` head became a marker.
    // A flag a block consumes through a core helper is already a literal in
    // the block's own text (depth zero); the helper's prose adds nothing.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
    const commandsDir = join(root, 'src', 'commands');
    const commandModules = parts.flatMap(({ text, dir }) => [...text.matchAll(/import\('(\.\.?\/[^']+\.ts)'\)/g)]
      .filter(mm => !isValueOnlyImport(text, mm.index ?? 0))
// nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- resolves literal relative import specifiers found in this repo's own source; results are filtered to src/commands below
      .map(mm => resolvePath(dir, mm[1])))
      .filter(p => p.startsWith(commandsDir + sep) && existsSync(p) && !isExcludedModule(p));
    for (const modPath of commandModules) {
      // A command module that IS a peeled façade counts its module files as
      // part of itself: their text scans at module depth and THEIR relative
      // imports scan at dep depth — exactly the pre-peel walk.
      const surface = [modPath, ...facadeExpansion(modPath)];
      for (const sfPath of surface) {
        const sfSrc = readSrc(sfPath);
        // Comments are prose at every depth, not just in the dispatch block:
        // a helper's doc comment ("Used by --fresh + after manual reset" in
        // backfill-base.ts) handed reindex-search-vector a --fresh it never
        // parses the moment the command imported one function from it.
        // Consumed flags are always string literals, so stripping can only
        // remove phantoms.
        const sfCode = stripComments(sfSrc);
        depthZeroText += sfCode;
        for (const f of flagsInText(sfCode)) { flags.add(f); depthZero.add(f); }
        for (const dep of relativeImports(sfSrc, dirname(sfPath))) {
          for (const f of flagsInText(stripComments(readSrc(dep)))) flags.add(f);
        }
      }
    }

    for (const f of EXTRA_FLAGS[command] ?? []) { flags.add(f); depthZero.add(f); }
    for (const f of SAFETY_FLAGS) {
      if (flags.has(f) && !consumes(depthZeroText, f)) flags.delete(f);
    }
    for (const f of SCOPING_FLAGS_BY_COMMAND[command] ?? []) {
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
