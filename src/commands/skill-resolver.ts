/**
 * `gbrain skills index build|status|remove`, `gbrain skills resolve` and
 * `gbrain skills library`: the skill resolver's CLI (library:
 * src/core/skills/resolver/). The router (src/cli/command-route.ts) sends these `skills` subcommands here
 * before any engine or brain is touched; plain `gbrain skills` keeps
 * listing skills through `list_skills`.
 *
 * Exit codes: 0 on success (a no_skill turn and an empty block are
 * successes); 1 on a runtime error (skill_index_missing and the rest), with
 * the code and fix on stderr and, under --json, the turn output with
 * `error` set on stdout; `--fail-open` turns a runtime error into exit 0
 * with `block: ""` and `error` set; 2 on a usage error (no input, bad JSON,
 * an unknown flag or catalog name), with the agent-protocol refusal.
 */
import { appendFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { exitCliError, usageError, writeCliError } from '../cli/cli-error.ts';
import { readStdinBounded } from '../core/interaction.ts';
import { opError } from '../core/ops/contract.ts';
import type { RegistryCode } from '../core/error-registry.ts';
import { JSON_INPUT_CAP_BYTES } from '../core/skills/resolver/sources.ts';
import {
  buildSkillIndex, catalogStatus, listCatalogs, removeSkillIndex, resolveSkills, resolverHome, sessionStatus,
  ResolverError, HARNESSES, errorTurnOutput, GBRAIN_VERSION, type BuildInput, type TurnInput,
} from '../core/skills/resolver/index.ts';
import { validCatalogName } from '../core/skills/resolver/paths.ts';
import { readResolverConfig, resolverHarnesses } from '../core/setup/skill-resolver-config.ts';
import { catalogSkillIds, pinProblem, PINS_MAX, readPins, renderPinnedBlock, writePins } from '../core/setup/skill-pins.ts';
import { refreshOpenclawPins } from '../core/setup/openclaw-skill-plugin.ts';
import { PI_SKILL_CATALOG, refreshPiPins } from '../core/setup/pi-skill-extension.ts';
import { HERMES_PINS_CATALOG, syncHermesPins } from '../core/setup/hermes-skill-pins.ts';
import { CURSOR_PINS_CATALOG_PREFIX, cursorPinnedBlock, refreshCursorPins } from '../core/setup/cursor-skill-pins.ts';

const HELP_INDEX = `Usage: gbrain skills index <build|status|remove> [options]

Build, inspect or remove a skill catalog's index (under GBRAIN_HOME/skill-index/).
No brain connection is needed.

  gbrain skills index build --catalog <name> (--dir <d>... | --bundled | --from-json <file|-> [--dir <d>...]
        | --claude-plugins <dir>) [--routing <file>] [--harness <h>] [--scope user|project] [--json]
  gbrain skills index status [--catalog <name>] [--session <id> [--harness <h>] [--shadow]] [--json]
  gbrain skills index remove --catalog <name> [--json]

  --catalog <name>   catalog name: a-z, 0-9, _ and -, up to 64 characters
  --dir <d>          a SKILL.md directory (repeatable; earlier wins on duplicate ids)
  --bundled          gbrain's own bundled skills
  --from-json <f|->  an adapter's skill list ([{id, name, description, triggers?, path?, eligible?}])
                     or OpenClaw's skills list --json output as is; with --dir, each listed skill
                     takes its body, path and triggers from the folder skill of the same name
  --claude-plugins <dir>  the skills of the enabled user-scope Claude Code plugins under
                     <dir> (~/.claude), named <plugin>:<skill>
  --routing <file>   one RESOLVER-style routing table; rows add trigger text to skills
  --harness <h>      openclaw, claude-code, codex, hermes, qm, pi or cursor (recorded in the receipt)
  --scope project    a cloned repository's skills: blocks show ids and names only
  --session <id>     status: that session's turn count and token budget

Guide: docs/guides/skill-resolver.md
`;

const HELP_RESOLVE = `Usage: gbrain skills resolve [--catalog <name>]... (--text <t> [--previous <t>] | --input-json -)
        [--session <id>] [--harness <h>] [--exclude a,b] [--top-k n] [--min-match <strength>] [--top-gate <x>] [--shadow [--shadow-log <file>]]
        [--expect-catalog <hash>] [--reset-session] [--names-only] [--load-hint <text>]
        [--explain-target <id>] [--fail-open] [--json]

Pick the few skills that fit one user turn (or none) and print the <relevant_skills>
block for the harness to show the model. Word matching only: nothing leaves this machine,
and no brain connection is needed.

  --catalog <name>     the catalog to rank (repeatable to merge; default: the only one)
  --text <t>           the user message (or send turn JSON with --input-json -)
  --session <id>       the harness session: suggestions are not repeated within it, and its
                       block tokens are capped by skills.resolver.session_token_budget (2000)
  --harness <h>        picks the load line: openclaw, claude-code, codex, hermes, qm, pi or cursor
  --top-k <n>          at most n suggestions (1-8, default 5)
  --exclude <ids>      comma-separated skill ids to leave out
  --min-match <s>      drop candidates weaker than this match: named, name, triggers,
                       routing, description or body (default: every match). It filters;
                       stronger matches still fill the block, so it never empties it
  --top-gate <x>       empty the block when the best skill it would show (after
                       --exclude, --min-match and session dedupe) scores below x over its catalog's
                       maximum word weight (0-100; default off); a skill named in the
                       turn bypasses it
  --shadow             compute the block without injecting it (block "" on stdout);
                       --shadow-log <file> appends what would have been injected
  --expect-catalog <h> refuse with skill_catalog_mismatch unless the catalog hash is h
  --reset-session      the session was compacted: start its dedupe and budget again
  --explain-target <id> why a skill did or did not rank
  --fail-open          a runtime error exits 0 with block "" and error set (for hooks)
  --json               the turn output document (docs/schemas/skill-resolver.v1.turn-output.json)

Guide: docs/guides/skill-resolver.md
`;

const HELP_PIN = `Usage: gbrain skills pin <add|remove|list> --catalog <name> [options]

The operator's always-on skills for one catalog: rendered as a pinned block the harness
shows on every turn, and never suggested twice. gbrain ships no pins; a catalog with
none gets no pinned block. Pins live in config.json (skills.resolver.pins.<catalog>),
so turning the resolver off keeps them.

  gbrain skills pin add <skill-id> --catalog <name> [--line "<when to use it, 100 chars>"] [--json]
  gbrain skills pin remove <skill-id> --catalog <name> [--json]
  gbrain skills pin list --catalog <name> [--json]

  --catalog <name>  the catalog the skill must be in (openclaw-<agent>, claude-code-user, ...)
  --line <text>     one trigger-first line shown beside the id (no < or >)

An OpenClaw agent picks up a pin change on its next turn, with no reload.
Guide: docs/guides/skill-resolver.md#pinned-skills
`;

const HELP_LIBRARY = `Usage: gbrain skills library [--out <file.mjs>] [--json]

Write the skill resolver library, built from this gbrain's own source, as one
dependency-free ES module that Node imports (default: GBRAIN_HOME/lib/gbrain-skill-resolver.mjs),
and print its path, sha256 and gbrain version. Run it again after each upgrade.

  --out <file.mjs>   write it here instead
  --json             {path, sha256, bytes, gbrain_version}

Guide: docs/guides/skill-resolver.md#library
`;

const CMD = 'skills';

function toOpError(e: ResolverError) {
  const command = e.toJSON().fix.command;
  return opError(e.code as RegistryCode, e.message, command ? `${e.fix.suggestion} Run: ${command}` : e.fix.suggestion,
    e.fix.argv ? { fix: { argv: e.fix.argv, consent: [], actor: 'agent', why: e.fix.suggestion, requires_exclusive: false } } : {});
}

function usage(message: string, suggestion: string): never {
  exitCliError(usageError(message, suggestion), CMD);
}

interface Parsed { flags: Map<string, string[]>; bools: Set<string>; positionals: string[] }

function parseFlags(args: string[], valued: readonly string[], booleans: readonly string[], help: string): Parsed {
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') { process.stdout.write(help); process.exit(0); }
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    if (booleans.includes(a)) { bools.add(a); continue; }
    if (!valued.includes(a)) usage(`unknown flag ${a} for 'gbrain skills'`, 'Run gbrain skills resolve --help or gbrain skills index --help for the accepted flags.');
    const v = args[i + 1];
    if (v === undefined || (v.startsWith('--') && v !== '-')) usage(`${a} requires a value.`, `Pass a value after ${a}.`);
    flags.set(a, [...(flags.get(a) ?? []), v!]);
    i++;
  }
  return { flags, bools, positionals };
}

const one = (p: Parsed, f: string) => { const v = p.flags.get(f); if (v && v.length > 1) usage(`${f} was given more than once.`, `Pass ${f} once.`); return v?.[0]; };

async function readStdinCapped(max: number): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const r = await readStdinBounded({ maxBytes: max });
  if (r.kind === 'data') return r.text;
  if (r.kind === 'empty') return '';
  usage(r.kind === 'timeout' ? 'stdin sent no data before the read timed out.' : 'stdin could not be read: ' + (r.kind === 'error' ? r.error.message : 'cancelled') + '.', 'Send one turn (or one catalog of at most 64 MB) on stdin and close it.');
}

function write(text: string): Promise<boolean> {
  if (!text) return Promise.resolve(true);
  return new Promise(res => { try { process.stdout.write(text, err => res(!err)); } catch { res(false); } });
}

function runtimeFailure(e: ResolverError, json: boolean): never {
  if (json) {
    exitCliError(toOpError(e), CMD, { json: true });
  }
  writeCliError(toOpError(e), CMD, { json: false });
  process.exit(1);
}

async function runIndex(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== 'build' && sub !== 'status' && sub !== 'remove') {
    if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') { process.stdout.write(HELP_INDEX); return; }
    usage(`Unknown subcommand "skills index ${sub}".`, 'Use gbrain skills index build, status or remove.');
  }
  const p = parseFlags(args.slice(1), ['--catalog', '--dir', '--from-json', '--claude-plugins', '--routing', '--harness', '--scope', '--session'], ['--bundled', '--json', '--shadow'], HELP_INDEX);
  const json = p.bools.has('--json');
  if (p.positionals.length) usage(`Unexpected argument "${p.positionals[0]}".`, 'Pass options as flags; see gbrain skills index --help.');
  try {
    if (sub === 'build') {
      const catalog = one(p, '--catalog');
      if (!catalog) usage('skills index build needs --catalog <name>.', 'Example: gbrain skills index build --catalog claude-user --dir ~/.claude/skills');
      const fromJson = one(p, '--from-json');
      const input: BuildInput = { catalog: catalog!, ...(p.flags.get('--dir') ? { dirs: p.flags.get('--dir') } : {}), ...(p.bools.has('--bundled') ? { bundled: true } : {}),
        ...(one(p, '--claude-plugins') !== undefined ? { claudePlugins: one(p, '--claude-plugins') } : {}),
        ...(one(p, '--routing') ? { routing: one(p, '--routing') } : {}), ...(one(p, '--harness') ? { harness: one(p, '--harness') } : {}),
        ...(one(p, '--scope') ? { scope: one(p, '--scope') as 'user' | 'project' } : {}) };
      if (fromJson === '-') {
        const text = await readStdinCapped(JSON_INPUT_CAP_BYTES);
        if (!text) exitCliError(toOpError(new ResolverError('skill_resolve_no_input', 'No catalog JSON arrived on stdin.', { suggestion: 'Pipe the skill list: <adapter> | gbrain skills index build --catalog <name> --from-json -' })), CMD);
        input.fromJson = text!;
        input.fromJsonStdin = true;
      } else if (fromJson !== undefined) input.fromJson = fromJson;
      const receipt = await buildSkillIndex(input);
      if (json) await write(`${JSON.stringify(receipt, null, 2)}\n`);
      else await write(`Built catalog ${receipt.catalog.name}: ${receipt.catalog.skill_count} skills (${receipt.catalog.skipped.length} skipped), variant ${receipt.ranker.variant}, ${receipt.index.size} bytes, ${receipt.build.ms} ms.\n`);
      return;
    }
    if (sub === 'remove') {
      const catalog = one(p, '--catalog');
      if (!catalog) usage('skills index remove needs --catalog <name>.', 'Example: gbrain skills index remove --catalog claude-user');
      const r = await removeSkillIndex(catalog!);
      await write(json ? `${JSON.stringify(r)}\n` : r.removed ? `Removed catalog ${r.catalog}.\n` : `No catalog named ${r.catalog}.\n`);
      return;
    }
    const home = resolverHome();
    const named = one(p, '--catalog');
    const names = named ? [named] : listCatalogs(home);
    const catalogs = [];
    for (const n of names) catalogs.push(await catalogStatus(n));
    const session = one(p, '--session') ? sessionStatus(one(p, '--session')!, { harness: one(p, '--harness'), shadow: p.bools.has('--shadow') }) : null;
    const doc = { schema_version: 1, home, catalogs, ...(session ? { session } : {}) };
    if (json) { await write(`${JSON.stringify(doc, null, 2)}\n`); return; }
    const lines = catalogs.length ? catalogs.map(c => c.present
      ? `${c.catalog}: ${c.receipt!.skill_count} skills, variant ${c.receipt!.variant}, ${c.fresh ? 'fresh' : `stale (${c.stale_reason})`}${c.rebuild.running ? `, rebuild running (${c.rebuild.holder})` : ''}${c.rebuild.last_error ? `, last build failed: ${c.rebuild.last_error.code} (${c.rebuild.log_path})` : ''}`
      : `${c.catalog}: not built (${c.stale_reason})`) : ['No skill catalogs. Build one with gbrain skills index build --catalog <name> --dir <skills dir>.'];
    if (session) lines.push(`session ${session.session_id}: turn ${session.turn}, ${session.spent}/${session.budget} block tokens spent, ${session.remaining} left`);
    await write(`${lines.join('\n')}\n`);
  } catch (e) {
    if (!(e instanceof ResolverError)) throw e;
    if (e.usage) exitCliError(toOpError(e), CMD);
    runtimeFailure(e, json);
  }
}

async function runResolve(args: string[]): Promise<void> {
  const p = parseFlags(args, ['--catalog', '--text', '--previous', '--input-json', '--session', '--harness', '--exclude', '--top-k', '--min-match', '--top-gate', '--shadow-log', '--explain-target', '--expect-catalog', '--load-hint'],
    ['--shadow', '--json', '--fail-open', '--reset-session', '--names-only'], HELP_RESOLVE);
  if (p.positionals.length) usage(`Unexpected argument "${p.positionals[0]}".`, 'Pass the message with --text "<message>" or turn JSON with --input-json -.');
  const json = p.bools.has('--json');
  const failOpen = p.bools.has('--fail-open');
  const text = one(p, '--text');
  const inputJson = one(p, '--input-json');
  if (text !== undefined && inputJson !== undefined) usage('Pass either --text or --input-json, not both.', 'Use --text "<message>" for one message, or --input-json - for turn JSON on stdin.');
  if (inputJson !== undefined && inputJson !== '-') usage('--input-json reads stdin only; pass --input-json -.', 'Pipe the turn JSON: echo \'{"message":"..."}\' | gbrain skills resolve --input-json -');
  let input: Record<string, unknown>;
  try {
    if (inputJson === '-') {
      const raw = await readStdinCapped(1024 * 1024);
      if (raw === null || !raw.trim()) throw new ResolverError('skill_resolve_no_input', raw === null ? 'stdin is a terminal, so no turn JSON arrived.' : 'stdin was empty, so no turn JSON arrived.', { suggestion: 'Pipe the turn JSON: echo \'{"message":"..."}\' | gbrain skills resolve --input-json -' });
      try { input = JSON.parse(raw) as Record<string, unknown>; } catch { throw new ResolverError('skill_resolve_invalid_input', 'The turn input on stdin is not valid JSON.', { suggestion: 'Send one JSON object such as {"message": "..."}.' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ResolverError('skill_resolve_invalid_input', 'The turn input must be a JSON object.', { suggestion: 'Send one JSON object such as {"message": "..."}.' });
    } else if (text !== undefined) input = { message: text };
    else throw new ResolverError('skill_resolve_no_input', 'No message: pass --text "<message>" or --input-json -.', { suggestion: 'Example: gbrain skills resolve --text "summarize my meeting notes"' });
    const prev = one(p, '--previous');
    if (prev !== undefined) input.previous_user_message = prev;
    const session = one(p, '--session'); if (session !== undefined) input.session_id = session;
    const harness = one(p, '--harness'); if (harness !== undefined) input.harness = harness;
    const exclude = one(p, '--exclude'); if (exclude !== undefined) input.exclude = exclude.split(',').map(s => s.trim()).filter(Boolean);
    const topK = one(p, '--top-k');
    if (topK !== undefined) { if (!/^\d+$/.test(topK)) throw new ResolverError('skill_resolve_invalid_input', '--top-k takes an integer from 1 to 8.', { suggestion: 'Example: --top-k 3' }); input.top_k = Number(topK); }
    const minMatch = one(p, '--min-match'); if (minMatch !== undefined) input.min_match_strength = minMatch;
    const topGate = one(p, '--top-gate');
    if (topGate !== undefined) { if (!/^\d+(\.\d+)?$/.test(topGate)) throw new ResolverError('skill_resolve_invalid_input', '--top-gate takes a number from 0 to 100.', { suggestion: 'Example: --top-gate 1.5' }); input.top_gate = Number(topGate); }
    if (p.bools.has('--shadow')) input.shadow = true;
    if (p.bools.has('--reset-session')) input.reset_session = true;
    const expect = one(p, '--expect-catalog'); if (expect !== undefined) input.expected_catalog_hash = expect;
    if (harness !== undefined && !(HARNESSES as readonly string[]).includes(harness)) throw new ResolverError('skill_resolve_invalid_input', `Unknown harness "${harness}".`, { suggestion: `Use one of: ${HARNESSES.join(', ')}.` });
  } catch (e) {
    if (e instanceof ResolverError) exitCliError(toOpError(e), CMD);
    throw e;
  }
  let result;
  try {
    result = await resolveSkills(input as unknown as TurnInput, {
      ...(p.flags.get('--catalog') ? { catalogs: p.flags.get('--catalog') } : {}), failOpen,
      ...(one(p, '--load-hint') ? { loadHint: one(p, '--load-hint') } : {}), namesOnly: p.bools.has('--names-only'),
      ...(one(p, '--explain-target') !== undefined ? { explainTarget: one(p, '--explain-target') } : {}),
    });
  } catch (e) {
    if (!(e instanceof ResolverError)) throw e;
    if (e.usage) exitCliError(toOpError(e), CMD);
    if (json) await write(`${JSON.stringify(errorTurnOutput(e, { shadow: input.shadow === true, catalog: p.flags.get('--catalog')?.length === 1 ? p.flags.get('--catalog')![0]! : null }))}\n`);
    writeCliError(toOpError(e), CMD, { json: false });
    process.exit(1);
  }
  const out = result.output;
  if (out.error) writeCliError(toOpError(new ResolverError(out.error.code as never, out.error.message, { suggestion: out.error.fix.suggestion })), CMD, { json: false });
  const shadowLog = one(p, '--shadow-log');
  if (shadowLog && result.shadowOutput) {
    try { appendFileSync(shadowLog, `${JSON.stringify(result.shadowOutput)}\n`, { mode: 0o600 }); } catch { /* the log is best effort; the turn is unaffected */ }
  }
  let delivered: boolean;
  if (json) delivered = await write(`${JSON.stringify(result.explain ? { ...out, explain: result.explain } : out)}\n`);
  else if (result.explain) {
    const x = result.explain;
    delivered = await write([
      `${x.target}: ${x.indexed ? `indexed in ${x.catalog}` : x.skip_reason ? `not indexed (${x.skip_reason})` : 'not in the catalog'}`,
      x.indexed ? `rank: ${x.rank ?? 'no match'}${x.score !== null ? `, score ${x.score}` : ''}` : '',
      Object.keys(x.fields).length ? `matched: ${Object.entries(x.fields).map(([f, t]) => `${f} (${t.join(', ')})`).join('; ')}` : '',
      x.excluded ? 'excluded by --exclude' : '', x.deduped ? 'already suggested in this session (deduped)' : '', `in block: ${x.in_block ? 'yes' : 'no'}`,
      x.session ? `session: turn ${x.session.turn}, ${x.session.spent}/${x.session.budget} block tokens spent, ${x.session.remaining} left` : '',
    ].filter(Boolean).join('\n') + '\n');
  } else delivered = await write(out.block ? `${out.block}\n` : '');
  if (delivered) await result.commit();
  if (out.error && !failOpen) process.exit(1);
}

async function runLibrary(args: string[]): Promise<void> {
  const p = parseFlags(args, ['--out'], ['--json'], HELP_LIBRARY);
  if (p.positionals.length) usage(`Unexpected argument "${p.positionals[0]}".`, 'Pass the file with --out <file.mjs>.');
  const json = p.bools.has('--json');
  const out = one(p, '--out');
  if (out !== undefined && !out.endsWith('.mjs')) usage('--out must name a .mjs file.', 'Example: gbrain skills library --out ./gbrain-skill-resolver.mjs');
  try {
    const { buildResolverLibrary, LIBRARY_FILE } = await import('./skill-resolver-library.ts');
    const built = await buildResolverLibrary(out ? resolvePath(out) : join(resolverHome(), 'lib', LIBRARY_FILE));
    const doc = { ...built, gbrain_version: GBRAIN_VERSION };
    await write(json ? `${JSON.stringify(doc)}\n` : `Wrote ${doc.path} (gbrain ${doc.gbrain_version}, ${doc.bytes} bytes)\nsha256 ${doc.sha256}\n`);
  } catch (e) {
    if (!(e instanceof ResolverError)) throw e;
    runtimeFailure(e, json);
  }
}

async function runPin(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== 'add' && sub !== 'remove' && sub !== 'list') {
    if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') { process.stdout.write(HELP_PIN); return; }
    usage(`Unknown subcommand "skills pin ${sub}".`, 'Use gbrain skills pin add, remove or list.');
  }
  const p = parseFlags(args.slice(1), ['--catalog', '--line'], ['--json'], HELP_PIN);
  const json = p.bools.has('--json');
  const catalog = one(p, '--catalog');
  if (!catalog || !validCatalogName(catalog)) usage('--catalog <name> is required (a-z, 0-9, _ and -).', 'Pass the catalog the pin belongs to, e.g. --catalog openclaw-main.');
  const home = resolverHome();
  const read = readResolverConfig(home);
  if (read.state === 'unreadable') exitCliError(opError('skill_resolver_config_unreadable', `${read.path} cannot be read (${read.why}); nothing was written.`, 'Fix or move the config file, then retry.', { docs: 'docs/guides/skill-resolver.md#skill_resolver_config_unreadable' }), CMD, { json });
  let pins = readPins(read, catalog);
  if (sub !== 'list') {
    const name = p.positionals[0];
    if (!name || p.positionals.length > 1) usage(`gbrain skills pin ${sub} takes one skill id.`, `Example: gbrain skills pin ${sub} <skill-id> --catalog ${catalog}`);
    const line = one(p, '--line');
    if (sub === 'add') {
      const problem = pinProblem({ name, ...(line !== undefined ? { line } : {}) });
      if (problem) usage(problem, 'Fix the value and retry.');
      const known = catalogSkillIds(home, catalog);
      if (!known) runtimeFailure(new ResolverError('skill_index_missing', `The catalog "${catalog}" has not been built, so the pin cannot be checked; nothing was written.`, { suggestion: `Build it first with gbrain skills index build --catalog ${catalog} ...; or run gbrain setup <harness> --skill-loading resolve.` }), json);
      if (!known.has(name)) exitCliError(opError('skill_resolver_pin_unknown', `"${name}" is not a skill in ${catalog}; nothing was written.`, `Check the id with gbrain skills index status --catalog ${catalog}, then retry.`, { docs: 'docs/guides/skill-resolver.md#skill_resolver_pin_unknown' }), CMD, { json });
      const others = pins.filter((x) => x.name !== name);
      if (others.length >= PINS_MAX) usage(`${catalog} already has ${PINS_MAX} pins.`, 'Remove one first.');
      pins = [...others, { name, ...(line !== undefined ? { line } : {}) }];
    } else {
      if (line !== undefined) usage('--line is for pin add.', 'Drop --line.');
      pins = pins.filter((x) => x.name !== name);
    }
    writePins(read, catalog, pins);
  }
  const cursor = catalog.startsWith(CURSOR_PINS_CATALOG_PREFIX);
  const rendered = cursor ? cursorPinnedBlock(home, catalog) : renderPinnedBlock(pins, { harness: catalog.startsWith('openclaw-') ? 'openclaw' : catalog === HERMES_PINS_CATALOG ? 'hermes' : catalog === PI_SKILL_CATALOG ? 'pi' : undefined, known: catalogSkillIds(home, catalog) });
  const agents = sub === 'list' ? [] : refreshOpenclawPins(home);
  const piUpdated = sub !== 'list' && catalog === PI_SKILL_CATALOG && refreshPiPins(home);
  const hermesOn = catalog === HERMES_PINS_CATALOG && sub !== 'list' && resolverHarnesses(read.state === 'ok' ? read.doc : null).includes('hermes');
  const soul = hermesOn ? syncHermesPins({ home, hermesHome: (await import('../core/setup/skill-resolver-hook.ts')).hermesHomeDir(), dryRun: false }) : null;
  const cursorRule = cursor && sub !== 'list' ? refreshCursorPins(home, catalog) : null;
  const doc = { catalog, pins, rendered: rendered.ids, unknown: rendered.unknown, cut: rendered.cut, block_tokens: rendered.tokens, ...(agents.length ? { openclaw_agents_updated: agents } : {}), ...(soul ? { hermes_soul: soul } : {}), ...(piUpdated ? { pi_state_updated: true } : {}), ...(cursorRule ? { cursor_rule: { project: cursorRule.project, steps: cursorRule.steps, ...(cursorRule.error ? { error: cursorRule.error } : {}) } } : {}) };
  if (json) { await write(`${JSON.stringify(doc)}\n`); return; }
  await write([
    pins.length ? `${catalog}: ${pins.length} pin(s)` : `${catalog}: no pins`,
    ...pins.map((x) => `  ${x.name}${x.line ? ` — ${x.line}` : ''}${rendered.unknown.includes(x.name) ? ' (not in the catalog: left out, skill_resolver_pin_unknown)' : rendered.cut.includes(x.name) ? ' (over the token cap: left out)' : ''}`),
    agents.length ? `OpenClaw agent(s) ${agents.join(', ')} use the new pins from their next turn.` : '',
    piUpdated ? 'Pi uses the new pins from its next run.' : '',
    soul ? `Hermes: ${soul.action} ${soul.detail}${soul.action === 'skip' ? '' : '; Hermes reads SOUL.md at session start'}.` : '',
    cursorRule ? (cursorRule.error ? `Cursor: ${cursorRule.error.message}` : `Cursor (${cursorRule.project}): ${cursorRule.steps.filter((x) => x.step === 'rule').map((x) => `${x.action} ${x.detail}`).join('; ')}; Cursor applies the rule from its next request.`) : '',
  ].filter(Boolean).join('\n') + '\n');
}

export async function runSkillResolver(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'index') return runIndex(rest);
  if (sub === 'resolve') return runResolve(rest);
  if (sub === 'library') return runLibrary(rest);
  if (sub === 'pin') return runPin(rest);
  process.stdout.write(`${HELP_RESOLVE}\n${HELP_INDEX}\n${HELP_PIN}\n${HELP_LIBRARY}`);
}
