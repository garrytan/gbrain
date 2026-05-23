// `gbrain schema` CLI surface.
//
// The active schema pack drives type inference, link verbs, expert
// routing, extractable types, enrichment rubrics, and per-source
// closure for search. See `src/core/schema-pack/load-active.ts` for
// the boundary helper that all engines + operations consume.
//
// Verbs are grouped by lifecycle:
//   Read-only inspection: active, list, show, validate, graph, lint,
//                         stats, explain, usage
//   Activation:           use, downgrade
//   Authoring:            init, fork, edit, diff, add-type, remove-type
//   Discovery + repair:   detect, suggest, review-candidates,
//                         review-orphans, sync

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  loadActivePack,
  resolveActivePackNameOnly,
  loadPackFromFile,
  parseSchemaPackManifest,
  SchemaPackManifestError,
  SchemaPackLoaderError,
  UnknownPackError,
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../core/schema-pack/index.ts';
import type { SchemaPackManifest } from '../core/schema-pack/manifest-v1.ts';
import { gbrainPath, loadConfig, configPath } from '../core/config.ts';

export async function runSchema(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'active':   return runActive(args.slice(1));
    case 'list':     return runList(args.slice(1));
    case 'show':     return runShow(args.slice(1));
    case 'validate': return runValidate(args.slice(1));
    case 'use':      return runUse(args.slice(1));
    case 'detect':   return runDetectCmd(args.slice(1));
    case 'suggest':  return runSuggestCmd(args.slice(1));
    case 'review-candidates': return runReviewCandidatesCmd(args.slice(1));
    case 'init':     return runInitCmd(args.slice(1));
    case 'fork':     return runForkCmd(args.slice(1));
    case 'edit':     return runEditCmd(args.slice(1));
    case 'diff':     return runDiffCmd(args.slice(1));
    case 'graph':    return runGraphCmd(args.slice(1));
    case 'lint':     return runLintCmd(args.slice(1));
    case 'explain':  return runExplainCmd(args.slice(1));
    case 'review-orphans': return runReviewOrphansCmd(args.slice(1));
    case 'downgrade': return runDowngradeCmd(args.slice(1));
    case 'usage':    return runUsageCmd(args.slice(1));
    case 'stats':    return runStatsCmd(args.slice(1));
    case 'sync':     return runSyncCmd(args.slice(1));
    case 'add-type': return runAddTypeCmd(args.slice(1));
    case 'remove-type': return runRemoveTypeCmd(args.slice(1));
    case undefined:
    case '--help':
    case '-h':
      return printHelp();
    default:
      console.error(`Unknown schema subcommand: ${sub}`);
      console.error('Run `gbrain schema --help` for available commands.');
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(`gbrain schema — active schema pack management

Inspection:
  active                  Show resolved pack + which tier provided it
  list                    List installed packs (bundled + ~/.gbrain/schema-packs/)
  show [<pack>]           Pretty-print a manifest (default: active pack)
  validate [<pack>]       Validate manifest shape against the v1 schema
  graph                   Show type/primitive graph with link-verb edges
  lint [<pack>]           Lint a pack for duplicates, dangling refs, etc.
  stats                   Per-type page counts + typed-coverage from the DB
  explain <type>          Print resolved settings for a single type
  usage [--since N(d|w|m)] CLI invocation telemetry summary

Activation:
  use <pack>              Activate pack (writes ~/.gbrain/config.json schema_pack)
  downgrade [--to <pack>] Restore the previous active pack

Authoring:
  init <name>             Scaffold a new pack (extends gbrain-base)
  fork <src> <new>        Copy a pack to a new editable name
  edit <name>             Print the on-disk pack file path
  diff <a> <b>            Compare page_type sets across two packs
  add-type <name>         Add a page_type to the active pack
    --primitive <p>       One of entity|media|temporal|annotation|concept (required)
    --prefix <dir/>       Path prefix bound to the type (required)
    --extractable         Mark as facts-extraction eligible
    --expert              Mark as expert/whoknows routable
    --alias <a>           Alias name; repeatable
    --pack <name>         Target pack (default: active pack)
  remove-type <name>      Remove a page_type from the active pack
    --pack <name>         Target pack (default: active pack)

Discovery + repair:
  detect                  Cluster pages by source_path → candidate page_types
  suggest                 Heuristic refinement on detect output
  review-candidates       Review disk-derived candidates; promote with --apply
  review-orphans          List pages with no active-pack type match
  sync [--apply]          Backfill page.type for rows matching pack prefixes
                          (dry-run by default)

All new verbs accept --json. Verbs scoped by source accept --source <id>.

Resolution chain (7-tier, tier 1 trust-gated):
  1. Per-call --schema-pack flag (CLI only)
  2. GBRAIN_SCHEMA_PACK env var
  3. Per-source DB config schema_pack.source.<id>
  4. Brain-wide DB config schema_pack
  5. gbrain.yml schema: section
  6. ~/.gbrain/config.json schema_pack
  7. Default: gbrain-base
`);
}

async function runActive(_args: string[]): Promise<void> {
  const cfg = loadConfig();
  const resolution = resolveActivePackNameOnly({ cfg, remote: false });
  const pack = await loadActivePack({ cfg, remote: false });
  console.log(`Active pack: ${pack.manifest.name} v${pack.manifest.version}`);
  console.log(`Source: ${resolution.source}`);
  console.log(`Pack identity: ${pack.identity}`);
  console.log(`Page types: ${pack.manifest.page_types.length}`);
  console.log(`Link verbs: ${pack.manifest.link_types.length}`);
  console.log(`Takes kinds: ${pack.manifest.takes_kinds.join(', ')}`);
  if (pack.manifest.description) {
    console.log(`\n${pack.manifest.description}`);
  }
}

function runList(_args: string[]): void {
  const bundled = ['gbrain-base', 'gbrain-recommended'];
  const installedDir = gbrainPath('schema-packs');
  const installed: string[] = [];
  if (existsSync(installedDir)) {
    for (const entry of readdirSync(installedDir)) {
      const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
      for (const c of candidates) {
        if (existsSync(join(installedDir, entry, c))) {
          installed.push(entry);
          break;
        }
      }
    }
  }
  console.log('Bundled packs:');
  for (const name of bundled) console.log(`  ${name}`);
  if (installed.length > 0) {
    console.log('\nInstalled packs (~/.gbrain/schema-packs/):');
    for (const name of installed) console.log(`  ${name}`);
  } else {
    console.log('\nNo user-installed packs (~/.gbrain/schema-packs/ empty or missing).');
  }
}

async function runShow(args: string[]): Promise<void> {
  // v0.39 T18 — `gbrain schema show --as-filing-rules` emits the JSON
  // shape currently maintained by hand at `skills/_brain-filing-rules.json`.
  // First step of the 4-step T18 sequence (per codex finding #3): ship
  // the alternative source, then migrate consumers, then update tests,
  // then DELETE the hand-maintained files. v0.39.0.0 ships the source;
  // consumer migration + deletion deferred to v0.39.1 to avoid breaking
  // synthesize/patterns/filing-audit/check-resolvable mid-wave.
  const asFilingRules = args.includes('--as-filing-rules');
  const jsonFlag = args.includes('--json') || asFilingRules;
  const packArg = args.find((a) => !a.startsWith('--'));
  const packName = packArg;
  let manifest;
  if (packName) {
    const path = packPathByName(packName);
    if (!path) {
      console.error(`Unknown pack: ${packName}`);
      console.error('Run `gbrain schema list` to see available packs.');
      process.exit(1);
    }
    manifest = loadPackFromFile(path);
  } else {
    const pack = await loadActivePack({ cfg: loadConfig(), remote: false });
    manifest = pack.manifest;
  }
  if (asFilingRules) {
    // Emit the filing-rules-shaped JSON for downstream consumers per T18.
    // Shape mirrors skills/_brain-filing-rules.json so synthesize.ts +
    // patterns.ts + filing-audit.ts + check-resolvable.ts can migrate
    // their reads to this output without re-shaping.
    const filingRules = {
      schema_version: 1,
      source: 'gbrain schema show --as-filing-rules',
      pack: { name: manifest.name, version: manifest.version },
      page_types: manifest.page_types.map((pt) => ({
        name: pt.name,
        primitive: pt.primitive,
        directory: pt.path_prefixes[0] ?? null,
        path_prefixes: pt.path_prefixes,
        extractable: pt.extractable,
        expert_routing: pt.expert_routing,
        aliases: pt.aliases ?? [],
      })),
      // Preserve the dream_synthesize_paths.globs key the synthesize
      // protected-name guard depends on. v0.39.1 migration moves this
      // to a first-class manifest field; for now derive from extractable
      // entity types (the same set the old file curated).
      dream_synthesize_paths: {
        globs: manifest.page_types
          .filter((pt) => pt.extractable)
          .flatMap((pt) => pt.path_prefixes.map((p) => `${p}**`)),
      },
    };
    console.log(JSON.stringify(filingRules, null, 2));
    return;
  }
  if (jsonFlag) {
    console.log(JSON.stringify({ schema_version: 1, ...manifest }, null, 2));
    return;
  }
  console.log(`# ${manifest.name} v${manifest.version}`);
  if (manifest.description) console.log(`# ${manifest.description}`);
  console.log(`# extends: ${manifest.extends ?? 'null (no parent)'}`);
  console.log();
  console.log(`Page types (${manifest.page_types.length}):`);
  for (const pt of manifest.page_types) {
    const flags: string[] = [];
    if (pt.extractable) flags.push('extractable');
    if (pt.expert_routing) flags.push('expert');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const prefixStr = pt.path_prefixes.length > 0 ? ` (${pt.path_prefixes.join(', ')})` : '';
    const aliasStr = pt.aliases.length > 0 ? ` aliases:[${pt.aliases.join(', ')}]` : '';
    console.log(`  ${pt.name} :: ${pt.primitive}${prefixStr}${aliasStr}${flagStr}`);
  }
  console.log();
  console.log(`Link verbs (${manifest.link_types.length}):`);
  for (const lt of manifest.link_types) {
    const inferenceStr = lt.inference
      ? lt.inference.page_type
        ? ` (page_type: ${lt.inference.page_type})`
        : lt.inference.regex
          ? ` (regex)`
          : ''
      : '';
    console.log(`  ${lt.name}${inferenceStr}`);
  }
  console.log();
  console.log(`Takes kinds: ${manifest.takes_kinds.join(', ')}`);
  console.log(`Enrichable types: ${manifest.enrichable_types.map(e => e.type).join(', ') || '(none)'}`);
}

function runValidate(args: string[]): void {
  const packName = args[0];
  let path: string | null;
  if (packName) {
    path = packPathByName(packName);
    if (!path) {
      console.error(`Unknown pack: ${packName}`);
      process.exit(1);
    }
  } else {
    path = packPathByName('gbrain-base');
    if (!path) {
      console.error('No active pack — provide a pack name.');
      process.exit(1);
    }
  }
  try {
    const manifest = loadPackFromFile(path);
    console.log(`✓ ${manifest.name} v${manifest.version}: valid manifest`);
    console.log(`  Path: ${path}`);
    console.log(`  Page types: ${manifest.page_types.length}`);
    console.log(`  Link verbs: ${manifest.link_types.length}`);
    console.log(`  Takes kinds: ${manifest.takes_kinds.length}`);
  } catch (e) {
    if (e instanceof SchemaPackManifestError) {
      console.error(`✗ Invalid manifest at ${path}`);
      console.error(`  Code: ${e.code}`);
      console.error(`  ${e.message}`);
      process.exit(1);
    } else if (e instanceof SchemaPackLoaderError) {
      console.error(`✗ Loader error at ${e.path}`);
      console.error(`  ${e.message}`);
      process.exit(1);
    } else {
      throw e;
    }
  }
}

function runUse(args: string[]): void {
  const packName = args[0];
  if (!packName) {
    console.error('Usage: gbrain schema use <pack-name>');
    process.exit(2);
  }
  const path = packPathByName(packName);
  if (!path) {
    console.error(`Unknown pack: ${packName}`);
    console.error('Run `gbrain schema list` to see available packs.');
    process.exit(1);
  }
  // Validate before activating — refuse to set a broken pack.
  try {
    loadPackFromFile(path);
  } catch (e) {
    console.error(`Refusing to activate ${packName}: ${(e as Error).message}`);
    process.exit(1);
  }
  // Write to file-plane config (~/.gbrain/config.json schema_pack field).
  // Tier 6 in the resolution chain — tiers 1-5 (per-call, env, DB) can
  // still override this without editing the file.
  const cfg = loadConfig() ?? { engine: 'pglite' as const };
  const updated = { ...cfg, schema_pack: packName };
  const cfgPath = configPath();
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  console.log(`✓ Active schema pack set to: ${packName}`);
  console.log(`  Written to: ${cfgPath}`);
  console.log(`\nRun \`gbrain schema active\` to verify resolution.`);
}

function packPathByName(name: string): string | null {
  if (name === 'gbrain-base') {
    // Resolve bundled YAML — try a few locations.
    const here = dirname(new URL(import.meta.url).pathname);
    const candidates = [
      join(here, '..', 'core', 'schema-pack', 'base', 'gbrain-base.yaml'),
      join(here, '..', '..', 'src', 'core', 'schema-pack', 'base', 'gbrain-base.yaml'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }
  const baseDir = gbrainPath('schema-packs', name);
  for (const c of ['pack.yaml', 'pack.yml', 'pack.json']) {
    const candidate = join(baseDir, c);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Test seam — let unit tests inject the locator if needed.
export const _testHelpers = {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
  packPathByName,
};

// =================================================================
// v0.39.0.0 schema cathedral verbs (T2-T5, T20, T23)
// =================================================================
//
// Each verb shares two contracts:
//   - --json output flag (T6 CLI contract)
//   - --source <id> flag where source-scoping makes sense (T6 contract)
// The contract is pinned in test/schema-cli-contract.test.ts so future
// verbs can't drift.

import { runDetect } from '../core/schema-pack/detect.ts';
import { runSuggest } from '../core/schema-pack/suggest.ts';
import {
  runReviewCandidates,
  runReviewOrphans,
} from '../core/schema-pack/review.ts';

interface ParsedFlags {
  json: boolean;
  source: string | undefined;
  positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  let json = false;
  let source: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--source' || a === '--source-id') { source = args[++i]; continue; }
    if (a.startsWith('--source=')) { source = a.slice('--source='.length); continue; }
    if (a.startsWith('--source-id=')) { source = a.slice('--source-id='.length); continue; }
    positional.push(a);
  }
  return { json, source, positional };
}

async function withConnectedEngine<T>(fn: (engine: import('../core/engine.ts').BrainEngine) => Promise<T>): Promise<T> {
  const { createEngine } = await import('../core/engine-factory.ts');
  const cfg = loadConfig() ?? {};
  const engineKind = (cfg as { engine?: string }).engine === 'postgres' ? 'postgres' : 'pglite';
  // Build the EngineConfig once and pass it to BOTH createEngine and
  // engine.connect. The prior version passed `{}` to connect(), which
  // silently caused PGLite to point at a stub path and Postgres to
  // read DATABASE_URL out-of-band rather than honoring the resolved
  // config — the cathedral verbs that issued real SQL (detect, suggest,
  // review-*) were quietly running against an unconfigured engine.
  const connectConfig: import('../core/types.ts').EngineConfig = {
    engine: engineKind,
    database_url: (cfg as { database_url?: string }).database_url,
  };
  const engine = await createEngine(connectConfig);
  await engine.connect(connectConfig);
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

// ------------- T2: schema detect ----------------------------------

async function runDetectCmd(args: string[]): Promise<void> {
  const { json, source } = parseFlags(args);
  const result = await withConnectedEngine((engine) => runDetect(engine, { sourceId: source }));
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
    return;
  }
  console.log(`Total pages scanned:    ${result.total_pages}`);
  console.log(`  with frontmatter type:  ${result.typed_pages}`);
  console.log(`  without type (untyped): ${result.untyped_pages}`);
  console.log('');
  console.log('Candidate page_types (top by page count):');
  for (const p of result.prefixes) {
    const samples = p.sample_types.length ? ` [samples: ${p.sample_types.join(', ')}]` : '';
    console.log(`  ${p.prefix.padEnd(30)} ${String(p.page_count).padStart(6)} pages → suggest type \`${p.suggested_type}\`${samples}`);
  }
  console.log('');
  console.log('Next: gbrain schema review-candidates  (decide promote / rename / ignore)');
  console.log('      gbrain schema suggest             (LLM refinement on this candidate)');
}

// ------------- T3: schema suggest ---------------------------------

async function runSuggestCmd(args: string[]): Promise<void> {
  const { json, source } = parseFlags(args);
  const result = await withConnectedEngine((engine) => runSuggest(engine, { sourceId: source }));
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
    return;
  }
  console.log(`Suggestions: ${result.suggestions.length}`);
  for (const s of result.suggestions) {
    console.log(`  [${s.confidence.toFixed(2)}] ${s.kind.padEnd(12)} ${s.summary}`);
  }
  if (result.notes.length) {
    console.log('');
    console.log('Notes:');
    for (const n of result.notes) console.log(`  - ${n}`);
  }
}

// ------------- T4: schema review-candidates -----------------------

async function runReviewCandidatesCmd(args: string[]): Promise<void> {
  const { json, source, positional } = parseFlags(args);
  const applyIdx = positional.indexOf('--apply');
  const applySlug = applyIdx >= 0 ? positional[applyIdx + 1] : undefined;
  const result = await withConnectedEngine((engine) =>
    runReviewCandidates(engine, { sourceId: source, applySlug }),
  );
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
    return;
  }
  // Codex finding #10: CLI must surface that this is DISK-derived, not
  // audit-log review. Make this loud so users understand drift semantics.
  console.log('Disk-derived candidates from current brain state.');
  console.log(`Audit history (cross-reference): ~/.gbrain/audit/schema-candidates-*.jsonl`);
  console.log('');
  if (result.applied) {
    console.log(`Applied: ${result.applied}`);
    return;
  }
  if (!result.candidates.length) {
    console.log('No candidate types found — your active pack matches current content shape.');
    return;
  }
  console.log('Candidate types (run with --apply <prefix> to promote):');
  for (const c of result.candidates) {
    console.log(`  ${c.prefix.padEnd(30)} ${String(c.page_count).padStart(6)} pages  (suggest \`${c.suggested_type}\`)`);
  }
}

// ------------- T5: 8 remaining cathedral verbs --------------------
// These are intentionally THIN. Each shares loadActivePack + manifest
// validation. Mark `init`, `fork`, `edit`, `diff`, `graph`, `explain` as
// EXPERIMENTAL-TIER (T23) — telemetry-gated for v0.40+ retro.

const EXPERIMENTAL_VERBS = new Set(['init', 'fork', 'edit', 'diff', 'graph', 'explain']);

async function runInitCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const name = positional[0];
  if (!name) {
    console.error('Usage: gbrain schema init <pack-name>  (experimental)');
    process.exit(2);
  }
  const baseDir = gbrainPath('schema-packs', name);
  if (existsSync(baseDir)) {
    console.error(`Pack \`${name}\` already exists at ${baseDir}`);
    process.exit(1);
  }
  mkdirSync(baseDir, { recursive: true });
  // Cast through Partial — the validate verb is the authoritative shape check.
  // The YAML written below has the minimum fields; lint/validate catch gaps.
  const stub = {
    api_version: 'gbrain-schema-pack-v1' as const,
    name,
    version: '0.0.1',
    gbrain_min_version: '0.39.0',
    extends: 'gbrain-base',
    description: `Stub pack scaffolded by 'gbrain schema init ${name}'. Edit ${baseDir}/pack.yaml then 'gbrain schema validate' + 'gbrain schema use ${name}'.`,
    page_types: [] as SchemaPackManifest['page_types'],
    link_types: [] as SchemaPackManifest['link_types'],
    takes_kinds: ['fact', 'take', 'bet', 'hunch'] as string[],
    borrow_from: [] as SchemaPackManifest['borrow_from'],
    frontmatter_links: [] as SchemaPackManifest['frontmatter_links'],
    enrichable_types: [] as SchemaPackManifest['enrichable_types'],
    filing_rules: [] as SchemaPackManifest['filing_rules'],
  };
  const yaml = `# Stub pack — extends gbrain-base by default. Add your own page_types below.
api_version: ${stub.api_version}
name: ${stub.name}
version: ${stub.version}
gbrain_min_version: ${stub.gbrain_min_version}
extends: gbrain-base
description: ${JSON.stringify(stub.description)}

page_types: []
link_types: []
takes_kinds:
  - fact
  - take
  - bet
  - hunch
borrow_from: []
`;
  writeFileSync(join(baseDir, 'pack.yaml'), yaml);
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, name, path: baseDir, tier: 'experimental' }, null, 2));
    return;
  }
  console.log(`(experimental) Scaffolded pack \`${name}\` at ${baseDir}/pack.yaml`);
  console.log(`Next: edit pack.yaml, then run \`gbrain schema validate ${name}\` and \`gbrain schema use ${name}\`.`);
}

async function runForkCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const from = positional[0];
  const to = positional[1];
  if (!from || !to) {
    console.error('Usage: gbrain schema fork <source-pack> <new-name>  (experimental)');
    process.exit(2);
  }
  const fromPath = packPathByName(from);
  if (!fromPath) {
    console.error(`Source pack \`${from}\` not found.`);
    process.exit(1);
  }
  const toDir = gbrainPath('schema-packs', to);
  if (existsSync(toDir)) {
    console.error(`Pack \`${to}\` already exists at ${toDir}`);
    process.exit(1);
  }
  mkdirSync(toDir, { recursive: true });
  const sourceManifest = loadPackFromFile(fromPath);
  const forked = { ...sourceManifest, name: to, version: '0.0.1' };
  writeFileSync(join(toDir, 'pack.json'), JSON.stringify(forked, null, 2));
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, from, to, path: toDir, tier: 'experimental' }, null, 2));
    return;
  }
  console.log(`(experimental) Forked \`${from}\` → \`${to}\` at ${toDir}/pack.json`);
}

async function runEditCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const name = positional[0];
  if (!name) {
    console.error('Usage: gbrain schema edit <pack-name>  (experimental)');
    process.exit(2);
  }
  const p = packPathByName(name);
  if (!p) {
    console.error(`Pack \`${name}\` not found.`);
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, name, path: p, tier: 'experimental' }, null, 2));
    return;
  }
  console.log(`(experimental) Pack file: ${p}`);
  console.log(`Open it in your editor; then run \`gbrain schema validate ${name}\`.`);
}

async function runDiffCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const a = positional[0];
  const b = positional[1];
  if (!a || !b) {
    console.error('Usage: gbrain schema diff <pack-a> <pack-b>  (experimental)');
    process.exit(2);
  }
  const aPath = packPathByName(a);
  const bPath = packPathByName(b);
  if (!aPath || !bPath) {
    console.error('One or both packs not found.');
    process.exit(1);
  }
  const aPack = loadPackFromFile(aPath);
  const bPack = loadPackFromFile(bPath);
  const aTypes = new Set(aPack.page_types.map((t) => t.name));
  const bTypes = new Set(bPack.page_types.map((t) => t.name));
  const onlyA = [...aTypes].filter((t) => !bTypes.has(t)).sort();
  const onlyB = [...bTypes].filter((t) => !aTypes.has(t)).sort();
  const both = [...aTypes].filter((t) => bTypes.has(t)).sort();
  if (json) {
    console.log(JSON.stringify({
      schema_version: 1,
      a, b,
      only_in_a: onlyA,
      only_in_b: onlyB,
      common: both,
      tier: 'experimental',
    }, null, 2));
    return;
  }
  console.log(`(experimental) Diff ${a} ↔ ${b}`);
  console.log(`Only in ${a}: ${onlyA.length ? onlyA.join(', ') : '<none>'}`);
  console.log(`Only in ${b}: ${onlyB.length ? onlyB.join(', ') : '<none>'}`);
  console.log(`Common: ${both.length}`);
}

async function runGraphCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const cfg = loadConfig();
  const packName = positional[0];
  let manifest: SchemaPackManifest;
  if (packName) {
    const p = packPathByName(packName);
    if (!p) {
      console.error(`Unknown pack: ${packName}`);
      process.exit(1);
    }
    manifest = loadPackFromFile(p);
  } else {
    manifest = (await loadActivePack({ cfg, remote: false })).manifest;
  }
  const typeNames = new Set(manifest.page_types.map((t) => t.name));
  // Edge model: a link_type with inference.page_type points FROM that
  // type via the verb. inference.target_type (when present) points to
  // the destination; otherwise the destination is '*' (any type).
  interface Edge { from: string; verb: string; to: string }
  const edges: Edge[] = [];
  for (const lt of manifest.link_types) {
    const inf = lt.inference;
    if (!inf || !inf.page_type) continue;
    edges.push({ from: inf.page_type, verb: lt.name, to: inf.target_type ?? '*' });
  }
  // Frontmatter links are an additional edge source: page_type --(link_type)--> *
  for (const fl of manifest.frontmatter_links ?? []) {
    edges.push({ from: fl.page_type, verb: fl.link_type, to: '*' });
  }
  edges.sort((a, b) =>
    a.from.localeCompare(b.from) || a.verb.localeCompare(b.verb) || a.to.localeCompare(b.to),
  );
  if (json) {
    console.log(JSON.stringify({
      schema_version: 1,
      pack: manifest.name,
      types: manifest.page_types.map((t) => ({
        name: t.name,
        primitive: t.primitive,
        aliases: t.aliases ?? [],
      })),
      edges,
    }, null, 2));
    return;
  }
  console.log(`Schema graph for pack \`${manifest.name}\`:`);
  console.log('');
  console.log('Types:');
  for (const t of manifest.page_types) {
    const aliases = (t.aliases ?? []).length ? `  aliases: ${(t.aliases ?? []).join(', ')}` : '';
    console.log(`  ${t.name.padEnd(24)} (${t.primitive})${aliases}`);
  }
  console.log('');
  if (edges.length === 0) {
    console.log('Edges: (none — pack defines no link_type inferences)');
    return;
  }
  console.log(`Edges (${edges.length}):`);
  for (const e of edges) {
    const fromMark = e.from !== '*' && !typeNames.has(e.from) ? '?' : '';
    const toMark = e.to !== '*' && !typeNames.has(e.to) ? '?' : '';
    console.log(`  ${fromMark}${e.from} --(${e.verb})--> ${toMark}${e.to}`);
  }
  // '?' prefix flags references to types not declared in this pack.
}

async function runLintCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const name = positional[0];
  const cfg = loadConfig();
  let pack: SchemaPackManifest | null;
  if (name) {
    const p = packPathByName(name);
    try { pack = p ? loadPackFromFile(p) : null; } catch { pack = null; }
  } else {
    pack = (await loadActivePack({ cfg, remote: false })).manifest;
  }
  if (!pack) {
    console.error(`Pack not found: ${name}`);
    process.exit(1);
  }
  const warnings: string[] = [];
  const seenTypeNames = new Set<string>();
  const aliasOwner = new Map<string, string>(); // alias → type that declared it
  for (const t of pack.page_types) {
    if (seenTypeNames.has(t.name)) warnings.push(`duplicate type name: ${t.name}`);
    seenTypeNames.add(t.name);
    if (!t.path_prefixes || t.path_prefixes.length === 0) {
      warnings.push(`type \`${t.name}\` has no path_prefixes — unreachable by inferType`);
    }
  }
  // Alias collision: any alias that matches another type's name.
  // (A type can alias ITSELF as a no-op; we ignore self-aliases.)
  for (const t of pack.page_types) {
    for (const a of t.aliases ?? []) {
      if (a !== t.name && seenTypeNames.has(a)) {
        warnings.push(`type \`${t.name}\` aliases \`${a}\` which is itself a declared type — query closure may shadow`);
      }
      const prev = aliasOwner.get(a);
      if (prev && prev !== t.name) {
        warnings.push(`alias \`${a}\` declared by both \`${prev}\` and \`${t.name}\` — closure direction will collide`);
      } else if (!prev) {
        aliasOwner.set(a, t.name);
      }
    }
  }
  // Enrichable types must point at declared page_types.
  for (const e of pack.enrichable_types ?? []) {
    if (!seenTypeNames.has(e.type)) {
      warnings.push(`enrichable_types references unknown type \`${e.type}\``);
    }
  }
  // Link inference referencing nonexistent page_types.
  for (const lt of pack.link_types) {
    if (lt.inference?.page_type && !seenTypeNames.has(lt.inference.page_type)) {
      warnings.push(`link_type \`${lt.name}\` inference.page_type references unknown type \`${lt.inference.page_type}\``);
    }
    if (lt.inference?.target_type && lt.inference.target_type !== '*' && !seenTypeNames.has(lt.inference.target_type)) {
      warnings.push(`link_type \`${lt.name}\` inference.target_type references unknown type \`${lt.inference.target_type}\``);
    }
  }
  // Frontmatter links referencing unknown page_types or link_types.
  const linkNames = new Set(pack.link_types.map((l) => l.name));
  for (const fl of pack.frontmatter_links ?? []) {
    if (!seenTypeNames.has(fl.page_type)) {
      warnings.push(`frontmatter_links page_type \`${fl.page_type}\` is not a declared type`);
    }
    if (!linkNames.has(fl.link_type)) {
      warnings.push(`frontmatter_links link_type \`${fl.link_type}\` is not a declared link verb`);
    }
  }
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, pack: pack.name, warnings }, null, 2));
    return;
  }
  if (!warnings.length) {
    console.log(`OK — pack \`${pack.name}\` lint clean.`);
    return;
  }
  console.log(`Pack \`${pack.name}\` lint:`);
  for (const w of warnings) console.log(`  warn: ${w}`);
}

async function runExplainCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const typeName = positional[0];
  if (!typeName) {
    console.error('Usage: gbrain schema explain <type-name>  (experimental)');
    process.exit(2);
  }
  const cfg = loadConfig();
  const pack = await loadActivePack({ cfg, remote: false });
  const found = pack.manifest.page_types.find((t) => t.name === typeName);
  if (!found) {
    console.error(`Type \`${typeName}\` not in active pack \`${pack.manifest.name}\`.`);
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify({
      schema_version: 1,
      pack: pack.manifest.name,
      type: found,
      tier: 'experimental',
    }, null, 2));
    return;
  }
  console.log(`(experimental) Type \`${found.name}\` in pack \`${pack.manifest.name}\`:`);
  console.log(`  primitive:     ${found.primitive}`);
  console.log(`  path_prefixes: ${found.path_prefixes.join(', ')}`);
  console.log(`  aliases:       ${(found.aliases ?? []).join(', ') || '<none>'}`);
  console.log(`  extractable:   ${found.extractable}`);
  console.log(`  expert_routing: ${found.expert_routing}`);
}

async function runReviewOrphansCmd(args: string[]): Promise<void> {
  const { json, source } = parseFlags(args);
  const result = await withConnectedEngine((engine) =>
    runReviewOrphans(engine, { sourceId: source }),
  );
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
    return;
  }
  console.log(`Orphan pages (no active-pack type match): ${result.orphan_count}`);
  for (const o of result.orphans.slice(0, 20)) {
    console.log(`  ${o.slug}`);
  }
  if (result.orphan_count > 20) {
    console.log(`  ... and ${result.orphan_count - 20} more (use --json to see all)`);
  }
}

// ------------- T20: schema downgrade ------------------------------

async function runDowngradeCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const target = positional.includes('--to')
    ? positional[positional.indexOf('--to') + 1]
    : undefined;
  // Find the previous pack from ~/.gbrain/schema-pack-history.jsonl OR honor --to <pack>.
  const historyPath = gbrainPath('schema-pack-history.jsonl');
  let restoredTo: string | null = null;
  if (target) {
    restoredTo = target;
  } else if (existsSync(historyPath)) {
    const lines = readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length >= 2) {
      // Most-recent line is current; second-most-recent is the previous.
      try {
        const prev = JSON.parse(lines[lines.length - 2]) as { pack?: string };
        if (prev.pack) restoredTo = prev.pack;
      } catch {
        // ignore
      }
    }
  }
  if (!restoredTo) {
    restoredTo = 'gbrain-base';
  }
  const cfg = loadConfig();
  const updated = { ...cfg, schema_pack: restoredTo };
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(updated, null, 2));
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, downgraded_to: restoredTo }, null, 2));
    return;
  }
  console.log(`Active pack restored to \`${restoredTo}\` in ${path}`);
  console.log('Run `gbrain schema active` to verify. Note: this command restores CONFIG only.');
  console.log('Custom-typed pages, cache rows, and eval rows from v0.39 are not auto-cleaned.');
  console.log('See docs/architecture/schema-packs.md for the full revert procedure.');
}

// ------------- T23: gbrain schema usage ---------------------------

async function runUsageCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const sinceArg = positional.includes('--since') ? positional[positional.indexOf('--since') + 1] : '30d';
  const days = parseSinceDays(sinceArg);
  const { readRecentSchemaEvents } = await import('../core/schema-events.ts');
  const events = readRecentSchemaEvents(days);
  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.verb, (counts.get(e.verb) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (json) {
    console.log(JSON.stringify({
      schema_version: 1,
      since_days: days,
      total_invocations: events.length,
      per_verb: Object.fromEntries(sorted),
      experimental_verbs: [...EXPERIMENTAL_VERBS],
    }, null, 2));
    return;
  }
  console.log(`Schema CLI usage (last ${days}d):`);
  console.log(`Total invocations: ${events.length}`);
  console.log('');
  for (const [verb, cnt] of sorted) {
    const tag = EXPERIMENTAL_VERBS.has(verb) ? ' (experimental)' : '';
    console.log(`  ${verb.padEnd(22)} ${String(cnt).padStart(6)}${tag}`);
  }
  console.log('');
  console.log('Experimental verbs are candidates for deprecation in v0.40+ if usage stays low.');
}

// ------------- Schema cathedral v2: stats / sync / add-type / remove-type

import { runStats } from '../core/schema-pack/stats.ts';
import { runSync } from '../core/schema-pack/sync.ts';
import {
  addTypeToPack,
  removeTypeFromPack,
  SchemaPackMutationError,
} from '../core/schema-pack/mutate.ts';
import type { PackPrimitive } from '../core/schema-pack/manifest-v1.ts';
import { PACK_PRIMITIVES } from '../core/schema-pack/manifest-v1.ts';

async function runStatsCmd(args: string[]): Promise<void> {
  const { json, source } = parseFlags(args);
  const result = await withConnectedEngine((engine) => runStats(engine, { sourceId: source }));
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
    return;
  }
  console.log(`Schema stats${result.source_id ? ` (source: ${result.source_id})` : ''}:`);
  console.log(`  Total pages:    ${result.total_pages}`);
  console.log(`  Typed pages:    ${result.typed_pages}`);
  console.log(`  Untyped pages:  ${result.untyped_pages}`);
  const pct = (result.coverage * 100).toFixed(2);
  console.log(`  Coverage:       ${pct}%`);
  console.log('');
  if (result.per_type.length === 0) {
    console.log('(no pages — brain is empty)');
    return;
  }
  console.log('Per-type:');
  for (const row of result.per_type) {
    console.log(`  ${row.type.padEnd(28)} ${String(row.count).padStart(8)}`);
  }
}

async function runSyncCmd(args: string[]): Promise<void> {
  const { json, source, positional } = parseFlags(args);
  const apply = positional.includes('--apply');
  const result = await withConnectedEngine((engine) =>
    runSync(engine, { sourceId: source, apply }),
  );
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
    return;
  }
  const verb = result.applied ? 'Updated' : 'Would update';
  console.log(`schema sync — pack: ${result.pack}${result.source_id ? `, source: ${result.source_id}` : ''}`);
  console.log(`Mode: ${result.applied ? 'APPLY' : 'DRY-RUN (pass --apply to write)'}`);
  console.log(`${verb} ${result.total_matched} page rows across ${result.per_type.length} types.`);
  if (result.per_type.length === 0) {
    console.log('No untyped pages matched any active-pack path_prefix.');
    return;
  }
  console.log('');
  for (const row of result.per_type) {
    console.log(`  ${row.type.padEnd(24)} ${String(row.matched).padStart(8)}  (prefixes: ${row.prefixes.join(', ')})`);
  }
}

interface AddTypeExtras {
  pack: string | undefined;
  primitive: PackPrimitive | undefined;
  prefix: string | undefined;
  extractable: boolean;
  expert: boolean;
  aliases: string[];
}

/**
 * Layered flag parser for the authoring verbs. Defers --json / --source
 * / positional capture to parseFlags(), then walks the positional list a
 * second time to peel off authoring-specific flags. This preserves the
 * CLI contract (every handler reads parseFlags()) while still supporting
 * the richer flag surface add-type / remove-type need.
 */
function parseAddTypeExtras(positional: string[]): { extras: AddTypeExtras; remaining: string[] } {
  let pack: string | undefined;
  let primitive: PackPrimitive | undefined;
  let prefix: string | undefined;
  let extractable = false;
  let expert = false;
  const aliases: string[] = [];
  const remaining: string[] = [];
  for (let i = 0; i < positional.length; i++) {
    const a = positional[i];
    if (a === '--pack') { pack = positional[++i]; continue; }
    if (a.startsWith('--pack=')) { pack = a.slice('--pack='.length); continue; }
    if (a === '--primitive') { primitive = positional[++i] as PackPrimitive; continue; }
    if (a.startsWith('--primitive=')) { primitive = a.slice('--primitive='.length) as PackPrimitive; continue; }
    if (a === '--prefix') { prefix = positional[++i]; continue; }
    if (a.startsWith('--prefix=')) { prefix = a.slice('--prefix='.length); continue; }
    if (a === '--extractable') { extractable = true; continue; }
    if (a === '--expert' || a === '--expert-routing') { expert = true; continue; }
    if (a === '--alias') { const v = positional[++i]; if (v) aliases.push(v); continue; }
    if (a.startsWith('--alias=')) { aliases.push(a.slice('--alias='.length)); continue; }
    remaining.push(a);
  }
  return { extras: { pack, primitive, prefix, extractable, expert, aliases }, remaining };
}

async function resolveTargetPackName(explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const cfg = loadConfig();
  const pack = await loadActivePack({ cfg, remote: false });
  return pack.manifest.name;
}

async function runAddTypeCmd(args: string[]): Promise<void> {
  // Honor the --json / --source contract via parseFlags() first.
  const flags = parseFlags(args);
  const { extras, remaining } = parseAddTypeExtras(flags.positional);
  const name = remaining[0];
  if (!name) {
    console.error('Usage: gbrain schema add-type <name> --primitive <p> --prefix <dir/> [--extractable] [--expert] [--alias <a>]...');
    process.exit(2);
  }
  if (!extras.primitive) {
    console.error(`--primitive is required. One of: ${PACK_PRIMITIVES.join(', ')}`);
    process.exit(2);
  }
  if (!extras.prefix) {
    console.error('--prefix is required (e.g. --prefix media/photos/)');
    process.exit(2);
  }
  const targetPack = await resolveTargetPackName(extras.pack);
  try {
    const result = addTypeToPack(targetPack, {
      name,
      primitive: extras.primitive,
      prefix: extras.prefix,
      extractable: extras.extractable,
      expertRouting: extras.expert,
      aliases: extras.aliases,
    });
    if (flags.json) {
      console.log(JSON.stringify({ schema_version: 1, action: 'add-type', ...result }, null, 2));
      return;
    }
    console.log(`✓ Added type \`${result.type}\` to pack \`${result.pack}\``);
    console.log(`  File: ${result.path} (${result.format})`);
    console.log(`  Next: gbrain schema validate ${result.pack}`);
  } catch (e) {
    if (e instanceof SchemaPackMutationError) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

async function runRemoveTypeCmd(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const { extras, remaining } = parseAddTypeExtras(flags.positional);
  const name = remaining[0];
  if (!name) {
    console.error('Usage: gbrain schema remove-type <name> [--pack <name>]');
    process.exit(2);
  }
  const targetPack = await resolveTargetPackName(extras.pack);
  try {
    const result = removeTypeFromPack(targetPack, { name });
    if (flags.json) {
      console.log(JSON.stringify({ schema_version: 1, action: 'remove-type', ...result }, null, 2));
      return;
    }
    console.log(`✓ Removed type \`${result.type}\` from pack \`${result.pack}\``);
    console.log(`  File: ${result.path} (${result.format})`);
  } catch (e) {
    if (e instanceof SchemaPackMutationError) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

function parseSinceDays(s: string): number {
  const m = /^(\d+)([dhwm])?$/.exec(s.trim());
  if (!m) return 30;
  const n = parseInt(m[1], 10);
  const unit = m[2] ?? 'd';
  switch (unit) {
    case 'h': return Math.max(1, Math.ceil(n / 24));
    case 'd': return n;
    case 'w': return n * 7;
    case 'm': return n * 30;
    default: return n;
  }
}
