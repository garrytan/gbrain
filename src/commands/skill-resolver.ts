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
import {
  buildSkillIndex, catalogStatus, listCatalogs, removeSkillIndex, resolveSkills, resolverHome, sessionStatus,
  ResolverError, HARNESSES, errorTurnOutput, GBRAIN_VERSION, type BuildInput, type TurnInput,
} from '../core/skills/resolver/index.ts';

const HELP_INDEX = `Usage: gbrain skills index <build|status|remove> [options]

Build, inspect or remove a skill catalog's index (under GBRAIN_HOME/skill-index/).
No brain connection is needed.

  gbrain skills index build --catalog <name> (--dir <d>... | --bundled | --from-json <file|->)
        [--routing <file>] [--harness <h>] [--scope user|project] [--json]
  gbrain skills index status [--catalog <name>] [--session <id> [--harness <h>] [--shadow]] [--json]
  gbrain skills index remove --catalog <name> [--json]

  --catalog <name>   catalog name: a-z, 0-9, _ and -, up to 64 characters
  --dir <d>          a SKILL.md directory (repeatable; earlier wins on duplicate ids)
  --bundled          gbrain's own bundled skills
  --from-json <f|->  an adapter's skill list ([{id, name, description, triggers?, path?, eligible?}])
  --routing <file>   one RESOLVER-style routing table; rows add trigger text to skills
  --harness <h>      openclaw, claude-code, codex, hermes, qm, pi or cursor (recorded in the receipt)
  --scope project    a cloned repository's skills: blocks show ids and names only
  --session <id>     status: that session's turn count and token budget

Guide: docs/guides/skill-resolver.md
`;

const HELP_RESOLVE = `Usage: gbrain skills resolve [--catalog <name>]... (--text <t> [--previous <t>] | --input-json -)
        [--session <id>] [--harness <h>] [--exclude a,b] [--top-k n] [--min-match <strength>] [--shadow [--shadow-log <file>]]
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
  --min-match <s>      the weakest match to suggest: named, name, triggers, routing,
                       description or body (default: every match)
  --shadow             compute the block without injecting it (block "" on stdout);
                       --shadow-log <file> appends what would have been injected
  --expect-catalog <h> refuse with skill_catalog_mismatch unless the catalog hash is h
  --reset-session      the session was compacted: start its dedupe and budget again
  --explain-target <id> why a skill did or did not rank
  --fail-open          a runtime error exits 0 with block "" and error set (for hooks)
  --json               the turn output document (docs/schemas/skill-resolver.v1.turn-output.json)

Guide: docs/guides/skill-resolver.md
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
  usage(r.kind === 'timeout' ? 'stdin sent no data before the read timed out.' : 'stdin could not be read: ' + (r.kind === 'error' ? r.error.message : 'cancelled') + '.', 'Send one turn (or one catalog of at most 8 MB) on stdin and close it.');
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
  const p = parseFlags(args.slice(1), ['--catalog', '--dir', '--from-json', '--routing', '--harness', '--scope', '--session'], ['--bundled', '--json', '--shadow'], HELP_INDEX);
  const json = p.bools.has('--json');
  if (p.positionals.length) usage(`Unexpected argument "${p.positionals[0]}".`, 'Pass options as flags; see gbrain skills index --help.');
  try {
    if (sub === 'build') {
      const catalog = one(p, '--catalog');
      if (!catalog) usage('skills index build needs --catalog <name>.', 'Example: gbrain skills index build --catalog claude-user --dir ~/.claude/skills');
      const fromJson = one(p, '--from-json');
      const input: BuildInput = { catalog: catalog!, ...(p.flags.get('--dir') ? { dirs: p.flags.get('--dir') } : {}), ...(p.bools.has('--bundled') ? { bundled: true } : {}),
        ...(one(p, '--routing') ? { routing: one(p, '--routing') } : {}), ...(one(p, '--harness') ? { harness: one(p, '--harness') } : {}),
        ...(one(p, '--scope') ? { scope: one(p, '--scope') as 'user' | 'project' } : {}) };
      if (fromJson === '-') {
        const text = await readStdinCapped(8 * 1024 * 1024);
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
  const p = parseFlags(args, ['--catalog', '--text', '--previous', '--input-json', '--session', '--harness', '--exclude', '--top-k', '--min-match', '--shadow-log', '--explain-target', '--expect-catalog', '--load-hint'],
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

export async function runSkillResolver(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'index') return runIndex(rest);
  if (sub === 'resolve') return runResolve(rest);
  if (sub === 'library') return runLibrary(rest);
  process.stdout.write(`${HELP_RESOLVE}\n${HELP_INDEX}\n${HELP_LIBRARY}`);
}
