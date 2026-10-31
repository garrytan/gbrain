/**
 * #7619: `--flag=value` on CLI_ONLY commands. The unknown-flag validator
 * accepts the `=` form of every registered flag, but most handlers read only
 * `--flag value` (`args.includes`, `args[args.indexOf(flag) + 1]`), so the
 * value was dropped with no error: `serve --access=read-only` served every
 * write tool, `auth create --scopes=read` minted a full-access token. The
 * CLI entry never lets an `=` token reach a handler that would drop it:
 *  - refuse (invalid_params, exit 2) a switch: a boolean in the command's own
 *    table (curated help, the sync flag table), a `--no-` negation, the
 *    command's COMMAND_SWITCHES, or a name whose shared-op parameter or
 *    curated flag is boolean. Splitting turns the switch on and keeping drops
 *    the value (`--dry-run=true` would write). Without the command's own
 *    table, that cross-command evidence picks the bare-switch message, so
 *    `--yes=n` is never answered with `--yes <value>`;
 *  - without the command's own table, refuse a true/false word or 0/1
 *    (`--apply=false`) naming both readings, so it never suggests
 *    `--apply false` (which turns a switch on) and says a value never turns
 *    a switch off;
 *  - after a bare `--` the handler reads past, refuse an `=` token that is
 *    not a registered flag: the unknown-flag validator stops at `--`;
 *  - keep the token where the handler on this path reads the `=` form
 *    (EQUALS_READERS, keyed by command or `command sub`), empty values
 *    included: that handler owns refusing them;
 *  - elsewhere, refuse an empty value or one that looks like a flag (`-y`, `--x`);
 *  - split `--flag value` when the command's own table declares a value;
 *  - refuse every other `=` form with the separate-token spelling. Splitting
 *    a flag the subcommand never reads would leave its value as a stray
 *    positional, which handlers that take the first numeric or non-flag token
 *    as their target would act on (`forget --purge --reason=3 34` purging
 *    fact 3). Keeping it whole is safe only where every path of the command
 *    reads the `=` form, and evidence from one module does not show that for
 *    its sibling subcommands (`extract links --source-id=x` walked every
 *    source while `extract --stale` validated the same token).
 * `--json=true` becomes `--json` (the agent contract's JSON spelling, read
 * the same way by jsonRequested). Refusals name `--flag=…`, never the value,
 * which may be a credential. A short flag never takes `=` (`-y=n` is refused,
 * never taken as consent); a quoted argument with whitespace that only starts
 * like one (`capture "-n=3 is the answer"`) is text. `agent run` scans only
 * where parseRunFlags reads flags: the leading flag zone (its switches, its value
 * flags with their value, which passes untouched, and flag-shaped `--x=`
 * tokens, so `--tools=bash, read` still refuses) and, when the prompt holds no
 * bare `--`, the trailing switches it hoists, exact or with an `=` value and
 * no whitespace (`--detach=true` there refuses); the prompt between them is
 * text, except that up to its first bare `--` one of its value flags written
 * with `=` (any value) or a switch written with `=` and no whitespace refuses
 * (`agent run --json --tools=read ...` would hand the job every tool), with
 * advice to write it before the prompt or put `--` before the prompt. OWN_EQUALS_PARSERS pass their argv through. On a
 * command with a registry row, unregistered flags keep the token for the
 * validator to name; on a path with none (the hand-parsed search
 * subcommands), every `=` token but `--json=true` refuses with a neutral
 * message that names the subcommand, echoes no value and vouches for no
 * switch. A bare `--` ends the scan only on a path whose handler stops there
 * (END_OF_OPTIONS, keyed by `command sub`): `serve`, `auth`,
 * `frontmatter generate`, `questions` and `agent logs` read flags after it.
 */
import type { OperationError } from '../core/ops/contract.ts';
import { CLI_FLAG_REGISTRY } from '../core/cli-flag-registry.generated.ts';
import { unknownFlagError, usageError } from './cli-error.ts';
import { loadCuratedHelp } from './help/render.ts';
import { OPERATION_MANIFEST } from '../core/operation-manifest.generated.ts';
import { SYNC_FLAGS } from '../core/sync-flags.ts';
import { parseGlobalFlags, setCliOptions } from '../core/cli-options.ts';

/**
 * Where the handler on a path reads the `=` form itself, keyed by command or
 * `command sub` (the narrowest key every path under it honors): the token is
 * kept as written. Pinned by test/cli-flag-equals.test.ts against every module
 * that reads an `=` form.
 */
export const EQUALS_READERS: Readonly<Record<string, readonly string[]>> = {
  // beliefs.ts:61 sourceArg runs before the sub branch (beliefs.ts:98) for every subcommand.
  beliefs: ['--source'],
  // beliefs.ts:52 beliefsChangesArgs (also the thin-client route, thin-client-routing.ts:85).
  'beliefs changes': ['--since'],
  // beliefs-replay-purges.ts:14 flag() reads --x v and --x=v.
  'beliefs replay-purges': ['--archived-at', '--purge-mirror', '--from-url-env'],
  // core/consent.ts:126 via consentGateOrExit (book-mirror.ts:431, args :440, effects paid); book-mirror reads no --max-* itself.
  'book-mirror': ['--max-usd', '--max-cost'],
  // capture.ts:96 regex; every other = form is refused by capture's own parser (capture.ts:132).
  capture: ['--request-id', '--expected-revision'],
  // check-resolvable.ts:120 parseFlags.
  'check-resolvable': ['--skills-dir'],
  // code-scope.ts:64 parseFlag (code-callees.ts:46-48, code-callers.ts:58-60, code-def.ts:166-172, code-refs.ts:109-115).
  'code-callees': ['--limit', '--source'],
  'code-callers': ['--limit', '--source'],
  'code-def': ['--limit', '--lang', '--source'],
  'code-refs': ['--limit', '--lang', '--source'],
  // compile-context.ts:74 flagValue (parseCompileFlags :88-115).
  'compile-context': ['--target', '--budget', '--include', '--out', '--source'],
  // core/consent.ts:123 parseConsentFlags via enableConsent (decide.ts:348, effects paid); decide reads no --max-* itself.
  'decide enable': ['--max-usd', '--max-cost'],
  // doctor.ts:417 --scope=brain only (=-only); doctor/budget.ts:68 --tier/--budget-ms; cli/commands/doctor.ts:27 --tier (thin client);
  // doctor/registry.ts:332 --only; check-resolvable.ts:120 --skills-dir via doctor.ts:460; core/consent.ts:130 --expect (remediate-consent.ts:133).
  doctor: ['--scope', '--tier', '--budget-ms', '--only', '--skills-dir', '--expect'],
  // edge-proposals.ts:81 flag() used only by list (:91,:93); other subs take the first numeric token as the id (:86).
  'edge-proposals list': ['--status', '--limit'],
  // embed.ts:841 parsePaceArgs (--pace bare or =mode); core/consent.ts:126 via embed-consent.ts:129 and held-embedding.ts:234.
  embed: ['--pace', '--pace-max-concurrency', '--max-usd', '--max-cost'],
  // eval-conversation-parser.ts:48-53 (main.ts handleCliOnly's eval conversation-parser branch and eval.ts:106 both reach it).
  'eval conversation-parser': ['--fixtures', '--min-recall'],
  // eval/decide-eval-flags.ts:122 extractDecideEvalFlags via eval-retrieval-quality.ts:38.
  'eval retrieval-quality': ['--decide', '--decide-provider', '--decide-calibration', '--decide-threshold', '--decide-force-on', '--decide-dataset'],
  // eval-takes-quality.ts:82 getFlag; union over run (:148-162) / trend (:200-201) / regress (:212-226); replay reads none.
  'eval takes-quality': ['--limit', '--cycles', '--budget-usd', '--slug-prefix', '--models', '--source', '--rubric-version', '--against', '--threshold'],
  // export.ts:18 option() (:95-99).
  export: ['--dir', '--source', '--type', '--slug-prefix', '--repo'],
  // core/consent.ts:126 via requireEmbedBackfillConsent (features.ts:306, --auto-fix paid fixes only).
  features: ['--max-usd', '--max-cost'],
  // recall.ts:1183-1188 runForget (plain) and forget-purge.ts:44 flagValue (:114-123, purge); --match is purge-only, ignored by plain forget in any form.
  forget: ['--request-id', '--source', '--match'],
  // forget-purge.ts:131 flagValue --reason (runForgetPurge, routed on --purge at recall.ts:1170); plain forget reads only the separate token (recall.ts:1181).
  'forget --purge': ['--reason'],
  // frontmatter.ts:356 runValidate.
  'frontmatter validate': ['--path'],
  // frontmatter.ts:667 runAudit.
  'frontmatter audit': ['--source'],
  // frontmatter-install-hook.ts:184.
  'frontmatter install-hook': ['--source'],
  // graph-query.ts:56.
  'graph-query': ['--source'],
  // import.ts:377-395 readSourceFlag (+ :237 keyless refusal).
  import: ['--source', '--source-id'],
  // integrity.ts:857 extractFlag via cmdCheck (:306-307); integrity auto is STRICT.
  'integrity check': ['--limit', '--type'],
  // core/consent.ts:126 via jobs/submit.ts:104 requireEmbedBackfillConsent, :128 requireReindexConsent, :294 authorizePaidSubmit (paid); submit's own parseFlag(--max-usd) (:286) reads only the separate `off`.
  'jobs submit': ['--max-usd', '--max-cost'],
  // jobs/shared.ts:121 parseJobIsolationFlag via jobs/supervisor.ts:165.
  'jobs supervisor': ['--job-isolation'],
  // jobs/shared.ts:121 parseJobIsolationFlag via jobs/work.ts:114.
  'jobs work': ['--job-isolation'],
  // jobs/watch.ts:11 reads only --refresh-ms=N.
  'jobs watch': ['--refresh-ms'],
  // lint.ts:929 runLint.
  lint: ['--exclude'],
  // migrate-graduation.ts:97 flagValue (parseGraduationArgs :121-151); graduation-only flags, the legacy copier (migrate-engine.ts) never reads them.
  migrate: ['--url-env', '--trigger-bypass', '--drain-timeout', '--batch-size', '--expect'],
  // models.ts:853 doctor mode only (sub selection :818), repeated --skip=<provider>, =-only.
  'models doctor': ['--skip'],
  // core/bounded-listing-cli.ts:15 parseListingFlags via orphans.ts:353.
  orphans: ['--limit', '--cursor'],
  // pages-purges.ts:12 flagValue (:21) for purges and unpurge.
  'pages purges': ['--source'],
  'pages unpurge': ['--source'],
  // pages-unsearchable.ts:34 flagValue (:42-52).
  'pages unsearchable': ['--state', '--limit', '--source'],
  // pages-ghosts.ts:24.
  'pages ghosts': ['--source'],
  // pages-status.ts:77 parsePagesStatusArgs.
  'pages status': ['--source'],
  // recall.ts:156-201 parseFlags (--entity both, --source-id=, --question=, --budget-policy= with empty-value refusal).
  recall: ['--entity', '--source-id', '--question', '--budget-policy'],
  // reindex.ts:155-163 normalizeReindexArgs at entry (cli/commands/reindex.ts:12); --max-cost via core/consent.ts:126 (reindex-consent.ts:77).
  reindex: ['--type', '--limit', '--repo', '--workers', '--concurrency', '--max-usd', '--max-cost'],
  // core/consent.ts:126 via reindex-code.ts:503 / reindex-code-delegate.ts:51 (paid); the own --max-cost loop (reindex-code.ts:438) reads only the separate token and :521 takes the consent cap.
  'reindex-code': ['--max-usd', '--max-cost'],
  // core/consent.ts:130 --expect via consentGateOrExit (reinit-pglite.ts:109, plan_hash :119); parseArgs (:213) reads no --expect.
  'reinit-pglite': ['--expect'],
  // resolvers.ts:172 extractFlag via cmdList (:66-67).
  'resolvers list': ['--cost', '--backend'],
  // routing-eval.ts:83 parseFlags.
  'routing-eval': ['--skills-dir'],
  // schema.ts:457 parseFlags; only these subs use the parsed source (:208,:499,:542,:562,:872,:1043,:1080,:1103).
  'schema active': ['--source', '--source-id'],
  'schema detect': ['--source', '--source-id'],
  'schema suggest': ['--source', '--source-id'],
  'schema review-candidates': ['--source', '--source-id'],
  'schema review-orphans': ['--source', '--source-id'],
  'schema stats': ['--source', '--source-id'],
  'schema cardinality-preview': ['--source', '--source-id'],
  'schema sync': ['--source', '--source-id'],
  // schema.ts:765 runLintCmd strips both forms through parseFlags before util.parseArgs.
  'schema lint': ['--source', '--source-id'],
  // schema.ts:1138 runReloadCmd; schema.ts:1004 pickPackName for the pack-authoring subs (remove-* are STRICT, add-type is OWN).
  'schema reload': ['--pack'],
  'schema update-type': ['--pack'],
  'schema add-alias': ['--pack'],
  'schema add-prefix': ['--pack'],
  'schema add-link-type': ['--pack'],
  'schema set-extractable': ['--pack'],
  'schema set-expert-routing': ['--pack'],
  'schema scaffold-extractable': ['--pack'],
  // skillify.ts:117 parseScaffoldFlags (:142-160); skillify check reads no = form.
  'skillify scaffold': ['--description', '--triggers', '--writes-to', '--skills-dir'],
  // skillpack.ts:312 cmdStatus, :382 cmdSync, :501 cmdMigrateFence, :547 cmdScrubLegacy, :1210 cmdHarvest, :1281-1287 cmdDiff.
  'skillpack status': ['--workspace'],
  'skillpack sync': ['--workspace'],
  'skillpack migrate-fence': ['--workspace'],
  'skillpack scrub-legacy-fence-rows': ['--workspace'],
  'skillpack harvest': ['--from'],
  'skillpack diff': ['--workspace', '--skills-dir'],
  // skillpack/scaffold.ts:36 lane select + :73 --workspace=; harness lane skillpack/harness.ts:91-158 parseHarnessArgs (:364).
  'skillpack scaffold': ['--workspace', '--harness', '--persona', '--skill', '--dest', '--scope', '--skills'],
  // skillpack/reference.ts:44 harness lane (strict-args.ts:102 makes the non-harness lane STRICT); harness.ts:542.
  'skillpack reference': ['--harness', '--persona', '--skill', '--dest', '--scope', '--workspace', '--skills'],
  // core/bounded-listing-cli.ts:15 via sources.ts:1213 runStatus (+ :1214 paged regex).
  'sources status': ['--limit', '--cursor'],
  // sources-harden.ts:31 flagVal: runHarden (:83-84), runPull (:150-151). `sources pull --path=` refuses: main.ts takes the database-free route only on the exact token.
  'sources harden': ['--branch', '--pat-file'],
  'sources pull': ['--branch'],
  // status.ts:812 parseDeadlineFlag, :834 parseSectionFlag (runStatus :871-881).
  status: ['--section', '--deadline-ms'],
  // core/bounded-listing-cli.ts:15 via sync/operator.ts:167 holdsListing (+ :173 sized check); the `sync --status` alias (syncOperatorVerb, operator.ts:136) reads as this path.
  'sync status': ['--limit', '--cursor'],
  // trust-claim.ts:65 flagValues (:81, :113).
  'trust claim-sources': ['--source'],
  // core/stable-channel.ts:19 parseChannelArg via upgrade.ts:361.
  upgrade: ['--channel'],
};

/** Commands that run another command's handler on the same argv (`repos` is runSources, cli/commands/repos.ts:18): the = rule reads the target's keys. */
export const READER_ALIASES: Readonly<Record<string, string>> = { repos: 'sources' };

/**
 * Commands and subcommands whose handler parses `--flag value` and
 * `--flag=value` itself on every path, refusing `=` on its own switches:
 * cliOnlyFlagArgs in src/cli/main.ts passes their argv through unchanged
 * (pinned by test/cli-flag-equals.test.ts in both directions against every
 * `indexOf('=')` option parser). The sources lifecycle subcommands are not
 * here: on an unmanaged brain they fall back to runSources, which reads only
 * exact tokens.
 */
export const OWN_EQUALS_PARSERS: ReadonlySet<string> = new Set([
  'append', 'auth local-writer', 'eval longmemeval', 'git', 'google attachments', 'migrate embeddings', 'repair', 'retrieval-upgrade', 'schema add-type', 'skillpack remove',
  'sources connect', 'sources inspect', 'sources reconcile', 'sources reset-upstream', 'sources writer',
  'takes add', 'takes remove', 'takes resolve', 'takes supersede', 'takes update',
]);

/** Switches a command reads with `args.includes` whose name takes a value elsewhere; the command's own reading wins. */
export const COMMAND_SWITCHES: Readonly<Record<string, readonly string[]>> = {
  sync: ['--detail'],
  schema: ['--fields'],
  agent: ['--follow', '--detach'],
  dream: ['--unsafe-bypass-dream-guard'],
  embed: ['--stale'],
};

/** Value flags of a command with no curated help that every path reads as `--flag <value>` (migrate-engine.ts parseArgs, migrate-graduation.ts flagValue and routesToGraduation); their `=` form splits. */
export const COMMAND_VALUES: Readonly<Record<string, readonly string[]>> = {
  migrate: ['--to', '--url'],
};

/** Paths (`command sub`) whose handler treats a bare `--` as the end of its options; everywhere else the scan continues past it. */
export const END_OF_OPTIONS: ReadonlySet<string> = new Set(['agent run', 'frontmatter validate']);

/** Switch evidence by name: shared-op boolean parameters (handler-free manifest) and boolean flags in any command's curated help. Loaded only when an `=` token needs it. */
let switches: Promise<ReadonlySet<string>> | undefined;
export function knownSwitches(): Promise<ReadonlySet<string>> {
  return switches ??= (async () => {
    const out = new Set<string>();
    for (const op of OPERATION_MANIFEST) for (const [name, p] of Object.entries(op.params)) if (p.type === 'boolean') out.add(`--${name.replace(/_/g, '-')}`);
    for (const command of Object.keys(CLI_FLAG_REGISTRY)) for (const f of (await loadCuratedHelp(command))?.flags ?? []) if (f.type === 'boolean') out.add(f.name);
    return out;
  })();
}

const EQUALS_TOKEN = /^(--[a-z0-9][a-z0-9-]*|-[A-Za-z])=([\s\S]*)$/;

export async function splitFlagEquals(command: string, args: readonly string[]): Promise<{ args: string[] } | { refusal: OperationError }> {
  if (!args.some(a => /^-[^=\s]*=/.test(a))) return { args: [...args] };
  const legal = CLI_FLAG_REGISTRY[command];
  const keyed = READER_ALIASES[command] ?? command;
  const sub = command === 'sync' && args[0] !== 'unblock' && args[0] !== 'trigger' && args.includes('--status') ? 'status' : command === 'forget' && args.includes('--purge') ? '--purge' : args[0];
  const readers = [...EQUALS_READERS[keyed] ?? [], ...EQUALS_READERS[`${keyed} ${sub}`] ?? []];
  let types: Map<string, string> | undefined;
  const out: string[] = [];
  const where = args[0] && !args[0].startsWith('-') ? `gbrain ${command} ${args[0]}` : `gbrain ${command}`;
  let pastDashDash = false;
  let promptAt = -1;
  let tailAt = args.length;
  const values = new Set<number>();
  if (command === 'agent' && args[0] === 'run') {
    const { RUN_VALUE_FLAGS, BOOLEAN_TAIL_FLAGS } = await import('../commands/agent.ts');
    for (promptAt = 1; promptAt < args.length; promptAt++) {
      const t = args[promptAt]!;
      if (RUN_VALUE_FLAGS.has(t)) values.add(++promptAt);
      else if (!BOOLEAN_TAIL_FLAGS.has(t) && !(t.startsWith('--') && EQUALS_TOKEN.test(t))) break;
    }
    const dashAt = args.indexOf('--', promptAt);
    if (dashAt < 0) while (tailAt > promptAt && BOOLEAN_TAIL_FLAGS.has(args[tailAt - 1]!.split('=')[0]!) && !/\s/.test(args[tailAt - 1]!)) tailAt--;
    const stray = args.slice(promptAt, dashAt < 0 ? tailAt : dashAt).map(t => /^(--[a-z0-9][a-z0-9-]*)=([\s\S]*)$/.exec(t)).find(m => m !== null && (RUN_VALUE_FLAGS.has(m[1]!) || BOOLEAN_TAIL_FLAGS.has(m[1]!) && !/\s/.test(m[2]!)))?.[1];
    if (stray) return { refusal: usageError(`gbrain agent: \`${stray}=…\`: agent run reads its flags before the prompt, so this would be prompt text.`, `Write ${RUN_VALUE_FLAGS.has(stray) ? `${stray} <value>` : stray} before the prompt and ahead of any word agent run does not read (such as --json or --yes), or put -- before the prompt to keep it as text.`) };
  }
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--' && END_OF_OPTIONS.has(`${command} ${args[0]}`)) return { args: [...out, ...args.slice(i)] };
    if (values.has(i)) { out.push(token); continue; }
    if (i === promptAt && promptAt < tailAt) { out.push(...args.slice(i, tailAt)); i = tailAt - 1; continue; }
    pastDashDash ||= token === '--';
    const m = EQUALS_TOKEN.exec(token);
    const flag = m?.[1];
    if (flag !== undefined && !flag.startsWith('--') && !/\s/.test(token)) {
      return { refusal: usageError(`gbrain ${command}: \`${flag}=…\`: a short flag takes no =.`, `Write ${flag} on its own, or ${flag} <value> with the value as the next argument.`) };
    }
    const registered = flag !== undefined && (!legal || legal.includes(flag) || flag.startsWith('--no-') && legal.includes(`--${flag.slice(5)}`));
    const unvalidated = pastDashDash && !registered && /^--[^=\s]+=/.exec(token);
    if (unvalidated) return { refusal: usageError(`gbrain ${command}: \`${unvalidated[0]}…\`: not a flag of this command, and its handler reads flags after --.`, 'Check the spelling: flags are lowercase words joined by hyphens.') };
    if (!m || !registered || readers.includes(flag)) { out.push(token); continue; }
    const value = m[2]!;
    if (flag === '--json' && value === 'true') { out.push(flag); continue; }
    types ??= new Map((await loadCuratedHelp(command))?.flags.map(f => [f.name, f.type]));
    const own = types.get(flag) ?? (command === 'sync' ? (SYNC_FLAGS as Record<string, { arity: string }>)[flag]?.arity : undefined) ?? (COMMAND_VALUES[command]?.includes(flag) ? 'string' : undefined);
    const isSwitch = own !== undefined ? own === 'boolean' : flag.startsWith('--no-') || COMMAND_SWITCHES[command]?.includes(flag) || (await knownSwitches()).has(flag);
    const refusal = !legal
      ? [`${where} reads no = form`, `Check the flag in ${where} --help: write a switch on its own (a value never turns it off), or a value as the next argument.`]
      : isSwitch
      ? [`${flag} is a switch and takes no value`, `Write ${flag} on its own, or leave it out.`]
      : value === '' || /^-[-A-Za-z]/.test(value)
        ? [`the value is empty or looks like a flag`, `Write ${flag} <value> with the value as the next argument.`]
        : own === undefined && /^(true|false|yes|no|y|n|on|off|0|1)$/i.test(value)
          ? [`write ${flag} on its own if it is a switch, or with its value as the next argument`, `If ${flag} is a switch, write it on its own to turn it on, or leave it out to turn it off: a value never turns it off. If it takes a value, put the value in the next argument.`]
          : own === undefined
          ? [`this command takes ${flag} <value> as two arguments`, `Write ${flag} <value>, or ${flag} on its own if it is a switch.`]
          : null;
    if (refusal) return { refusal: usageError(`gbrain ${command}: \`${flag}=…\`: ${refusal[0]}.`, refusal[1]!) };
    out.push(flag, value);
  }
  return { args: out };
}

/** CLI_ONLY lane: token scan against the generated legal set. */
export function findUnknownFlag(args: string[], legal: ReadonlySet<string>): string | null {
  for (const a of args) {
    if (a === '--') break;
    const m = /^--([a-z0-9][a-z0-9-]*)(?:=[\s\S]*)?$/i.exec(a);
    if (!m) continue;
    // Casing typo = unknown flag: every handler in the repo is
    // case-sensitive-lowercase, so `--MIGRATE-ONLY` passing validation would
    // just be silently ignored downstream — the exact class this validator
    // exists to kill.
    if (/[A-Z]/.test(m[1])) return `--${m[1]}`;
    const name = `--${m[1]}`;
    if (legal.has(name)) continue;
    // --no-<flag> negation of a known flag is legal.
    if (name.startsWith('--no-') && legal.has(`--${name.slice(5)}`)) continue;
    return name;
  }
  return null;
}

/** auth.ts's direct `bun run` entry, in main's order: global flags stripped and applied, the `=` rule (`command sub` own `=` parsers pass through; auth has no whole-command own parser, strict spec or exempt path), and main's unknown-flag check with its envelope (legacy keys included). */
export async function directEntryArgs(command: string, raw: string[]): Promise<{ args: string[] } | { refusal: OperationError; legacy?: Record<string, string> }> {
  const { cliOpts, rest } = parseGlobalFlags(raw);
  setCliOptions(cliOpts);
  const split = OWN_EQUALS_PARSERS.has(`${command} ${rest[0]}`) ? { args: rest } : await splitFlagEquals(command, rest);
  if ('refusal' in split) return split;
  const unknown = findUnknownFlag(split.args, new Set(CLI_FLAG_REGISTRY[command]));
  if (!unknown) return split;
  const message = `unknown flag ${unknown} for 'gbrain ${command}'`;
  const known = (await loadCuratedHelp(command))?.flags.map(f => f.name) ?? CLI_FLAG_REGISTRY[command] ?? [];
  return { refusal: unknownFlagError(command, unknown, message, known), legacy: { status: 'error', reason: 'invalid_flag', message } };
}
