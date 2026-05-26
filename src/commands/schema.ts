// `gbrain schema` CLI surface.
//
// The active schema pack drives type inference, link verbs, expert
// routing, extractable types, enrichment rubrics, and per-source
// closure for search. See `src/core/schema-pack/load-active.ts` for
// the boundary helper that all engines + operations consume.
//
// Verbs grouped by lifecycle:
//   Inspection:           active, list, show, validate, graph, lint,
//                         stats, explain, usage
//   Activation:           use, downgrade, reload
//   Authoring:            init, fork, edit, diff, add-type, remove-type,
//                         update-type, add-alias, remove-alias,
//                         add-prefix, remove-prefix, add-link-type,
//                         remove-link-type, set-extractable,
//                         set-expert-routing
//   Discovery + repair:   detect, suggest, review-candidates,
//                         review-orphans, sync

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  addAliasToType,
  addLinkTypeToPack,
  addPrefixToType,
  addTypeToPack,
  invalidatePackCache,
  loadActivePack,
  removeAliasFromType,
  removeLinkTypeFromPack,
  removePrefixFromType,
  removeTypeFromPack,
  resolveActivePackNameOnly,
  loadPackFromFile,
  parseSchemaPackManifest,
  runStatsCore,
  runSyncCore,
  SchemaPackManifestError,
  SchemaPackLoaderError,
  SchemaPackMutationError,
  setExpertRoutingOnType,
  setExtractableOnType,
  UnknownPackError,
  updateTypeOnPack,
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../core/schema-pack/index.ts';
import type { SchemaPackManifest, PackPrimitive } from '../core/schema-pack/manifest-v1.ts';
import { PACK_PRIMITIVES } from '../core/schema-pack/manifest-v1.ts';
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
    case 'reload':   return runReloadCmd(args.slice(1));
    case 'add-type': return runAddTypeCmd(args.slice(1));
    case 'remove-type': return runRemoveTypeCmd(args.slice(1));
    case 'update-type': return runUpdateTypeCmd(args.slice(1));
    case 'add-alias': return runAddAliasCmd(args.slice(1));
    case 'remove-alias': return runRemoveAliasCmd(args.slice(1));
    case 'add-prefix': return runAddPrefixCmd(args.slice(1));
    case 'remove-prefix': return runRemovePrefixCmd(args.slice(1));
    case 'add-link-type': return runAddLinkTypeCmd(args.slice(1));
    case 'remove-link-type': return runRemoveLinkTypeCmd(args.slice(1));
    case 'set-extractable': return runSetExtractableCmd(args.slice(1));
    case 'set-expert-routing': return runSetExpertRoutingCmd(args.slice(1));
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
  stats [--source <id>]   Per-type page counts + typed-coverage from the DB
  explain <type>          Print resolved settings for a single type
  usage [--since N(d|w|m)] CLI invocation telemetry summary

Activation:
  use <pack>              Activate pack (writes ~/.gbrain/config.json schema_pack)
  downgrade [--to <pack>] Restore the previous active pack
  reload [--pack <name>]  Flush the in-process pack cache; --pack scopes

Authoring (v0.40.6.0):
  init <name>             Scaffold a new pack (extends gbrain-base)
  fork <src> <new>        Copy a pack to a new editable name
  edit <name>             Print the on-disk pack file path
  diff <a> <b>            Compare page_type sets across two packs

  add-type <name> --primitive <p> --prefix <dir/>
                          [--extractable] [--expert] [--alias <a>]* [--pack <name>]
  remove-type <name>      [--pack <name>]
  update-type <name>      [--extractable BOOL] [--expert BOOL] [--primitive P] [--pack <name>]
  add-alias <type> <alias>      [--pack <name>]
  remove-alias <type> <alias>   [--pack <name>]
  add-prefix <type> <prefix>    [--pack <name>]
  remove-prefix <type> <prefix> [--pack <name>]
  add-link-type <name> [--inverse <verb>] [--page-type <t>] [--target-type <t>] [--pack <name>]
  remove-link-type <name>       [--pack <name>]
  set-extractable <type> <true|false>      [--pack <name>]
  set-expert-routing <type> <true|false>   [--pack <name>]

Discovery + repair:
  detect                  Cluster pages by source_path → candidate page_types
  suggest                 Heuristic refinement on detect output
  review-candidates       Review disk-derived candidates; promote with --apply
  review-orphans          List pages with no active-pack type match
  sync [--apply]          Backfill page.type for rows matching pack prefixes
                          (dry-run by default; chunked UPDATE on apply)

All new verbs accept --json. Verbs scoped by source accept --source <id>.
Pass --force to bypass per-pack lock contention on writes.

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
  // PR #1321 (closed) defensive fix retained: build the EngineConfig once and
  // pass it to BOTH createEngine and engine.connect. The factory captures
  // config at construction; explicit re-pass at connect() is defense in depth
  // against future engine implementations that read URL from connect-time.
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
  const { json } = parseFlags(args);
  const cfg = loadConfig();
  const pack = await loadActivePack({ cfg, remote: false });
  if (json) {
    console.log(JSON.stringify({
      schema_version: 1,
      pack: pack.manifest.name,
      types: pack.manifest.page_types.map((t) => ({ name: t.name, primitive: t.primitive, aliases: t.aliases ?? [] })),
      tier: 'experimental',
    }, null, 2));
    return;
  }
  console.log(`(experimental) ASCII graph for pack \`${pack.manifest.name}\`:`);
  console.log('');
  for (const t of pack.manifest.page_types) {
    const aliases = (t.aliases ?? []).length ? `  aliases: ${(t.aliases ?? []).join(', ')}` : '';
    console.log(`  ${t.name.padEnd(20)} (${t.primitive})${aliases}`);
  }
}

async function runLintCmd(args: string[]): Promise<void> {
  const { json, positional } = parseFlags(args);
  const withDb = args.includes('--with-db');
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
  // v0.40.6.0 Phase 5: swap basic 2-rule check for the rich 11-rule lint
  // suite from Phase 1.5. File-plane rules run by default; --with-db
  // opts into extractable_empty_corpus + mutation_count_anomaly which
  // need an engine connection.
  const { runAllLintRules } = await import('../core/schema-pack/lint-rules.ts');
  const report = withDb
    ? await withConnectedEngine(async (engine) => runAllLintRules(pack!, { engine }))
    : await runAllLintRules(pack);
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, pack: pack.name, ...report }, null, 2));
    if (!report.ok) process.exit(1);
    return;
  }
  if (report.ok && report.warnings.length === 0) {
    console.log(`OK — pack \`${pack.name}\` lint clean.`);
    return;
  }
  console.log(`Pack \`${pack.name}\` lint:`);
  for (const e of report.errors) {
    console.log(`  ERROR (${e.rule}): ${e.message}`);
    if (e.hint) console.log(`    hint: ${e.hint}`);
  }
  for (const w of report.warnings) {
    console.log(`  warn (${w.rule}): ${w.message}`);
    if (w.hint) console.log(`    hint: ${w.hint}`);
  }
  if (!report.ok) process.exit(1);
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

// ──────────────────────────────────────────────────────────────────────
// v0.40.6.0 Schema Cathedral v3 — 14 new authoring + DB-aware verbs.
//
// All handlers thin-wrap a pure core function from src/core/schema-pack/
// (see Phase 2 mutate.ts, Phase 3 stats.ts/sync.ts). CLI prints to
// stdout (text or --json) and exits with a meaningful code.
// ──────────────────────────────────────────────────────────────────────

function parseBool(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return null;
}

function pickPackName(parsed: { positional?: string[] }, args: string[]): string {
  // Honor --pack <name> before falling back to the active pack.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pack') return args[i + 1] ?? '';
    if (args[i]?.startsWith('--pack=')) return args[i]!.slice('--pack='.length);
  }
  const cfg = loadConfig();
  const resolution = resolveActivePackNameOnly({ cfg, remote: false });
  return resolution.pack_name;
}

function emitMutateResult(result: { pack: string; format: string; prev_sha8: string; new_sha8: string }, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }));
    return;
  }
  console.log(`Pack: ${result.pack} (${result.format})`);
  console.log(`Sha8: ${result.prev_sha8} → ${result.new_sha8}`);
}

function handleMutationError(err: unknown): never {
  if (err instanceof SchemaPackMutationError) {
    console.error(`Error: ${err.message}`);
    if (err.code === 'PACK_READONLY') {
      console.error('  Hint: fork the pack first, then mutate the fork.');
    } else if (err.code === 'STILL_REFERENCED') {
      const refs = (err.details?.references as string[] | undefined) ?? [];
      if (refs.length > 0) console.error(`  Still referenced by: ${refs.join(', ')}`);
    }
    process.exit(1);
  }
  throw err;
}

async function runStatsCmd(args: string[]): Promise<void> {
  const { json, source } = parseFlags(args);
  await withConnectedEngine(async (engine) => {
    const ctx = { engine, config: {}, logger: console, dryRun: false, remote: false, sourceId: source } as never;
    const result = await runStatsCore(ctx, source ? { sourceId: source } : {});
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Pack: ${result.pack_identity ?? '(no pack loaded)'}`);
    console.log(`Total pages: ${result.aggregate.total_pages}`);
    console.log(`Typed: ${result.aggregate.typed_pages} (${(result.aggregate.coverage * 100).toFixed(1)}%)`);
    console.log(`Untyped: ${result.aggregate.untyped_pages}`);
    if (result.aggregate.by_type.length > 0) {
      console.log(`\nBy type:`);
      for (const t of result.aggregate.by_type) {
        console.log(`  ${t.type.padEnd(20)} ${t.count}`);
      }
    }
    if (result.per_source.length > 1) {
      console.log(`\nPer source:`);
      for (const s of result.per_source) {
        console.log(`  ${s.source_id.padEnd(20)} total=${s.total_pages} typed=${s.typed_pages} coverage=${(s.coverage * 100).toFixed(1)}%`);
      }
    }
    if (result.dead_prefixes.length > 0) {
      console.log(`\nDead prefixes (declared but 0 pages):`);
      for (const dp of result.dead_prefixes) {
        console.log(`  ${dp.type.padEnd(20)} ${dp.prefix}`);
      }
    }
  });
}

async function runSyncCmd(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const { json, source } = parseFlags(args);
  await withConnectedEngine(async (engine) => {
    const ctx = { engine, config: {}, logger: console, dryRun: false, remote: false, sourceId: source } as never;
    const result = await runSyncCore(ctx, {
      apply,
      sourceId: source,
      onProgress: (info) => {
        if (!json) process.stderr.write(`  [sync] ${info.type} ${info.prefix} → ${info.appliedSoFar} applied\n`);
      },
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Pack: ${result.pack_identity ?? '(no pack loaded)'}`);
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
    for (const p of result.per_prefix) {
      const marker = p.dead_prefix ? ' (dead prefix — no matching pages)' : '';
      console.log(`  ${p.type.padEnd(20)} ${p.prefix.padEnd(30)} would_apply=${p.would_apply} applied=${p.applied}${marker}`);
      if (p.sample_slugs.length > 0 && !apply) {
        console.log(`    sample: ${p.sample_slugs.slice(0, 3).join(', ')}${p.sample_slugs.length > 3 ? '...' : ''}`);
      }
    }
    console.log(`\nTotal: would_apply=${result.total_would_apply} applied=${result.total_applied}`);
    if (!apply && result.total_would_apply > 0) {
      console.log(`\nRun \`gbrain schema sync --apply\` to backfill page.type.`);
    }
  });
}

function runReloadCmd(args: string[]): void {
  const { json } = parseFlags(args);
  let packName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pack') { packName = args[i + 1]; break; }
    if (args[i]?.startsWith('--pack=')) { packName = args[i]!.slice('--pack='.length); break; }
  }
  const result = invalidatePackCache(packName);
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }));
    return;
  }
  if (result.invalidated.length === 0) {
    console.log('No cached packs to flush.');
  } else {
    console.log(`Flushed: ${result.invalidated.join(', ')}`);
  }
}

async function runAddTypeCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const positional = args.filter((a) => !a.startsWith('--'));
  const name = positional[0];
  if (!name) { console.error('Usage: gbrain schema add-type <name> --primitive <p> --prefix <dir/>'); process.exit(2); }
  let primitive: string | undefined;
  let prefix: string | undefined;
  let extractable = false;
  let expert = false;
  const aliases: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--primitive') primitive = args[++i];
    else if (a?.startsWith('--primitive=')) primitive = a.slice('--primitive='.length);
    else if (a === '--prefix') prefix = args[++i];
    else if (a?.startsWith('--prefix=')) prefix = a.slice('--prefix='.length);
    else if (a === '--extractable') extractable = true;
    else if (a === '--expert' || a === '--expert-routing') expert = true;
    else if (a === '--alias') aliases.push(args[++i]!);
    else if (a?.startsWith('--alias=')) aliases.push(a.slice('--alias='.length));
  }
  if (!primitive || !PACK_PRIMITIVES.includes(primitive as PackPrimitive)) {
    console.error(`--primitive must be one of ${PACK_PRIMITIVES.join('|')}`);
    process.exit(2);
  }
  if (!prefix) { console.error('--prefix is required (e.g. --prefix people/researchers/)'); process.exit(2); }
  try {
    const result = await addTypeToPack(packName, {
      name, primitive: primitive as PackPrimitive, prefix,
      extractable, expertRouting: expert, aliases,
    });
    emitMutateResult(result, json);
  } catch (e) { handleMutationError(e); }
}

async function runRemoveTypeCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const name = args.filter((a) => !a.startsWith('--'))[0];
  if (!name) { console.error('Usage: gbrain schema remove-type <name>'); process.exit(2); }
  try { emitMutateResult(await removeTypeFromPack(packName, name), json); }
  catch (e) { handleMutationError(e); }
}

async function runUpdateTypeCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const name = args.filter((a) => !a.startsWith('--'))[0];
  if (!name) { console.error('Usage: gbrain schema update-type <name> [--extractable BOOL] [--expert BOOL] [--primitive P]'); process.exit(2); }
  const patch: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--extractable') {
      const v = parseBool(args[++i]);
      if (v === null) { console.error('--extractable requires true|false'); process.exit(2); }
      patch.extractable = v;
    } else if (a === '--expert' || a === '--expert-routing') {
      const v = parseBool(args[++i]);
      if (v === null) { console.error('--expert requires true|false'); process.exit(2); }
      patch.expert_routing = v;
    } else if (a === '--primitive') {
      patch.primitive = args[++i];
    }
  }
  try { emitMutateResult(await updateTypeOnPack(packName, { name, patch }), json); }
  catch (e) { handleMutationError(e); }
}

async function runAddAliasCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length < 2) { console.error('Usage: gbrain schema add-alias <type> <alias>'); process.exit(2); }
  try { emitMutateResult(await addAliasToType(packName, pos[0]!, pos[1]!), json); }
  catch (e) { handleMutationError(e); }
}

async function runRemoveAliasCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length < 2) { console.error('Usage: gbrain schema remove-alias <type> <alias>'); process.exit(2); }
  try { emitMutateResult(await removeAliasFromType(packName, pos[0]!, pos[1]!), json); }
  catch (e) { handleMutationError(e); }
}

async function runAddPrefixCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length < 2) { console.error('Usage: gbrain schema add-prefix <type> <prefix>'); process.exit(2); }
  try { emitMutateResult(await addPrefixToType(packName, pos[0]!, pos[1]!), json); }
  catch (e) { handleMutationError(e); }
}

async function runRemovePrefixCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length < 2) { console.error('Usage: gbrain schema remove-prefix <type> <prefix>'); process.exit(2); }
  try { emitMutateResult(await removePrefixFromType(packName, pos[0]!, pos[1]!), json); }
  catch (e) { handleMutationError(e); }
}

async function runAddLinkTypeCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const name = args.filter((a) => !a.startsWith('--'))[0];
  if (!name) { console.error('Usage: gbrain schema add-link-type <name> [--inverse <verb>] [--page-type <t>] [--target-type <t>]'); process.exit(2); }
  let inverse: string | undefined;
  let pageType: string | undefined;
  let targetType: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--inverse') inverse = args[++i];
    else if (a === '--page-type') pageType = args[++i];
    else if (a === '--target-type') targetType = args[++i];
  }
  const inference = (pageType || targetType) ? { page_type: pageType, target_type: targetType } : undefined;
  try {
    emitMutateResult(await addLinkTypeToPack(packName, { name, inverse, inference }), json);
  } catch (e) { handleMutationError(e); }
}

async function runRemoveLinkTypeCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const name = args.filter((a) => !a.startsWith('--'))[0];
  if (!name) { console.error('Usage: gbrain schema remove-link-type <name>'); process.exit(2); }
  try { emitMutateResult(await removeLinkTypeFromPack(packName, name), json); }
  catch (e) { handleMutationError(e); }
}

async function runSetExtractableCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length < 2) { console.error('Usage: gbrain schema set-extractable <type> <true|false>'); process.exit(2); }
  const v = parseBool(pos[1]);
  if (v === null) { console.error('Second argument must be true|false'); process.exit(2); }
  try { emitMutateResult(await setExtractableOnType(packName, pos[0]!, v), json); }
  catch (e) { handleMutationError(e); }
}

async function runSetExpertRoutingCmd(args: string[]): Promise<void> {
  const { json } = parseFlags(args);
  const packName = pickPackName({}, args);
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length < 2) { console.error('Usage: gbrain schema set-expert-routing <type> <true|false>'); process.exit(2); }
  const v = parseBool(pos[1]);
  if (v === null) { console.error('Second argument must be true|false'); process.exit(2); }
  try { emitMutateResult(await setExpertRoutingOnType(packName, pos[0]!, v), json); }
  catch (e) { handleMutationError(e); }
}
